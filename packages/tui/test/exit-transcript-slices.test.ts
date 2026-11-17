import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import type { Terminal } from "../src/terminal.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

/** Lines of the transcript quitting writes to the main screen: tens of thousands, as a long session leaves. */
const TRANSCRIPT_LINES = 40_000;
/**
 * The most one write may carry while the transcript is written in slices. A terminal takes a write in one piece (on
 * Linux the write blocks until it has), so the largest write bounds how long the loop waits on the terminal.
 */
const MAX_SLICED_WRITE_CHARACTERS = 64 * 1024;

class RecordingTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns = 80;
	rows = 24;
	readonly writes: Array<{ data: string; turn: number }> = [];
	turn = 0;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push({ data, turn: this.turn });
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

class Transcript implements Component {
	readonly lines = Array.from({ length: TRANSCRIPT_LINES }, (_, index) => `line ${index} \x1b[1mbold\x1b[22m text`);
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Runs a fullscreen session over the transcript and returns what stopping it writes, by event-loop turn. */
async function exitOutput(writeInSlices: boolean): Promise<RecordingTerminal["writes"]> {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(new ScrollView(new Transcript(), { follow: "end", primary: true }));
	tui.start();
	tui.renderNow();
	const from = terminal.writes.length;
	let stopped = false;
	tui.stop({ writeInSlices });
	const written = tui.whenStopped().then(() => {
		stopped = true;
	});
	while (!stopped) {
		await new Promise((resolve) => setImmediate(resolve));
		terminal.turn++;
	}
	await written;
	return terminal.writes.slice(from);
}

describe("quitting the fullscreen renderer", () => {
	it("writes a long transcript in bounded slices across event-loop turns, with the same output", async () => {
		const sliced = await exitOutput(true);
		const atOnce = await exitOutput(false);
		assert.equal(sliced.map((write) => write.data).join(""), atOnce.map((write) => write.data).join(""));
		const largest = Math.max(...sliced.map((write) => write.data.length));
		assert.ok(largest <= MAX_SLICED_WRITE_CHARACTERS, `the largest write carried ${largest} characters`);
		const turns = new Set(sliced.map((write) => write.turn)).size;
		assert.ok(turns > 1, "the transcript was written in a single event-loop turn");
	});
});
