import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getThemesDir } from "../src/config.ts";
import {
	colorValueToHex,
	contrastRatio,
	rateContrast,
	resolveThemeColors,
} from "../src/modes/interactive/theme/color-utils.ts";
import { isLightTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ColorValue } from "../src/modes/interactive/theme/theme-schema.ts";

const BUNDLED_THEME_NAMES = [
	"dark",
	"light",
	"catppuccin-frappe",
	"catppuccin-latte",
	"catppuccin-macchiato",
	"catppuccin-mocha",
] as const;

// Phase 0 methodology.
//
// Content text is composed with its *context-specific* background, not the
// terminal canvas — user/custom messages, tool boxes, search matches and
// selection all paint a background and draw their text on it (see
// user-message.ts, custom-message.ts, tool-execution.ts, interactive-tui.ts).
// We measure those visible pairs directly. Only foregrounds that genuinely
// render on the terminal-default canvas are measured against an ASSUMED canvas
// (`#1e1e1e` / `#ffffff`); a foreground token of "" (terminal default) falls
// back to the assumed terminal text, and a background of "" to the assumed
// canvas — mirroring what the user actually sees. Optional tokens resolve
// through the same fallbacks as theme-class.ts.
const ASSUMED = {
	dark: { canvasBg: "#1e1e1e", text: "#cdd6f4" },
	light: { canvasBg: "#ffffff", text: "#1e1e2e" },
} as const;

const BG_TOKENS = new Set([
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"searchMatchBg",
	"scrollbarThumb",
]);

// Foreground tokens that are only ever drawn on a context-specific background,
// never on the canvas. Kept out of the canvas sweep and measured via pairs.
const PAIRED_FG = new Set([
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"searchMatchText",
]);

// Rendered foreground → background pairs the user actually sees.
const RENDERED_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["userMessageText", "userMessageBg"],
	["customMessageText", "customMessageBg"],
	["customMessageLabel", "customMessageBg"],
	["toolTitle", "toolPendingBg"],
	["toolTitle", "toolSuccessBg"],
	["toolTitle", "toolErrorBg"],
	["toolOutput", "toolPendingBg"],
	["toolOutput", "toolSuccessBg"],
	["toolOutput", "toolErrorBg"],
	["searchMatchText", "searchMatchBg"],
	// Selection highlights compose these foregrounds on `selectedBg`.
	["text", "selectedBg"],
	["muted", "selectedBg"],
	["accent", "selectedBg"],
];

/** Resolve a token, applying the same optional-token fallbacks as theme-class.ts. */
function resolveWithFallback(resolved: Record<string, string | number>, name: string): string | number | undefined {
	if (name in resolved) return resolved[name];
	if (name === "searchMatchText") return resolved.text;
	if (name === "searchMatchBg" || name === "scrollbarThumb") return resolved.selectedBg;
	return undefined;
}

interface Row {
	pair: string;
	ratio: number;
	rating: string;
}

function measureTheme(name: string): Row[] {
	const content = JSON.parse(readFileSync(join(getThemesDir(), `${name}.json`), "utf8")) as {
		colors: Record<string, ColorValue>;
		vars?: Record<string, ColorValue>;
	};
	const resolved = resolveThemeColors(content.colors, content.vars ?? {});
	const assumed = isLightTheme(name) ? ASSUMED.light : ASSUMED.dark;
	const hexOf = (name_: string): string | undefined => {
		const value = resolveWithFallback(resolved, name_);
		return value === undefined ? undefined : colorValueToHex(value);
	};
	const rows: Row[] = [];

	// Visible composed foreground/background pairs.
	for (const [fgToken, bgToken] of RENDERED_PAIRS) {
		const fg = hexOf(fgToken) ?? assumed.text; // "" foreground → terminal default text
		const bg = hexOf(bgToken) ?? assumed.canvasBg; // "" background → canvas
		const ratio = contrastRatio(fg, bg);
		rows.push({ pair: `${fgToken} on ${bgToken}`, ratio, rating: rateContrast(ratio) });
	}

	// Scrollbar thumb is a non-text UI element measured against the canvas.
	const thumb = hexOf("scrollbarThumb");
	if (thumb) {
		const ratio = contrastRatio(thumb, assumed.canvasBg);
		rows.push({ pair: "scrollbarThumb on canvas", ratio, rating: rateContrast(ratio) });
	}

	// Remaining foregrounds render directly on the terminal-default canvas.
	for (const [token, value] of Object.entries(resolved)) {
		if (BG_TOKENS.has(token) || PAIRED_FG.has(token)) continue;
		const hex = colorValueToHex(value);
		if (!hex) continue; // "" terminal-default foreground: unknowable
		const ratio = contrastRatio(hex, assumed.canvasBg);
		rows.push({ pair: `${token} on canvas`, ratio, rating: rateContrast(ratio) });
	}

	return rows.sort((x, y) => x.ratio - y.ratio);
}

describe("theme contrast baseline (Phase 0 — report only)", () => {
	it("emits a per-theme contrast table for the six built-in themes", () => {
		const lines: string[] = [];
		for (const name of BUNDLED_THEME_NAMES) {
			const rows = measureTheme(name);
			expect(rows.length, `${name}: no measurable tokens`).toBeGreaterThan(0);
			lines.push(`\n### ${name} (${isLightTheme(name) ? "light" : "dark"})`);
			lines.push("| rating | ratio | pair |");
			lines.push("|---|---:|---|");
			for (const r of rows) {
				lines.push(`| ${r.rating} | ${r.ratio.toFixed(2)} | ${r.pair} |`);
				// report-only: assert the math is well-formed, NOT that themes pass
				expect(Number.isFinite(r.ratio) && r.ratio >= 1 && r.ratio <= 21.01, r.pair).toBe(true);
			}
		}
		// Surfaces the baseline in test output; no build gate in Phase 0.
		console.log(lines.join("\n"));
	});

	it("measures paired content text on its real background, not the canvas", () => {
		// Regression guard for the review finding: userMessageText must be paired
		// with userMessageBg, never scored against the assumed canvas.
		const rows = measureTheme("catppuccin-mocha");
		const pairs = rows.map((r) => r.pair);
		expect(pairs).toContain("userMessageText on userMessageBg");
		expect(pairs).toContain("customMessageText on customMessageBg");
		expect(pairs).toContain("searchMatchText on searchMatchBg");
		expect(pairs).not.toContain("userMessageText on canvas");
	});
});
