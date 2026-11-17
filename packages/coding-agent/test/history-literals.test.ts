import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { indexLiterals, type LiteralQuery } from "../src/core/tools/history-literals.js";
import { normalizeSearchPattern } from "../src/core/tools/resource-selectors.js";
import { loadNativeSearchBinding } from "../src/core/tools/search-native.js";

const sets = (pattern: string, ignoreCase = false, literal = false) =>
	indexLiterals(pattern, ignoreCase, literal)?.map((set) => [...set].sort());

const PROPERTY_TRIALS = 1500;
const MINIMUM_CHECKS: readonly (readonly [string, number])[] = [
	["native", 700],
	["script", 700],
	["dot", 400],
	["class", 400],
	["escape", 400],
	["engine-specific escape", 200],
	["optional", 400],
	["repeated", 400],
	["alternation", 120],
	["group", 400],
	["case-insensitive", 200],
];

interface Random {
	below(limit: number): number;
	pick<T>(items: readonly T[]): T;
}

interface GeneratedPattern {
	readonly pattern: string;
	readonly unit: boolean;
	readonly features: readonly string[];
	sample(ignoreCase: boolean): string;
}

function seededRandom(seed: number): Random {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), state | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
	const below = (limit: number) => Math.floor(next() * limit);
	return { below, pick: (items) => items[below(items.length)]! };
}

const LETTERS = ["a", "b", "c", "k", "s", "x", "z", "A", "B", "K", "S", "é", "É", "ſ", "\u212a", "ß", "😀", "日"];
const PADDING = [...LETTERS, " ", "-", ".", "<", ">", "0", "7", "_", "{", "}", "\\"];
const ESCAPES: readonly (readonly [string, readonly string[]])[] = [
	["\\.", ["."]],
	["\\(", ["("]],
	["\\{", ["{"]],
	["\\-", ["-"]],
	["\\d", ["5"]],
	["\\w", ["w", "_"]],
	["\\s", [" "]],
	["\\W", ["-"]],
	["\\b", [""]],
	["\\x41", ["A"]],
	["\\u0062", ["b"]],
];
const ENGINE_SPECIFIC_ESCAPES: readonly (readonly [string, readonly string[]])[] = [
	["\\<", ["", "<"]],
	["\\>", ["", ">"]],
	["\\U0000006A", ["j", "U0000006A"]],
	["\\U{6B}", ["k", "U{6B}"]],
	["\\pL", ["q", "pL"]],
	["\\p{Lu}", ["Q", "p{Lu}"]],
	["\\x{e9}", ["é", "x{e9}"]],
	["\\cA", ["\u0001"]],
	["\\c1", ["\\c1"]],
	["\\c{0,2}", ["\\", "\\cc"]],
	["\\p", ["p"]],
	["\\p[ab]", ["pa", "pb"]],
];
const CLASSES: readonly (readonly [string, readonly string[]])[] = [
	["[abc]", ["a", "b", "c"]],
	["[^a]", ["b", "Z", "."]],
	["[a-z]", ["q", "k"]],
	["[\\d.]", ["5", "."]],
	["[<>{]", ["<", "{"]],
];
const QUANTIFIERS: readonly (readonly [string, number, number])[] = [
	["?", 0, 1],
	["??", 0, 1],
	["*", 0, 2],
	["+", 1, 2],
	["+?", 1, 2],
	["{2}", 2, 2],
	["{0,2}", 0, 2],
	["{1,}", 1, 2],
	["{2,3}", 2, 3],
	["{0}", 0, 0],
	["{1}{2}", 2, 2],
	["?{2}", 0, 2],
	["{0,99999999999999999999999999}", 0, 1],
];

function caseVariant(char: string, random: Random): string {
	if (char === "k" || char === "K") return random.pick(["k", "K", "\u212a"]);
	if (char === "s" || char === "S") return random.pick(["s", "S", "ſ"]);
	return random.pick([char, char.toLowerCase(), char.toUpperCase()]);
}

function literalPiece(random: Random): GeneratedPattern {
	const text = Array.from({ length: 1 + random.below(5) }, () => random.pick(LETTERS)).join("");
	return {
		pattern: text,
		unit: Array.from(text).length === 1,
		features: [],
		sample: (ignoreCase) => (ignoreCase ? [...text].map((char) => caseVariant(char, random)).join("") : text),
	};
}

function choicePiece(pattern: string, samples: readonly string[], feature: string, random: Random): GeneratedPattern {
	return { pattern, unit: true, features: [feature], sample: () => random.pick(samples) };
}

function atom(random: Random, depth: number): GeneratedPattern {
	const kind = random.below(depth < 2 ? 10 : 8);
	if (kind <= 3) return literalPiece(random);
	if (kind === 4) return choicePiece(".", ["X", "q", "3", "é", "-"], "dot", random);
	if (kind === 5) return choicePiece(...random.pick(CLASSES), "class", random);
	if (kind === 6) return choicePiece(...random.pick(ESCAPES), "escape", random);
	if (kind === 7) return choicePiece(...random.pick(ENGINE_SPECIFIC_ESCAPES), "engine-specific escape", random);
	return group(random, depth + 1);
}

function group(random: Random, depth: number): GeneratedPattern {
	const first = sequence(random, depth);
	const second = random.below(3) === 0 ? sequence(random, depth) : undefined;
	const opening = random.pick(["(", "(?:", "(?:", "(?i:", "(?=", "(?!"]);
	const lookaround = opening === "(?=" || opening === "(?!";
	const branches = second === undefined ? [first] : [first, second];
	return {
		pattern: `${opening}${branches.map((branch) => branch.pattern).join("|")})`,
		unit: true,
		features: [
			"group",
			...(second === undefined ? [] : ["alternation"]),
			...branches.flatMap((branch) => branch.features),
		],
		sample: (ignoreCase) => (lookaround ? "" : random.pick(branches).sample(ignoreCase || opening === "(?i:")),
	};
}

function quantified(random: Random, depth: number): GeneratedPattern {
	const inner = atom(random, depth);
	if (random.below(3) !== 0) return inner;
	const [suffix, least, most] = random.pick(QUANTIFIERS);
	return {
		pattern: `${inner.unit ? inner.pattern : `(?:${inner.pattern})`}${suffix}`,
		unit: true,
		features: [least === 0 ? "optional" : "repeated", ...inner.features],
		sample: (ignoreCase) =>
			Array.from({ length: least + random.below(most - least + 1) }, () => inner.sample(ignoreCase)).join(""),
	};
}

function sequence(random: Random, depth: number): GeneratedPattern {
	const pieces = Array.from({ length: 1 + random.below(depth < 2 ? 7 : 3) }, () => quantified(random, depth));
	return {
		pattern: pieces.map((piece) => piece.pattern).join(""),
		unit: false,
		features: pieces.flatMap((piece) => piece.features),
		sample: (ignoreCase) => pieces.map((piece) => piece.sample(ignoreCase)).join(""),
	};
}

function generatedPattern(random: Random): GeneratedPattern {
	const body = random.below(5) === 0 ? group(random, 1) : sequence(random, 0);
	const prefix = random.below(6) === 0 ? "(?i)" : "";
	return {
		pattern: prefix + body.pattern,
		unit: false,
		features: [...new Set(body.features)],
		sample: (ignoreCase) => body.sample(ignoreCase || prefix !== ""),
	};
}

function padding(random: Random): string {
	return Array.from({ length: random.below(6) }, () => random.pick(PADDING)).join("");
}

function compiles(pattern: string, flags: string): RegExp | undefined {
	try {
		return new RegExp(pattern, flags);
	} catch {
		return undefined;
	}
}

function foldForIndex(text: string): string {
	return text.replace(/[A-Z\u017f\u212a]/g, (char) =>
		char === "\u017f" ? "s" : char === "\u212a" ? "k" : char.toLowerCase(),
	);
}

function foundByIndex(query: LiteralQuery, line: string): boolean {
	const folded = foldForIndex(line);
	return query.some((set) => set.every((part) => folded.includes(foldForIndex(part))));
}

describe("index literals of a search pattern (#5250)", () => {
	it("requires every literal run of three or more characters", () => {
		assert.deepEqual(sets("sync the latest origin/main"), [["sync the latest origin/main"]]);
		assert.deepEqual(sets("zephyr-ne+dle"), [["dle", "zephyr-n"]]);
		assert.deepEqual(sets("foo\\.bar\\(x\\)"), [["foo.bar(x)"]]);
		assert.deepEqual(sets("ab"), undefined);
	});

	it("keeps each alternative and gives up when one has no literal", () => {
		assert.deepEqual(sets("alpha|beta"), [["alpha"], ["beta"]]);
		assert.deepEqual(sets("alpha|b"), undefined);
		assert.deepEqual(sets("x(alpha|beta)y"), [["alpha"], ["beta"]]);
		assert.deepEqual(
			sets("(?:alpha|beta) gamma"),
			[["alpha"], ["beta"]].map((set) => [...set, " gamma"].sort()),
		);
	});

	it("drops what an optional or repeated part may leave out", () => {
		assert.deepEqual(sets("(alpha)?beta"), [["beta"]]);
		assert.deepEqual(sets("(alpha)*beta"), [["beta"]]);
		assert.deepEqual(sets("(alpha){0,2}beta"), [["beta"]]);
		assert.deepEqual(sets("(alpha){2}beta"), [["alpha", "beta"]]);
		assert.deepEqual(sets("(alpha)+beta"), [["alpha", "beta"]]);
	});

	it("treats classes, escapes, anchors and lookarounds as unknown characters", () => {
		assert.deepEqual(sets("^foo[abc]bar\\d+baz$"), [["bar", "baz", "foo"]]);
		assert.deepEqual(sets("foo(?=bar)baz"), [["baz", "foo"]]);
		assert.deepEqual(sets("foo\\p{Lu}bar"), [["bar", "foo"]]);
		assert.deepEqual(sets("foo\\x41bar\\u{1F600}baz"), [["bar", "baz", "foo"]]);
		assert.deepEqual(sets("(?<name>foo)bar"), [["bar", "foo"]]);
		assert.deepEqual(sets("(?i)FooBar"), [["FooBar"]]);
	});

	it("respects inline case-folding scopes when choosing Unicode literals (#5250)", () => {
		assert.equal(sets("(?i:aꟋb)"), undefined);
		assert.deepEqual(sets("prefix(?i:aꟋb)"), [["prefix"]]);
		assert.equal(sets("(?:(?i)aꟋb)|other"), undefined);
		assert.deepEqual(sets("(?i:alpha)(?-i:aꟋb)"), [["alpha", "aꟋb"].sort()]);
	});

	it("gives up on syntax whose meaning differs between engines", () => {
		assert.equal(sets("foo[]bar"), undefined);
		assert.equal(sets("foo[a[b]]bar"), undefined);
		assert.equal(sets("foo(?x) bar"), undefined);
		assert.equal(sets("foo)bar"), undefined);
		assert.equal(sets("*foo"), undefined);
	});

	it("gives up on stacked repetition and on \\p, \\P or \\c without a letter after them (#5250)", () => {
		assert.equal(sets("a?{2}bcd"), undefined);
		assert.equal(sets("[a-z]{2}{2}xyz"), undefined);
		assert.equal(sets("(abc){1}{0}def"), undefined);
		assert.equal(sets("A\\p[a-z]"), undefined);
		assert.equal(sets("abc\\P1def"), undefined);
		assert.equal(sets("zz\\c{0,2}yy"), undefined);
		assert.equal(sets("zzz\\c1yyy"), undefined);
		assert.deepEqual(sets("abc\\pLdef\\cAghi"), [["abc", "def", "ghi"]]);
		assert.deepEqual(sets("(abc){2}{x}def"), [["abc", "x}def"]]);
	});

	it("disables the prefilter for long repetition bounds (#5250)", () => {
		assert.equal(sets("xyz{0,99999999999999999999999999}abc"), undefined);
		assert.equal(sets("(abc){123456789012345678901234567890}def"), undefined);
		assert.equal(sets("prefix(ab){00000000000000000000000002}suffix"), undefined);
		assert.deepEqual(sets("(abc){2}def"), [["abc", "def"]]);
	});

	it("reads \\< and \\> as word boundaries rather than angle brackets (#5250)", () => {
		assert.deepEqual(sets("\\<foo\\>"), [["foo"]]);
		assert.deepEqual(sets("alpha\\>beta"), [["alpha", "beta"]]);
		assert.deepEqual(sets("\\<a\\>"), undefined);
	});

	it("reads an eight-digit \\U escape as one unknown character (#5250)", () => {
		assert.deepEqual(sets("\\U00000061bcdef"), [["bcdef"]]);
		assert.deepEqual(sets("abc\\U{1F600}def"), [["abc", "def"]]);
	});

	it("takes a literal search whole, split where a line or a fold breaks it", () => {
		assert.deepEqual(sets("a.b*c", false, true), [["a.b*c"]]);
		assert.deepEqual(sets("foo\nbar", false, true), [["bar", "foo"]]);
		assert.deepEqual(sets("CAFÉ crème", true, true), [[" cr", "CAF"]]);
		assert.deepEqual(sets("CAFÉ crème", false, true), [["CAFÉ crème"]]);
	});

	it("a dot stands for any one character, not for a dot (#5250)", () => {
		const query = indexLiterals("prefix.suffix", false, false);
		assert.deepEqual(
			query?.map((set) => [...set].sort()),
			[["prefix", "suffix"]],
		);
		assert.equal(foundByIndex(query!, "see prefixXsuffix here"), true);
	});

	it("never asks the index for a literal a matching line lacks", () => {
		const native = loadNativeSearchBinding()?.search;
		assert.ok(native);
		const random = seededRandom(5250);
		const patterns = new Set<string>();
		const checked = new Map<string, number>();
		const count = (key: string) => checked.set(key, (checked.get(key) ?? 0) + 1);
		for (let trial = 0; trial < PROPERTY_TRIALS; trial++) {
			const generated = generatedPattern(random);
			const ignoreCase = random.below(4) === 0;
			patterns.add(generated.pattern);
			const query = indexLiterals(generated.pattern, ignoreCase, false);
			if (query === undefined) continue;
			const normalized = normalizeSearchPattern(generated.pattern, ignoreCase);
			const folded = normalized.flags.includes("i");
			const lines = [
				...Array.from({ length: 6 }, () => padding(random) + generated.sample(folded) + padding(random)),
				...Array.from({ length: 4 }, () => padding(random) + padding(random)),
			];
			const matched: { readonly engine: string; readonly line: string }[] = [];
			const nativeResult = native(lines.join("\n"), {
				pattern: normalized.pattern,
				ignoreCase: folded,
				multiline: false,
				contextBefore: 0,
				contextAfter: 0,
				maxCount: lines.length,
			});
			if (!nativeResult.error)
				for (const match of nativeResult.matches)
					matched.push({ engine: "native", line: lines[match.lineNumber - 1]! });
			const regex = compiles(normalized.pattern, normalized.flags);
			if (regex !== undefined)
				for (const line of lines) if (regex.test(line)) matched.push({ engine: "script", line });
			for (const { engine, line } of matched) {
				assert.ok(
					foundByIndex(query, line),
					`${generated.pattern} matches ${JSON.stringify(line)} in the ${engine} engine but the index would not find it in ${JSON.stringify(query)}`,
				);
				for (const feature of [engine, ...generated.features, folded ? "case-insensitive" : "case-sensitive"])
					count(feature);
			}
		}
		assert.ok(patterns.size >= PROPERTY_TRIALS * 0.9, `${patterns.size} distinct patterns`);
		for (const [feature, minimum] of MINIMUM_CHECKS)
			assert.ok((checked.get(feature) ?? 0) >= minimum, `${feature}: ${JSON.stringify([...checked])}`);
	});
});
