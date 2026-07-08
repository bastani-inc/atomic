import { describe, expect, it } from "vitest";
import { applyEarlyInputChunk, startEarlyInputCapture, type EarlyInputState } from "../src/main-early-input.ts";

class FakeStdin {
	isTTY = true;
	isRaw = false;
	rawModeCalls: boolean[] = [];
	listeners: Array<(chunk: Buffer | string) => void> = [];

	setRawMode(mode: boolean): void {
		this.rawModeCalls.push(mode);
		this.isRaw = mode;
	}

	setEncoding(_encoding: BufferEncoding): void {}
	resume(): void {}
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
		for (const listener of this.listeners) listener(chunk);
	}
}

describe("early startup input", () => {
	it("applies printable text, backspace, enter submissions, and ignored escape sequences", () => {
		const state: EarlyInputState = { text: "", submissions: [] };

		applyEarlyInputChunk(state, "helo\x7flo\rnext\x1b[A draft");

		expect(state).toEqual({
			text: "next draft",
			submissions: ["hello"],
		});
	});

	it("captures raw TTY input and restores raw mode when consumed", () => {
		const stdin = new FakeStdin();
		const capture = startEarlyInputCapture({ enabled: true, stdin });

		stdin.emit("typed\rmore");

		expect(capture?.consume()).toEqual({ text: "more", submissions: ["typed"] });
		expect(stdin.rawModeCalls).toEqual([true, false]);
		expect(stdin.listeners).toHaveLength(0);
	});

	it("does not start when disabled", () => {
		const stdin = new FakeStdin();

		expect(startEarlyInputCapture({ enabled: false, stdin })).toBeUndefined();
		expect(stdin.rawModeCalls).toEqual([]);
	});
});
