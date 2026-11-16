import { describe, expect, it, vi } from "vitest";
import { applyEarlyInputChunk, type EarlyInputState, startEarlyInputCapture } from "../src/main-early-input.ts";

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
