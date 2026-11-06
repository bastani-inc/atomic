import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPatch } from "diff";
import { describe, expect, it, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import {
	generateDiffString,
	generateEditDiff,
	generateUnifiedPatch,
	type TextReplacement,
} from "../src/core/tools/edit-diff.js";

useTemporaryAgentDir();

const diffedChars = vi.hoisted(() => ({ total: 0 }));

vi.mock("diff", async (importOriginal) => {
	const original = await importOriginal<typeof import("diff")>();
	return {
		...original,
		diffLines: (...args: Parameters<typeof original.diffLines>) => {
			diffedChars.total += args[0].length + args[1].length;
			return original.diffLines(...args);
		},
		structuredPatch: (...args: Parameters<typeof original.structuredPatch>) => {
			diffedChars.total += args[2].length + args[3].length;
			return original.structuredPatch(...args);
		},
		createTwoFilesPatch: (...args: Parameters<typeof original.createTwoFilesPatch>) => {
			diffedChars.total += args[2].length + args[3].length;
			return original.createTwoFilesPatch(...args);
		},
	};
});

/** A child Node process loads edit-diff from source and diffs a 20 MB file: structural, not a slow test. */
const CHILD_PROCESS_TIMEOUT_MS = 120_000;
// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;

/** Small deterministic generator (mulberry32), using the high bits. */
function createRandom(seed: number): (max: number) => number {
	let state = seed;
	return (max) => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
	};
}

function applyReplacements(content: string, replacements: TextReplacement[]): string {
	let result = "";
	let position = 0;
	for (const replacement of replacements) {
		result += content.slice(position, replacement.matchIndex) + replacement.newText;
		position = replacement.matchIndex + replacement.matchLength;
	}
	return result + content.slice(position);
}

/** Random content and sorted, disjoint, non-empty replacements; `distinct` makes every line unique. */
function randomCase(random: (max: number) => number, distinct: boolean) {
	const lineCount = random(400);
	const lines = Array.from({ length: lineCount }, (_, i) => (distinct ? `line ${i}` : ["a", "b", "", "}"][random(4)]));
	const content = lines.join("\n") + (random(2) === 0 ? "\n" : "");
	const replacements: TextReplacement[] = [];
	let position = 0;
	const count = 1 + random(4);
	for (let i = 0; i < count && position < content.length; i++) {
		const matchIndex = position + random(Math.min(content.length - position, 300));
		if (matchIndex >= content.length) break;
		const matchLength = 1 + random(Math.min(content.length - matchIndex, 120));
		const newLines = Array.from({ length: random(4) }, (_, j) => `new ${i} ${j}`);
		const newText = random(3) === 0 ? "" : newLines.join("\n") + (random(2) === 0 ? "\n" : "");
		replacements.push({ matchIndex, matchLength, newText });
		position = matchIndex + matchLength;
	}
	return { content, replacements, newContent: applyReplacements(content, replacements) };
}

/**
 * Distinct lines, sometimes after an empty first line, with replacements far enough apart that their windows
 * often stay separate; the first one is often near the top, where a window reaches the start of the file.
 */
function sparseCase(random: (max: number) => number) {
	const lines = Array.from({ length: 200 + random(1300) }, (_, i) => `line ${i}`);
	const leading = random(3) === 0 ? "\n" : "";
	const content = leading + lines.join("\n") + (random(2) === 0 ? "\n" : "");
	const replacements: TextReplacement[] = [];
	let position = 0;
	const count = 1 + random(4);
	for (let i = 0; i < count && position < content.length; i++) {
		const gap = i === 0 && random(2) === 0 ? 40 : 4000;
		const matchIndex = position + random(Math.min(content.length - position, gap));
		if (matchIndex >= content.length) break;
		const matchLength = 1 + random(Math.min(content.length - matchIndex, 60));
		const newLines = Array.from({ length: random(4) }, (_, j) => `new ${i} ${j}`);
		const newText = random(3) === 0 ? "" : newLines.join("\n") + (random(2) === 0 ? "\n" : "");
		replacements.push({ matchIndex, matchLength, newText });
		position = matchIndex + matchLength;
	}
	return { content, replacements, newContent: applyReplacements(content, replacements) };
}

describe("generateEditDiff (pi #11751)", () => {
	it("matches the whole-file diff and patch when lines are distinct", () => {
		const random = createRandom(1);
		for (let run = 0; run < 2000; run++) {
			const { content, replacements, newContent } = randomCase(random, true);
			if (content === newContent) continue;
			const windowed = generateEditDiff("f.txt", content, newContent, replacements);
			const whole = generateDiffString(content, newContent);
			expect(windowed, `run ${run}`).toEqual({
				diff: whole.diff,
				patch: generateUnifiedPatch("f.txt", content, newContent),
				firstChangedLine: whole.firstChangedLine,
			});
		}
	});

	it("produces a patch that applies when lines repeat", () => {
		const random = createRandom(2);
		for (let run = 0; run < 2000; run++) {
			const { content, replacements, newContent } = randomCase(random, false);
			if (content === newContent) continue;
			const { patch } = generateEditDiff("f.txt", content, newContent, replacements);
			expect(applyPatch(content, patch), `run ${run}`).toBe(newContent);
		}
	});

	it("handles a replacement of many lines", () => {
		const newText = "x\n".repeat(150000);
		const replacements = [{ matchIndex: 0, matchLength: 2, newText }];
		const { patch } = generateEditDiff("f.txt", "a\nb\n", `${newText}b\n`, replacements);
		expect(applyPatch("a\nb\n", patch)).toBe(`${newText}b\n`);
	});

	it("matches the whole-file diff and patch when replacements are far apart, so their windows stay separate", () => {
		const random = createRandom(3);
		let separateWindows = 0;
		for (let run = 0; run < 600; run++) {
			const { content, replacements, newContent } = sparseCase(random);
			if (content === newContent) continue;
			const windowed = generateEditDiff("f.txt", content, newContent, replacements);
			const whole = generateDiffString(content, newContent);
			expect(windowed, `run ${run}`).toEqual({
				diff: whole.diff,
				patch: generateUnifiedPatch("f.txt", content, newContent),
				firstChangedLine: whole.firstChangedLine,
			});
			if (windowed.diff.includes("...\n") && windowed.diff.split("\n").length > 20) separateWindows++;
		}
		expect(separateWindows).toBeGreaterThan(100);
	});

	it("formats the display diff as the whole-file diff always has", () => {
		const base = "a\nb\nc\n";
		const changed = "a\nB\nc\n";
		const expected = { diff: " 1 a\n-2 b\n+2 B\n 3 c", firstChangedLine: 2 };

		expect(generateDiffString(base, changed)).toEqual(expected);
		expect(generateEditDiff("f.txt", base, changed, [{ matchIndex: 2, matchLength: 1, newText: "B" }])).toEqual({
			...expected,
			patch: generateUnifiedPatch("f.txt", base, changed),
		});
	});

	it("pads line numbers to the width of the larger line count", () => {
		const base = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
		const changed = base.replace("l9", "L9");
		const expected = { diff: "    ...\n  6 l5\n  7 l6\n  8 l7\n  9 l8\n-10 l9\n+10 L9", firstChangedLine: 10 };

		expect(generateDiffString(base, changed)).toEqual(expected);
		expect(
			generateEditDiff("f.txt", base, changed, [{ matchIndex: base.indexOf("l9"), matchLength: 2, newText: "L9" }]),
		).toMatchObject(expected);
	});

	it("honors a smaller context around separate windows", () => {
		const lines = Array.from({ length: 120 }, (_, i) => `l${i}`);
		const base = lines.join("\n");
		const changed = lines.map((line, i) => (i === 5 || i === 100 ? line.toUpperCase() : line)).join("\n");
		const replacements = [
			{ matchIndex: base.indexOf("l5\n"), matchLength: 2, newText: "L5" },
			{ matchIndex: base.indexOf("l100\n"), matchLength: 4, newText: "L100" },
		];

		const windowed = generateEditDiff("f.txt", base, changed, replacements, 1);
		const whole = generateDiffString(base, changed, 1);

		expect(windowed).toEqual({
			diff: whole.diff,
			patch: generateUnifiedPatch("f.txt", base, changed, 1),
			firstChangedLine: 6,
		});
		expect(windowed.diff.split("\n").filter((line) => line.trim() === "...")).toHaveLength(3);
	});

	it("diffs only the 32 lines on each side of a small change, where the whole-file diff reads every line", () => {
		const filler = `${"x".repeat(99)}\n`;
		const half = filler.repeat(10000);
		const base = `${half}TARGET = 1\n${half}`;
		const changed = `${half}TARGET = 2\n${half}`;
		const windowChars = 64 * filler.length + "TARGET = 1\n".length;

		diffedChars.total = 0;
		const windowed = generateEditDiff("big.txt", base, changed, [
			{ matchIndex: half.length, matchLength: 10, newText: "TARGET = 2" },
		]);
		const windowedTotal = diffedChars.total;

		diffedChars.total = 0;
		generateDiffString(base, changed);
		generateUnifiedPatch("big.txt", base, changed);
		const wholeFileTotal = diffedChars.total;

		expect(windowedTotal).toBe(2 * 2 * windowChars);
		expect(wholeFileTotal).toBe(2 * (base.length + changed.length));
		expect(windowed.diff.split("\n").filter((line) => /^[+-]/.test(line))).toEqual([
			"-10001 TARGET = 1",
			"+10001 TARGET = 2",
		]);
		expect(windowed.firstChangedLine).toBe(10001);
	});

	it("ends a window 32 lines after a replacement that ends with its line feed", () => {
		const filler = `${"x".repeat(99)}\n`;
		const half = filler.repeat(1000);
		const base = `${half}TARGET = 1\n${half}`;
		const changed = `${half}TARGET = 2\n${half}`;

		diffedChars.total = 0;
		generateEditDiff("big.txt", base, changed, [
			{ matchIndex: half.length, matchLength: "TARGET = 1\n".length, newText: "TARGET = 2\n" },
		]);

		expect(diffedChars.total).toBe(2 * 2 * (64 * filler.length + "TARGET = 1\n".length));
	});

	it("diffs two far-apart replacements in two windows instead of the lines between them", () => {
		const filler = `${"x".repeat(99)}\n`;
		const gap = filler.repeat(1000);
		const base = `${gap}ONE = 1\n${gap}TWO = 2\n${gap}`;
		const changed = `${gap}ONE = 10\n${gap}TWO = 20\n${gap}`;
		const secondIndex = base.indexOf("TWO = 2");

		diffedChars.total = 0;
		const windowed = generateEditDiff("big.txt", base, changed, [
			{ matchIndex: gap.length, matchLength: 7, newText: "ONE = 10" },
			{ matchIndex: secondIndex, matchLength: 7, newText: "TWO = 20" },
		]);

		const oldWindows = 2 * 64 * filler.length + "ONE = 1\n".length + "TWO = 2\n".length;
		const newWindows = 2 * 64 * filler.length + "ONE = 10\n".length + "TWO = 20\n".length;
		expect(diffedChars.total).toBe(2 * (oldWindows + newWindows));
		expect(windowed.diff.split("\n").filter((line) => /^[+-]/.test(line))).toEqual([
			"-1001 ONE = 1",
			"+1001 ONE = 10",
			"-2002 TWO = 2",
			"+2002 TWO = 20",
		]);
	});

	it(
		"diffs a small change in a 20 MB file with a 96 MB heap",
		() => {
			// A child process, so a regression to diffing the whole file runs out of memory instead of passing.
			const editDiffUrl = pathToFileURL(
				fileURLToPath(new URL("../src/core/tools/edit-diff.ts", import.meta.url)),
			).href;
			const script = `
				import { generateEditDiff } from ${JSON.stringify(editDiffUrl)};
				const filler = "x".repeat(99) + "\\n";
				const half = filler.repeat(100000);
				const base = half + "TARGET = 1\\n" + half;
				const replacement = { matchIndex: half.length, matchLength: 10, newText: "TARGET = 2" };
				const changed = half + "TARGET = 2\\n" + half;
				const { diff } = generateEditDiff("big.txt", base, changed, [replacement]);
				process.stdout.write(diff.split("\\n").filter((line) => /^[+-]/.test(line)).join("\\n"));
			`;
			const output = execFileSync(
				process.execPath,
				[
					"--max-old-space-size=96",
					"--import",
					`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
					"--input-type=module",
					"--eval",
					script,
				],
				{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
			);
			expect(output).toBe("-100001 TARGET = 1\n+100001 TARGET = 2");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);
});
