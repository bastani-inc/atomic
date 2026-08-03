import type { Component } from "@earendil-works/pi-tui";

/**
 * Emits `max(0, getMax(width) - getCurrent(width))` empty rows. Used in
 * `dialog-builder.ts` to absorb the dialog-height residual OUTSIDE the bordered
 * body region: the body renders at its natural height (no internal `""`
 * padding), and this spacer makes up the difference between the global max
 * across tabs and the current tab's body height so the overall dialog footprint
 * stays constant on tab switches.
 */
export class BodyResidualSpacer implements Component {
	private declare readonly getMax: (width: number) => number;
	private declare readonly getCurrent: (width: number) => number;

	constructor(getMax: (width: number) => number, getCurrent: (width: number) => number) {
		this.getMax = getMax;
		this.getCurrent = getCurrent;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(width: number): string[] {
		const diff = Math.max(0, this.getMax(width) - this.getCurrent(width));
		return Array<string>(diff).fill("");
	}
}
