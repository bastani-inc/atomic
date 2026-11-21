import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const repositoryRoot = join(moduleDir(import.meta.url), "..", "..");

/** The TypeScript files below `directory`, without tests, fixtures, examples (extensions name `typebox`, which the extension loader resolves to Atomic's copy), dependencies or build output. */
function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (["node_modules", "dist", "test", "tests", "fixtures", "scripts", "examples"].includes(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (/\.m?ts$/.test(entry.name) && !/\.(test|spec)\.m?ts$/.test(entry.name)) files.push(path);
	}
	return files;
}

// Atomic ships one copy of TypeBox, bundled into @bastani/atomic-ai, whose own `typebox` imports the bundle keeps in that
// copy. Other shipped code that imported the `typebox` package itself would load a second copy, whose formats and
// settings Atomic's validation never sees.
test("shipped sources import TypeBox only from Atomic's copy", () => {
	const packages = join(repositoryRoot, "packages");
	const offenders: string[] = [];
	for (const name of readdirSync(packages)) {
		for (const file of sourceFiles(join(packages, name))) {
			const path = relative(repositoryRoot, file).split("\\").join("/");
			if (path.startsWith("packages/ai/src/")) continue;
			const source = readFileSync(file, "utf8");
			if (/(?:\bfrom\s*|\bimport\s*\(\s*)["'](?:typebox|@sinclair\/typebox)(?:\/[^"']*)?["']/.test(source))
				offenders.push(path);
		}
	}
	assert.deepEqual(offenders, []);
});
