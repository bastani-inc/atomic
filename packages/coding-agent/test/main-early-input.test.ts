import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
	applyEarlyInputChunk,
	consumeStartupInput,
	type EarlyInputState,
	linkStartupShell,
	startEarlyInputCapture,
	withEarlyInputHeldForStartupDialog,
} from "../src/main-early-input.ts";

class FakeStdin {
	isTTY = true;
	isRaw = false;
	rawModeCalls: boolean[] = [];
	listeners: Array<(chunk: Buffer | string) => void> = [];
	emitDuringResume = "";

	setRawMode(mode: boolean): void {
		this.rawModeCalls.push(mode);
		this.isRaw = mode;
	}

	setEncoding(_encoding: BufferEncoding): void {}
	resume(): void {
		if (this.emitDuringResume) this.emit(this.emitDuringResume);
	}
	on(_event: "data", listener: (chunk: Buffer | string) => void): void {
		this.listeners.push(listener);
	}
	off(_event: "data", listener: (chunk: Buffer | string) => void): void {
		this.listeners = this.listeners.filter((candidate) => candidate !== listener);
	}
	removeListener(event: "data", listener: (chunk: Buffer | string) => void): void {
		this.off(event, listener);
	}

	emit(chunk: string): void {
		for (const listener of [...this.listeners]) listener(chunk);
	}
}

type FakeProcessEvent = "exit" | "SIGINT" | "SIGTERM" | "SIGHUP" | "uncaughtException";
type FakeProcessListener = (error?: Error) => void;

class FakeProcess {
	pid = 1234;
	platform: NodeJS.Platform = "darwin";
	listeners = new Map<FakeProcessEvent, FakeProcessListener[]>();
	kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];

	on(event: FakeProcessEvent, listener: FakeProcessListener): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}
	off(event: FakeProcessEvent, listener: FakeProcessListener): void {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
		);
	}
	removeListener(event: FakeProcessEvent, listener: FakeProcessListener): void {
		this.off(event, listener);
	}
	kill(pid: number, signal: NodeJS.Signals): void {
		this.kills.push({ pid, signal });
	}
	emit(event: FakeProcessEvent, error?: Error): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(error);
	}
	listenerCount(event: FakeProcessEvent): number {
		return this.listeners.get(event)?.length ?? 0;
	}
}

function createCapture() {
	const stdin = new FakeStdin();
	const process = new FakeProcess();
	const capture = startEarlyInputCapture({ enabled: true, stdin, process });
	if (!capture) throw new Error("expected capture to start");
	return { stdin, process, capture };
}

describe("early startup input", () => {
	it("applies printable text, backspace, enter submissions, and ignored escape sequences", () => {
		const state: EarlyInputState = { text: "", submissions: [] };

		applyEarlyInputChunk(state, "helo\x7flo\rnext\x1b[A draft");

		expect(state).toEqual({
			text: "next draft",
			submissions: ["hello"],
			pendingEscape: undefined,
		});
	});

	it("preserves ordinary text after a bare escape in the same chunk", () => {
		const state: EarlyInputState = { text: "", submissions: [] };

		applyEarlyInputChunk(state, "\x1bhello");

		expect(state.text).toBe("hello");
		expect(state.pendingEscape).toBeUndefined();
	});

	// libuv on Windows and the Linux console send F1-F5 as ESC [ [ A..E. On Windows a cursor position report the
	// console host did not ask for also arrives as F3, so a prompt typed before the first frame was submitted and a
	// stray "C" stayed in the editor.
	it("drops the Linux-console function keys typed before the first frame, whole", () => {
		const state: EarlyInputState = { text: "", submissions: [] };

		applyEarlyInputChunk(state, "prompt\r\x1b[[C");
		applyEarlyInputChunk(state, "a\x1b[[Ab\x1b[[5~c");

		expect(state).toEqual({ text: "abc", submissions: ["prompt"], pendingEscape: undefined });
	});

	it("keeps a Linux-console function key split across chunks out of the text", () => {
		const state: EarlyInputState = { text: "", submissions: [] };

		applyEarlyInputChunk(state, "x\x1b[[");
		applyEarlyInputChunk(state, "Ey");

		expect(state.text).toBe("xy");
	});

	it("skips escape sequences split across chunks instead of treating terminators as text", () => {
		const state: EarlyInputState = { text: "", submissions: [] };

		applyEarlyInputChunk(state, "before\x1b[");
		applyEarlyInputChunk(state, "Aafter");

		expect(state.text).toBe("beforeafter");
		expect(state.pendingEscape).toBeUndefined();
	});

	it("skips a split CSI sequence when its continuation arrives before timeout", () => {
		vi.useFakeTimers();
		try {
			const { stdin, capture } = createCapture();

			stdin.emit("\x1b[");
			vi.advanceTimersByTime(25);
			stdin.emit("Ahello");

			expect(capture.consume()).toEqual({ text: "hello", submissions: [] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears an incomplete pending escape after timeout so later text is preserved", () => {
		vi.useFakeTimers();
		try {
			const { stdin, capture } = createCapture();

			stdin.emit("\x1b[");
			vi.advanceTimersByTime(51);
			stdin.emit("Ahello");

			expect(capture.consume()).toEqual({ text: "Ahello", submissions: [] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("captures raw TTY input and restores raw mode when consumed", () => {
		const { stdin, process, capture } = createCapture();

		stdin.emit("typed\rmore");

		expect(capture.consume()).toEqual({ text: "more", submissions: ["typed"] });
		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.listeners).toHaveLength(0);
		expect(process.listenerCount("exit")).toBe(0);
		expect(process.listenerCount("SIGINT")).toBe(0);
	});

	it("registers the data listener before resuming stdin", () => {
		const stdin = new FakeStdin();
		const process = new FakeProcess();
		stdin.emitDuringResume = "during resume";

		const capture = startEarlyInputCapture({ enabled: true, stdin, process });

		expect(capture?.consume()).toEqual({ text: "during resume", submissions: [] });
	});

	it("restores raw mode and removes handlers on process exit", () => {
		const { stdin, process } = createCapture();

		process.emit("exit");

		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.listeners).toHaveLength(0);
		expect(process.listenerCount("SIGTERM")).toBe(0);
	});

	it("cleans up and forwards Ctrl+C data as SIGINT", () => {
		const { stdin, process } = createCapture();

		stdin.emit("\x03");

		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.listeners).toHaveLength(0);
		expect(process.kills).toEqual([{ pid: 1234, signal: "SIGINT" }]);
		expect(process.listenerCount("SIGINT")).toBe(0);
	});

	it("cleans up and forwards startup signals while capture is active", () => {
		const { stdin, process } = createCapture();

		process.emit("SIGTERM");

		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.listeners).toHaveLength(0);
		expect(process.kills).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
		expect(process.listenerCount("SIGTERM")).toBe(0);
	});

	it("does not start when disabled", () => {
		const stdin = new FakeStdin();
		const process = new FakeProcess();

		expect(startEarlyInputCapture({ enabled: false, stdin, process })).toBeUndefined();
		expect(stdin.rawModeCalls).toEqual([]);
	});
});

/**
 * A terminal's stdin as libuv reads it on Windows: keys the user typed reach the process only once a read has started
 * and its helper thread has completed it, `readLatencyMs` later.
 */
class OsStdin extends Readable {
	isTTY = true;
	isRaw = false;
	private readonly typed: Buffer[] = [];
	private wanted = false;
	private delivering = false;

	constructor(private readonly readLatencyMs: number) {
		super();
	}

	setRawMode(mode: boolean): this {
		this.isRaw = mode;
		return this;
	}

	type(text: string): void {
		this.typed.push(Buffer.from(text));
		this.deliverWhenRead();
	}

	/** The bytes typed that no read has handed over yet, as the OS reports them. */
	pending(): number {
		return this.typed.reduce((total, chunk) => total + chunk.length, 0);
	}

	override _read(): void {
		this.wanted = true;
		this.deliverWhenRead();
	}

	private deliverWhenRead(): void {
		if (!this.wanted || this.delivering || this.typed.length === 0) return;
		this.delivering = true;
		setTimeout(() => {
			this.delivering = false;
			this.wanted = false;
			this.push(Buffer.concat(this.typed.splice(0)));
		}, this.readLatencyMs);
	}
}

function busyFor(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {}
}

/** An OS read that completes this long after it starts, far longer than a startup dialog waits for typed input. */
const SLOW_READ_MS = 200;
/** An OS read that completes this soon after it starts, as a terminal's usually does. */
const PROMPT_READ_MS = 10;

describe("early startup input held for a startup dialog (#5241)", () => {
	it("captures input typed while startup does not yield, before a dialog takes stdin", async () => {
		const stdin = new OsStdin(5);
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		stdin.type("hello");
		busyFor(20);
		const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
		expect(snapshot).toEqual({ text: "hello", submissions: [], heldForStartupDecision: true });
	});

	// The capture starts the OS read as it starts, so a read that takes long is already done when startup, busy all
	// that while, opens a dialog. A read started only once startup yields would complete after the dialog took stdin.
	it("captures input typed while startup does not yield, however long the OS takes to complete a read", async () => {
		const stdin = new OsStdin(SLOW_READ_MS);
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		stdin.type("hello");
		busyFor(SLOW_READ_MS + 50);
		const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
		expect(snapshot).toEqual({ text: "hello", submissions: [], heldForStartupDecision: true });
	});

	// A dialog waits a moment for input already typed before it takes stdin, so a read the OS completes just after the
	// dialog starts still reaches the draft instead of answering the dialog.
	it("captures input whose read completes just after a dialog starts", async () => {
		const stdin = new OsStdin(PROMPT_READ_MS);
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		stdin.type("hello");
		const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
		expect(snapshot).toEqual({ text: "hello", submissions: [], heldForStartupDecision: true });
	});

	it("captures input the OS already holds when a dialog starts, however long its read takes on a busy machine (#5241)", async () => {
		const stdin = new OsStdin(SLOW_READ_MS);
		const capture = startEarlyInputCapture({
			enabled: true,
			stdin,
			process: new FakeProcess(),
			pendingInput: () => stdin.pending(),
		});
		stdin.type("hello");
		const snapshot = await withEarlyInputHeldForStartupDialog(async () => consumeStartupInput(capture));
		expect(snapshot).toEqual({ text: "hello", submissions: [], heldForStartupDecision: true });
	});

	it("leaves input that arrives once a dialog holds stdin to the dialog's reader instead of dropping it", async () => {
		const stdin = new OsStdin(0);
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		const read = await withEarlyInputHeldForStartupDialog(async () => {
			stdin.type("y");
			await delay(10);
			const chunks: string[] = [];
			const onData = (chunk: Buffer | string) => chunks.push(String(chunk));
			stdin.on("data", onData);
			stdin.resume();
			await delay(10);
			stdin.off("data", onData);
			stdin.pause();
			return chunks.join("");
		});
		expect(read).toBe("y");
		expect(consumeStartupInput(capture)).toEqual({ text: "", submissions: [], heldForStartupDecision: true });
	});
});

describe("the startup input capture behind the early editor", () => {
	/** An early editor that shows `typed` until it is ended. */
	function linkEditor(typed: EarlyInputState) {
		let active = true;
		const abort = vi.fn(() => {
			active = false;
			return typed;
		});
		linkStartupShell({
			get active() {
				return active;
			},
			abort,
		});
		return { abort, end: () => (active = false) };
	}

	it("leaves the keys to the editor while it shows the prompt, and hands the session nothing", () => {
		linkEditor({ text: "draft", submissions: [] });
		const stdin = new FakeStdin();
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		expect(stdin.listeners).toHaveLength(0);
		expect(stdin.rawModeCalls).toEqual([]);
		expect(capture?.consume()).toEqual({ text: "", submissions: [] });
		linkStartupShell(undefined);
	});

	it("continues from what was typed in an editor that ended before the session was ready", () => {
		const editor = linkEditor({ text: "", submissions: [] });
		const stdin = new FakeStdin();
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		editor.end();
		linkStartupShell(undefined, { text: "early", submissions: ["sent before"] });
		stdin.emit(" late");
		expect(capture?.consume()).toEqual({ text: "early late", submissions: ["sent before"] });
	});

	it("ends the editor before a startup question takes the terminal, its prompt then unfinished input", async () => {
		const editor = linkEditor({ text: "half typed", submissions: [] });
		const stdin = new FakeStdin();
		const capture = startEarlyInputCapture({ enabled: true, stdin, process: new FakeProcess() });
		const unfinished = await withEarlyInputHeldForStartupDialog(async ({ hasUnfinishedInput }) => hasUnfinishedInput);
		expect(editor.abort).toHaveBeenCalledTimes(1);
		expect(unfinished).toBe(true);
		stdin.emit("!");
		// As the capture holds input from before a startup question: in the prompt, to send deliberately.
		expect(capture?.consume()).toEqual({ text: "half typed!", submissions: [], heldForStartupDecision: true });
	});
});
