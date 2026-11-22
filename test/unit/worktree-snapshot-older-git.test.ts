import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	type GitExecutable,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	setWorktreeSnapshotGit,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/**
 * A `git` that answers as Git 2.30 does for the options it lacks and runs the installed Git for everything else:
 * `worktree list -z` and `worktree add --reason` stop at the usage text with exit code 129, `rev-parse --path-format`
 * prints the option back, and `bundle create --stdin` bundles no ref it reads from standard input.
 */
function gitWithout231Options(real: string): string {
	const script = sandbox.path("git-2.30");
	writeFileSync(
		script,
		`#!/bin/sh
case " $* " in
*" worktree list "*" -z "*) echo "error: unknown switch \\\`z'" >&2; exit 129 ;;
*" worktree add "*" --reason "*) echo "error: unknown option \\\`reason'" >&2; exit 129 ;;
*" bundle create "*" --stdin ") last_two=$(printf '%s\\n' "$@" | tail -n 2 | head -n 1)
	case "$last_two" in /*|?:*) echo "fatal: Refusing to create empty bundle." >&2; exit 128 ;; esac ;;
esac
n=$#
found=
for arg in "$@"; do
	if [ "$arg" = "--path-format=absolute" ]; then found=1; else set -- "$@" "$arg"; fi
done
shift "$n"
if [ -n "$found" ]; then printf '%s\\n' --path-format=absolute; fi
exec "${real}" "$@"
`,
	);
	chmodSync(script, 0o755);
	return script;
}

/** The installed Git, by absolute path. */
function installedGit(): string {
	return execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
}

/**
 * The Gits to run against: the emulation of Git 2.30 where a shell runs it, and each Git install prefix named in
 * `ATOMIC_TEST_OLDER_GIT` (separated as PATH is), such as a Git 2.30 or 2.35 built from source.
 */
function olderGits(): { readonly name: string; readonly executable: () => GitExecutable }[] {
	const gits: { name: string; executable: () => GitExecutable }[] = [];
	if (process.platform !== "win32") {
		gits.push({
			name: "a Git without the options of 2.31",
			executable: () => ({ path: gitWithout231Options(installedGit()), env: sandbox.executable.env }),
		});
	}
	for (const prefix of (process.env.ATOMIC_TEST_OLDER_GIT ?? "").split(delimiter).filter(Boolean)) {
		const path = join(prefix, "bin", process.platform === "win32" ? "git.exe" : "git");
		if (!existsSync(path)) continue;
		const version = execFileSync(path, ["--version"], {
			encoding: "utf8",
			env: { ...process.env, GIT_EXEC_PATH: join(prefix, "libexec", "git-core") },
		}).trim();
		gits.push({
			name: version,
			executable: () => ({
				path,
				env: { ...sandbox.executable.env, GIT_EXEC_PATH: join(prefix, "libexec", "git-core") },
			}),
		});
	}
	return gits;
}

const gits = olderGits();
// Windows runs no shell script as Git: there, these run only against installs named in ATOMIC_TEST_OLDER_GIT.
if (gits.length === 0) test.skip("snapshots with a Git older than 2.36 (none to run against here)", () => {});
for (const { name, executable } of gits) {
	describe(`snapshots with ${name}`, () => {
		test("a checkout with an unpushed commit is captured with its bundle and restored into a pooled worktree", async () => {
			const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
			sandbox.write(join(clone, "feature.txt"), "unpushed\n");
			await sandbox.commitAll(clone, "unpushed work");
			sandbox.write(join(clone, "a.txt"), "edited\n");
			const restore = setWorktreeSnapshotGit(async () => executable());
			try {
				const blobs = new MemorySnapshotBlobStore();
				const captured = await captureWorktreeSnapshot(clone, { blobs });
				assert.equal(captured.status, "captured", JSON.stringify(captured));
				const snapshot = (captured as { snapshot: WorktreeSnapshot }).snapshot;
				assert.ok(snapshot.bundle, "the unpushed commit travels in a bundle");

				const storeDir = sandbox.path("machine-b");
				const restored = await restoreWorktree(snapshot, { blobs, storeDir });
				assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), snapshot.head);
				assert.equal(readFileSync(join(restored.path, "a.txt"), "utf8"), "edited\n");
				assert.equal(readFileSync(join(restored.path, "feature.txt"), "utf8"), "unpushed\n");

				await removeRestoredWorktree(restored.path, { storeDir });
				assert.equal(existsSync(restored.path), false);
			} finally {
				setWorktreeSnapshotGit(restore);
			}
		});
	});
}

test.skipIf(process.platform === "win32")(
	"a store whose path has a line break is restored into and removed from with the installed Git",
	async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
		sandbox.write(join(clone, "a.txt"), "edited\n");
		const blobs = new MemorySnapshotBlobStore();
		const captured = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(captured.status, "captured", JSON.stringify(captured));
		const snapshot = (captured as { snapshot: WorktreeSnapshot }).snapshot;
		const storeDir = sandbox.path("machine\nb");
		const restored = await restoreWorktree(snapshot, { blobs, storeDir });
		assert.equal(readFileSync(join(restored.path, "a.txt"), "utf8"), "edited\n");
		await removeRestoredWorktree(restored.path, { storeDir });
		assert.equal(existsSync(restored.path), false);
	},
);
