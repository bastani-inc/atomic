import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const repositoryRoot = join(moduleDir(import.meta.url), "..", "..");

/** Each first-party package's export keys in 0.10.3, `null` for a package without an exports map. */
const exportsIn0103 = JSON.parse(
	readFileSync(join(repositoryRoot, "test/fixtures/atomic-0.10.3/package-exports.json"), "utf8"),
) as Record<string, string[] | null>;

/**
 * Subpaths 0.10.3 did not export that an updated file may still name: a module every Atomic process has already
 * loaded, at startup, before an update can land, so a running process never resolves its specifier again.
 */
const LOADED_AT_STARTUP = new Set(["@bastani/atomic-codemode/node-options"]);

/** Whether 0.10.3's exports map resolves `subpath` (`""` for the package itself) of `name`. */
function exportedIn0103(name: string, subpath: string): boolean {
	const keys = exportsIn0103[name];
	if (keys === undefined || keys === null) return true;
	const key = subpath === "" ? "." : `.${subpath}`;
	return keys.some((candidate) =>
		candidate.endsWith("*") ? key.startsWith(candidate.slice(0, -1)) : key === candidate,
	);
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

// Node and Bun read a package's package.json once per process. When Atomic is updated in place while a 0.10.3 session
// runs, code that session loads later comes from the updated files but resolves their imports of Atomic's packages
// through the exports maps it read at startup, so every subpath those files name must already be in 0.10.3's map.
test("Atomic's built files import only package subpaths a 0.10.3 process can still resolve after an in-place update", () => {
	const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](@bastani\/[a-z-]+)(\/[^"']*)?["']/g;
	const unresolvable = new Set<string>();
	let scanned = 0;
	for (const workspace of ["coding-agent", "ai", "agent", "tui", "schema", "telemetry", "codemode"]) {
		for (const file of loadableFiles(join(repositoryRoot, "packages", workspace, "dist"))) {
			scanned++;
			for (const [, name = "", subpath = ""] of readFileSync(file, "utf8").matchAll(specifier)) {
				if (exportedIn0103(name, subpath) || LOADED_AT_STARTUP.has(`${name}${subpath}`)) continue;
				unresolvable.add(`${name}${subpath} in ${relative(repositoryRoot, file).split("\\").join("/")}`);
			}
		}
	}
	assert.ok(scanned > 1000, `scanned only ${scanned} built files`);
	assert.deepEqual([...unresolvable].sort(), []);
});
