import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { repositoryRoot } from "../../vitest.base.js";

/**
 * Packages whose components the transcript draws. Every component Ctrl+O expands (it defines `setExpanded`) is a
 * block a click expands too: it declares `expandsOnClick` and the rows a click takes, as
 * `ClickExpandableBlock` in transcript-block-clicks.ts describes.
 */
const SCANNED = [
	"packages/coding-agent/src",
	"packages/workflows/src",
	"packages/subagents/src",
	"packages/intercom",
	"packages/web-access",
	"packages/mcp",
];

/** Components that define `setExpanded` but are not transcript blocks of their own, and why. */
const NOT_BLOCKS: Readonly<Record<string, string>> = {
	"packages/coding-agent/src/modes/interactive/components/notice-line.ts":
		"a notice line is drawn inside a message card or a stage notice row, and that block takes the click",
	"packages/coding-agent/src/modes/interactive/components/startup-identity.ts":
		"the startup header shows nothing more when expanded; its setExpanded does nothing",
};

/**
 * A method or object-literal member that sets the expansion, with a body: interface declarations end in `;`, and a
 * parameter typed as a setter has no body.
 */
const SET_EXPANDED = /\bsetExpanded\s*(?:\(\s*[\w$]+\s*:\s*boolean\s*\)\s*(?::\s*void\s*)?\{|:\s*\([^)]*\)\s*=>\s*\{)/g;
/** `readonly expandsOnClick = …`, `get expandsOnClick()` or an object literal's `expandsOnClick: …`. */
const EXPANDS_ON_CLICK = /\bexpandsOnClick\s*(?:=|:\s*(?!boolean\b)|\(\))|\bget\s+expandsOnClick\s*\(/g;

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts"))
			files.push(path);
	}
	return files;
}

test("every component Ctrl+O expands is a block a click expands, or is listed with the reason it is not", () => {
	const missing: string[] = [];
	const found = new Set<string>();
	for (const root of SCANNED) {
		for (const path of sourceFiles(join(repositoryRoot, root))) {
			const source = readFileSync(path, "utf8");
			const expandable = source.match(SET_EXPANDED)?.length ?? 0;
			if (expandable === 0) continue;
			const file = relative(repositoryRoot, path).replaceAll("\\", "/");
			found.add(file);
			if (NOT_BLOCKS[file] !== undefined) continue;
			const clickable = source.match(EXPANDS_ON_CLICK)?.length ?? 0;
			if (clickable < expandable) missing.push(`${file}: ${expandable} setExpanded, ${clickable} expandsOnClick`);
		}
	}
	assert.deepEqual(missing, [], "each of these components expands with Ctrl+O but takes no click");
	for (const file of Object.keys(NOT_BLOCKS)) {
		assert.ok(found.has(file), `${file} no longer defines setExpanded; drop it from the list`);
	}
});
