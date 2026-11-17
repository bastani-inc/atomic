import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Frames painted while the overlay is open; each one would lay the transcript out again if it were drawn. */
const COVERED_FRAMES = 20;

class CountingTranscript implements Component {
	renders = 0;
	lines = Array.from({ length: 200 }, (_, index) => `transcript ${index}`);
	render(): string[] {
		this.renders += 1;
		return this.lines;
	}
	invalidate(): void {}
}

class View implements Component {
	text = "view 0";
	private readonly rows: number;
	constructor(rows: number) {
		this.rows = rows;
	}
	render(width: number): string[] {
		return Array.from({ length: this.rows }, (_, row) => (row === 0 ? this.text : "").padEnd(width));
	}
	invalidate(): void {}
}

async function paint(tui: TuiAltScreen, terminal: VirtualTerminal): Promise<string[]> {
	tui.requestRender();
	await terminal.waitForRender();
	return terminal.getViewport().map((line) => stripTerminalSequences(line));
}

describe("TuiAltScreen under a full-screen overlay", () => {
	it("does not lay out the screen under an overlay that covers it, and draws it again once uncovered", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const transcript = new CountingTranscript();
		tui.addChild(transcript);
		tui.start();
		try {
			await paint(tui, terminal);
			const view = new View(10);
			const overlay = tui.showOverlay(view, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
			await paint(tui, terminal);
			const before = transcript.renders;
			for (let frame = 1; frame <= COVERED_FRAMES; frame++) {
				view.text = `view ${frame}`;
				const screen = await paint(tui, terminal);
				assert.equal(screen[0]?.trim(), `view ${frame}`);
			}
			assert.equal(transcript.renders, before, "frames of a covering overlay never lay out the screen under it");

			overlay.setHidden(true);
			const uncovered = await paint(tui, terminal);
			assert.ok(transcript.renders > before, "the screen is laid out again once the overlay stops covering it");
			assert.ok(uncovered.some((line) => line.includes("transcript 199")));
		} finally {
			tui.stop();
		}
	});

	it("draws the screen under an overlay that does not cover all of it", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const transcript = new CountingTranscript();
		tui.addChild(transcript);
		tui.start();
		try {
			await paint(tui, terminal);
			const view = new View(4);
			tui.showOverlay(view, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
			await paint(tui, terminal);
			const before = transcript.renders;
			view.text = "view 1";
			const screen = await paint(tui, terminal);
			assert.ok(transcript.renders > before, "a partial overlay leaves rows of the screen under it showing");
			assert.ok(screen.some((line) => line.includes("transcript")));
		} finally {
			tui.stop();
		}
	});
});
