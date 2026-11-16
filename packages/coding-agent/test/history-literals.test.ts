import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { indexLiterals } from "../src/core/tools/history-literals.js";

const sets = (pattern: string, ignoreCase = false, literal = false) =>
	indexLiterals(pattern, ignoreCase, literal)?.map((set) => [...set].sort());

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

	it("gives up on syntax whose meaning differs between engines", () => {
		assert.equal(sets("foo[]bar"), undefined);
		assert.equal(sets("foo[a[b]]bar"), undefined);
		assert.equal(sets("foo(?x) bar"), undefined);
		assert.equal(sets("foo)bar"), undefined);
		assert.equal(sets("*foo"), undefined);
	});

	it("takes a literal search whole, split where a line or a fold breaks it", () => {
		assert.deepEqual(sets("a.b*c", false, true), [["a.b*c"]]);
		assert.deepEqual(sets("foo\nbar", false, true), [["bar", "foo"]]);
		assert.deepEqual(sets("CAFÉ crème", true, true), [[" cr", "CAF"]]);
		assert.deepEqual(sets("CAFÉ crème", false, true), [["CAFÉ crème"]]);
	});

	it("never asks the index for a literal a matching line lacks", () => {
		let seed = 5250;
		const random = (limit: number) => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % limit;
		};
		const alphabet = ["a", "b", "c", "ab", "ba", "abc"];
		const piece = (): string => {
			const kind = random(7);
			const word = alphabet[random(alphabet.length)]!.repeat(1 + random(3));
			if (kind === 0) return `(${word}|${alphabet[random(alphabet.length)]!}${word})`;
			if (kind === 1) return `${word}?`;
			if (kind === 2) return `(${word})+`;
			if (kind === 3) return "[ab]";
			if (kind === 4) return ".";
			return word;
		};
		for (let trial = 0; trial < 400; trial++) {
			const pattern = Array.from({ length: 1 + random(4) }, piece).join("");
			const ignoreCase = random(2) === 0;
			const regex = new RegExp(pattern, ignoreCase ? "i" : "");
			const query = indexLiterals(pattern, ignoreCase, false);
			if (query === undefined) continue;
			for (let sample = 0; sample < 30; sample++) {
				const line = Array.from({ length: 4 + random(20) }, () => "abcAB "[random(6)]).join("");
				if (!regex.test(line)) continue;
				const folded = line.toLowerCase();
				assert.ok(
					query.some((set) => set.every((part) => folded.includes(part.toLowerCase()))),
					`${pattern} matches ${JSON.stringify(line)} but the index would not find it in ${JSON.stringify(query)}`,
				);
			}
		}
	});
});
