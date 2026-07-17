import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Regression for PR #1842: the published `@bastani/atomic` package build runs
// `tsgo -p tsconfig.build.json` with `erasableSyntaxOnly` and without Bun's
// ambient types. Two classes of syntax broke that build one error at a time:
//   1. TS1294 - constructor parameter properties (`constructor(private x)`),
//      which are not erasable syntax.
//   2. TS2868 - references to the ambient `Bun` global, whose types are
//      excluded from the published build.
// This contract test guards the RPC and interactive-engine source trees so a
// regression fails fast in a focused unit test instead of only in CI.

const SRC_ROOT = join(import.meta.dirname, "..", "..", "..", "src");
const GUARDED_DIRS = [
	join(SRC_ROOT, "modes", "interactive-engine"),
	join(SRC_ROOT, "modes", "rpc"),
];

// Matches a constructor parameter carrying an accessibility/readonly modifier,
// e.g. `constructor(private readonly foo: Bar)` across single or multi-line
// parameter lists.
const PARAM_PROPERTY = /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\b[^)]*\)/s;
// Matches a real `Bun.` global usage (not the substring inside an identifier or
// a comment reference).
const BUN_GLOBAL = /(^|[^\w.$])Bun\.\w/;

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...collectSourceFiles(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
	}
	return out;
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("PR #1842 published build syntax contract", () => {
	const files = GUARDED_DIRS.flatMap(collectSourceFiles);

	test("guards a non-empty set of source files", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		const rel = file.slice(SRC_ROOT.length + 1);

		test(`${rel} has no constructor parameter properties`, () => {
			const code = stripComments(readFileSync(file, "utf8"));
			expect(PARAM_PROPERTY.test(code)).toBe(false);
		});

		test(`${rel} does not reference the ambient Bun global`, () => {
			const code = stripComments(readFileSync(file, "utf8"));
			expect(BUN_GLOBAL.test(code)).toBe(false);
		});
	}
});
