import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	extractRegexSources,
	findBacktrackingRisks,
	type RegexRisk,
	scanPaths,
} from "../../scripts/event-loop/regex-safety.ts";
import {
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.ts";

const root = join(moduleDir(import.meta.url), "../..");

function risks(pattern: string, flags = ""): RegexRisk[] {
	return findBacktrackingRisks(pattern, flags);
}

function summary(pattern: string, flags = ""): string[] {
	return risks(pattern, flags).map((risk) => `${risk.kind}: ${risk.subPattern}`);
}

describe("exponential backtracking", () => {
	const cases: [pattern: string, flags: string, subPattern: string][] = [
		["(a+)+$", "", "(a+)+"],
		["(a|a)*$", "", "(a|a)*"],
		["(\\w|\\d)+$", "", "(\\w|\\d)+"],
		["(x*)*y", "", "(x*)*"],
		["(\\w+\\s?)+$", "", "(\\w+\\s?)+"],
		["(a|aa)*c", "", "(a|aa)*"],
		["(\\n\\s*)+$", "", "(\\n\\s*)+"],
		["(\\r\\n|\\r|\\n)+$", "", "(\\r\\n|\\r|\\n)+"],
		["(a{1,3})+$", "", "(a{1,3})+"],
		["([a-z]|\\u212A)+$", "iu", "([a-z]|\\u212A)+"],
		["^(?=(a+)+$)", "", "(a+)+"],
	];
	for (const [pattern, flags, subPattern] of cases) {
		test(`flags /${pattern}/${flags} at ${subPattern}`, () => {
			assert.deepEqual(summary(pattern, flags), [`exponential: ${subPattern}`]);
		});
	}

	test("explains nested repetitions by naming both quantifiers and the repeated character", () => {
		const [risk] = risks("(a+)+$");
		assert.match(risk!.reason, /a\+ repeats inside \(a\+\)\+/);
		assert.match(risk!.reason, /"a"/);
	});

	test("explains overlapping alternatives by naming the repetition", () => {
		const [risk] = risks("(\\w|\\d)+$");
		assert.match(risk!.reason, /alternatives that \(\\w\|\\d\)\+ repeats/);
	});
});

describe("polynomial backtracking", () => {
	const cases: [pattern: string, flags: string, expected: string[]][] = [
		["\\s*\\s*$", "", ["polynomial: \\s*\\s*"]],
		["a*a*b", "", ["polynomial: a*a*"]],
		[".*,.*=", "", ["polynomial: .*,.*"]],
		["^(.*?)\\s*$", "", ["polynomial: (.*?)\\s*"]],
		["a+?a+?b", "", ["polynomial: a+?a+?"]],
		["(a+){2,5}$", "", ["polynomial: (a+){2,5}"]],
		["\\p{L}+\\p{L}+$", "u", ["polynomial: \\p{L}+\\p{L}+"]],
		["^(?i:a+)A+$", "", ["polynomial: (?i:a+)A+"]],
		["(a*)\\1b", "", ["polynomial: (a*)\\1"]],
		["^\\s*(.*)$", "", ["polynomial: \\s*(.*)"]],
		["\\d{1,100}\\d{1,100}x", "", ["polynomial: \\d{1,100}\\d{1,100}"]],
	];
	for (const [pattern, flags, expected] of cases) {
		test(`flags /${pattern}/${flags}`, () => {
			assert.deepEqual(summary(pattern, flags), expected);
		});
	}

	test("states the degree of a chain of three repetitions", () => {
		const reasons = risks("exit(?:ed)?\\s*(?:with\\s*)?(?:code|status)?\\s*[:\\s]?\\s*(\\d+)", "i").map(
			(risk) => risk.reason,
		);
		assert.ok(reasons.length > 0);
		for (const reason of reasons) assert.match(reason, /O\(n\^3\)/);
	});

	test("names both repetitions and the repeated character", () => {
		const [risk] = risks("\\s*\\s*$");
		assert.match(risk!.reason, /\\s\* and \\s\* can both read a run of " "/);
		assert.match(risk!.reason, /O\(n\^2\)/);
	});
});

describe("patterns that never backtrack super-linearly", () => {
	const safe: [pattern: string, flags: string, why: string][] = [
		["^abc$", "", "anchored literal"],
		["^v?\\d+\\.\\d+\\.\\d+$", "", "separators force every split"],
		["(a|b)*$", "", "disjoint alternatives"],
		["(a|ab)*c", "", "overlapping first characters, but every text splits one way"],
		["(a{1,3}){1,3}$", "", "bounded nesting costs a small constant"],
		["(\\d{1,3}\\.){3}\\d{1,3}$", "", "bounded repetition with separators"],
		["(?<=a)b+(?!c)", "", "lookarounds"],
		["\\w+(?=\\s)", "", "lookahead after a repetition"],
		["\\x1b\\[[0-9;]*m", "g", "ANSI colour sequence"],
		["^\\s+|\\s+$", "g", "trim"],
		["a+b", "", "search-loop retries are not an ambiguity"],
		["(\\w+\\s?)+", "", "nothing after the repetition can fail"],
		["a*a*", "", "nothing after the repetitions can fail"],
		["^\\s*([\\s\\S]*)$", "", "the last repetition accepts whatever follows"],
		["^description:\\s*(.+)$", "m", "the last repetition accepts whatever follows"],
		["^[\\w.-]+@[\\w.-]+$", "", "separator between the repetitions"],
		["\\[([^\\]]*)\\]\\(([^)]*)\\)", "g", "markdown link"],
		['"(?:[^"\\\\]|\\\\.)*"', "", "string literal with escapes"],
		["(?<quote>['\"]).*?\\k<quote>", "", "named group and backreference"],
		["[\\p{L}--[a-z]]+[a-z]+$", "v", "set subtraction makes the classes disjoint"],
		["[\\q{abc|ab}]+c$", "v", "class strings that split one way"],
		["\\p{Emoji_Presentation}+", "u", "Unicode property"],
		["(?<x>a+)+\\k<x>", "", "the backreference always lets the match end"],
		["(?:^|,)([^,]*)", "", "separated fields"],
		["^(.*?)(?<!\\s)\\s*\\{#([A-Za-z0-9_-]+)\\}\\s*$", "", "the lookbehind pins where the name ends"],
		["\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", "g", "OSC 8 hyperlink"],
		["^(?:<{7}|\\|{7}|={7}|>{7})(?:[ \\r]|$)", "", "conflict marker"],
		["[^\\n]*\\n|[^\\n]+$", "g", "line splitter"],
		["^history:\\/\\/([^/?#]*)(?:\\/([^?#]*))?(?:\\?([^#]*))?$", "", "history URL"],
		["^(?:\\?q=(.+)|:([^:?]+)(?:\\?(.+))?(?::([^:?]+))?)?$", "i", "resource selector"],
		['"status"\\s*:\\s*"([A-Z_]+)"', "", "JSON status field"],
		["^[A-Za-z0-9+/]+={0,2}$", "", "base64"],
		["^data:([^;]+);base64,(.+)$", "", "data URL"],
		["^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i", "UUID"],
		[
			"exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\\d,]+ tokens?|\\s*\\([\\d,]+\\))",
			"i",
			"provider error",
		],
		["(^|[;&|()]|\\n)\\s*tee\\s+[^|&;]+", "", "mutating command"],
	];
	for (const [pattern, flags, why] of safe) {
		test(`does not flag /${pattern}/${flags} (${why})`, () => {
			assert.deepEqual(summary(pattern, flags), []);
		});
	}
});

describe("shipped patterns rewritten to read each run once", () => {
	const rewrites: [file: string, before: string, after: string, flags: string][] = [
		[
			"subagents/src/shared/utils.ts",
			String.raw`exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)`,
			String.raw`exit(?:ed)?\s*(?:with\s*)?(?:(?:code|status)\s*)?(?::\s*)?(\d+)`,
			"i",
		],
		[
			"subagents/src/runs/shared/long-running-guard.ts",
			String.raw`(^|[;&|()\s])sed\s+[^\n;&|]*\s-i\b`,
			String.raw`(^|[;&|()\s])sed\s(?:[^\S\n]*\n)*[^\n;&|]*\s-i\b`,
			"",
		],
		[
			"subagents/src/tui/render-status-progress.ts",
			String.raw`\[Write to:\s*([^\]\n]+)\]`,
			String.raw`\[Write to:(?:[^\S\n]*\n)*([^\]\n]+)\]`,
			"i",
		],
		[
			"tui/src/components/markdown.ts",
			String.raw`^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$`,
			String.raw`^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*(?:\|[ \t]*)?$`,
			"",
		],
		[
			"tui/src/components/markdown.ts",
			String.raw`^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)`,
			String.raw`^ {0,3}\$\$[ \t]*(?:\n|(?![ \t]))([\s\S]*?)\$\$[ \t]*(?:\n|$)`,
			"",
		],
		[
			"workflows/builtin/verification-criteria.ts",
			String.raw`^(.*?)\s*\{#([A-Za-z0-9_-]+)\}\s*$`,
			String.raw`^(.*?)(?<!\s)\s*\{#([A-Za-z0-9_-]+)\}\s*$`,
			"",
		],
		[
			"intercom/intercom-utils.ts",
			String.raw`${"```"}(?:json)?\s*([\s\S]*?)${"```"}`,
			String.raw`${"```"}(?:json)?([\s\S]*?)${"```"}`,
			"i",
		],
		[
			"coding-agent/src/utils/changelog.ts",
			String.raw`(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))`,
			String.raw`(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s[^)]*)?\))`,
			"g",
		],
	];
	for (const [file, before, after, flags] of rewrites) {
		test(`${file}: /${after}/${flags} has none of the polynomial risks of /${before}/${flags}`, () => {
			const previous = risks(before, flags).map((risk) => risk.kind);
			assert.ok(previous.length > 0);
			assert.deepEqual(new Set(previous), new Set(["polynomial"]));
			assert.deepEqual(summary(after, flags), []);
		});
	}
});

describe("lookbehind", () => {
	test("reads a lookbehind right to left, so repetitions it tries first are checked against what must follow them", () => {
		assert.deepEqual(summary("(?<=a\\s*\\s*)b"), ["polynomial: \\s*\\s*"]);
		assert.deepEqual(summary("(?<=^\\s*\\s*)b"), ["polynomial: \\s*\\s*"]);
	});

	test("does not flag a lookbehind whose repetitions the matcher reaches last", () => {
		assert.deepEqual(summary("(?<=\\s*\\s*a)b"), []);
	});
});

describe("pattern syntax", () => {
	test("rejects a pattern that is not valid JavaScript", () => {
		assert.throws(() => findBacktrackingRisks("(a", ""), SyntaxError);
		assert.throws(() => findBacktrackingRisks("a", "gg"), SyntaxError);
	});

	test("reads escapes, named groups, lazy and counted quantifiers, and every flag", () => {
		assert.deepEqual(summary("(?<year>\\d{4})-(?<month>\\d{2})\\u{1F600}?.*?$", "dgimsuy"), []);
		assert.deepEqual(summary("[\\p{Script=Greek}&&\\p{Letter}]{2,}", "v"), []);
	});
});

describe("extractRegexSources", () => {
	test("finds regular expression literals and tells them apart from division", () => {
		const source = [
			"const ratio = total / count / 2;",
			"const pattern = /a+b/gi;",
			"const half = (x) / 2, other = y / /c/.source.length;",
		].join("\n");
		assert.deepEqual(extractRegexSources("example.ts", source), [
			{ file: "example.ts", line: 2, pattern: "a+b", flags: "gi" },
			{ file: "example.ts", line: 3, pattern: "c", flags: "" },
		]);
	});

	test("finds RegExp calls whose pattern and flags are written literally", () => {
		const source = [
			'new RegExp("\\\\s+$", "m");',
			"RegExp(`x+`);",
			"new RegExp(String.raw`\\d+\\.`, `g`);",
			"new RegExp(dynamic);",
			`new RegExp(\`a\${b}\`, "g");`,
			'new RegExp("a", flags);',
		].join("\n");
		assert.deepEqual(extractRegexSources("example.ts", source), [
			{ file: "example.ts", line: 1, pattern: "\\s+$", flags: "m" },
			{ file: "example.ts", line: 2, pattern: "x+", flags: "" },
			{ file: "example.ts", line: 3, pattern: "\\d+\\.", flags: "g" },
		]);
	});

	test("parses TypeScript syntax and JSX in .tsx files", () => {
		const source = [
			"function f<T>(value: T): T { return value as T; }",
			"const view = <div title={/x/.source}>{a / b}</div>;",
		].join("\n");
		assert.deepEqual(extractRegexSources("view.tsx", source), [
			{ file: "view.tsx", line: 2, pattern: "x", flags: "" },
		]);
	});
});

describe("scanning source trees", () => {
	const directory = makeTempDirectory("regex-safety-");
	afterAll(() => removeTempDirectory(directory));
	makeDirectorySync(join(directory, "src", "nested"), { recursive: true });
	makeDirectorySync(join(directory, "src", "test"), { recursive: true });
	makeDirectorySync(join(directory, "src", "node_modules", "dep"), { recursive: true });
	writeTextSync(join(directory, "src", "nested", "parse.ts"), "export const a = /ok/;\nexport const b = /(a+)+$/;\n");
	writeTextSync(join(directory, "src", "parse.test.ts"), "export const c = /(b+)+$/;\n");
	writeTextSync(join(directory, "src", "test", "helper.ts"), "export const d = /(c+)+$/;\n");
	writeTextSync(join(directory, "src", "node_modules", "dep", "index.js"), "export const e = /(d+)+$/;\n");
	writeTextSync(join(directory, "src", "types.d.ts"), "export declare const f: RegExp;\n");

	test("reports every regular expression in shipped files, skipping tests and dependencies", () => {
		const scanned = scanPaths(["src"], directory);
		assert.deepEqual(
			scanned.map((entry) => [entry.file, entry.line, entry.pattern, entry.risks.map((risk) => risk.kind)]),
			[
				["src/nested/parse.ts", 1, "ok", []],
				["src/nested/parse.ts", 2, "(a+)+$", ["exponential"]],
			],
		);
	});

	test("runs under plain Node and exits 1 with the location of each risky pattern", () => {
		const result = spawnSyncCollect(
			[process.execPath, join(root, "scripts/event-loop/regex-safety.ts"), "--json", "src"],
			{ cwd: directory },
		);
		assert.equal(result.exitCode, 1, result.stderr.toString());
		const report = JSON.parse(result.stdout.toString()) as { file: string; line: number; risks: RegexRisk[] }[];
		assert.deepEqual(
			report.map((entry) => [entry.file, entry.line, entry.risks[0]?.subPattern]),
			[["src/nested/parse.ts", 2, "(a+)+"]],
		);
	});
});
