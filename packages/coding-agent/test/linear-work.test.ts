import assert from "node:assert/strict";
import chalk from "chalk";
import { applyPatch, lineDiff, wordDiff } from "diff";
import { beforeAll, describe, it } from "vitest";
import { generateEditDiff, generateUnifiedPatch } from "../src/core/tools/edit-diff.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

/**
 * Input sizes ten times apart. A bound per unit of input that holds at both leaves no room for work that grows with
 * the square of the input.
 */
const SIZES = [2_000, 20_000] as const;
/**
 * Token comparisons per word of a modified line pair. Highlighting stops comparing once the lines need more edits than
 * a highlight can usefully show, so the comparisons left are a fixed number plus a few per word.
 */
const WORD_COMPARISONS_PER_WORD = 4;
/**
 * Line comparisons per line of a rewritten block, for the display diff and the patch together. Each diff stops once
 * the block needs more line edits than it would show line by line, so the comparisons left are a fixed number plus a
 * few per line.
 */
const LINE_COMPARISONS_PER_LINE = 32;

type Differ = { equals(left: string, right: string, options: object): boolean };

/** Calls `run` and returns how many tokens `differ` compared meanwhile. Unlike a spy, it keeps no arguments. */
function countComparisons(differ: Differ, run: () => void): number {
	const own = Object.getOwnPropertyDescriptor(differ, "equals");
	const compare = differ.equals;
	let comparisons = 0;
	differ.equals = function (this: Differ, left: string, right: string, options: object): boolean {
		comparisons++;
		return compare.call(this, left, right, options);
	};
	try {
		run();
	} finally {
		if (own) Object.defineProperty(differ, "equals", own);
		else Reflect.deleteProperty(differ, "equals");
	}
	return comparisons;
}

/** `count` words from a vocabulary of 997, the `index`th being word `offset + index * step`. */
function words(count: number, step: number, offset: number): string {
	return Array.from({ length: count }, (_, index) => `w${(offset + index * step) % 997}`).join(" ");
}

describe("diff rendering does work linear in its input", () => {
	it("renderDiff highlights a long modified line with word comparisons linear in its length", () => {
		for (const count of SIZES) {
			const diff = `-1 ${words(count, 7, 0)}\n+1 ${words(count, 13, 3)}`;
			const made = countComparisons(wordDiff, () => {
				assert.equal(renderDiff(diff).split("\n").length, 2);
			});
			const bound = WORD_COMPARISONS_PER_WORD * 2 * count;
			assert.ok(made <= bound, `${count} words: ${made} token comparisons, bound ${bound}`);
		}
	});

	it("generateEditDiff diffs a rewritten block with line comparisons linear in its length", () => {
		for (const count of SIZES) {
			const block = (prefix: string) => Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");
			const base = `head\n${block("old")}tail\n`;
			const changed = `head\n${block("new")}tail\n`;
			const replacements = [{ matchIndex: 5, matchLength: base.length - 10, newText: block("new") }];
			const made = countComparisons(lineDiff, () => {
				const { patch } = generateEditDiff("f.txt", base, changed, replacements);
				assert.equal(applyPatch(base, patch), changed);
			});
			const bound = LINE_COMPARISONS_PER_LINE * 2 * count;
			assert.ok(made <= bound, `${count} lines: ${made} line comparisons, bound ${bound}`);
		}
	});
});

describe("bounded diffs keep their output", () => {
	it("renderDiff still highlights the changed words of a long line with few changes", () => {
		const before = words(SIZES[1], 1, 0);
		const after = before.replace("w10 ", "changed ").replace("w500 ", "edited ");
		const level = chalk.level;
		chalk.level = 1;
		try {
			const [removed, added] = renderDiff(`-1 ${before}\n+1 ${after}`).split("\n");
			assert.match(removed!, /\x1b\[7mw10\x1b\[27m/);
			assert.match(added!, /\x1b\[7mchanged\x1b\[27m/);
			assert.match(added!, /\x1b\[7medited\x1b\[27m/);
		} finally {
			chalk.level = level;
		}
	});

	it("generateEditDiff shows a block rewritten past the diff bound as the whole-file diff does", () => {
		for (const ending of ["\n", ""]) {
			for (const [before, after] of [
				[30, 30],
				[0, 30],
				[30, 0],
				[2, 1],
			] as const) {
				const lines = (prefix: string, count: number) =>
					Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
				const context = (prefix: string, count: number) => lines(prefix, count).map((line) => `${line}\n`);
				const head = context("head", before).join("");
				const oldBlock = lines("old", 600).join("\n");
				const newBlock = lines("new", 500).join("\n");
				const tail = after > 0 ? `\n${lines("tail", after).join("\n")}${ending}` : ending;
				const base = `${head}${oldBlock}${tail}`;
				const changed = `${head}${newBlock}${tail}`;
				const replacements = [{ matchIndex: head.length, matchLength: oldBlock.length, newText: newBlock }];
				const windowed = generateEditDiff("f.txt", base, changed, replacements);
				assert.equal(windowed.patch, generateUnifiedPatch("f.txt", base, changed), `${before}/${after}`);
				assert.equal(applyPatch(base, windowed.patch), changed);
				const shown = windowed.diff.split("\n");
				assert.equal(shown.filter((line) => line.startsWith("-")).length, 600);
				assert.equal(shown.filter((line) => line.startsWith("+")).length, 500);
			}
		}
	});
});
