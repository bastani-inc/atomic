#!/usr/bin/env node
// @ts-check
/** Checks published restored worktrees. A `.staging-*` directory is not a worktree used for resume. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A directory in the final worktree namespace must be its own Git checkout with a readable HEAD. Staging directories
 * are never returned as a worktree and are left to snapshot recovery; they must not be mistaken for published trees.
 * @param {string} root
 * @param {string} git
 * @returns {{ clean: boolean, incomplete: string[], staging: string[] }}
 */
export function checkPublishedWorktrees(root, git) {
	if (!existsSync(root)) return { clean: true, incomplete: [], staging: [] };
	const entries = readdirSync(root, { withFileTypes: true });
	const staging = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
		.map((entry) => entry.name);
	const incomplete = entries
		.filter((entry) => !staging.includes(entry.name))
		.filter((entry) => {
			if (!entry.isDirectory()) return true;
			const path = join(root, entry.name);
			const head = spawnSync(git, ["-C", path, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
			const top = spawnSync(git, ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
			return head.status !== 0 || top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(path);
		})
		.map((entry) => entry.name);
	return { clean: incomplete.length === 0, incomplete, staging };
}

/**
 * A byte-accurate, portable tree manifest. It includes paths, file bytes, symlink targets and executable bits, but not
 * host-specific ownership, non-executable permission bits or timestamps. Git metadata is excluded at every level.
 * @typedef {{ path: string, type: "file" | "directory" | "symlink", digest?: string, executable?: boolean }} TreeEntry
 * @param {string} root
 * @returns {{ digest: string, entries: TreeEntry[] }}
 */
export function treeManifest(root) {
	/** @type {TreeEntry[]} */
	const entries = [];
	/** @param {string} directory @param {string} prefix */
	function walk(directory, prefix) {
		for (const name of readdirSync(directory).sort()) {
			if (name === ".git") continue;
			const path = join(directory, name);
			const relative = prefix === "" ? name : `${prefix}/${name}`;
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				entries.push({ path: relative, type: "directory" });
				walk(path, relative);
			} else if (stat.isSymbolicLink()) {
				entries.push({
					path: relative,
					type: "symlink",
					digest: createHash("sha256").update(readlinkSync(path)).digest("hex"),
				});
			} else if (stat.isFile()) {
				entries.push({
					path: relative,
					type: "file",
					digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
					executable: (stat.mode & 0o111) !== 0,
				});
			} else throw new TypeError(`unsupported tree entry ${relative}`);
		}
	}
	walk(root, "");
	return { digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const [first, second] = process.argv.slice(2);
	if (first === undefined || second === undefined)
		throw new TypeError("resume-check needs a worktree root and Git executable, or tree and a root");
	const result = first === "tree" ? treeManifest(second) : checkPublishedWorktrees(first, second);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
