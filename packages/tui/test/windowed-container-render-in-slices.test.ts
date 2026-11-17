import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WindowedContainer } from "../src/components/windowed-container.ts";
import type { Component } from "../src/tui.ts";

/** How long each entry takes to render: with enough entries, rendering them all runs past one slice's budget. */
const ENTRY_RENDER_MS = 2;
const ENTRIES = 40;

class SlowEntry implements Component {
	private readonly index: number;
	constructor(index: number) {
		this.index = index;
	}
	render(_width: number): string[] {
		const until = performance.now() + ENTRY_RENDER_MS;
		while (performance.now() < until) {}
		return [`entry ${this.index}`];
	}
	invalidate(): void {}
}

function transcript(): WindowedContainer {
	const container = new WindowedContainer();
	for (let index = 0; index < ENTRIES; index++) container.addChild(new SlowEntry(index));
	return container;
}

describe("rendering a windowed transcript in slices", () => {
	it("yields the event loop between slices and renders what rendering at once does", async () => {
		let turns = 0;
		let rendering = true;
		const countTurns = (): void => {
			if (!rendering) return;
			turns++;
			setImmediate(countTurns);
		};
		setImmediate(countTurns);
		const sliced = await transcript().renderInSlices(80);
		rendering = false;

		assert.deepEqual(sliced, transcript().render(80));
		assert.ok(turns > 1, `the transcript rendered in ${turns} event-loop turn(s)`);
	});
});
