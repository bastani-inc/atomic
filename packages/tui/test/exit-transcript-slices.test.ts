import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { WindowedContainer } from "../src/components/windowed-container.ts";
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
	readonly exitRestores: string[] = [];
	turn = 0;
	flush?: () => Promise<void>;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push({ data, turn: this.turn });
	}
	restoreOnExit(before: string, after: string): void {
		this.exitRestores.push(before + after);
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

class TranscriptEntry implements Component {
	readonly lines: string[];
	constructor(index: number) {
		this.lines = Array.from({ length: 1 + (index % 7) }, (_, row) => `entry ${index} row ${row} \x1b[1mbold\x1b[22m`);
	}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class HiddenOutput extends WindowedContainer {
	override render(_width: number): string[] {
		return [];
	}
	protected override windowChildren(): readonly Component[] {
		return [];
	}
}

function windowedTranscript(): WindowedContainer {
	const root = new WindowedContainer();
	const history = new WindowedContainer();
	for (let index = 0; index < TRANSCRIPT_LINES / 4; index++) history.addChild(new TranscriptEntry(index));
	root.addChild(history);
	const hidden = new HiddenOutput();
	hidden.addChild(new TranscriptEntry(1));
	root.addChild(hidden);
	const notices = new WindowedContainer();
	notices.addChild(new TranscriptEntry(2));
	root.addChild(notices);
	root.addChild(new TranscriptEntry(3));
	return root;
}

/** Runs a fullscreen session over the transcript and returns what stopping it writes, by event-loop turn. */
async function exitOutput(
	writeInSlices: boolean,
	layoutRoot: () => Component = () => new ScrollView(new Transcript(), { follow: "end", primary: true }),
): Promise<RecordingTerminal["writes"]> {
	const terminal = new RecordingTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	tui.setLayoutRoot(layoutRoot());
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

	it("writes a windowed transcript in slices with the same output as at once", async () => {
		const sliced = await exitOutput(true, windowedTranscript);
		const atOnce = await exitOutput(false, windowedTranscript);
		assert.equal(sliced.map((write) => write.data).join(""), atOnce.map((write) => write.data).join(""));
		assert.ok(new Set(sliced.map((write) => write.turn)).size > 1, "the transcript was written in a single turn");
	});

	it("restores autowrap and ends synchronized output when the process exits during the sliced write", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		tui.setLayoutRoot(new ScrollView(new Transcript(), { follow: "end", primary: true }));
		tui.start();
		tui.renderNow();
		const before = new Set(process.listeners("exit"));
		tui.stop({ writeInSlices: true });
		const exitDuringWrite = process.listeners("exit").filter((listener) => !before.has(listener));
		for (const listener of exitDuringWrite) listener(1);
		const restored = terminal.exitRestores.join("");
		assert.ok(restored.includes("\x1b[?7h"), "autowrap stayed disabled");
		assert.ok(restored.includes("\x1b[?2026l"), "synchronized output stayed open");
		await tui.whenStopped();
		assert.deepEqual(
			process.listeners("exit").filter((listener) => !before.has(listener)),
			[],
		);
	});

	it("restores autowrap and ends synchronized output when the sliced write fails, also if the process exits after", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		tui.setLayoutRoot(new ScrollView(new Transcript(), { follow: "end", primary: true }));
		tui.start();
		tui.renderNow();
		const from = terminal.writes.length;
		const before = new Set(process.listeners("exit"));
		terminal.flush = () => Promise.reject(new Error("the terminal went away"));
		tui.stop({ writeInSlices: true });
		await assert.rejects(tui.whenStopped(), /the terminal went away/);
		for (const listener of process.listeners("exit").filter((listener) => !before.has(listener))) listener(1);
		const output = terminal.writes
			.slice(from)
			.map((write) => write.data)
			.concat(terminal.exitRestores)
			.join("");
		assert.ok(output.includes("\x1b[?7l"), "the sliced write never disabled autowrap");
		assert.ok(output.lastIndexOf("\x1b[?7h") > output.lastIndexOf("\x1b[?7l"), "autowrap stayed disabled");
		assert.ok(
			output.lastIndexOf("\x1b[?2026l") > output.lastIndexOf("\x1b[?2026h"),
			"synchronized output stayed open",
		);
		for (const listener of process.listeners("exit").filter((listener) => !before.has(listener)))
			process.off("exit", listener);
	});

	it("leaves no exit handler once the restore after a failed sliced write reaches the terminal", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		tui.setLayoutRoot(new ScrollView(new Transcript(), { follow: "end", primary: true }));
		tui.start();
		tui.renderNow();
		const before = new Set(process.listeners("exit"));
		let failures = 1;
		terminal.flush = () => (failures-- > 0 ? Promise.reject(new Error("one write failed")) : Promise.resolve());
		tui.stop({ writeInSlices: true });
		await assert.rejects(tui.whenStopped(), /one write failed/);
		assert.ok(terminal.writes.at(-1)?.data.includes("\x1b[?7h"), "the failed write was not followed by a restore");
		assert.deepEqual(
			process.listeners("exit").filter((listener) => !before.has(listener)),
			[],
		);
	});
});
