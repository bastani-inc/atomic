import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const SKIPPED = new Set([
	"node_modules",
	"dist",
	"test",
	"tests",
	"__tests__",
	"fixtures",
	"docs",
	"vendor",
	"examples",
]);
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
// A call of the method, or an open that asks for every entry, in any spelling a source file could use.
const WHOLE_HISTORY = /\.\s*loadFullHistory\b|\[\s*["'`]loadFullHistory["'`]\s*\]|\bhistory\s*:\s*["'`]full["'`]/;

function* sources(directory: string): Generator<string> {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED.has(entry.name)) yield* sources(join(directory, entry.name));
		} else if (SOURCE.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) yield join(directory, entry.name);
	}
}

test("Atomic's own code reads older entries a page at a time and never loads a whole session into a manager (#5554)", () => {
	const callers: string[] = [];
	let scanned = 0;
	for (const file of sources(join(repository, "packages"))) {
		scanned++;
		const lines = readFileSync(file, "utf8").split("\n");
		for (const [index, line] of lines.entries())
			if (WHOLE_HISTORY.test(line)) callers.push(`${relative(repository, file)}:${index + 1}: ${line.trim()}`);
	}
	assert.ok(scanned > 1_000, `expected to scan the packages' sources, scanned ${scanned} files`);
	// loadFullHistory() and { history: "full" } stay for SDK callers that need every entry resident; built-in callers
	// use readHistory(), readEntry() or the omitted-history totals so memory stays bounded by the window.
	assert.deepEqual(callers, []);
});
