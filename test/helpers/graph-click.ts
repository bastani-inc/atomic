import type { TuiMouseEvent } from "@bastani/atomic-tui";

/**
 * The click the fullscreen renderer gives a full-screen view once the left press `report`, an SGR mouse report such
 * as `\x1b[<0;12;5M`, is released on the same cell. Views act on that click, not on the press.
 */
export function sgrClick(report: string, size: { width: number; height: number } = { width: 200, height: 60 }) {
	const match = /^\x1b\[<0;(\d+);(\d+)M$/.exec(report);
	if (!match) throw new Error(`not a left press report: ${JSON.stringify(report)}`);
	const x = Number(match[1]) - 1;
	const y = Number(match[2]) - 1;
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: size.width,
		height: size.height,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	} satisfies TuiMouseEvent;
}
