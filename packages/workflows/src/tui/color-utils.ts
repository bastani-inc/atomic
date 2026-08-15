/**
 * Color interpolation utilities.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/color-utils.ts
 */

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace(/^#/, "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return [r, g, b];
}

function toHex(r: number, g: number, b: number): string {
	const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Linear interpolation between two hex colors.
 * t in [0,1]. Returns hex string "#rrggbb".
 */
export function lerpColor(a: string, b: string, t: number): string {
	const [ar, ag, ab] = parseHex(a);
	const [br, bg, bb] = parseHex(b);
	const r = ar + (br - ar) * t;
	const g = ag + (bg - ag) * t;
	const bl = ab + (bb - ab) * t;
	return toHex(r, g, bl);
}

/** Convert a hex color to an ANSI 24-bit foreground escape sequence. */
export function hexToAnsi(hex: string): string {
	const [r, g, b] = parseHex(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Convert a hex color to an ANSI 24-bit background escape sequence. */
export function hexBg(hex: string): string {
	const [r, g, b] = parseHex(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const UNDERLINE = "\x1b[4m";
export const INVERSE = "\x1b[7m";

/**
 * Combine a foreground hex + optional background hex into a single
 * styled ANSI run. Pass `bold: true` for the emphasised pill style.
 *
 * `underline` and `inverse` exist for one reason: the fullscreen transcript
 * search paints an ordinary match underlined and the selected one inverse and
 * bold (`interactive-tui.ts` createFullscreenTui, through chalk's SGR 4 and
 * 7). A stage-chat match is meant to be indistinguishable from a transcript
 * match, so it needs the same two attributes and not only the same two colors.
 */
export function paint(
	text: string,
	fg: string,
	opts: { bg?: string; bold?: boolean; underline?: boolean; inverse?: boolean } = {},
): string {
	const bgSeq = opts.bg ? hexBg(opts.bg) : "";
	const boldSeq = opts.bold ? BOLD : "";
	const inverseSeq = opts.inverse ? INVERSE : "";
	const underlineSeq = opts.underline ? UNDERLINE : "";
	return `${bgSeq}${hexToAnsi(fg)}${boldSeq}${inverseSeq}${underlineSeq}${text}${RESET}`;
}
