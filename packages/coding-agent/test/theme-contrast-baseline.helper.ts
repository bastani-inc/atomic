// Phase 0 contrast baseline generator (report only — no rendering effect).
//
// This module derives the *rendered* surface-to-foreground mapping: every pair
// is the foreground token as it is actually painted, on the background it is
// actually painted on, in a given color mode. It is grounded in the renderers:
//
//   - Assistant prose paints on the terminal canvas (assistant-message.ts adds
//     no background box); its Markdown/syntax tokens therefore contrast the
//     canvas.
//   - User messages paint Markdown inside `userMessageBg`
//     (user-message.ts: `Box(..., theme.bg("userMessageBg", ...))`, base text
//     overridden to `userMessageText`; headings/code/syntax keep the Markdown
//     palette — see pi-tui markdown.js `defaultTextStyle.color` vs `theme.*`).
//   - Custom messages paint Markdown inside `customMessageBg`
//     (custom-message.ts), with `customMessageLabel` for the `[type]` tag.
//   - Tool boxes paint `toolTitle`/`toolOutput`/diffs/`muted` hints inside
//     `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` (tool-execution.ts).
//   - Selection composes `text`/`muted`/`accent` on `selectedBg`
//     (host-input-form.ts, transcript-follow-indicator.ts, tree-selector-list.ts).
//   - The working indicator paints its tones on the canvas
//     (atomic-working-status.ts).
//
// Only genuine canvas foregrounds are swept against the ASSUMED terminal
// canvas; context-specific tokens are never scored against the canvas.
//
// `searchMatchText`/`searchMatchBg` are intentionally excluded: transcript
// search was removed from `main`, so that pair is a loadable compatibility
// fallback (theme-class.ts still resolves it) rather than a visible surface.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getThemesDir } from "../src/config.ts";
import {
	type ColorMode,
	contrastRatio,
	quantizeColorValueToHex,
	rateContrast,
	resolveVarRefs,
} from "../src/modes/interactive/theme/color-utils.ts";
import { isLightTheme } from "../src/modes/interactive/theme/theme.ts";
import type { ColorValue } from "../src/modes/interactive/theme/theme-schema.ts";

export const BUNDLED_THEME_NAMES = [
	"dark",
	"light",
	"catppuccin-frappe",
	"catppuccin-latte",
	"catppuccin-macchiato",
	"catppuccin-mocha",
] as const;

export const COLOR_MODES = ["truecolor", "256color"] as const satisfies readonly ColorMode[];

// Assumed terminal defaults. These are the terminal's own colors, used only
// where a token is the terminal default (`""`): a `""` foreground resolves to
// the assumed default text, a `""` background to the assumed canvas. They are
// NOT quantized in 256-color mode — the terminal paints its own defaults, and
// only theme colors pass through `fgAnsi()`/`bgAnsi()`.
export const ASSUMED = {
	dark: { canvasBg: "#1e1e1e", text: "#cdd6f4" },
	light: { canvasBg: "#ffffff", text: "#1e1e2e" },
} as const;

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3.0;

// Markdown palette painted in every prose surface (assistant/user/custom).
const MD_FG = [
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
] as const;

// Syntax palette painted inside fenced code blocks in every prose surface.
const SYNTAX_FG = [
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
] as const;

// Foregrounds painted directly on the terminal canvas (chrome + assistant prose).
const CANVAS_FG = [
	"text",
	"thinkingText",
	"accent",
	"muted",
	"dim",
	"success",
	"error",
	"warning",
	"border",
	"borderAccent",
	"borderMuted",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
	"scrollbarThumb",
	...MD_FG,
	...SYNTAX_FG,
] as const;

// Foregrounds painted inside a tool box.
const TOOL_FG = ["toolTitle", "toolOutput", "muted", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext"] as const;

// Non-text tokens (borders, rules, box-drawing, indicators). WCAG applies the
// 3.0 large/non-text threshold to these rather than 4.5.
const NON_TEXT = new Set<string>([
	"border",
	"borderAccent",
	"borderMuted",
	"mdHr",
	"mdCodeBlockBorder",
	"mdQuoteBorder",
	"scrollbarThumb",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
]);

interface Surface {
	readonly label: string;
	// Background token name, or null for the terminal canvas.
	readonly bgToken: string | null;
	readonly foregrounds: readonly string[];
}

const SURFACES: readonly Surface[] = [
	{ label: "canvas", bgToken: null, foregrounds: CANVAS_FG },
	{ label: "userMessageBg", bgToken: "userMessageBg", foregrounds: ["userMessageText", ...MD_FG, ...SYNTAX_FG] },
	{
		label: "customMessageBg",
		bgToken: "customMessageBg",
		foregrounds: ["customMessageText", "customMessageLabel", ...MD_FG, ...SYNTAX_FG],
	},
	{ label: "toolPendingBg", bgToken: "toolPendingBg", foregrounds: TOOL_FG },
	{ label: "toolSuccessBg", bgToken: "toolSuccessBg", foregrounds: TOOL_FG },
	{ label: "toolErrorBg", bgToken: "toolErrorBg", foregrounds: TOOL_FG },
	{ label: "selectedBg", bgToken: "selectedBg", foregrounds: ["text", "muted", "accent"] },
];

// Working-indicator tones, painted on the canvas (atomic-working-status.ts).
const WORKING_INDICATOR_TONES = ["dark", "lift", "muted", "accent", "bright", "peak"] as const;

interface ThemeFile {
	colors: Record<string, ColorValue>;
	vars?: Record<string, ColorValue>;
	workingIndicator?: Partial<Record<(typeof WORKING_INDICATOR_TONES)[number], ColorValue>>;
}

export interface Row {
	readonly pair: string;
	readonly kind: "text" | "non-text";
	readonly fgHex: string;
	readonly bgHex: string;
	readonly ratio: number;
	readonly rating: string;
}

function readThemeFile(name: string): ThemeFile {
	return JSON.parse(readFileSync(join(getThemesDir(), `${name}.json`), "utf8")) as ThemeFile;
}

/** Apply the same optional-token fallbacks as theme-class.ts. */
function resolveWithFallback(
	colors: Record<string, ColorValue>,
	vars: Record<string, ColorValue>,
	name: string,
): ColorValue | undefined {
	const raw = name in colors ? colors[name] : name === "scrollbarThumb" ? colors.selectedBg : undefined;
	return raw === undefined ? undefined : resolveVarRefs(raw, vars);
}

export function measureTheme(name: string, mode: ColorMode): Row[] {
	const { colors, vars = {}, workingIndicator } = readThemeFile(name);
	const assumed = isLightTheme(name) ? ASSUMED.light : ASSUMED.dark;
	const rows: Row[] = [];

	const push = (fgToken: string, bgToken: string | null, bgLabel: string): void => {
		const rawFg = resolveWithFallback(colors, vars, fgToken);
		// "" foreground → assumed terminal-default text (not quantized).
		const fgHex = (rawFg === undefined ? undefined : quantizeColorValueToHex(rawFg, mode)) ?? assumed.text;
		let bgHex: string;
		if (bgToken === null) {
			bgHex = assumed.canvasBg; // terminal canvas, not quantized
		} else {
			const rawBg = resolveWithFallback(colors, vars, bgToken);
			bgHex = (rawBg === undefined ? undefined : quantizeColorValueToHex(rawBg, mode)) ?? assumed.canvasBg;
		}
		const ratio = contrastRatio(fgHex, bgHex);
		rows.push({
			pair: `${fgToken} on ${bgLabel}`,
			kind: NON_TEXT.has(fgToken) ? "non-text" : "text",
			fgHex,
			bgHex,
			ratio,
			rating: rateContrast(ratio),
		});
	};

	for (const surface of SURFACES) {
		for (const fgToken of surface.foregrounds) {
			push(fgToken, surface.bgToken, surface.label);
		}
	}

	// Working-indicator tones (only when the theme defines them).
	for (const tone of WORKING_INDICATOR_TONES) {
		const raw = workingIndicator?.[tone];
		if (raw === undefined) continue;
		const resolved = resolveVarRefs(raw, vars);
		const fgHex = quantizeColorValueToHex(resolved, mode) ?? assumed.text;
		const ratio = contrastRatio(fgHex, assumed.canvasBg);
		rows.push({
			pair: `workingIndicator.${tone} on canvas`,
			kind: "non-text",
			fgHex,
			bgHex: assumed.canvasBg,
			ratio,
			rating: rateContrast(ratio),
		});
	}

	return rows.sort((a, b) => a.ratio - b.ratio || a.pair.localeCompare(b.pair));
}

/**
 * A stable fingerprint of the baseline's inputs (the six theme files). It
 * changes only when the measured source changes, so the committed report can
 * carry a "source revision" without a git SHA that would drift every commit.
 */
export function themeSourceFingerprint(): string {
	const hash = createHash("sha256");
	for (const name of BUNDLED_THEME_NAMES) {
		hash.update(name);
		hash.update("\0");
		hash.update(readFileSync(join(getThemesDir(), `${name}.json`)));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

export const GENERATION_COMMAND =
	"UPDATE_CONTRAST_BASELINE=1 npm run test --workspace=@bastani/atomic -- theme-contrast-baseline";

export function generateBaselineMarkdown(): string {
	const lines: string[] = [];
	lines.push("# Theme contrast baseline (Phase 0 — report only)");
	lines.push("");
	lines.push(
		"Generated, checked-in WCAG 2.x contrast measurement across the six built-in themes.",
		"This is a **measurement baseline only** — no theme values change, and nothing gates",
		"the build on it. Regenerate with the command below; a test asserts this file stays",
		"in sync with the generator.",
		"",
	);
	lines.push(`- Generation command: \`${GENERATION_COMMAND}\``);
	lines.push(`- Theme source fingerprint: \`${themeSourceFingerprint()}\``);
	lines.push(
		`- WCAG thresholds: AA normal text \`>= ${WCAG_AA_NORMAL}\`, AA large / non-text \`>= ${WCAG_AA_LARGE}\``,
	);
	lines.push("");
	lines.push("## Assumptions");
	lines.push("");
	lines.push(
		"Each color is measured on the background where it actually renders (see",
		"`test/theme-contrast-baseline.helper.ts` for the surface → foreground mapping).",
		'Where a token is the terminal default (`""`), these assumed terminal colors are',
		"substituted; assumed values are the terminal's own colors and are **not** quantized",
		"in 256-color mode (only theme colors pass through `fgAnsi()`/`bgAnsi()`):",
		"",
	);
	lines.push("| theme kind | assumed canvas bg | assumed default text |");
	lines.push("|---|---|---|");
	lines.push(`| dark | \`${ASSUMED.dark.canvasBg}\` | \`${ASSUMED.dark.text}\` |`);
	lines.push(`| light | \`${ASSUMED.light.canvasBg}\` | \`${ASSUMED.light.text}\` |`);
	lines.push("");
	lines.push(
		"`searchMatchText`/`searchMatchBg` are omitted: transcript search was removed from",
		"`main`, so the pair is a loadable compatibility fallback, not a visible surface.",
		"",
	);

	for (const mode of COLOR_MODES) {
		lines.push(`## ${mode}`);
		for (const name of BUNDLED_THEME_NAMES) {
			lines.push("");
			lines.push(`### ${name} (${isLightTheme(name) ? "light" : "dark"})`);
			lines.push("");
			lines.push("| rating | ratio | kind | pair | fg | bg |");
			lines.push("|---|---:|---|---|---|---|");
			for (const r of measureTheme(name, mode)) {
				lines.push(
					`| ${r.rating} | ${r.ratio.toFixed(2)} | ${r.kind} | ${r.pair} | \`${r.fgHex}\` | \`${r.bgHex}\` |`,
				);
			}
		}
		lines.push("");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

export const BASELINE_MARKDOWN_PATH = join(import.meta.dirname, "theme-contrast-baseline.md");
