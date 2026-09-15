import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BASELINE_MARKDOWN_PATH,
	BUNDLED_THEME_NAMES,
	COLOR_MODES,
	generateBaselineMarkdown,
	measureTheme,
} from "./theme-contrast-baseline.helper.ts";

// Phase 0 methodology.
//
// Every color is measured on the background where it actually renders — user /
// custom messages paint Markdown inside their message background, tool boxes
// paint titles/output/diffs inside pending/success/error backgrounds, selection
// composes foregrounds on `selectedBg`, and only genuine canvas foregrounds are
// swept against the assumed terminal canvas. Both truecolor and 256-color
// (quantized through `fgAnsi()`/`bgAnsi()`) results are emitted. See
// `theme-contrast-baseline.helper.ts` for the full surface → foreground mapping.
//
// This is report only: it asserts the WCAG math is well-formed and that the
// checked-in Markdown baseline stays in sync with the generator. It does NOT
// gate the build on any theme passing.

describe("theme contrast baseline (Phase 0 — report only)", () => {
	it("produces a well-formed contrast measurement for every theme and color mode", () => {
		for (const mode of COLOR_MODES) {
			for (const name of BUNDLED_THEME_NAMES) {
				const rows = measureTheme(name, mode);
				expect(rows.length, `${name} (${mode}): no measurable tokens`).toBeGreaterThan(0);
				for (const r of rows) {
					expect(Number.isFinite(r.ratio) && r.ratio >= 1 && r.ratio <= 21.01, `${name} ${mode}: ${r.pair}`).toBe(
						true,
					);
					expect(["AA", "AA-large", "FAIL"]).toContain(r.rating);
				}
			}
		}
	});

	it("measures context-specific content text on its real background, not the canvas", () => {
		// Regression guard for the review finding: content tokens must be paired
		// with the background they render on, never scored against the canvas.
		const pairs = measureTheme("catppuccin-mocha", "truecolor").map((r) => r.pair);
		expect(pairs).toContain("userMessageText on userMessageBg");
		expect(pairs).toContain("customMessageText on customMessageBg");
		expect(pairs).toContain("customMessageLabel on customMessageBg");
		expect(pairs).toContain("toolTitle on toolPendingBg");
		expect(pairs).toContain("toolOutput on toolErrorBg");
		expect(pairs).toContain("mdHeading on userMessageBg");
		expect(pairs).toContain("syntaxKeyword on customMessageBg");
		expect(pairs).toContain("accent on selectedBg");
		expect(pairs).toContain("workingIndicator.peak on canvas");
		// Never scored against the canvas, and the removed search pair never appears.
		expect(pairs).not.toContain("userMessageText on canvas");
		expect(pairs.some((p) => p.startsWith("searchMatch"))).toBe(false);
	});

	it("quantizes to a 256-color palette that can change a rating", () => {
		// The whole point of emitting a 256-color column: quantization is not a
		// no-op. Somewhere across the six themes at least one ratio must differ
		// between truecolor and 256-color.
		let anyDifference = false;
		for (const name of BUNDLED_THEME_NAMES) {
			const truecolor = new Map(measureTheme(name, "truecolor").map((r) => [r.pair, r.ratio]));
			for (const r of measureTheme(name, "256color")) {
				if (Math.abs((truecolor.get(r.pair) ?? r.ratio) - r.ratio) > 1e-6) {
					anyDifference = true;
					break;
				}
			}
			if (anyDifference) break;
		}
		expect(anyDifference).toBe(true);
	});

	it("keeps the checked-in Markdown baseline in sync with the generator", () => {
		const generated = generateBaselineMarkdown();
		if (process.env.UPDATE_CONTRAST_BASELINE) {
			writeFileSync(BASELINE_MARKDOWN_PATH, generated);
			return;
		}
		const committed = readFileSync(BASELINE_MARKDOWN_PATH, "utf8");
		expect(
			committed,
			`Checked-in contrast baseline is stale. Regenerate with:\n  UPDATE_CONTRAST_BASELINE=1 npm run test --workspace=@bastani/atomic -- theme-contrast-baseline`,
		).toBe(generated);
	});
});
