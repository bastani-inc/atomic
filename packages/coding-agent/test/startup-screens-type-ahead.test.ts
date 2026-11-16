import assert from "node:assert/strict";
import type { Component } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const screens = vi.hoisted(() => ({
	created: [] as Array<{ setFocus: (component: unknown) => void }>,
	detectTheme: vi.fn<() => Promise<"dark">>(async () => "dark"),
}));

vi.mock("@bastani/atomic-tui", async (importOriginal) => {
	const original = await importOriginal<typeof import("@bastani/atomic-tui")>();
	class FakeMainScreen extends original.Container {
		start = vi.fn();
		stop = vi.fn();
		clear = vi.fn();
		requestRender = vi.fn();
		setFocus = vi.fn();
		setClearOnShrink = vi.fn();
		constructor() {
			super();
			screens.created.push(this);
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
	await new Promise((resolve) => setImmediate(resolve));
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const screen = screens.created.at(-1);
		const component = screen
			? (vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0] as Component | undefined)
			: undefined;
		if (component?.handleInput) return component;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("a startup screen took focus");
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
	await new Promise((resolve) => setImmediate(resolve));
	const screen = screens.created.at(-1);
	const guard = screen && (vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0] as Component | undefined);
	guard?.handleInput?.("gap2");
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
