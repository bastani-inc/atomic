import assert from "node:assert/strict";
import type { Component } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const screens = vi.hoisted(() => ({
	created: [] as Array<{
		running: boolean;
		setFocus: (component: Component) => void;
		sendChunk: (data: string) => void;
	}>,
	detectTheme: vi.fn<() => Promise<"dark">>(async () => "dark"),
}));

vi.mock("@bastani/atomic-tui", async (importOriginal) => {
	const original = await importOriginal<typeof import("@bastani/atomic-tui")>();
	class FakeMainScreen extends original.Container {
		running = false;
		private readonly buffer = new original.StdinBuffer();
		start = vi.fn(() => {
			this.running = true;
		});
		stop = vi.fn(() => {
			this.running = false;
		});
		clear = vi.fn();
		requestRender = vi.fn();
		setFocus = vi.fn<(component: Component) => void>();
		setClearOnShrink = vi.fn();
		constructor() {
			super();
			this.buffer.on("data", (sequence) => {
				if (this.running) this.setFocus.mock.calls.at(-1)?.[0].handleInput?.(sequence);
			});
			screens.created.push(this);
		}
		sendChunk(data: string): void {
			this.buffer.process(data);
		}
	}
	return { ...original, ProcessTerminal: class {}, TuiMainScreen: FakeMainScreen };
});

vi.mock("../src/modes/interactive/theme/theme.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/theme/theme.js")>()),
	detectTerminalThemeForAuto: () => screens.detectTheme(),
}));

vi.mock("../src/cli/startup-ui.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/cli/startup-ui.ts")>()),
	shouldRunFirstTimeSetup: () => true,
}));

const { consumeStartupInput, startEarlyInputCapture } = await import("../src/main-early-input.ts");
const { runFirstTimeSetup } = await import("../src/main-first-time-setup.ts");
const { showStartupInput } = await import("../src/cli/startup-ui.ts");
const { showDeprecationWarnings } = await import("../src/migrations.ts");
const { confirmStartupQuestion, promptForDirtyCheckout } = await import("../src/main-session.ts");
const { selectSession } = await import("../src/cli/session-picker.ts");
const { initTheme } = await import("../src/modes/interactive/theme/theme.js");

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

const settingsManager = {
	getTerminalCapabilityOverrides: () => ({}),
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
	setTheme: vi.fn(),
	setEnableAnalytics: vi.fn(),
	flush: vi.fn(async () => {}),
} as unknown as SettingsManager;

class FakeStdin {
	isTTY = true;
	isRaw = false;
	listeners: Array<(chunk: Buffer | string) => void> = [];
	setRawMode(mode: boolean): void {
		this.isRaw = mode;
	}
	setEncoding(): void {}
	resume(): void {}
	pause(): void {}
	on(_event: "data", listener: (chunk: Buffer | string) => void): void {
		this.listeners.push(listener);
	}
	once(_event: "data", listener: (chunk: Buffer | string) => void): void {
		const once = (chunk: Buffer | string) => {
			this.off("data", once);
			listener(chunk);
		};
		this.listeners.push(once);
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

const fakeProcess = {
	pid: 1,
	platform: "linux" as NodeJS.Platform,
	on() {},
	off() {},
	removeListener() {},
	kill() {},
};

function startCapture(stdin: FakeStdin) {
	const capture = startEarlyInputCapture({ enabled: true, stdin, process: fakeProcess });
	assert.ok(capture);
	return capture;
}

async function focused(): Promise<Component> {
	return vi.waitFor(() => {
		const screen = screens.created.at(-1);
		assert.ok(screen?.running, "a startup screen is running");
		const component = vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0];
		assert.ok(component?.handleInput, "a startup screen took focus");
		return component;
	});
}

async function press(...keys: string[]): Promise<void> {
	await focused();
	for (const key of keys) {
		const screen = screens.created.at(-1)!;
		const component = vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0] as Component;
		component.handleInput?.(key);
	}
}

function settled<T>(promise: Promise<T>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	return new Promise((resolve) => setImmediate(() => resolve(done)));
}

beforeEach(() => {
	initTheme("dark");
	screens.created.length = 0;
	screens.detectTheme.mockReset().mockResolvedValue("dark");
});
afterEach(() => {
	consumeStartupInput(undefined);
});

test("first-time setup keeps type-ahead and text typed into it as a draft, and typed text never confirms it", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	stdin.emit("reply with PONG\r");

	const setup = runFirstTimeSetup("interactive", settingsManager, capture);
	await press(" please", ENTER, ENTER);
	assert.equal(await settled(setup), false, "Enter after typed text does not confirm the setup");
	assert.equal(stdin.listeners.length, 0, "the setup screen owns the terminal while it is open");

	await press(DOWN, UP, ENTER, ENTER);
	const kept = await setup;

	assert.deepEqual(consumeStartupInput(kept), {
		text: "reply with PONG\n please",
		submissions: [],
		heldForStartupDecision: true,
	});
});

test.each(["setup", "selector"])("keeps keys typed while a startup %s closes (#5241)", async (kind) => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	const answer =
		kind === "setup"
			? runFirstTimeSetup("interactive", settingsManager, capture)
			: promptForDirtyCheckout(
					{ checkout: "/a", recordedRoot: "/b", snapshotId: "0123456789abcdef" },
					settingsManager,
				);
	if (kind === "setup") await press(ENTER);
	await press(ENTER, "XYZ");
	await answer;
	assert.equal(consumeStartupInput(capture).text, "XYZ");
});

test("an unfinished startup prompt cannot submit an empty input dialog (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	stdin.emit("hello");
	const answer = showStartupInput(settingsManager, "Reason");
	const notice = (await focused()).render(160).join("\n");
	await press(ENTER, "answer", ENTER);
	assert.equal(await answer, "answer");
	assert.ok(notice.includes("Type your answer and press Enter; your earlier text is kept as a draft."));
	assert.equal(consumeStartupInput(capture).text, "hello");
});

test.each(["timeout", "abort", "escape"])(
	"keeps startup input text after %s and guards the next question (#5241)",
	async (ending) => {
		const stdin = new FakeStdin();
		const capture = startCapture(stdin);
		const controller = new AbortController();
		const answer = showStartupInput(settingsManager, "Reason", undefined, {
			timeout: ending === "timeout" ? 100 : undefined,
			signal: controller.signal,
		});
		const choice = promptForDirtyCheckout(
			{ checkout: "/a", recordedRoot: "/b", snapshotId: "0123456789abcdef" },
			settingsManager,
		);
		await press("hello");
		if (ending === "abort") controller.abort();
		if (ending === "escape") await press("\x1b[27u");
		assert.equal(await answer, undefined);
		await press(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 40));
		const answeredByPromptEnter = await settled(choice);
		await press(DOWN, ENTER);
		await choice;
		assert.equal(answeredByPromptEnter, false);
		assert.equal(consumeStartupInput(capture).text, "hello");
	},
);

test("keeps line breaks typed into a startup choice (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	const choice = promptForDirtyCheckout(
		{ checkout: "/a", recordedRoot: "/b", snapshotId: "0123456789abcdef" },
		settingsManager,
	);
	await press("fix bug", ENTER, "add tests", DOWN, ENTER);
	assert.equal(await choice, "use");
	assert.equal(consumeStartupInput(capture).text, "fix bug\nadd tests");
});

test.each(["picker", "input"])("keeps unread type-ahead out of the startup %s (#5241)", async (kind) => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	const text = kind === "picker" ? "second" : "hello";
	setImmediate(() => {
		if (stdin.listeners.length > 0) stdin.emit(`${text}\r`);
		else screens.created.at(-1)!.sendChunk(`${text}\r`);
	});
	const answer =
		kind === "picker"
			? selectSession(
					async () => pickerSessions,
					async () => pickerSessions,
					settingsManager,
				)
			: showStartupInput(settingsManager, "Reason");
	await focused();
	await new Promise((resolve) => setTimeout(resolve, 40));
	const answeredByTypeAhead = await settled(answer);
	if (kind === "picker") await press(DOWN, ENTER);
	else await press("reply", ENTER);
	const result = await answer;
	const draft = consumeStartupInput(capture).text;
	assert.equal(answeredByTypeAhead, false);
	assert.equal(typeof result === "string" ? result : result?.id, kind === "picker" ? "sess-second" : "reply");
	assert.equal(draft, text);
});

test("keeps keys typed after submitting a standalone startup input (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	const answer = showStartupInput(settingsManager, "Reason");
	await press("answer", ENTER, "XYZ");
	assert.equal(await answer, "answer");
	assert.equal(consumeStartupInput(capture).text, "XYZ");
});

test("keeps text typed during first-time setup theme detection (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	let detect!: (theme: "dark") => void;
	screens.detectTheme.mockReturnValue(
		new Promise((resolve) => {
			detect = resolve;
		}),
	);
	const setup = runFirstTimeSetup("interactive", settingsManager, capture);
	const guard = await focused();
	guard.handleInput?.("gap2");
	detect("dark");
	await press(DOWN, UP, ENTER, ENTER);
	await setup;
	assert.equal(consumeStartupInput(capture).text, "gap2");
});

test("the deprecation notice keeps type-ahead and the key that closes it as a draft", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	stdin.emit("reply with PONG\r");
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		const notice = showDeprecationWarnings(["Old extension path"], stdin);
		await vi.waitFor(() => assert.ok(log.mock.calls.some(([text]) => String(text).includes("Press any key"))));
		stdin.emit("and more");
		await notice;
	} finally {
		log.mockRestore();
	}

	assert.deepEqual(consumeStartupInput(capture), {
		text: "reply with PONG\nand more",
		submissions: [],
		heldForStartupDecision: true,
	});
});

test("the dirty-checkout question keeps type-ahead, explains how to answer, and guards Enter (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	stdin.emit("reply with PONG\r");

	const choice = promptForDirtyCheckout(
		{ checkout: "/a", recordedRoot: "/b", snapshotId: "0123456789abcdef" },
		settingsManager,
	);
	await press("typed", ENTER);
	assert.equal(await settled(choice), false, "Enter after typed text does not answer the question");
	const notice = (await focused()).render(160).join("\n");

	await press(DOWN, UP, ENTER);
	assert.equal(await choice, "restore");
	assert.ok(notice.includes("Answer with ↑↓ and Enter;"));
	assert.deepEqual(consumeStartupInput(capture), {
		text: "reply with PONG\ntyped",
		submissions: [],
		heldForStartupDecision: true,
	});
});

const pickerSessions: SessionInfo[] = ["first", "second"].map((name) => ({
	path: `/tmp/sess-${name}.jsonl`,
	id: `sess-${name}`,
	cwd: "/tmp",
	created: new Date(0),
	modified: new Date(0),
	messageCount: 1,
	firstMessage: name,
	allMessagesText: name,
}));

test.each(["navigation", "filter"])(
	"an unfinished startup prompt cannot pick a session before %s input (#5241)",
	async (kind) => {
		const stdin = new FakeStdin();
		const capture = startCapture(stdin);
		stdin.emit("hello");
		const picked = selectSession(
			async () => pickerSessions,
			async () => pickerSessions,
			settingsManager,
		);
		const notice = (await focused()).render(160).join("\n");
		await press(ENTER, kind === "navigation" ? DOWN : "second", ENTER);
		assert.equal((await picked)?.id, "sess-second");
		assert.ok(notice.includes("Answer with ↑↓ and Enter;"));
		assert.equal(consumeStartupInput(capture).text, "hello");
	},
);

test.each(["\x1b[13;5u", "\x1b[27;5;13~"])(
	"guards a custom prompt-submit key %j in the startup picker (#5241)",
	async (submitKey) => {
		const bindings = vi.spyOn(KeybindingsManager, "create").mockReturnValue(
			new KeybindingsManager({
				"tui.input.submit": ["enter", "ctrl+enter"],
			}),
		);
		const stdin = new FakeStdin();
		const capture = startCapture(stdin);
		try {
			stdin.emit("hello");
			const picked = selectSession(
				async () => pickerSessions,
				async () => pickerSessions,
				settingsManager,
			);
			await press(submitKey);
			await new Promise((resolve) => setTimeout(resolve, 40));
			const answeredByPromptSubmit = await settled(picked);
			await press(DOWN, ENTER);
			await picked;
			assert.equal(answeredByPromptSubmit, false);
			assert.equal(consumeStartupInput(capture).text, "hello");
		} finally {
			bindings.mockRestore();
			consumeStartupInput(capture);
		}
	},
);

test.each(["select", "cancel"])("keeps keys in the same stdin chunk after picker %s (#5241)", async (kind) => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	const picked = selectSession(
		async () => pickerSessions,
		async () => pickerSessions,
		settingsManager,
	);
	await press(DOWN);
	screens.created.at(-1)!.sendChunk(`${kind === "select" ? ENTER : "\x1b[27u"}XYZ`);
	assert.equal((await picked)?.id ?? null, kind === "select" ? "sess-second" : null);
	assert.equal(consumeStartupInput(capture).text, "XYZ");
});

test("the resume picker keeps type-ahead as a draft instead of filtering or picking with it", async () => {
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	stdin.emit("reply with PONG\r");

	const picked = selectSession(
		async () => [],
		async () => [],
		settingsManager,
	);
	await focused();
	assert.equal(stdin.listeners.length, 0, "the picker owns the terminal while it is open");
	await press("\x1b");

	assert.equal(await picked, null);
	assert.deepEqual(consumeStartupInput(capture), {
		text: "reply with PONG",
		submissions: [],
		heldForStartupDecision: true,
	});
});

test("the fork question keeps type-ahead as a draft and asks again when an answer is neither yes nor no", async () => {
	const { PassThrough } = await import("node:stream");
	const stdin = new FakeStdin();
	const capture = startCapture(stdin);
	stdin.emit("reply with PONG\r");
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();

	const answer = confirmStartupQuestion("Fork this session into current directory?", { input, output });
	input.write("some prompt text\n");
	assert.equal(await settled(answer), false, "text that is not an answer does not answer the question");
	input.write("y\n");

	assert.equal(await answer, true);
	assert.deepEqual(consumeStartupInput(capture), {
		text: "reply with PONG\nsome prompt text",
		submissions: [],
		heldForStartupDecision: true,
	});
});
