/**
 * Color interpolation utilities.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/color-utils.ts
 */
import { hexColorAnsi } from "@bastani/atomic";
import { Text, truncateToWidth } from "@bastani/atomic-tui";
import { BoundedTextCache } from "./text-helpers.js";

const filledBackgroundLines = new BoundedTextCache(1024);

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

/**
 * The foreground escape sequence for a hex color, in the color level the host theme paints with: none under NO_COLOR or
 * FORCE_COLOR=0, 256 colors under FORCE_COLOR=1 or 2, and true color otherwise.
 */
export function hexToAnsi(hex: string): string {
	return hexColorAnsi(hex, "fg");
}

/** Pulse a status foreground without introducing a second hue. `t` runs from quiet (0) to full intensity (1). */
export function pulseForeground(hex: string, peak: string, t: number): string {
	if (!peak) return "";
	if (peak.startsWith("\x1b[38;2;")) {
		const [r, g, b] = parseHex(hex);
		const max = Math.max(r, g, b);
		if (max !== 1) {
			// Black ink on a light canvas fades towards white; all other hues scale towards black.
			const neutral = max === 0 ? 255 : 0;
			const intensity = 0.55 + 0.45 * t;
			const shade = (channel: number) => neutral + (channel - neutral) * intensity;
			return hexToAnsi(toHex(shade(r), shade(g), shade(b)));
		}
	}
	// Neither an indexed slot nor a one-step RGB channel has a guaranteed dimmer shade of the same hue.
	return t < 0.5 ? `\x1b[2m${peak}` : peak;
}

/** The background escape sequence for a hex color, in the same color level as {@link hexToAnsi}. */
export function hexBg(hex: string): string {
	return hexColorAnsi(hex, "bg");
}

/**
 * Names the color level colors are painted in: it changes whenever NO_COLOR or FORCE_COLOR turn color off, limit it to
 * 256 colors or restore true color. A cache of painted rows keys on it so it never serves rows painted at another level.
 */
export function colorLevelKey(): string {
	return hexColorAnsi("#000000", "fg");
}

/** Whether NO_COLOR or FORCE_COLOR=0 turned color off, from the cached color level; it never reads the environment. */
export function colorsOff(): boolean {
	return colorLevelKey() === "";
}

/** Unpainted canvas, matching main chat and attached stage chat. */
export const DEFAULT_BG = "\x1b[49m";

export const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * A text style sequence (bold, italic, inverse, ...) in the style level the host theme paints with: none when NO_COLOR
 * or FORCE_COLOR=0 turned colors and styles off, as the host theme drops them. It reads the cached level, never the
 * environment.
 */
export function textStyle(sequence: string): string {
	return colorsOff() ? "" : sequence;
}

/** The bold sequence in the host theme's style level; see {@link textStyle}. */
export function boldOn(): string {
	return textStyle(BOLD);
}

/** Keep a filled row intact across pi-tui truncation and nested style resets. */
export function fillBackground(text: string, width: number, background: string): string {
	return filledBackgroundLines.get(`${width}\0${background}\0${text}`, () => {
		return (
			new Text(
				truncateToWidth(text, width, "…"),
				0,
				0,
				(line) => `${background}${line.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background)}${RESET}`,
			).render(width)[0] ?? ""
		);
	});
}

/**
 * Combine a foreground hex + optional background hex into a single
 * styled ANSI run. Pass `bold: true` for the emphasised pill style.
 */
export function paint(text: string, fg: string, opts: { bg?: string; bold?: boolean } = {}): string {
	const bgSeq = opts.bg ? hexBg(opts.bg) : "";
	const boldSeq = opts.bold ? boldOn() : "";
	return `${bgSeq}${hexToAnsi(fg)}${boldSeq}${text}${RESET}`;
}
