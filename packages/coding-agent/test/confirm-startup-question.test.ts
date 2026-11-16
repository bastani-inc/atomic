import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, test } from "vitest";
import { consumeStartupInput, startEarlyInputCapture } from "../src/main-early-input.ts";
import { confirmStartupQuestion } from "../src/main-session.ts";

class FakeStdin {
	isTTY = true;
	isRaw = false;
	paused = false;
	listeners: Array<(chunk: Buffer | string) => void> = [];
	setRawMode(mode: boolean): void {
		this.isRaw = mode;
	}
	setEncoding(): void {}
	resume(): void {
		this.paused = false;
	}
	pause(): void {
		this.paused = true;
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
	emit(chunk: Buffer | string): void {
		for (const listener of [...this.listeners]) listener(chunk);
	}
}

const fakeProcess = {
	pid: 1,
	platform: "linux" as NodeJS.Platform,
	on() {},
	off() {},
	removeListener() {},
	kill() {},
};

function settled<T>(promise: Promise<T>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	return new Promise((resolve) => setImmediate(() => resolve(done)));
}

afterEach(() => {
	consumeStartupInput(undefined);
});

test.each([
	["y\rXYZ", true, "XYZ"],
	["y\nXYZ", true, "XYZ"],
	["y\r\nXYZ", true, "XYZ"],
	["YES\r\nXYZ\r\n", true, "XYZ"],
	["n\rXYZ", false, "XYZ"],
	["no\r\nXYZ", false, "XYZ"],
	["\r\nXYZ", false, "XYZ"],
] as const)("confirmStartupQuestion keeps suffix in the same chunk for %j (#5241)", async (chunk, expected, draft) => {
	const stdin = new FakeStdin();
	const capture = startEarlyInputCapture({ enabled: true, stdin, process: fakeProcess });
	assert.ok(capture);
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();

	const answer = confirmStartupQuestion("Fork this session into current directory?", { input, output });
	input.write(chunk);

	assert.equal(await answer, expected);
	assert.deepEqual(consumeStartupInput(capture), {
		text: draft,
		submissions: [],
		heldForStartupDecision: true,
	});
});

test("confirmStartupQuestion retains invalid answers and CRLF suffix in typing order (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startEarlyInputCapture({ enabled: true, stdin, process: fakeProcess });
	assert.ok(capture);
	stdin.emit("before\r");

	const input = new FakeStdin();
	let prompts = "";
	const output = {
		write(chunk: string) {
			prompts += chunk;
			return true;
		},
	};

	const answer = confirmStartupQuestion("Fork this session into current directory?", { input, output });
	input.emit("first invalid\r\n");
	assert.equal(await settled(answer), false);

	input.emit("second invalid\r");
	assert.equal(await settled(answer), false);
	input.emit("\n");
	assert.equal(await settled(answer), false);

	input.emit("third invalid\r\ny\r\nXYZ");
	assert.equal(await answer, true);
	assert.equal(input.listeners.length, 0);
	assert.equal(input.paused, true);

	const promptsAfterResolve = prompts;
	input.emit("ignored after cleanup\r\n");
	assert.equal(prompts, promptsAfterResolve);

	stdin.emit("after");
	assert.deepEqual(consumeStartupInput(capture), {
		text: "before\nfirst invalid\nsecond invalid\nthird invalid\nXYZ\nafter",
		submissions: [],
		heldForStartupDecision: true,
	});
});
