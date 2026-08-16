/**
 * Colors and attributes a stage-chat search match is painted with.
 *
 * Owned by the stage-chat surface, not by the graph. `graph-theme.ts` maps a
 * host theme onto the overlay's role palette and is read by the graph and the
 * notification paths; find-in-stage-chat needs two tokens that palette has no
 * role for, so it reads them here instead of widening a module the graph owns.
 *
 * The two tokens are `searchMatchBg` and `searchMatchText` — exactly the pair
 * the fullscreen transcript search paints with — so a stage-chat match and a
 * transcript match look alike under any theme. Pi's accessors already return
 * ready-to-use SGR sequences, so they are used as they come: converting them
 * to `#rrggbb` and back would drop the ambient palette indices 0–15, which no
 * hex table can name, on themes that use them.
 *
 * cross-ref: specs/2026-08-14-pi-0.84.2-migration.md §5.5
 */

import { BOLD, hexBg, hexToAnsi, RESET } from "./color-utils.js";
import type { GraphTheme } from "./graph-theme.js";

const UNDERLINE = "\x1b[4m";
const INVERSE = "\x1b[7m";

/**
 * Structural subset of Pi's `Theme`. The overlay is a `.ts` extension loaded by
 * the host, so the concrete class cannot be imported without pulling the whole
 * host into this type graph; the two accessors are feature-detected instead.
 */
export interface PiSearchTheme {
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
}

/** Ready-to-emit SGR sequences for a search match. */
export interface SearchMatchAnsi {
	bg: string;
	text: string;
}

/**
 * Invoke a Pi theme accessor that throws on a token this theme lacks.
 *
 * The call is made **on the theme**. Pi's `Theme` reads instance fields through
 * `this` (`theme-class.ts:158-171`), so a detached `theme.getFgAnsi` passed
 * around as a plain function throws `TypeError` on every call — a throw that
 * reads exactly like "this theme has no such token" and would quietly paint
 * every real host theme with the fallback palette.
 */
function tryThemeAnsi(theme: PiSearchTheme, accessor: "getFgAnsi" | "getBgAnsi", color: string): string | undefined {
	const fn = theme[accessor];
	if (typeof fn !== "function") return undefined;
	try {
		const ansi = fn.call(theme, color);
		return typeof ansi === "string" && ansi.length > 0 ? ansi : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Search-match colors, read from the host's live Pi theme on every frame so
 * `/theme` repaints an open search rather than leaving it on the palette it
 * opened with.
 *
 * A theme that omits the two tokens resolves them from `selectedBg`/`text`
 * inside Pi's own `Theme`; a host with no theme at all falls back to the
 * overlay's own palette so the highlight is never invisible.
 */
export function searchMatchAnsi(piTheme: PiSearchTheme | undefined, fallback: GraphTheme): SearchMatchAnsi {
	const fallbackAnsi: SearchMatchAnsi = { bg: hexBg(fallback.selection), text: hexToAnsi(fallback.text) };
	if (!piTheme || typeof piTheme !== "object") return fallbackAnsi;
	const theme = piTheme;
	return {
		bg: tryThemeAnsi(theme, "getBgAnsi", "searchMatchBg") ?? fallbackAnsi.bg,
		text: tryThemeAnsi(theme, "getFgAnsi", "searchMatchText") ?? fallbackAnsi.text,
	};
}

/**
 * Paint one match run.
 *
 * Attribute order matches `color-utils.paint` (background, foreground, bold,
 * inverse, underline) so a highlighted row reads the same whichever painter
 * produced it. L8 underlines an ordinary match and paints the selected one
 * bold and inverse (`interactive-tui.ts` createFullscreenTui); same colors,
 * same attributes, one feature rather than two that resemble each other.
 */
export function paintSearchMatch(
	text: string,
	colors: SearchMatchAnsi,
	opts: { bold?: boolean; inverse?: boolean; underline?: boolean } = {},
): string {
	const bold = opts.bold ? BOLD : "";
	const inverse = opts.inverse ? INVERSE : "";
	const underline = opts.underline ? UNDERLINE : "";
	return `${colors.bg}${colors.text}${bold}${inverse}${underline}${text}${RESET}`;
}
