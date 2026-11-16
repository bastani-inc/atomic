import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { test } from "vitest";

type TextHelpers = typeof import("../../packages/workflows/src/tui/text-helpers.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("workflows text helpers load through extension-loader pi-tui aliases and wrap long words in linear width work (#5234)", async () => {
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
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
