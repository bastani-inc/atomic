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

// Phase 0 methodology: flat tokens set to "" (terminal default) have no
// author-known background, so we measure foregrounds against an ASSUMED canvas
// and themed *Bg tokens against an ASSUMED text color. Rows are directional,
// not verdicts on any one terminal — which is itself the argument for the gate.
const ASSUMED = {
	dark: { canvasBg: "#1e1e1e", text: "#cdd6f4" },
	light: { canvasBg: "#ffffff", text: "#1e1e2e" },
} as const;

interface Row {
	token: string;
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
	const rows: Row[] = [];
	for (const [token, value] of Object.entries(resolved)) {
		const hex = colorValueToHex(value);
		if (!hex) continue; // terminal-default: unknowable here
		const isBg = /bg$/i.test(token);
		const [a, b, pair] = isBg
			? [assumed.text, hex, `text on ${token} (assumed)`]
			: [hex, assumed.canvasBg, `${token} on canvas (assumed)`];
		const ratio = contrastRatio(a, b);
		rows.push({ token, pair, ratio, rating: rateContrast(ratio) });
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
});
