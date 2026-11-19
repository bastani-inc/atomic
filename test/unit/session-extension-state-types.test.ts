import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "vitest";
import { isExtensionCustomState } from "../../packages/coding-agent/src/core/storage/session/session-resume.js";
import { moduleDir } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const skipped = new Set(["node_modules", "dist", "test", "tests", "docs", "examples", "fixtures"]);

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return skipped.has(entry.name) ? [] : sources(path);
		return /\.(ts|mjs|js)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name) ? [path] : [];
	});
}

// A fork copies every custom entry type Atomic does not own as extension state (#5500). A new Atomic writer whose
// type is not listed in session-resume.ts would be copied into every forked child.
test("a subagent fork does not treat a custom entry type Atomic writes as extension state (#5500)", () => {
	const files = sources(join(repositoryRoot, "packages"));
	const constants = new Map<string, string>();
	const texts = files.map((file) => [relative(repositoryRoot, file), readFileSync(file, "utf8")] as const);
	for (const [, text] of texts)
		for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*"([^"]+)"/g)) constants.set(m[1]!, m[2]!);
	const written: string[] = [];
	const unresolved: string[] = [];
	for (const [file, text] of texts)
		for (const m of text.matchAll(
			/\b(?:appendEntry|appendCustomEntry|appendEntryUnlessReleased|createCustomEntry)\??\.?\(\s*(?:pi,\s*)?(?:"([^"]+)"|([A-Z][A-Z0-9_]+)\b)|errorEntryType:\s*"([^"]+)"|\.append\(\s*([A-Z][A-Z0-9_]*_ENTRY)\b/g,
		)) {
			const name = m[2] ?? m[4];
			const type = m[1] ?? m[3] ?? constants.get(name!);
			if (type === undefined) unresolved.push(`${file}: ${name}`);
			else if (isExtensionCustomState(type)) written.push(`${file}: ${type}`);
		}
	assert.ok(
		texts.some(([file]) => file.includes("subagents")),
		"no Atomic package sources were scanned",
	);
	assert.deepEqual(unresolved, []);
	assert.deepEqual(written, []);
});
