// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixture source text contains template-literal holes on purpose
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import {
	type PossibleStageCandidate,
	type PossibleStagesScanResult,
	scanPossibleStagesFromSource,
} from "../../packages/workflows/src/shared/possible-stages.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/** Paths mapped to how many more reads succeed before every later read fails, to simulate a file that vanishes. */
const readBudgets = vi.hoisted(() => new Map<string, number>());
/** Paths whose source read fails while the existence probe still succeeds. */
const unreadableSources = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync(...args: Parameters<typeof fs.readFileSync>) {
			const [path, options] = args;
			if (typeof path === "string" && typeof options === "string" && unreadableSources.has(path)) {
				throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
			}
			const remaining = typeof path === "string" ? readBudgets.get(path) : undefined;
			if (remaining !== undefined) {
				if (remaining <= 0)
					throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
				readBudgets.set(path as string, remaining - 1);
			}
			return fs.readFileSync(...args);
		},
	};
});
afterEach(() => {
	readBudgets.clear();
	unreadableSources.clear();
});

const TEST_DIR = makeTempDirectory("possible-stage-candidates");
afterAll(() => {
	removeTempDirectory(TEST_DIR);
});

let fixtureCounter = 0;

/** Write `source` under a fresh directory so fixtures never see each other's files. */
function writeFixture(name: string, source: string, directory = `case-${fixtureCounter}`): string {
	const filePath = join(TEST_DIR, directory, name);
	mkdirSync(dirname(filePath), { recursive: true });
	writeTextSync(filePath, source);
	return filePath;
}

function scan(source: string, options?: { readonly maxDepth?: number }): PossibleStagesScanResult {
	fixtureCounter += 1;
	return scanPossibleStagesFromSource(writeFixture("entry.ts", source), options);
}

/** Scan an entry written next to sibling modules, all in one fresh directory. */
function scanWith(
	siblings: Readonly<Record<string, string>>,
	source: string,
	options?: { readonly maxDepth?: number },
): PossibleStagesScanResult {
	fixtureCounter += 1;
	for (const [name, text] of Object.entries(siblings)) writeFixture(name, text);
	return scanPossibleStagesFromSource(writeFixture("entry.ts", source), options);
}

function literal(...stages: string[]): PossibleStageCandidate {
	return { stages, source: "literal" };
}

function enumArray(...stages: string[]): PossibleStageCandidate {
	return { stages, source: "enum-array" };
}

function workflowSource(body: string, prelude = ""): string {
	return `${prelude}\nexport default workflow({ name: "w", run: async (ctx) => {\n${body}\n}});\n`;
}

describe("uncertainty call sites", () => {
	test("an optional-chained context call is tracked", () => {
		const result = scan(workflowSource("await ctx?.task(dynamicName, {});"));
		assert.deepEqual(result.stages, ["*"]);
		assert.equal(result.hasTrackedNodes, true);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.line]),
			[["unresolved-name", 3]],
		);
	});

	test("an optional-chained map callback still names its iterated array", () => {
		const result = scan(
			workflowSource(
				"await KINDS?.map(async (kind) => ctx.task(kind, {}));",
				'const KINDS = ["a", "b"];\nconst OTHER = ["c"];',
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [enumArray("a", "b"), enumArray("a"), enumArray("b")]);
	});

	test("an unreadable entry records its boundary and no source digest", () => {
		const result = scanPossibleStagesFromSource(join(TEST_DIR, "never-written", "entry.ts"));
		assert.deepEqual(result.uncertainties[0], {
			code: "unreadable-file",
			file: "entry.ts",
			line: 1,
			excerpt: "",
			boundary: "",
			candidates: [],
		});
		assert.deepEqual(result.sources, []);
		assert.equal(result.warnings.length, 1);
		assert.ok(result.warnings[0]!.startsWith("possible-stages: failed to read"));
	});

	test("source digests are sorted by relative file across many modules", () => {
		const imports = Array.from({ length: 80 }, (_, index) => `import { m${index} } from "./m${index}.js";`);
		const siblings: Record<string, string> = {};
		for (let index = 0; index < 80; index += 1) siblings[`m${index}.ts`] = `export const m${index} = ${index};\n`;
		const result = scanWith(siblings, `${imports.join("\n")}\nawait ctx.task("one", {});\n`);
		const files = result.sources.map((source) => source.file);
		assert.equal(files.length, 81);
		assert.deepEqual(files, [...files].sort());
	});
});

describe("zero-stages candidates", () => {
	test("literals from the entry's local closure are offered", () => {
		const result = scanWith(
			{ "helper.ts": 'export const helper = "from-helper";\n' },
			'import { helper } from "./helper.js";\nexport const mine = "from-entry";\n',
		);
		assert.deepEqual(result.uncertainties.at(-1)!.candidates, [literal("from-entry"), literal("from-helper")]);
	});

	test("a literal is offered up to 128 characters and dropped beyond", () => {
		const fits = "n".repeat(128);
		const tooLong = "n".repeat(129);
		const result = scan(`export const a = "${fits}";\nexport const b = "${tooLong}";\nexport const c = "after";\n`);
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal(fits), literal("after")]);
	});

	test("the excerpt keeps the first seven lines within 1200 characters", () => {
		const line = "x".repeat(300);
		const result = scan(`${Array.from({ length: 9 }, () => line).join("\n")}\n`);
		assert.equal(
			result.uncertainties[0]!.excerpt,
			Array.from({ length: 4 }, () => line)
				.join("\n")
				.slice(0, 1200),
		);
		assert.equal(result.uncertainties[0]!.excerpt.length, 1200);
	});

	test("a name-like literal is a candidate, a path or sentence is not", () => {
		const result = scan('export const items = ["a.b", "c:d", "e-f", "g_h", "-lead", "has space", "x/y", "z*"];\n');
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			literal("a.b"),
			literal("c:d"),
			literal("e-f"),
			literal("g_h"),
		]);
	});
});

describe("excerpts", () => {
	test("an overlong window falls back to the call line and the three lines after it", () => {
		const callLine = `await ctx.task(dynamicName, {}); // ${"y".repeat(3000)}`;
		const result = scan(`${"x".repeat(2000)}\n${callLine}\n// after\n`);
		const [only] = result.uncertainties;
		assert.equal(only!.line, 2);
		assert.equal(only!.excerpt, callLine.slice(0, 1200));
	});

	test("a window at the very start of the file begins on line one", () => {
		const result = scan("await ctx.task(dynamicName, {});\n// second\n// third\n// fourth\n// fifth\n");
		assert.equal(
			result.uncertainties[0]!.excerpt,
			"await ctx.task(dynamicName, {});\n// second\n// third\n// fourth",
		);
	});
});

describe("name candidates from a call expression", () => {
	const HELPER = "const label = (kind, n) => `${kind}-${n}`;";

	test("a helper call spanning the whole argument composes its template", () => {
		const result = scan(workflowSource('await ctx.task(label("scan", 3), {});', HELPER));
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			literal("scan"),
			{ stages: ["scan-3"], source: "template" },
		]);
	});

	test("a helper call followed by more tokens is not composed", () => {
		const result = scan(workflowSource('await ctx.task(label("scan", 3) + "-x", {});', HELPER));
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("scan"), literal("-x")]);
	});

	test("a member access on the helper name is not a helper call", () => {
		const result = scan(workflowSource('await ctx.task(label.suffix("scan", 3), {});', HELPER));
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("scan")]);
	});

	test("a template argument with a hole offers no enum array candidates", () => {
		const result = scan(workflowSource("await ctx.task(`${dynamicName}`, {});", 'const KINDS = ["a", "b"];'));
		assert.deepEqual(result.stages, ["*"]);
		assert.deepEqual(result.uncertainties[0]!.candidates, []);
	});

	test("an unnamed factory step has no candidates", () => {
		const result = scan(
			workflowSource(
				"await ctx.parallel([makeStep()]);",
				'const makeStep = () => ({ prompt: "x" });\nconst KINDS = ["a", "b"];',
			),
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[["unresolved-name", []]],
		);
		assert.deepEqual(result.stages, ["*"]);
	});

	test("a helper with a block body returns its literal", () => {
		const result = scan(
			workflowSource(
				'await ctx.task(pick("only"), {});',
				"function pick(a) { if (a) { return `x-${a}`; } return `fallback`; }",
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			literal("only"),
			{ stages: ["x-only"], source: "template" },
		]);
	});
});

describe("template helper composition", () => {
	function candidatesFor(helper: string, callArguments: string): readonly PossibleStageCandidate[] {
		const result = scan(workflowSource(`await ctx.task(label(${callArguments}), {});`, helper));
		return result.uncertainties[0]!.candidates;
	}

	test("a helper returning a plain string offers that string", () => {
		assert.deepEqual(candidatesFor('const label = (kind) => "fixed";', "dynamic"), [
			{ stages: ["fixed"], source: "template" },
		]);
	});

	test("a number argument fills a hole", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${n}`;", "42"), [
			{ stages: ["step-42"], source: "template" },
		]);
	});

	test("a string argument fills a hole and the other arguments are ignored", () => {
		assert.deepEqual(candidatesFor("const label = (a, b) => `${b}-${a}`;", '"x", "y"'), [
			literal("x"),
			literal("y"),
			{ stages: ["y-x"], source: "template" },
		]);
	});

	test("a hole with a non-literal argument composes nothing", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${n}`;", "someVar"), []);
	});

	test("a hole whose argument is missing composes nothing", () => {
		assert.deepEqual(candidatesFor("const label = (a, b) => `${a}-${b}`;", '"only"'), [literal("only")]);
	});

	test("an identifier argument that is not purely digits composes nothing", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${n}`;", "7x"), []);
		assert.deepEqual(candidatesFor("const label = (n) => `step-${n}`;", "x7"), []);
	});

	test("a multi-token argument composes nothing", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${n}`;", "1 + 2"), []);
	});

	test("a hole that is not a parameter composes nothing", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${other}`;", "1"), []);
	});

	test("a hole expression is matched to its parameter after trimming", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${ n }`;", "5"), [
			{ stages: ["step-5"], source: "template" },
		]);
	});

	test("a nested brace inside a hole is skipped to the matching close", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `a-${n}-${{}.x}`;", "5"), []);
		assert.deepEqual(candidatesFor("const label = (n, m) => `${m}-${n}-end`;", '1, "2"'), [
			literal("2"),
			{ stages: ["2-1-end"], source: "template" },
		]);
	});

	test("escaped backtick and backslash in static text are unescaped before a hole", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `a\\`${n}\\\\z`;", "1"), [
			{ stages: ["a`1\\z"], source: "template" },
		]);
	});

	test("other escapes in static text are kept as written", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `a\\nb-${n}`;", "1"), [
			{ stages: ["a\\nb-1"], source: "template" },
		]);
	});

	test("an escaped hole is static text, so it never takes an argument", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `a-\\${n}`;", '"x"'), [
			literal("x"),
			{ stages: ["a-${n}"], source: "template" },
		]);
	});

	test("an escaped hole that never closes is static text and the scan ends", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `cost-\\${nn`;", '"x"'), [
			literal("x"),
			{ stages: ["cost-${nn"], source: "template" },
		]);
	});

	test("a hole that never closes composes nothing and the scan ends", () => {
		const result = scan(`${workflowSource('await ctx.task(label("x"), {});')}const label = (n) => \`a-\${nn\n`);
		assert.deepEqual(result.uncertainties[0]?.candidates, [literal("x")]);
	});

	test("an escaped backslash before a hole leaves the hole open", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `a\\\\${n}`;", '"x"'), [
			literal("x"),
			{ stages: ["a\\x"], source: "template" },
		]);
	});

	test("trailing static text after the last hole is kept", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `${n}-tail\\`s`;", "3"), [
			{ stages: ["3-tail`s"], source: "template" },
		]);
	});
});

describe("enum array selection", () => {
	const ARRAYS = 'const KINDS = ["a1", "a2"];\nconst OTHER = ["b1"];';
	const ONLY_KINDS = [enumArray("a1", "a2"), enumArray("a1"), enumArray("a2")];
	const ALL_ARRAYS = [enumArray("a1", "a2"), enumArray("a1"), enumArray("a2"), enumArray("b1")];

	function candidatesIn(body: string, prelude = ARRAYS): readonly PossibleStageCandidate[] {
		const result = scan(workflowSource(body, prelude));
		assert.equal(result.uncertainties.length, 1, JSON.stringify(result.uncertainties));
		return result.uncertainties[0]!.candidates;
	}

	test("a bare identifier with no iteration source ranges over every array", () => {
		assert.deepEqual(candidatesIn("await ctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("a script with no enum arrays offers no array candidates", () => {
		assert.deepEqual(candidatesIn("await ctx.task(kind, {});", "const x = 1;"), []);
	});

	test("a single-element array is offered once", () => {
		assert.deepEqual(candidatesIn("await ctx.task(kind, {});", 'const SOLO = ["only"];'), [enumArray("only")]);
	});

	test("a for-of loop over an array narrows to that array", () => {
		assert.deepEqual(candidatesIn("for (const kind of KINDS) await ctx.task(kind, {});"), ONLY_KINDS);
	});

	test("a for-of loop with let, var or no declaration narrows the same way", () => {
		assert.deepEqual(candidatesIn("for (let kind of KINDS) await ctx.task(kind, {});"), ONLY_KINDS);
		assert.deepEqual(candidatesIn("for (var kind of KINDS) await ctx.task(kind, {});"), ONLY_KINDS);
		assert.deepEqual(candidatesIn("let kind;\nfor (kind of KINDS) await ctx.task(kind, {});"), ONLY_KINDS);
	});

	test("a for-of loop nested under another statement still narrows", () => {
		assert.deepEqual(candidatesIn("if (enabled) for (const kind of KINDS) await ctx.task(kind, {});"), ONLY_KINDS);
	});

	test("a loop variable that shadows another array name narrows to the iterated array", () => {
		assert.deepEqual(candidatesIn("for (const OTHER of KINDS) await ctx.task(OTHER, {});"), ONLY_KINDS);
	});

	test("a for-of loop over something else does not narrow", () => {
		assert.deepEqual(candidatesIn("for (const other of OTHER) await ctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("a for-of loop that has not started before the call does not narrow", () => {
		assert.deepEqual(candidatesIn("await ctx.task(kind, {});\nfor (const kind of KINDS) {}"), ALL_ARRAYS);
	});

	test("a for await loop does not narrow", () => {
		assert.deepEqual(candidatesIn("for await (const kind of KINDS) await ctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("a for-of loop whose parentheses never close does not narrow", () => {
		assert.deepEqual(candidatesIn("for (const kind of (KINDS await ctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("a map callback narrows to its receiver", () => {
		assert.deepEqual(candidatesIn("await Promise.all(KINDS.map((kind) => ctx.task(kind, {})));"), ONLY_KINDS);
	});

	test("an async map callback narrows to its receiver", () => {
		assert.deepEqual(candidatesIn("await Promise.all(KINDS.map(async (kind) => ctx.task(kind, {})));"), ONLY_KINDS);
	});

	test("a forEach callback with a bare parameter narrows to its receiver", () => {
		assert.deepEqual(candidatesIn("KINDS.forEach((kind) => ctx.task(kind, {}));"), ONLY_KINDS);
		assert.deepEqual(candidatesIn("KINDS.forEach(kind => ctx.task(kind, {}));"), ONLY_KINDS);
		assert.deepEqual(candidatesIn("KINDS.forEach(async kind => ctx.task(kind, {}));"), ONLY_KINDS);
	});

	test("a callback for a different method does not narrow", () => {
		assert.deepEqual(candidatesIn("KINDS.filter((kind) => ctx.task(kind, {}));"), ALL_ARRAYS);
	});

	test("a callback whose first parameter is another name does not narrow", () => {
		assert.deepEqual(candidatesIn("KINDS.map((other, kind) => ctx.task(kind, {}));"), ALL_ARRAYS);
		assert.deepEqual(candidatesIn("KINDS.map(other => ctx.task(kind, {}));"), ALL_ARRAYS);
		assert.deepEqual(candidatesIn("KINDS.map(kind + 1);\nctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("a bare map function that is not a method does not narrow", () => {
		assert.deepEqual(candidatesIn("lookup(OTHER, map((kind) => ctx.task(kind, {})));"), ALL_ARRAYS);
	});

	test("a map property read that is not called does not narrow", () => {
		assert.deepEqual(candidatesIn("const fn = KINDS.map;\nctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("an inner callback over another array does not take over the loop variable's source", () => {
		const result = scan(
			workflowSource(
				'AREAS.map(async (area) => { const skipped = SKIP.some((area) => area === "x"); return ctx.task(area, {}); });',
				'const AREAS = ["api", "ui"];\nconst SKIP = ["legacy"];',
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			enumArray("api", "ui"),
			enumArray("api"),
			enumArray("ui"),
		]);
	});

	test("a string spelling a dot before a bare map call is not a method access", () => {
		assert.deepEqual(candidatesIn('KINDS\n"."\nmap((kind) => ctx.task(kind, {}));'), ALL_ARRAYS);
	});

	test("a string after a dot is not a method name", () => {
		assert.deepEqual(candidatesIn('KINDS."map"((kind) => ctx.task(kind, {}));'), ALL_ARRAYS);
	});

	test("a map property read followed by an arrow function does not narrow", () => {
		assert.deepEqual(candidatesIn("const fn = KINDS.map; kind => ctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("the nearest preceding iteration wins", () => {
		assert.deepEqual(
			candidatesIn("for (const kind of OTHER) {}\nfor (const kind of KINDS) await ctx.task(kind, {});\n"),
			ONLY_KINDS,
		);
	});

	test("a map at the very start of the file narrows to its receiver", () => {
		const source = `KINDS.map((kind) => ctx.task(kind, {}));\n${ARRAYS}\n`;
		const result = scan(source);
		assert.deepEqual(result.uncertainties[0]!.candidates, ONLY_KINDS);
	});

	test("a loop source that aliases an array through a local narrows to that array", () => {
		assert.deepEqual(
			candidatesIn("const items = KINDS;\nfor (const kind of items) await ctx.task(kind, {});"),
			ONLY_KINDS,
		);
	});

	test("an alias is followed through a call that is not itself an array", () => {
		assert.deepEqual(
			candidatesIn("const items = pick(KINDS);\nfor (const kind of items.slice(1)) await ctx.task(kind, {});"),
			ONLY_KINDS,
		);
	});

	test("an iteration source with no array and no alias ranges over every array", () => {
		assert.deepEqual(candidatesIn("for (const kind of unknown) await ctx.task(kind, {});"), ALL_ARRAYS);
	});

	test("a string in the loop source that names a local is not an alias", () => {
		assert.deepEqual(
			candidatesIn('const named = KINDS;\nfor (const kind of lookup("named")) await ctx.task(kind, {});'),
			ALL_ARRAYS,
		);
	});

	test("a string in the loop source that names an array is not a mention", () => {
		assert.deepEqual(candidatesIn('for (const kind of lookup("KINDS")) await ctx.task(kind, {});'), ALL_ARRAYS);
	});

	test("an iterated expression naming two arrays offers both", () => {
		assert.deepEqual(candidatesIn("for (const kind of [...KINDS, ...OTHER]) await ctx.task(kind, {});"), [
			enumArray("a1", "a2"),
			enumArray("a1"),
			enumArray("a2"),
			enumArray("b1"),
		]);
	});

	test("an iterated expression naming the same array twice offers it once", () => {
		assert.deepEqual(candidatesIn("for (const kind of [...KINDS, ...KINDS]) await ctx.task(kind, {});"), ONLY_KINDS);
	});

	test("a plain object element name resolves through the same selection", () => {
		const result = scan(workflowSource("KINDS.map((kind) => ctx.parallel([{ name: kind }]));", ARRAYS));
		assert.equal(result.uncertainties.length, 1);
		assert.equal(result.uncertainties[0]!.code, "unresolved-name");
		assert.deepEqual(result.uncertainties[0]!.candidates, ONLY_KINDS);
	});
});

describe("map receivers", () => {
	const B_FIRST = 'const KINDS = ["a1", "a2"];\nconst OTHER = ["b1"];';

	function candidatesAfter(before: string): readonly PossibleStageCandidate[] {
		const result = scan(workflowSource(`${before}\nKINDS.map((kind) => ctx.task(kind, {}));`, B_FIRST));
		return result.uncertainties[0]!.candidates;
	}

	const ONLY_KINDS = [enumArray("a1", "a2"), enumArray("a1"), enumArray("a2")];

	for (const separator of [";", ",", "=", "=>", ":"]) {
		test(`a receiver stops at '${separator}'`, () => {
			assert.deepEqual(candidatesAfter(`OTHER ${separator}`), ONLY_KINDS);
		});
	}

	for (const keyword of ["return", "await", "of", "in", "const", "let", "var", "yield", "typeof"]) {
		test(`a receiver stops at the keyword '${keyword}'`, () => {
			assert.deepEqual(candidatesAfter(`OTHER ${keyword}`), ONLY_KINDS);
		});
	}

	test("a keyword inside a bracketed receiver argument does not end the receiver", () => {
		const result = scan(
			workflowSource(
				"OTHER;\nKINDS.filter((item) => typeof item === 'string').map((kind) => ctx.task(kind, {}));",
				B_FIRST,
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, ONLY_KINDS);
	});

	test("a string that spells a keyword does not end the receiver", () => {
		const result = scan(workflowSource('OTHER + "in" + KINDS.map((kind) => ctx.task(kind, {}));', B_FIRST));
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			enumArray("b1"),
			enumArray("a1", "a2"),
			enumArray("a1"),
			enumArray("a2"),
		]);
	});

	test("a receiver stops at an enclosing open bracket", () => {
		assert.deepEqual(candidatesAfter("OTHER, [").slice(0, 3), ONLY_KINDS);
		assert.deepEqual(candidatesAfter("wrap(OTHER, ").slice(0, 3), ONLY_KINDS);
	});

	test("a receiver keeps a bracketed call chain and its arguments", () => {
		const result = scan(
			workflowSource(
				"OTHER;\nKINDS.filter((item) => keep(item, [1, 2])).map((kind) => ctx.task(kind, {}));",
				B_FIRST,
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, ONLY_KINDS);
	});

	test("a receiver holds bracketed arguments naming another array", () => {
		const result = scan(
			workflowSource("KINDS.concat(wrap({ extra: [OTHER] })).map((kind) => ctx.task(kind, {}));", B_FIRST),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [
			enumArray("a1", "a2"),
			enumArray("a1"),
			enumArray("a2"),
			enumArray("b1"),
		]);
	});
});

describe("template helper recognition", () => {
	function candidatesFor(helper: string, callArguments = '"x"'): readonly PossibleStageCandidate[] {
		const result = scan(workflowSource(`await ctx.task(label(${callArguments}), {});`, helper));
		return result.uncertainties[0]!.candidates;
	}
	const composed = (stage: string): PossibleStageCandidate => ({ stages: [stage], source: "template" });

	test("a function declaration with a return type annotation is a helper", () => {
		assert.deepEqual(
			candidatesFor("function label(kind: string, n: number): string { return `${kind}-${n}`; }", '"a", 2'),
			[literal("a"), composed("a-2")],
		);
	});

	test("a function declaration without a body is not a helper", () => {
		assert.deepEqual(candidatesFor("declare function label(kind: string): string;", '"a"'), [literal("a")]);
	});

	test("a function returning a string literal without a semicolon is a helper", () => {
		assert.deepEqual(candidatesFor('function label() { return "fixed" }', "dynamic"), [composed("fixed")]);
	});

	test("a function returning a template literal is a helper", () => {
		assert.deepEqual(candidatesFor("function label(n) { return `n-${n};`; }", "1"), [composed("n-1;")]);
	});

	test("a function returning an expression is not a helper", () => {
		assert.deepEqual(candidatesFor('function label() { return "fixed" + suffix; }', "dynamic"), []);
	});

	test("a function returning an identifier is not a helper", () => {
		assert.deepEqual(candidatesFor("function label(a) { return result; }"), [literal("x")]);
	});

	test("a function keyword followed by a string is not a declaration", () => {
		assert.deepEqual(candidatesFor('function "label"() { return "fixed"; }'), [literal("x")]);
	});

	test("a generic function declaration is not a helper", () => {
		assert.deepEqual(candidatesFor('function label<T>(kind) { return "fixed"; }'), [literal("x")]);
	});

	test("a function keyword at the end of the file is not a declaration", () => {
		const result = scan("await ctx.task(label(dynamic), {});\nfunction");
		assert.deepEqual(result.uncertainties[0]!.candidates, []);
	});

	test("a body after a destructured last parameter is found", () => {
		const result = scan('await ctx.task(label(dynamic), {});\nfunction label({ kind }) { return "fixed"; }');
		assert.deepEqual(result.uncertainties[0]!.candidates, [composed("fixed")]);
	});

	test("a returned literal is taken from the return statement, not from earlier literals", () => {
		assert.deepEqual(
			candidatesFor('function label(kind, round) { const sep = "x"; return `${kind}-${round}`; }', '"audit", 3'),
			[literal("audit"), composed("audit-3")],
		);
	});

	test("a block body ending in a bare return is not a helper", () => {
		const result = scan('await ctx.task(label("a"), {});\nconst label = (n) => { return');
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("a")]);
	});

	test("a bodiless declaration at the end of the file is not a helper", () => {
		const result = scan('await ctx.task(label("a"), {});\ndeclare function label(kind: string): string;\n');
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("a")]);
	});

	test("a function expression is not a helper", () => {
		assert.deepEqual(candidatesFor("const label = function (kind) { return `${kind}`; };"), [literal("x")]);
	});

	test("an arrow with an identifier body is not a helper", () => {
		assert.deepEqual(candidatesFor("const label = (a) => result;"), [literal("x")]);
	});

	test("an arrow whose literal is followed by a call is not a helper", () => {
		assert.deepEqual(candidatesFor("const label = (n) => `step-${n}`.toUpperCase();", "1"), []);
	});

	test("an arrow with a block body is a helper", () => {
		assert.deepEqual(candidatesFor("const label = (n) => { return `step-${n}`; };", "1"), [composed("step-1")]);
	});

	test("an async arrow is a helper", () => {
		assert.deepEqual(candidatesFor("const label = async (n) => `step-${n}`;", "1"), [composed("step-1")]);
	});

	test("an arrow with a bare parameter is a helper", () => {
		assert.deepEqual(candidatesFor("const label = n => `step-${n}`;", "1"), [composed("step-1")]);
		assert.deepEqual(candidatesFor("const label = async n => `step-${n}`;", "1"), [composed("step-1")]);
	});

	test("a value that is not an arrow is not a helper", () => {
		assert.deepEqual(candidatesFor('const label = ["x"];'), [literal("x")]);
		assert.deepEqual(candidatesFor("const label = (n);", "1"), []);
	});

	test("an arrow whose only parameter is named async is not a helper", () => {
		assert.deepEqual(candidatesFor('const label = async => "fixed";'), [literal("x")]);
	});

	test("a parenthesised value followed by a literal is not an arrow", () => {
		assert.deepEqual(candidatesFor('const label = (n) + "fixed";'), [literal("x")]);
	});

	test("a destructured first parameter keeps its position, so later parameters take their own arguments", () => {
		assert.deepEqual(candidatesFor("const label = ({ a }, n) => `n-${n}`;", '"m", 5'), [
			literal("m"),
			composed("n-5"),
		]);
		assert.deepEqual(candidatesFor("const label = (n, ...rest) => `n-${n}`;", '"m", 5'), [
			literal("m"),
			composed("n-m"),
		]);
	});

	test("consecutive helper declarations are all recognised", () => {
		assert.deepEqual(candidatesFor("const first = (n) => `f-${n}`;const label = (n) => `second-${n}`;", "1"), [
			composed("second-1"),
		]);
	});

	test("parameters are found past generics, destructuring and string defaults", () => {
		assert.deepEqual(candidatesFor("const label = (map: Map<string, number>, n) => `n-${n}`;", '"m", 5'), [
			literal("m"),
			composed("n-5"),
		]);
		assert.deepEqual(candidatesFor("const label = (opts: { a: string, b: number }, n) => `n-${n}`;", '"m", 5'), [
			literal("m"),
			composed("n-5"),
		]);
		assert.deepEqual(candidatesFor('const label = (kind = "(", n) => `n-${n}`;', '"m", 5'), [
			literal("m"),
			composed("n-5"),
		]);
		assert.deepEqual(candidatesFor("const label = (kind: string, n: number) => `${n}`;", '"m", 5'), [
			literal("m"),
			composed("5"),
		]);
	});
});

describe("enum array recognition", () => {
	function candidatesWith(prelude: string, loop: string): readonly PossibleStageCandidate[] {
		const result = scan(workflowSource(`for (const kind of ${loop}) await ctx.task(kind, {});`, prelude));
		return result.uncertainties[0]!.candidates;
	}
	const KINDS = 'const KINDS = ["k1", "k2"];';

	test("an array of string literals is recognised with or without as const", () => {
		assert.deepEqual(candidatesWith('const LIST = ["x", "y"];', "LIST"), [
			enumArray("x", "y"),
			enumArray("x"),
			enumArray("y"),
		]);
		assert.deepEqual(candidatesWith('const LIST = ["x", "y"] as const;', "LIST"), [
			enumArray("x", "y"),
			enumArray("x"),
			enumArray("y"),
		]);
	});

	test("an array with a different suffix is not an enum array", () => {
		assert.deepEqual(candidatesWith(`${KINDS}\nconst LIST = ["x", "y"].map(trim);`, "LIST"), [
			enumArray("k1", "k2"),
			enumArray("k1"),
			enumArray("k2"),
		]);
		assert.deepEqual(candidatesWith(`${KINDS}\nconst LIST = ["x", "y"] as Names;`, "LIST"), [
			enumArray("k1", "k2"),
			enumArray("k1"),
			enumArray("k2"),
		]);
	});

	test("an array followed by as const and further tokens is not an enum array", () => {
		assert.deepEqual(candidatesWith(`${KINDS}\nconst LIST = ["x", "y"] as const satisfies Names;`, "LIST"), [
			enumArray("k1", "k2"),
			enumArray("k1"),
			enumArray("k2"),
		]);
	});

	test("an array followed by a member named const is not an enum array", () => {
		assert.deepEqual(candidatesWith(`${KINDS}\nconst LIST = ["x", "y"].const;`, "LIST"), [
			enumArray("k1", "k2"),
			enumArray("k1"),
			enumArray("k2"),
		]);
	});

	test("an empty array is not an enum array", () => {
		assert.deepEqual(candidatesWith(`${KINDS}\nconst EMPTY = [];`, "EMPTY"), [
			enumArray("k1", "k2"),
			enumArray("k1"),
			enumArray("k2"),
		]);
	});

	test("an array with a non-literal element is not an enum array", () => {
		assert.deepEqual(candidatesWith('const LIST = ["x", dynamic];', "LIST"), []);
		assert.deepEqual(candidatesWith('const LIST = ["x", "y" + suffix];', "LIST"), []);
		assert.deepEqual(candidatesWith("const LIST = [1, 2];", "LIST"), []);
	});

	test("an unterminated array at the end of the file is not an enum array", () => {
		const result = scan('await ctx.task(kind, {});\nconst LIST = ["a", "b"');
		assert.deepEqual(result.uncertainties[0]!.candidates, []);
	});

	test("a value that merely contains an array is not an enum array", () => {
		assert.deepEqual(candidatesWith('const LIST = wrap(["x", "y"]);', "LIST"), []);
	});

	test("two consecutive array declarations are both recognised", () => {
		assert.deepEqual(candidatesWith('const FIRST = ["f"];const SECOND = ["s"];', "SECOND"), [enumArray("s")]);
	});

	test("an array imported by name is offered under its local name", () => {
		const result = scanWith(
			{ "kinds.ts": 'export const ORIGINAL = ["i1", "i2"];\nexport const unused = ["u"];\n' },
			'import { ORIGINAL as LOCAL, missing } from "./kinds.js";\nfor (const kind of LOCAL) await ctx.task(kind, {});\n',
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [enumArray("i1", "i2"), enumArray("i1"), enumArray("i2")]);
	});

	test("local arrays are offered before imported arrays", () => {
		const result = scanWith(
			{ "kinds.ts": 'export const KINDS = ["imported"];\n' },
			'import { KINDS } from "./kinds.js";\nconst KINDS_LOCAL = ["local"];\nawait ctx.task(kind, {});\n',
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [enumArray("local"), enumArray("imported")]);
	});

	test("an import from a non-relative module contributes no array", () => {
		const result = scan('import { KINDS } from "some-package";\nawait ctx.task(kind, {});\n');
		assert.deepEqual(result.uncertainties[0]!.candidates, []);
	});
});

function child(name: string, body = ""): string {
	return `export default workflow({ name: ${JSON.stringify(name)}, run: async (ctx) => {\n${body}\n}});\n`;
}

const CHILD_IMPORTS = 'import alpha from "./alpha.js";\nimport beta from "./beta.js";\n';

function parentCalling(call: string, imports = CHILD_IMPORTS): string {
	return `${imports}export default workflow({ name: "p", run: async (ctx) => {\n${call}\n}});\n`;
}

function childCandidatesOf(result: PossibleStagesScanResult): readonly PossibleStageCandidate[] {
	const entry = result.uncertainties.find((uncertainty) => uncertainty.code === "unresolved-child");
	assert.ok(entry, JSON.stringify(result.uncertainties));
	return entry.candidates;
}

describe("child definition candidates", () => {
	test("each imported child is offered with its own sorted stages", () => {
		const result = scanWith(
			{
				"alpha.ts": child("Alpha Child", 'await ctx.task("zeta", {});\nawait ctx.task("beta", {});'),
				"beta.ts": child("beta", 'await ctx.task("only", {});'),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result), [
			{
				stages: ["workflow:alpha-child", "workflow:alpha-child/beta", "workflow:alpha-child/zeta"],
				source: "child-definition",
			},
			{ stages: ["workflow:beta", "workflow:beta/only"], source: "child-definition" },
		]);
	});

	test("a helper module without a workflow definition is not a child", () => {
		const result = scanWith(
			{
				"alpha.ts": 'export default { name: "not-a-workflow" };\n',
				"beta.ts": child("beta"),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:beta"], source: "child-definition" }]);
	});

	test("a child whose name is not statically visible is not offered", () => {
		const result = scanWith(
			{
				"alpha.ts": "export default workflow({ name: computedName, run: async (ctx) => {} });\n",
				"beta.ts": child("beta"),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:beta"], source: "child-definition" }]);
	});

	test("the importing module is never offered as its own child", () => {
		const result = scanWith(
			{ "beta.ts": child("beta") },
			parentCalling(
				"await ctx.workflow(children[pick]);",
				`${CHILD_IMPORTS.replace('import alpha from "./alpha.js";\n', 'import self from "./entry.js";\n')}`,
			),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:beta"], source: "child-definition" }]);
	});

	test("two bindings to one module offer it once", () => {
		const result = scanWith(
			{ "alpha.ts": child("alpha") },
			parentCalling(
				"await ctx.workflow(children[pick]);",
				'import alpha from "./alpha.js";\nimport { other } from "./alpha.js";\n',
			),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:alpha"], source: "child-definition" }]);
	});

	test("a child whose normalized name is empty is not offered", () => {
		const result = scanWith(
			{ "alpha.ts": child("!!!"), "beta.ts": child("beta") },
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:beta"], source: "child-definition" }]);
	});

	test("a child boundary is offered up to 128 characters and dropped beyond", () => {
		const fits = "n".repeat(128 - "workflow:".length);
		const result = scanWith(
			{ "alpha.ts": child(fits), "beta.ts": child(`${fits}n`) },
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: [`workflow:${fits}`], source: "child-definition" }]);
	});

	test("nested stages are offered only when every segment is a plain name", () => {
		const result = scanWith(
			{
				"alpha.ts": child(
					"alpha",
					[
						'await ctx.task("two words", {});',
						'await ctx.task("", {});',
						"await ctx.task(dynamic, {});",
						"await ctx.task(`wild-${dynamic}`, {});",
						'await ctx.task("fine", {});',
					].join("\n"),
				),
				"beta.ts": child("beta"),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result)[0], {
			stages: ["workflow:alpha", "workflow:alpha/fine", "workflow:alpha/two words"],
			source: "child-definition",
		});
	});

	test("a grandchild's stage path is offered under both boundaries", () => {
		const result = scanWith(
			{
				"alpha.ts": `import grand from "./grand.js";\n${child("alpha", "await ctx.workflow(grand);")}`,
				"grand.ts": child("grand", 'await ctx.task("leaf", {});'),
				"beta.ts": child("beta"),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result)[0], {
			stages: ["workflow:alpha", "workflow:alpha/workflow:grand", "workflow:alpha/workflow:grand/leaf"],
			source: "child-definition",
		});
	});

	test("a grandchild with an unresolved name is left out of the offered stages", () => {
		const result = scanWith(
			{
				"alpha.ts": `import grand from "./grand.js";\n${child("alpha", "await ctx.workflow(grand, { stageName: dynamicName });")}`,
				"grand.ts": child("grand", 'await ctx.task("leaf", {});'),
				"beta.ts": child("beta"),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(childCandidatesOf(result)[0], { stages: ["workflow:alpha"], source: "child-definition" });
	});

	test("an import cycle back to the parent stops at the cycle", () => {
		const result = scanWith(
			{
				"alpha.ts": `import parent from "./entry.js";\n${child("alpha", "await ctx.workflow(parent);")}`,
				"beta.ts": child("beta"),
			},
			parentCalling('await ctx.task("entry-task", {});\nawait ctx.workflow(children[pick]);'),
		);
		assert.deepEqual(childCandidatesOf(result)[0], {
			stages: ["workflow:alpha", "workflow:alpha/workflow:p"],
			source: "child-definition",
		});
	});

	test("a child whose name is not visible is not offered even under an explicit stageName", () => {
		const result = scanWith(
			{
				"alpha.ts": "export default workflow({ name: computedName, run: async (ctx) => {} });\n",
				"beta.ts": child("beta"),
			},
			parentCalling('await ctx.workflow(children[pick], { stageName: "fixed" });'),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["fixed"], source: "child-definition" }]);
	});

	test("a child is not descended into at the depth limit", () => {
		const siblings = {
			"alpha.ts": child("alpha", 'await ctx.task("inner", {});'),
			"beta.ts": child("beta"),
		};
		const atLimit = scanWith(siblings, parentCalling("await ctx.workflow(children[pick]);"), { maxDepth: 1 });
		assert.deepEqual(childCandidatesOf(atLimit)[0], { stages: ["workflow:alpha"], source: "child-definition" });
		const below = scanWith(siblings, parentCalling("await ctx.workflow(children[pick]);"), { maxDepth: 2 });
		assert.deepEqual(childCandidatesOf(below)[0], {
			stages: ["workflow:alpha", "workflow:alpha/inner"],
			source: "child-definition",
		});
	});

	test("scanning a candidate child leaves the parent's warnings and uncertainties untouched", () => {
		const result = scanWith(
			{
				"alpha.ts": child("alpha", "await ctx.parallel(buildSteps());\nawait ctx.task(dynamic, {});"),
				"beta.ts": child("beta"),
			},
			parentCalling("await ctx.workflow(children[pick]);"),
		);
		assert.deepEqual(result.stages, ["workflow:*"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.code),
			["unresolved-child"],
		);
		assert.equal(result.warnings.length, 2);
		assert.ok(
			result.warnings.every(
				(warning) => warning.includes("child definition name") || warning.includes("could not be resolved"),
			),
		);
		assert.equal(result.hasTrackedNodes, true);
	});
});

describe("a child file that cannot be read during candidate discovery", () => {
	test("its read failure still reaches the real warnings and uncertainties", () => {
		fixtureCounter += 1;
		const alpha = `import grand from "./grand.js";\n${child("alpha", "await ctx.parallel(buildSteps());")}`;
		writeFixture("alpha.ts", alpha);
		writeFixture("grand.ts", child("grand"));
		const entry = writeFixture(
			"entry.ts",
			parentCalling("await ctx.workflow(children[pick]);", 'import alpha from "./alpha.js";\n'),
		);
		// The path probe reads grand.ts once; reading it for real then fails.
		readBudgets.set(join(dirname(entry), "grand.ts"), 1);
		const result = scanPossibleStagesFromSource(entry);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.file, entry.line]),
			[
				["unreadable-file", "grand.ts", 1],
				["unresolved-child", "entry.ts", 3],
			],
		);
		assert.equal(result.warnings.length, 3);
		assert.deepEqual(
			result.warnings.map(
				(warning) =>
					/^possible-stages: (child definition name|failed to read|ctx\.workflow child)/.exec(warning)?.[1],
			),
			["child definition name", "failed to read", "ctx.workflow child"],
		);
		assert.ok(result.warnings[1]!.includes("grand.ts"));
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:alpha"], source: "child-definition" }]);
	});
});

describe("ctx.workflow uncertainty", () => {
	test("a resolved child with a static name is certain", () => {
		const result = scanWith({ "alpha.ts": child("alpha") }, parentCalling("await ctx.workflow(alpha);"));
		assert.deepEqual(result.stages, ["workflow:alpha"]);
		assert.deepEqual(result.uncertainties, []);
		assert.deepEqual(result.warnings, []);
	});

	test("a resolved child with an explicit literal stageName is certain", () => {
		const result = scanWith(
			{ "alpha.ts": child("alpha", 'await ctx.task("inner", {});') },
			parentCalling('await ctx.workflow(alpha, { stageName: "custom" });'),
		);
		assert.deepEqual(result.stages, ["custom", "custom/inner"]);
		assert.deepEqual(result.uncertainties, []);
	});

	test("a resolved child whose name is not visible is an unresolved child with no candidates", () => {
		const result = scanWith(
			{ "alpha.ts": "export default workflow({ name: computedName, run: async (ctx) => {} });\n" },
			parentCalling("await ctx.workflow(alpha);"),
		);
		assert.deepEqual(result.stages, ["workflow:alpha"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.line, entry.candidates]),
			[["unresolved-child", 4, []]],
		);
		assert.equal(result.warnings.length, 1);
	});

	test("an unresolvable child with an explicit stageName offers each import under that name", () => {
		const result = scanWith(
			{
				"alpha.ts": child("alpha", 'await ctx.task("inner", {});'),
				"beta.ts": child("beta"),
			},
			parentCalling('await ctx.workflow(children[pick], { stageName: "fixed" });'),
		);
		assert.deepEqual(result.stages, ["fixed"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.code),
			["unresolved-child"],
		);
		assert.deepEqual(childCandidatesOf(result), [
			{ stages: ["fixed", "fixed/inner"], source: "child-definition" },
			{ stages: ["fixed"], source: "child-definition" },
		]);
		assert.deepEqual(
			result.warnings.map((warning) => warning.includes("could not be resolved")),
			[true],
		);
	});

	test("an unresolvable child with an unresolved stageName offers no candidates", () => {
		const result = scanWith(
			{ "alpha.ts": child("alpha") },
			parentCalling("await ctx.workflow(children[pick], { stageName: dynamicName });"),
		);
		assert.deepEqual(result.stages, ["*"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[
				["unresolved-name", []],
				["unresolved-child", []],
			],
		);
	});

	test("an unresolvable child offers no candidate when it has no imports", () => {
		const result = scan(workflowSource("await ctx.workflow(children[pick]);"));
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[["unresolved-child", []]],
		);
	});

	test("a builtin child with no source file is an unresolved child", () => {
		const result = scan(
			parentCalling(
				"await ctx.workflow(missingBuiltin);",
				'import { missingBuiltin } from "@bastani/atomic/workflows/builtin";\n',
			),
		);
		assert.deepEqual(result.stages, ["workflow:missing-builtin"]);
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.code),
			["unresolved-child"],
		);
		assert.ok(
			result.warnings.some((warning) => warning.includes('builtin definition "missingBuiltin" has no source file')),
		);
	});

	test("an explicit stageName that is a literal adds no name uncertainty", () => {
		const result = scanWith(
			{ "alpha.ts": child("alpha") },
			parentCalling('await ctx.workflow(alpha, { stageName: "plain" });'),
		);
		assert.deepEqual(result.uncertainties, []);
	});
});

describe("step element candidates", () => {
	const factory = (candidate: string): PossibleStageCandidate => ({ stages: [candidate], source: "factory" });

	test("a call to an unknown function offers nothing", () => {
		const result = scan(workflowSource("await ctx.parallel([unknownStep()]);"));
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[["unresolved-step", []]],
		);
	});

	test("an identifier that is not called offers nothing", () => {
		const result = scan(
			workflowSource("await ctx.parallel([makeStep]);", 'function makeStep() { return { name: "built" }; }'),
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[["unresolved-step", []]],
		);
	});

	test("a declared function factory offers every plain name in its body", () => {
		const result = scan(
			workflowSource(
				"await ctx.parallel([makeStep()]);",
				'function makeStep() { return [{ prompt: "p", name: "second" }, { name: "first" }, { name: "bad/name" }, { name: "wild*" }, { name: dynamic }]; }',
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [factory("second"), factory("first")]);
	});

	test("an arrow builder declared right after another builder is still found", () => {
		const result = scan(
			workflowSource(
				"await ctx.parallel([second()]);",
				'const first = () => [{ name: "one" }];const second = () => [{ name: "two" }];',
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [factory("two")]);
	});

	test("an arrow factory that is not an arrow offers nothing", () => {
		const result = scan(workflowSource("await ctx.parallel([value()]);", 'const value = ({ name: "n" });'));
		assert.deepEqual(result.uncertainties[0]!.candidates, []);
	});

	test("an imported function factory offers its names, and a missing export offers nothing", () => {
		const result = scanWith(
			{ "steps.ts": 'export function makeStep() { return { name: "imported" }; }\n' },
			'import { makeStep, absent } from "./steps.js";\nexport default workflow({ name: "w", run: async (ctx) => {\nawait ctx.parallel([makeStep(), absent()]);\n}});\n',
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.candidates),
			[[factory("imported")], []],
		);
	});

	test("an imported arrow factory offers its names under the imported name", () => {
		const result = scanWith(
			{ "steps.ts": 'export const make = () => ({ name: "arrow-imported" });\n' },
			'import { make as build } from "./steps.js";\nexport default workflow({ name: "w", run: async (ctx) => {\nawait ctx.parallel([build()]);\n}});\n',
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [factory("arrow-imported")]);
	});

	test("a name that follows another property after a comma is offered", () => {
		const result = scan(
			workflowSource("await ctx.parallel(buildSteps());", 'const defaults = { prompt: "p", name: "after-comma" };'),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("after-comma"), literal("w")]);
	});

	test("a name key not preceded by an object delimiter is ignored", () => {
		const result = scan(
			workflowSource(
				"await ctx.parallel(buildSteps());",
				'const odd = { x: label.name; name: "x" };\nconst typed = { a: 1 }; name: "loose";',
			),
		);
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("w")]);
	});
});

describe("step name uncertainty from object and factory elements", () => {
	function unresolvedNames(body: string, prelude = "") {
		const result = scan(workflowSource(body, prelude));
		return result.uncertainties.map((entry) => [entry.code, entry.line, entry.candidates] as const);
	}

	test("an object element with a dynamic name is an unresolved name", () => {
		assert.deepEqual(unresolvedNames('await ctx.parallel([{ name: pick("only") }]);'), [["unresolved-name", 3, []]]);
	});

	test("an object element with a dynamic name ranges over the visible arrays", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([{ name: kind }]);", 'const KINDS = ["a", "b"];'), [
			["unresolved-name", 3, [enumArray("a", "b"), enumArray("a"), enumArray("b")]],
		]);
	});

	test("an object element with a literal name is certain", () => {
		assert.deepEqual(unresolvedNames('await ctx.parallel([{ name: "fixed" }, { name: `tpl-${1}x` }]);'), []);
	});

	test("an object element with a local constant name is certain", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([{ name: fixedName }]);", 'const fixedName = "local";'), []);
	});

	test("an object element without a name is an unresolved step", () => {
		assert.deepEqual(unresolvedNames('await ctx.parallel([{ prompt: "p" }]);'), [["unresolved-step", 3, []]]);
	});

	test("a factory without a name field is an unresolved name with no candidates", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([step()]);", 'const step = () => ({ prompt: "p" });'), [
			["unresolved-name", 3, []],
		]);
	});

	test("a factory called with a literal fills its name parameter", () => {
		assert.deepEqual(
			unresolvedNames('await ctx.parallel([step("filled")]);', "const step = (name) => ({ name });"),
			[],
		);
	});

	test("a factory called with a dynamic argument is an unresolved name drawn from that argument", () => {
		assert.deepEqual(
			unresolvedNames('await ctx.parallel([step(pick("from-arg"))]);', "const step = (name) => ({ name });"),
			[["unresolved-name", 3, [literal("from-arg")]]],
		);
	});

	test("a factory called with no argument is an unresolved name", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([step()]);", "const step = (name) => ({ name });"), [
			["unresolved-name", 3, []],
		]);
	});

	test("a factory called with an empty argument is an unresolved name drawn from the factory's name", () => {
		assert.deepEqual(
			unresolvedNames(
				"await ctx.parallel([step(, 1)]);",
				`const step = (name) => ({ name });\n${'const KINDS = ["a"];'}`,
			),
			[["unresolved-name", 4, [enumArray("a")]]],
		);
	});

	test("a factory with a template name that has a hole is an unresolved name", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([step(1)]);", "const step = (n) => ({ name: `${n}` });"), [
			["unresolved-name", 3, []],
		]);
	});

	test("a factory with a literal name is certain", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([step()]);", 'const step = () => ({ name: "fixed" });'), []);
	});

	test("a factory whose literal name is the wildcard is an unresolved name", () => {
		assert.deepEqual(unresolvedNames("await ctx.parallel([step()]);", 'const step = () => ({ name: "*" });'), [
			["unresolved-name", 3, []],
		]);
	});
});

describe("map callbacks building steps", () => {
	function run(body: string, prelude = "") {
		const result = scan(workflowSource(body, prelude));
		return {
			stages: result.stages,
			uncertainties: result.uncertainties.map((entry) => [entry.code, entry.candidates] as const),
		};
	}

	test("an expression-bodied object without a name contributes nothing and is certain", () => {
		assert.deepEqual(run("await ctx.parallel(items.map((item) => ({ prompt: item })));"), {
			stages: [],
			uncertainties: [],
		});
	});

	test("an expression-bodied object with a dynamic name is an unresolved name", () => {
		assert.deepEqual(run("await ctx.parallel(items.map((item) => ({ name: item })));"), {
			stages: ["*"],
			uncertainties: [["unresolved-name", []]],
		});
	});

	test("an expression-bodied object with a literal name is certain", () => {
		assert.deepEqual(run('await ctx.parallel(items.map((item) => ({ name: "fixed" })));'), {
			stages: ["fixed"],
			uncertainties: [],
		});
	});

	test("a block-bodied callback returning an object with a dynamic name is an unresolved name", () => {
		assert.deepEqual(run("await ctx.parallel(items.map((item) => { return { name: item }; }));"), {
			stages: ["*"],
			uncertainties: [["unresolved-name", []]],
		});
	});

	test("a block-bodied callback returning an object with a literal name is certain", () => {
		assert.deepEqual(run('await ctx.parallel(items.map((item) => { const x = 1; return { name: "built" }; }));'), {
			stages: ["built"],
			uncertainties: [],
		});
	});

	test("a block-bodied callback returning an object without a name is unrecognised", () => {
		const result = scan(workflowSource("await ctx.parallel(items.map((item) => { return { prompt: item }; }));"));
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.code),
			["unresolved-steps"],
		);
	});

	test("an unresolved callback name ranges over the visible arrays", () => {
		const result = run(
			"await ctx.parallel(items.map((item) => ({ name: item })));",
			'const KINDS = ["a"];\nconst OTHER = ["b"];',
		);
		assert.deepEqual(result.uncertainties, [["unresolved-name", [enumArray("a"), enumArray("b")]]]);
	});

	test("a callback body that calls a local factory uses the factory's name", () => {
		assert.deepEqual(
			run("await ctx.parallel(items.map((item) => step(item)));", "const step = (name) => ({ name });"),
			{ stages: ["*"], uncertainties: [["unresolved-name", []]] },
		);
		assert.deepEqual(
			run('await ctx.parallel(items.map((item) => step("lit")));', "const step = (name) => ({ name });"),
			{ stages: ["lit"], uncertainties: [] },
		);
	});

	test("a map call through a local variable resolves the same way", () => {
		assert.deepEqual(run("const built = items.map((item) => ({ name: item }));\nawait ctx.parallel(built);"), {
			stages: ["*"],
			uncertainties: [["unresolved-name", []]],
		});
	});

	test("an unrecognised callback body is an unresolved steps argument", () => {
		const result = scan(workflowSource("await ctx.parallel(items.map((item) => steps[item]));"));
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.code),
			["unresolved-steps"],
		);
	});

	test("a function-expression callback contributes nothing and is certain", () => {
		const result = scan(workflowSource("await ctx.parallel(items.map(function (item) { return { name: item }; }));"));
		assert.deepEqual(
			result.uncertainties.map((entry) => entry.code),
			[],
		);
	});
});

describe("candidate recognition at the edges", () => {
	const HELPER = "const label = (kind, n) => `${kind}-${n}`;";

	test("a string followed by an argument list is not a helper call", () => {
		const result = scan(workflowSource('await ctx.task("label"("scan", 3), {});', HELPER));
		assert.deepEqual(result.uncertainties[0]!.candidates, [literal("label"), literal("scan")]);
	});

	test("an imported helper whose source cannot be read composes nothing", () => {
		fixtureCounter += 1;
		writeFixture("helpers.ts", `export ${HELPER}\n`);
		const entry = writeFixture(
			"entry.ts",
			`import { label } from "./helpers.js";\n${workflowSource('await ctx.task(label("scan", 3), {});')}`,
		);
		unreadableSources.add(join(dirname(entry), "helpers.ts"));
		const result = scanPossibleStagesFromSource(entry);
		const named = result.uncertainties.find((entry) => entry.code === "unresolved-name");
		assert.deepEqual(named?.candidates, [literal("scan")]);
	});

	test("a string followed by an argument list is not a factory call", () => {
		const result = scan(
			workflowSource('await ctx.parallel(["makeStep"()]);', 'function makeStep() { return { name: "built" }; }'),
		);
		assert.deepEqual(
			result.uncertainties.map((entry) => [entry.code, entry.candidates]),
			[["unresolved-step", []]],
		);
	});
});

describe("child candidates at the edges", () => {
	test("a child module that cannot be read is not offered", () => {
		fixtureCounter += 1;
		writeFixture("alpha.ts", child("alpha"));
		writeFixture("beta.ts", child("beta"));
		const entry = writeFixture("entry.ts", parentCalling("await ctx.workflow(children[pick]);"));
		unreadableSources.add(join(dirname(entry), "alpha.ts"));
		const result = scanPossibleStagesFromSource(entry);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["workflow:beta"], source: "child-definition" }]);
	});

	test("a child with a computed name and its own stages is not offered under an explicit stageName", () => {
		const result = scanWith(
			{
				"alpha.ts":
					'export default workflow({ name: computedName, run: async (ctx) => {\nawait ctx.task("inner", {});\n} });\n',
				"beta.ts": child("beta"),
			},
			parentCalling('await ctx.workflow(children[pick], { stageName: "fixed" });'),
		);
		assert.deepEqual(childCandidatesOf(result), [{ stages: ["fixed"], source: "child-definition" }]);
	});

	test("a grandchild's stages are offered under a wildcard parent boundary", () => {
		const result = scanWith(
			{
				"alpha.ts": `import gamma from "./gamma.js";\n${child("alpha", "await ctx.workflow(children[pick]);")}`,
				"gamma.ts": child("gamma", 'await ctx.task("inner", {});'),
			},
			parentCalling("await ctx.workflow(alpha, { stageName: dynamicName });", 'import alpha from "./alpha.js";\n'),
		);
		assert.deepEqual(childCandidatesOf(result), [
			{ stages: ["*/workflow:gamma", "*/workflow:gamma/inner"], source: "child-definition" },
		]);
	});
});
