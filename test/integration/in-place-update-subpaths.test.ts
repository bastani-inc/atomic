import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const repositoryRoot = join(moduleDir(import.meta.url), "..", "..");
/** The entries the build's split wrote (`packages/coding-agent/scripts/split-dist.mjs`). */
const SPLIT_STATE = join(repositoryRoot, "packages/coding-agent/node_modules/.cache/atomic-split-dist/state.json");
const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(join(repositoryRoot, "test/fixtures/atomic-0.10.3", name), "utf8"));

/** Each first-party package's exports map in 0.10.3, as key -> file, `null` for a package without one. */
const exportsIn0103 = fixture("package-exports.json") as Record<string, Record<string, string> | null>;
/** The files a bare specifier could reach in each package in 0.10.3 through a pattern export, or any path. */
const filesIn0103 = fixture("package-files.json") as Record<string, string[]>;

/**
 * Subpaths 0.10.3 did not export that an updated file may still name: a module every Atomic process has already
 * loaded, at startup, before an update can land, so a running process never resolves its specifier again.
 */
const LOADED_AT_STARTUP = new Set(["@bastani/atomic-codemode/node-options"]);

/**
 * What a 0.10.3 process makes of `name` + `subpath` (`""` for the package itself) through the package.json it read at
 * startup: `null` when it cannot resolve it, else the file, by path in the package, for a pattern export or a package
 * without an exports map, and `""` for an export of one file.
 */
function resolvedIn0103(name: string, subpath: string): string | null {
	if (!(name in exportsIn0103)) return "";
	const exportsMap = exportsIn0103[name];
	if (exportsMap === undefined || exportsMap === null) return subpath.slice(1);
	const key = subpath === "" ? "." : `.${subpath}`;
	if (key in exportsMap) return "";
	for (const [pattern, target] of Object.entries(exportsMap)) {
		if (!pattern.endsWith("*") || !key.startsWith(pattern.slice(0, -1))) continue;
		// Node puts the matched text in place of every `*` of the target.
		return target.replaceAll("*", key.slice(pattern.length - 1)).replace(/^\.\//, "");
	}
	return null;
}

/** The JavaScript files Node and Bun load from a package's dist; `_modules` is the copy only bundlers read. */
function loadableFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "_modules" && entry.name !== "node_modules") files.push(...loadableFiles(path));
		} else if (/\.[cm]?js$/.test(entry.name)) files.push(path);
	}
	return files;
}

// When Atomic is updated in place while a 0.10.3 session runs, code that session loads later comes from the updated
// files, but resolves their imports of Atomic's packages as the session did at startup: Node and Bun read each
// package.json once per process, and Bun also reads each directory's entries once. So every subpath those files name
// must be in 0.10.3's exports map, and a file that 0.10.3 did not have must be in a directory it did not have either.
test("Atomic's built files import only package subpaths a 0.10.3 process can still resolve after an in-place update", () => {
	const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@bastani\/[a-z-]+)(\/[^"']*)?["']/g;
	const directoriesIn0103 = Object.fromEntries(
		Object.entries(filesIn0103).map(([name, files]) => [name, new Set(files.map((file) => posix.dirname(file)))]),
	);
	const unresolvable = new Set<string>();
	const scanned = new Set<string>();
	const workspaces = ["coding-agent", "ai", "agent", "tui", "schema", "telemetry", "codemode"];
	for (const workspace of workspaces) {
		for (const file of loadableFiles(join(repositoryRoot, "packages", workspace, "dist"))) {
			const importer = relative(repositoryRoot, file).split("\\").join("/");
			scanned.add(importer);
			for (const [, name = "", subpath = ""] of readFileSync(file, "utf8").matchAll(specifier)) {
				if (LOADED_AT_STARTUP.has(`${name}${subpath}`)) continue;
				const resolved = resolvedIn0103(name, subpath);
				if (resolved === null) unresolvable.add(`${name}${subpath} (not exported) in ${importer}`);
				else if (
					resolved !== "" &&
					directoriesIn0103[name]?.has(posix.dirname(resolved)) &&
					!filesIn0103[name]?.includes(resolved)
				)
					unresolvable.add(`${name}${subpath} (a new file in a directory 0.10.3 had) in ${importer}`);
			}
		}
	}
	// Every package's built files were scanned: each package has some, and Atomic's are every entry the build's split
	// wrote and every shared file it moved their code into.
	for (const workspace of workspaces)
		assert.ok(
			[...scanned].some((path) => path.startsWith(`packages/${workspace}/dist/`)),
			`no built files of ${workspace}`,
		);
	const splitEntries = Object.keys(
		(JSON.parse(readFileSync(SPLIT_STATE, "utf8")) as { entries: Record<string, string> }).entries,
	);
	const sharedFiles = readdirSync(join(repositoryRoot, "packages/coding-agent/dist/_shared")).filter((file) =>
		file.endsWith(".js"),
	);
	assert.ok(splitEntries.length > 0 && sharedFiles.length > 0, "the build split Atomic's modules");
	const split = [
		...splitEntries.map((entry) => `packages/coding-agent/dist/${entry}.js`),
		...sharedFiles.map((file) => `packages/coding-agent/dist/_shared/${file}`),
	];
	assert.deepEqual(
		split.filter((path) => !scanned.has(path)),
		[],
		"built files the scan missed",
	);
	assert.deepEqual([...unresolvable].sort(), []);
});
