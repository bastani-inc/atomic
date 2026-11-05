import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	type PossibleStagesScanResult,
	scanPossibleStagesFromSource,
} from "../../packages/workflows/src/shared/possible-stages.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const TEST_DIR = makeTempDirectory("possible-stage-uncertainties");
afterAll(() => {
	removeTempDirectory(TEST_DIR);
});

const FIXTURES = join(moduleDir(import.meta.url), "..", "fixtures", "possible-stage-prediction");

function writeFixture(name: string, source: string): string {
	const filePath = join(TEST_DIR, name);
	mkdirSync(dirname(filePath), { recursive: true });
	writeTextSync(filePath, source);
	return filePath;
}

function scanFile(name: string, source: string, options?: { readonly maxDepth?: number }): PossibleStagesScanResult {
	return scanPossibleStagesFromSource(writeFixture(name, source), options);
}

function scanCommitted(name: string): PossibleStagesScanResult {
	return scanPossibleStagesFromSource(join(FIXTURES, name, "workflow.mjs"));
}

describe("committed prediction fixtures", () => {
	test("helper-names offers each call's composed helper name", () => {
		const result = scanCommitted("helper-names");
		assert.deepEqual(result.stages, ["*"]);
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.file, entry.line, entry.boundary]),
			[
				["unresolved-name", "workflow.mjs", 12, ""],
				["unresolved-name", "workflow.mjs", 13, ""],
			],
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			{ stages: ["review"], source: "literal" },
			{ stages: ["review-1"], source: "template" },
		]);
		assert.deepEqual(result.uncertainties[1]!.candidates, [
			{ stages: ["summary"], source: "literal" },
			{ stages: ["summary-2"], source: "template" },
		]);
		assert.ok(result.uncertainties[0]!.excerpt.includes('await ctx.task(stageName("review", 1)'));
		assert.ok(result.uncertainties[1]!.excerpt.includes('await ctx.task(stageName("summary", 2)'));
	});

	test("imported-factory offers each imported factory's step name", () => {
		const result = scanCommitted("imported-factory");
		assert.deepEqual(result.stages, []);
		assert.equal(result.hasTrackedNodes, true);
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.line, entry.candidates]),
			[
				["unresolved-step", 10, [{ stages: ["lint"], source: "factory" }]],
				["unresolved-step", 10, [{ stages: ["typecheck"], source: "factory" }]],
			],
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.placeholder),
			[undefined, undefined],
		);
		assert.ok(result.uncertainties[0]!.excerpt.includes("await ctx.parallel([makeLint(), makeTypecheck()]);"));
	});

	test("data-driven-loop offers the aliased enum array as a group, then each element", () => {
		const result = scanCommitted("data-driven-loop");
		assert.deepEqual(result.stages, ["*"]);
		assert.deepEqual(result.warnings, []);
		assert.equal(result.uncertainties.length, 1);
		const [only] = result.uncertainties;
		assert.equal(only!.code, "unresolved-name");
		assert.equal(only!.line, 12);
		assert.equal(only!.placeholder, "*");
		assert.deepEqual(only!.candidates, [
			{ stages: ["api", "ui", "docs"], source: "enum-array" },
			{ stages: ["api"], source: "enum-array" },
			{ stages: ["ui"], source: "enum-array" },
			{ stages: ["docs"], source: "enum-array" },
		]);
		assert.ok(only!.excerpt.includes("await ctx.task(area, "));
	});

	test("dynamic-children offers each imported child with its own scanned stages", () => {
		const result = scanCommitted("dynamic-children");
		assert.deepEqual(result.stages, ["workflow:*"]);
		assert.equal(result.warnings.length, 2);
		assert.equal(result.uncertainties.length, 1);
		const [only] = result.uncertainties;
		assert.equal(only!.code, "unresolved-child");
		assert.equal(only!.line, 13);
		assert.equal(only!.placeholder, "workflow:*");
		assert.deepEqual(only!.candidates, [
			{ stages: ["workflow:child-alpha", "workflow:child-alpha/alpha-draft"], source: "child-definition" },
			{ stages: ["workflow:child-beta", "workflow:child-beta/beta-draft"], source: "child-definition" },
		]);
		assert.ok(only!.excerpt.includes("await ctx.workflow(children[kind]);"));
	});

	test("a child sub-scan leaves the parent's own stage output unchanged", () => {
		const result = scanCommitted("dynamic-children");
		assert.deepEqual(result.stages, ["workflow:*"]);
		assert.deepEqual(
			result.sources.map((source) => source.file),
			["child-alpha.mjs", "child-beta.mjs", "workflow.mjs"],
		);
	});
});

describe("uncertainty records", () => {
	test("a fully literal workflow has no uncertainties", () => {
		const result = scanFile(
			"literal.ts",
			`
			export default workflow({ name: "literal", run: async (ctx) => {
				await ctx.stage("plan", {});
				await ctx.parallel([{ name: "a" }, { name: "b" }]);
			}});
		`,
		);
		assert.deepEqual(result.stages, ["a", "b", "plan"]);
		assert.deepEqual(result.uncertainties, []);
	});

	test("zero-stages reports name-like literals and the first seven lines", () => {
		const result = scanFile(
			"zero.ts",
			[
				"export default workflow({",
				'\tname: "zero",',
				'\tdescription: "has spaces so it is not name-like",',
				'\ttag: "not/a/name",',
				"\trun: async () => {",
				'\t\treturn "done";',
				"\t},",
				'\tlast: "beyond-excerpt",',
				"});",
			].join("\n"),
		);
		assert.equal(result.hasTrackedNodes, false);
		assert.deepEqual(result.stages, []);
		assert.equal(result.uncertainties.length, 1);
		const [only] = result.uncertainties;
		assert.equal(only!.code, "zero-stages");
		assert.equal(only!.file, "zero.ts");
		assert.equal(only!.line, 1);
		assert.equal(only!.boundary, "");
		assert.equal(only!.excerpt.split("\n").length, 7);
		assert.ok(!only!.excerpt.includes("beyond-excerpt"));
		assert.deepEqual(only!.candidates, [
			{ stages: ["zero"], source: "literal" },
			{ stages: ["done"], source: "literal" },
			{ stages: ["beyond-excerpt"], source: "literal" },
		]);
	});

	test("unreadable-file records a missing entry with no excerpt or candidates", () => {
		const result = scanPossibleStagesFromSource(join(TEST_DIR, "gone", "entry.ts"));
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.file, entry.line, entry.excerpt, entry.candidates]),
			[
				["unreadable-file", "entry.ts", 1, "", []],
				["zero-stages", "entry.ts", 1, "", []],
			],
		);
		assert.deepEqual(result.sources, []);
	});

	test("unresolved-steps offers the name literals of the unit", () => {
		const result = scanFile(
			"steps.ts",
			`
			const known = { name: "alpha" };
			export default workflow({ name: "steps", run: async (ctx) => {
				await ctx.parallel(buildSteps());
				await ctx.chain(opaqueSteps);
				const other = [{ name: "beta" }, { name: "alpha" }, { name: "bad/name" }, { name: "wild*" }];
			}});
		`,
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.line]),
			[
				["unresolved-steps", 4],
				["unresolved-steps", 5],
			],
		);
		for (const entry of result.uncertainties) {
			assert.deepEqual(entry.candidates, [
				{ stages: ["alpha"], source: "literal" },
				{ stages: ["steps"], source: "literal" },
				{ stages: ["beta"], source: "literal" },
			]);
		}
		assert.ok(result.uncertainties[0]!.excerpt.includes("await ctx.parallel(buildSteps());"));
		assert.equal(result.warnings.length, 2);
	});

	test("unresolved-step covers local function factories and unrecognized elements", () => {
		const result = scanFile(
			"steps-local.ts",
			`
			function makeBuild() { return { name: "build", prompt: "x" }; }
			export default workflow({ name: "local", run: async (ctx) => {
				await ctx.parallel([makeBuild(), { prompt: "no name" }, ...extra]);
			}});
		`,
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[
				["unresolved-step", [{ stages: ["build"], source: "factory" }]],
				["unresolved-step", []],
				["unresolved-step", []],
			],
		);
	});

	test("a helper imported by name composes its template from literal arguments", () => {
		writeFixture("helpers.ts", "export const label = (kind: string, n: number) => `$" + "{kind}-$" + "{n}`;\n");
		const result = scanFile(
			"helper-import.ts",
			`
			import { label } from "./helpers.js";
			export default workflow({ name: "h", run: async (ctx) => {
				await ctx.task(label("scan", 3), {});
				await ctx.task(label(dynamic, 3), {});
			}});
		`,
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.candidates),
			[
				[
					{ stages: ["scan"], source: "literal" },
					{ stages: ["scan-3"], source: "template" },
				],
				[],
			],
		);
	});

	test("enum arrays through a named import and an as-const array are expanded", () => {
		writeFixture("kinds.ts", 'export const KINDS = ["x", "y"] as const;\n');
		const result = scanFile(
			"enum-import.ts",
			`
			import { KINDS } from "./kinds.js";
			const OTHER = ["z"];
			export default workflow({ name: "e", run: async (ctx) => {
				for (const kind of KINDS) {
					await ctx.task(kind, {});
				}
				await ctx.task(unknown, {});
			}});
		`,
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			{ stages: ["x", "y"], source: "enum-array" },
			{ stages: ["x"], source: "enum-array" },
			{ stages: ["y"], source: "enum-array" },
		]);
		assert.deepEqual(result.uncertainties[1]!.candidates, [
			{ stages: ["z"], source: "enum-array" },
			{ stages: ["x", "y"], source: "enum-array" },
			{ stages: ["x"], source: "enum-array" },
			{ stages: ["y"], source: "enum-array" },
		]);
	});

	test("a call inside a scanned child records the child boundary", () => {
		writeFixture(
			"boundary-child.ts",
			`export default workflow({ name: "child-a", run: async (ctx) => { await ctx.task(pick("only"), {}); }});\n`,
		);
		const result = scanFile(
			"boundary-parent.ts",
			`
			import child from "./boundary-child.js";
			export default workflow({ name: "p", run: async (ctx) => { await ctx.workflow(child); }});
		`,
		);
		assert.deepEqual(result.stages, ["workflow:child-a", "workflow:child-a/*"]);
		assert.deepEqual(result.uncertainties, [
			{
				code: "unresolved-name",
				file: "boundary-child.ts",
				line: 1,
				excerpt: `export default workflow({ name: "child-a", run: async (ctx) => { await ctx.task(pick("only"), {}); }});`,
				boundary: "workflow:child-a",
				candidates: [{ stages: ["workflow:child-a/only"], source: "literal" }],
				placeholder: "workflow:child-a/*",
			},
		]);
	});

	test("an explicit unresolved stageName is an unresolved-name, with child candidates under it", () => {
		writeFixture(
			"sn-child.ts",
			`export default workflow({ name: "sn", run: async (ctx) => { await ctx.task("inner", {}); }});\n`,
		);
		const result = scanFile(
			"sn-parent.ts",
			`
			import child from "./sn-child.js";
			export default workflow({ name: "p", run: async (ctx) => {
				await ctx.workflow(child, { stageName: dynamicName });
			}});
		`,
		);
		assert.deepEqual(result.stages, ["*", "*/inner"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.placeholder]),
			[["unresolved-name", "*"]],
		);
	});

	test("a child that cannot be resolved under a readable name adds no wildcard", () => {
		const result = scanFile(
			"missing-child-parent.ts",
			`
			import child from "./missing-child.js";
			export default workflow({ name: "p", run: async (ctx) => { await ctx.workflow(child); }});
		`,
		);
		assert.deepEqual(result.stages, ["workflow:child"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.placeholder]),
			[["unresolved-child", undefined]],
		);
	});

	test("an unreadable stageName on an unresolved child marks both call-site records with the wildcard", () => {
		const result = scanFile(
			"unread-child-parent.ts",
			`
			export default workflow({ name: "p", run: async (ctx) => {
				await ctx.workflow(children[kind], { stageName: dynamicName });
			}});
		`,
		);
		assert.deepEqual(result.stages, ["*"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.placeholder]),
			[
				["unresolved-name", "*"],
				["unresolved-child", "*"],
			],
		);
	});

	test("maxDepth limits a child candidate to its boundary", () => {
		writeFixture(
			"md-child.ts",
			`export default workflow({ name: "md", run: async (ctx) => { await ctx.task("deep", {}); }});\n`,
		);
		const source = `
			import child from "./md-child.js";
			export default workflow({ name: "p", run: async (ctx) => { await ctx.workflow(children[pick]); }});
		`;
		assert.deepEqual(scanFile("md-parent-1.ts", source, { maxDepth: 1 }).uncertainties[0]!.candidates, [
			{ stages: ["workflow:md"], source: "child-definition" },
		]);
		assert.deepEqual(scanFile("md-parent-2.ts", source, { maxDepth: 2 }).uncertainties[0]!.candidates, [
			{ stages: ["workflow:md", "workflow:md/deep"], source: "child-definition" },
		]);
	});
});

describe("source digests", () => {
	test("every read file has its sha256, sorted by relative file", () => {
		writeFixture("digest-b.ts", `export const B = ["b"];\n`);
		writeFixture("sub/digest-a.ts", `export const helper = 1;\n`);
		const entry = writeFixture(
			"digest-entry.ts",
			`
			import { B } from "./digest-b.js";
			import { helper } from "./sub/digest-a.js";
			export default workflow({ name: "d", run: async (ctx) => { await ctx.task("one", {}); }});
		`,
		);
		const result = scanPossibleStagesFromSource(entry);
		const expected = ["digest-b.ts", "digest-entry.ts", "sub/digest-a.ts"].map((file) => ({
			file,
			sha256: createHash("sha256")
				.update(readFileSync(join(TEST_DIR, file), "utf8"), "utf8")
				.digest("hex"),
		}));
		assert.deepEqual(result.sources, expected);
	});

	test("a file outside the entry directory keeps a ../ relative form", () => {
		writeFixture("shared/outside.ts", `export const helper = 1;\n`);
		const entry = writeFixture(
			"nested/up-entry.ts",
			`
			import { helper } from "../shared/outside.js";
			export default workflow({ name: "u", run: async (ctx) => { await ctx.task(helper, {}); }});
		`,
		);
		const result = scanPossibleStagesFromSource(entry);
		assert.deepEqual(
			result.sources.map((source) => source.file),
			["../shared/outside.ts", "up-entry.ts"],
		);
		assert.equal(result.uncertainties[0]!.file, "up-entry.ts");
	});
});

describe("candidate invariants", () => {
	test("a candidate containing '/' or '*' is never produced", () => {
		const result = scanFile(
			"invalid-names.ts",
			`
			const BAD = ["ok", "a/b", "w*c", " padded ", ""];
			const OK_ONLY = ["fine"];
			export default workflow({ name: "i", run: async (ctx) => {
				await ctx.task(pick("x/y", "star*", "good"), {});
				for (const item of BAD) await ctx.task(item, {});
				for (const item of OK_ONLY) await ctx.task(item, {});
			}});
		`,
		);
		for (const entry of result.uncertainties) {
			for (const candidate of entry.candidates) {
				for (const stage of candidate.stages) {
					assert.ok(!stage.includes("*"), stage);
					assert.ok(!stage.includes("/"), stage);
					assert.equal(stage, stage.trim());
				}
			}
		}
		assert.deepEqual(result.uncertainties[0]!.candidates, [{ stages: ["good"], source: "literal" }]);
		assert.deepEqual(result.uncertainties[1]!.candidates, [{ stages: ["ok"], source: "enum-array" }]);
		assert.deepEqual(result.uncertainties[2]!.candidates, [{ stages: ["fine"], source: "enum-array" }]);
	});

	test("candidates are capped at 24 per uncertainty", () => {
		const names = Array.from({ length: 40 }, (_, index) => `n${index}`);
		const result = scanFile(
			"cap.ts",
			`
			const MANY = ${JSON.stringify(names)};
			export default workflow({ name: "cap", run: async (ctx) => {
				for (const item of MANY) await ctx.task(item, {});
			}});
		`,
		);
		const [only] = result.uncertainties;
		assert.equal(only!.candidates.length, 24);
		assert.deepEqual(only!.candidates[0]!.stages, names);
		assert.deepEqual(only!.candidates[1]!.stages, ["n0"]);
		assert.deepEqual(only!.candidates[23]!.stages, ["n22"]);
	});

	test("scans are deterministic", () => {
		for (const name of ["helper-names", "imported-factory", "data-driven-loop", "dynamic-children"]) {
			assert.deepEqual(scanCommitted(name), scanCommitted(name), name);
		}
	});

	test("excerpts hold the call line with up to three lines around it and stay bounded", () => {
		const lines = Array.from({ length: 12 }, (_, index) => `// line ${index + 1}`);
		lines[5] = "await ctx.task(dynamicName, {});";
		const result = scanFile("excerpt.ts", `${lines.join("\n")}\n`);
		assert.deepEqual(result.uncertainties[0]!.line, 6);
		assert.equal(
			result.uncertainties[0]!.excerpt,
			[
				"// line 3",
				"// line 4",
				"// line 5",
				"await ctx.task(dynamicName, {});",
				"// line 7",
				"// line 8",
				"// line 9",
			].join("\n"),
		);
		const long = scanFile("excerpt-long.ts", `${"x".repeat(5000)}\nawait ctx.task(dynamicName, {});\n`);
		assert.ok(long.uncertainties[0]!.excerpt.length <= 1200);
	});
});
