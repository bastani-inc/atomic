import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, getGraphemeCellRange, sliceByColumn, sliceWithWidth } from "../src/utils.ts";

// https://github.com/earendil-works/pi/issues/10169
describe("sliceByColumn ANSI order regression", () => {
	it("keeps a reset at the slice start after earlier style codes", () => {
		const line = "\x1b[32mfoo\x1b[39m bar";
		assert.strictEqual(sliceByColumn(line, 3, 4, true), "\x1b[32m\x1b[39m bar");
	});

	it("does not leak color into text after a highlighted token", () => {
		const line = "Another \x1b[35malpha\x1b[39m line with \x1b[35mbeta\x1b[39m later.";
		const after = sliceByColumn(line, 13, 100, true);
		assert.strictEqual(after, "\x1b[35m\x1b[39m line with \x1b[35mbeta\x1b[39m later.");
	});

	it("matches segmenter behavior across printable ASCII, ANSI styles, overlap bounds, and Unicode", () => {
		const styled = "\x1b[48;5;236m\x1b[36mconst x = 42;\x1b[39m // comment\x1b[0m";
		assert.deepStrictEqual(sliceWithWidth(styled, 0, 5, true), {
			text: "\x1b[48;5;236m\x1b[36mconst",
			width: 5,
		});
		assert.deepStrictEqual(sliceWithWidth(styled, 6, 7, true), {
			text: "\x1b[48;5;236m\x1b[36mx = 42;",
			width: 7,
		});
		assert.deepStrictEqual(sliceWithWidth(styled, 50, 5, true), { text: "", width: 0 });
		assert.deepStrictEqual(getGraphemeCellRange(styled, 0), { start: 0, end: 1 });
		assert.deepStrictEqual(getGraphemeCellRange(styled, 23), { start: 23, end: 24 });
		assert.strictEqual(getGraphemeCellRange(styled, 24), undefined);
		// Wide CJK & combining marks still use grapheme ranges
		assert.deepStrictEqual(getGraphemeCellRange("ab中cd", 2), { start: 2, end: 4 });
		assert.deepStrictEqual(getGraphemeCellRange("ab中cd", 3), { start: 2, end: 4 });
		assert.deepStrictEqual(getGraphemeCellRange("e\u0301x", 0), { start: 0, end: 1 });

		// extractSegments normal and overlapping (beforeEnd > afterStart)
		assert.deepStrictEqual(extractSegments("\x1b[31mhello world\x1b[0m", 5, 8, 3, true), {
			before: "\x1b[31mhello",
			beforeWidth: 5,
			after: "\x1b[31mrld",
			afterWidth: 3,
		});
		assert.deepStrictEqual(extractSegments("\x1b[31mabcdef\x1b[0m", 4, 2, 4, true), {
			before: "\x1b[31mabcd",
			beforeWidth: 4,
			after: "\x1b[31mef",
			afterWidth: 2,
		});
		// When afterLen > 0 and beforeEnd > afterEnd, stops at afterEnd just like the grapheme path.
		assert.deepStrictEqual(extractSegments("\x1b[31mhello\x1b[0m", 9, 1, 1, false), {
			before: "\x1b[31mhe",
			beforeWidth: 2,
			after: "",
			afterWidth: 0,
		});
		// Negative afterStart with afterEnd <= 0 && afterLen > 0 must match the grapheme slow path.
		assert.deepStrictEqual(extractSegments("hello", 3, -5, 2, false), {
			before: "h",
			beforeWidth: 1,
			after: "",
			afterWidth: 0,
		});
		assert.deepStrictEqual(extractSegments("\x1b[31mhello\x1b[0m", 3, -2, 2, false), {
			before: "\x1b[31mh",
			beforeWidth: 1,
			after: "",
			afterWidth: 0,
		});
		// Fractional bounds must also match the grapheme slow path.
		assert.deepStrictEqual(extractSegments("hello", 1.5, 3, 2, false), {
			before: "h",
			beforeWidth: 1,
			after: "lo",
			afterWidth: 2,
		});
		assert.deepStrictEqual(sliceWithWidth("hello", 0, 2.5, true), { text: "he", width: 2 });
		assert.deepStrictEqual(getGraphemeCellRange("hello", 1.5), { start: 1, end: 2 });
	});

	it("extractSegments ASCII fast path matches grapheme slow path across 60,000+ cases including negatives", () => {
		// Bijectively map printable ASCII text (outside ANSI sequences) to width-1 Greek/Cyrillic letters so
		// `extractSegments` runs its real production grapheme slow path (including AnsiCodeTracker), then invert.
		// Using U+0410..U+044F (64 Cyrillic letters) + U+0391..U+03A1 / U+03A3..U+03C9 (55 Greek letters) = 119 width-1 chars.
		const nonAsciiPool: string[] = [];
		for (let cp = 0x0410; cp <= 0x044f; cp++) nonAsciiPool.push(String.fromCodePoint(cp));
		for (let cp = 0x0391; cp <= 0x03a1; cp++) nonAsciiPool.push(String.fromCodePoint(cp));
		for (let cp = 0x03a3; cp <= 0x03c9; cp++) nonAsciiPool.push(String.fromCodePoint(cp));
		const toNonAscii = new Map<string, string>();
		const toAscii = new Map<string, string>();
		for (let code = 0x20; code <= 0x7e; code++) {
			const ascii = String.fromCharCode(code);
			const mapped = nonAsciiPool[code - 0x20]!;
			toNonAscii.set(ascii, mapped);
			toAscii.set(mapped, ascii);
		}
		const mapTextOutsideAnsi = (str: string, table: ReadonlyMap<string, string>): string => {
			let out = "";
			for (let i = 0; i < str.length; ) {
				if (str[i] === "\x1b") {
					const next = str[i + 1];
					if (next === "[") {
						let j = i + 2;
						while (j < str.length && !/[a-zA-Z~]/.test(str[j]!)) j++;
						out += str.slice(i, j + 1);
						i = j + 1;
						continue;
					}
					if (next === "_") {
						const bel = str.indexOf("\x07", i + 2);
						if (bel >= 0) {
							out += str.slice(i, bel + 1);
							i = bel + 1;
							continue;
						}
					}
				}
				const ch = str[i]!;
				out += table.get(ch) ?? ch;
				i++;
			}
			return out;
		};

		const lines = [
			"",
			"a",
			"hello",
			"\x1b[31mhello world\x1b[0m",
			"abc\x1b[32mdef\x1b[0mghi",
			"\x1b_pi:c\x07hello\x1b[1mworld\x1b[0m",
			"\x1b[48;5;236m\x1b[36mconst x;\x1b[39m // c\x1b[0m",
			"\x1b[31m\x1b[42mxy\x1b[0m",
			"  \x1b[33mhi\x1b[0m  ",
		];
		let totalCases = 0;
		for (const line of lines) {
			const slowLine = mapTextOutsideAnsi(line, toNonAscii);
			for (let beforeEnd = -3; beforeEnd <= 12; beforeEnd++) {
				for (let afterStart = -6; afterStart <= 12; afterStart++) {
					for (let afterLen = -2; afterLen <= 8; afterLen++) {
						for (const strictAfter of [false, true]) {
							totalCases++;
							const actual = extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter);
							const rawSlow = extractSegments(slowLine, beforeEnd, afterStart, afterLen, strictAfter);
							const expected = {
								before: mapTextOutsideAnsi(rawSlow.before, toAscii),
								beforeWidth: rawSlow.beforeWidth,
								after: mapTextOutsideAnsi(rawSlow.after, toAscii),
								afterWidth: rawSlow.afterWidth,
							};
							assert.deepStrictEqual(
								actual,
								expected,
								`mismatch for line=${JSON.stringify(line)} beforeEnd=${beforeEnd} afterStart=${afterStart} afterLen=${afterLen} strictAfter=${strictAfter}`,
							);
						}
					}
				}
			}
		}
		assert.ok(totalCases >= 60_000, `expected >= 60,000 cases, ran ${totalCases}`);
	});
});
