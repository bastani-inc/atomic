import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, describe, test, vi } from "vitest";
import { createProcessLoginTerminal } from "../src/cli/auth-terminal.js";
import { openBrowser } from "../src/utils/open-browser.js";

const inputs: PassThrough[] = [];
const restoreTty: (() => void)[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const input of inputs) input.destroy();
	inputs.length = 0;
	while (restoreTty.length > 0) restoreTty.pop()?.();
});

const isAbortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

interface RawInput extends PassThrough {
	setRawMode: ReturnType<typeof vi.fn>;
}

function setup() {
	const input = new PassThrough() as RawInput;
	input.setRawMode = vi.fn();
	inputs.push(input);
	// Readline only needs the readable stream; secrets also switch the terminal to raw mode.
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const controller = new AbortController();
	const interrupt = vi.fn(() => controller.abort());
	const terminal = createProcessLoginTerminal(interrupt);
	return { input, stdout, controller, interrupt, terminal };
}

function setTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, isTTY: boolean | undefined) {
	const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
	Object.defineProperty(stream, "isTTY", { value: isTTY, configurable: true, writable: true });
	restoreTty.push(() => {
		if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
		else delete (stream as { isTTY?: boolean }).isTTY;
	});
}

const written = (stdout: ReturnType<typeof setup>["stdout"]) => stdout.mock.calls.map(([chunk]) => String(chunk));

describe("auth terminal output", () => {
	test("is interactive only when both stdin and stdout are terminals", () => {
		for (const [stdin, stdout, interactive] of [
			[true, true, true],
			[true, false, false],
			[false, true, false],
			[undefined, true, false],
		] as const) {
			setTty(process.stdin, stdin);
			setTty(process.stdout, stdout);
			assert.equal(createProcessLoginTerminal(() => {}).interactive, interactive);
			while (restoreTty.length > 0) restoreTty.pop()?.();
		}
	});

	test("writes lines to stdout and errors to stderr, and opens URLs with the shared launcher", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const terminal = createProcessLoginTerminal(() => {});
		terminal.write("Logged in.");
		terminal.error("Login cancelled.");
		assert.deepEqual(
			stdout.mock.calls.map(([chunk]) => chunk),
			["Logged in.\n"],
		);
		assert.deepEqual(
			stderr.mock.calls.map(([chunk]) => chunk),
			["Login cancelled.\n"],
		);
		assert.equal(terminal.openUrl, openBrowser);
	});
});

describe("auth terminal questions", () => {
	test("rejects and cancels the login when stdin closes before an answer", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const answer = terminal.question("Enter domain: ", controller.signal);
		input.end();
		await assert.rejects(answer, isAbortError);
		assert.equal(interrupt.mock.calls.length, 1);
		assert.equal(controller.signal.aborted, true);
	});

	test("normal cleanup does not cancel the login after an answer", async () => {
		const { input, stdout, controller, interrupt, terminal } = setup();
		const answer = terminal.question("Enter domain: ", controller.signal);
		input.write("example.com\n");
		assert.equal(await answer, "example.com");
		assert.ok(written(stdout).includes("Enter domain: "));
		assert.equal(interrupt.mock.calls.length, 0);
		assert.equal(controller.signal.aborted, false);
	});

	test("keeps an answer delivered immediately before EOF", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const answer = terminal.question("Enter domain: ", controller.signal);
		input.end("example.com\n");
		assert.equal(await answer, "example.com");
		assert.equal(interrupt.mock.calls.length, 0);
	});

	test("prompt cancellation does not cancel the whole login", async () => {
		const { controller, interrupt, terminal } = setup();
		const prompt = new AbortController();
		const answer = terminal.question("Paste code: ", AbortSignal.any([controller.signal, prompt.signal]));
		prompt.abort();
		await assert.rejects(answer, isAbortError);
		assert.equal(interrupt.mock.calls.length, 0);
		assert.equal(controller.signal.aborted, false);
	});
});

describe("auth terminal secrets", () => {
	test("reads a line without echoing it and restores the terminal", async () => {
		const { input, stdout, controller, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		assert.deepEqual(input.setRawMode.mock.calls, [[true]]);
		assert.equal(input.isPaused(), false);
		input.write("sk test\tkey\n");
		assert.equal(await secret, "sk testkey");
		assert.deepEqual(written(stdout), ["API key: ", "\n"]);
		assert.deepEqual(input.setRawMode.mock.calls, [[true], [false]]);
		assert.equal(input.isPaused(), true);
		assert.equal(input.listenerCount("data"), 0);
	});

	test("reads secrets one after another, resuming stdin that the previous secret paused", async () => {
		const { input, controller, terminal } = setup();
		const first = terminal.secret("First: ", controller.signal);
		input.write("one\n");
		assert.equal(await first, "one");
		assert.equal(input.isPaused(), true);
		const second = terminal.secret("Second: ", controller.signal);
		input.write("two\n");
		assert.equal(await second, "two");
	});

	test("aborting after a secret was read leaves the terminal alone", async () => {
		const { input, stdout, controller, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.write("sk-test\n");
		assert.equal(await secret, "sk-test");
		controller.abort();
		assert.deepEqual(input.setRawMode.mock.calls, [[true], [false]]);
		assert.deepEqual(written(stdout), ["API key: ", "\n"]);
	});

	test("ends at a carriage return and ignores what follows it", async () => {
		const { input, controller, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.write("first\rsecond\n");
		assert.equal(await secret, "first");
	});

	test("deletes whole characters on Backspace and ignores escape sequences", async () => {
		const { input, controller, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.write("ab😀c");
		input.write("\u007f");
		input.write("\b");
		input.write("\u001b[D");
		input.write("d\u007f\u007f\u007fx\n");
		assert.equal(await secret, "x");
	});

	test("Ctrl+C interrupts the login and rejects with the abort reason", async () => {
		const { input, stdout, controller, interrupt, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.write("sk-\u0003ignored\n");
		await assert.rejects(secret, (error) => error === controller.signal.reason);
		assert.equal(interrupt.mock.calls.length, 1);
		assert.deepEqual(input.setRawMode.mock.calls, [[true], [false]]);
		assert.equal(input.isPaused(), true);
		assert.equal(input.listenerCount("data"), 0);
		assert.deepEqual(written(stdout), ["API key: ", "\n"]);
	});

	test("Ctrl+D interrupts the login and rejects with the abort reason", async () => {
		const { input, stdout, controller, interrupt, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.write("sk-\u0004ignored\n");
		await assert.rejects(secret, (error) => error === controller.signal.reason);
		assert.equal(interrupt.mock.calls.length, 1);
		assert.deepEqual(input.setRawMode.mock.calls, [[true], [false]]);
		assert.equal(input.isPaused(), true);
		assert.equal(input.listenerCount("data"), 0);
		assert.deepEqual(written(stdout), ["API key: ", "\n"]);
	});

	test("rejects and cancels the login when stdin closes before the secret is entered", async () => {
		const { input, stdout, controller, interrupt, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.end("sk-");
		await assert.rejects(secret, (error) => error === controller.signal.reason);
		assert.equal(interrupt.mock.calls.length, 1);
		assert.deepEqual(input.setRawMode.mock.calls, [[true], [false]]);
		assert.equal(input.listenerCount("data"), 0);
		assert.deepEqual(written(stdout), ["API key: ", "\n"]);
	});

	test("keeps a secret delivered immediately before EOF", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const secret = terminal.secret("API key: ", controller.signal);
		input.end("sk-test\n");
		assert.equal(await secret, "sk-test");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(interrupt.mock.calls.length, 0);
		assert.equal(controller.signal.aborted, false);
	});

	test("cancelling the prompt rejects with its reason without interrupting the login", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const prompt = new AbortController();
		const signal = AbortSignal.any([controller.signal, prompt.signal]);
		const secret = terminal.secret("API key: ", signal);
		prompt.abort(new Error("callback arrived"));
		await assert.rejects(secret, (error) => error === prompt.signal.reason);
		assert.equal(interrupt.mock.calls.length, 0);
		assert.equal(controller.signal.aborted, false);
		assert.deepEqual(input.setRawMode.mock.calls, [[true], [false]]);
		input.write("late\n");
		assert.equal(input.listenerCount("data"), 0);
	});

	test("rejects an already cancelled prompt without touching the terminal", async () => {
		const { input, stdout, controller, terminal } = setup();
		controller.abort();
		await assert.rejects(
			terminal.secret("API key: ", controller.signal),
			(error) => error === controller.signal.reason,
		);
		assert.deepEqual(input.setRawMode.mock.calls, []);
		assert.deepEqual(written(stdout), []);
		assert.equal(input.listenerCount("data"), 0);
	});
});
