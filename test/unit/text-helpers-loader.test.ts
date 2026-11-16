import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { test } from "vitest";
import { visibleWidth, wrapPlainText } from "../../packages/workflows/src/tui/text-helpers.js";

type TextHelpers = typeof import("../../packages/workflows/src/tui/text-helpers.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("workflows text helpers load through extension-loader pi-tui aliases and wrap long words and many short words in linear width work (#5234)", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "atomic-pi-tui-alias-"));

	try {
		const piTuiShimPath = path.join(tempDir, "pi-tui-root.mjs");
		await writeFile(
			piTuiShimPath,
			`export let visibleWidthCalls = 0;
export let visibleWidthChars = 0;
export function resetVisibleWidthCounts() {
  visibleWidthCalls = 0;
  visibleWidthChars = 0;
}
export function decodeKittyPrintable(data) {
  return data === "\\x1b[65;2u" ? "A" : undefined;
}
export function matchesKey(data, key) {
  return data === key;
}
export function truncateToWidth(text, width, suffix = "") {
  return text.length > width ? text.slice(0, Math.max(0, width - suffix.length)) + suffix : text;
}
export function visibleWidth(text) {
  visibleWidthCalls += 1;
  visibleWidthChars += [...text].length;
  return [...text].length;
}
`,
		);

		const jiti = createJiti(import.meta.url, {
			moduleCache: false,
			alias: {
				"@bastani/atomic-tui": piTuiShimPath,
			},
		});

		const shim = (await jiti.import(piTuiShimPath)) as {
			visibleWidthCalls: number;
			visibleWidthChars: number;
			resetVisibleWidthCounts: () => void;
		};
		const helpers = (await jiti.import(
			path.resolve(__dirname, "../../packages/workflows/src/tui/text-helpers.ts"),
		)) as TextHelpers;

		assert.equal(typeof helpers.decodePrintableKey, "function");
		assert.equal(helpers.decodePrintableKey("\x1b[65;2u"), "A");
		assert.equal(helpers.decodePrintableKey("\x1b[27;2;65~"), "A");

		shim.resetVisibleWidthCounts();
		const longWord = "E".repeat(4_096);
		const wrapped = helpers.wrapPlainText(longWord, 120);
		assert.equal(wrapped.join(""), longWord);
		assert.ok(
			shim.visibleWidthChars <= longWord.length * 2,
			`expected O(graphemes) visibleWidth work, got ${shim.visibleWidthChars} chars across ${shim.visibleWidthCalls} calls`,
		);

		shim.resetVisibleWidthCounts();
		const manyShortWords = Array.from({ length: 4_000 }, (_, index) => (index % 2 === 0 ? "ab" : "cde")).join(" ");
		const wrappedShortWords = helpers.wrapPlainText(manyShortWords, 120);
		assert.equal(wrappedShortWords.join(" "), manyShortWords);
		assert.ok(shim.visibleWidthCalls > 0);
		assert.ok(
			shim.visibleWidthChars <= manyShortWords.length * 2,
			`expected O(words) visibleWidth work, got ${shim.visibleWidthChars} chars across ${shim.visibleWidthCalls} calls`,
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("wrapPlainText keeps rows within budget when words start with combining or spacing marks (#5234)", () => {
	const cases: ReadonlyArray<{ readonly text: string; readonly width: number; readonly expected: readonly string[] }> =
		[
			{ text: "🏻 \u0301\u093f😀 Ａ", width: 8, expected: ["🏻 \u0301\u093f😀", "Ａ"] },
			{ text: "🏻 ः\u0301 b", width: 5, expected: ["🏻 ः\u0301", "b"] },
			{ text: "b ःﾞ Ａ", width: 6, expected: ["b ःﾞ", "Ａ"] },
			{ text: "Ａ ि่ 😀", width: 6, expected: ["Ａ ि่", "😀"] },
		];

	for (const { text, width, expected } of cases) {
		const rows = wrapPlainText(text, width);
		assert.deepEqual(rows, expected);
		for (const row of rows) {
			assert.ok(
				visibleWidth(row) <= width,
				`row exceeds width ${width}: ${JSON.stringify(row)} (w=${visibleWidth(row)})`,
			);
		}
	}

	const ansiCombining = "🏻 \x1b[31m\u0301\u093f😀\x1b[0m Ａ";
	const ansiRows = wrapPlainText(ansiCombining, 8);
	assert.equal(ansiRows.join(" "), ansiCombining);
	for (const row of ansiRows) {
		assert.ok(visibleWidth(row) <= 8, `row exceeds width 8: ${JSON.stringify(row)} (w=${visibleWidth(row)})`);
	}
});
