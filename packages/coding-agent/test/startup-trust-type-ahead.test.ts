import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { getProjectTrustOptions } from "../src/core/trust-manager.ts";

const screens = vi.hoisted(() => ({ created: [] as Array<{ setFocus: (component: unknown) => void }> }));

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

const { showStartupSelector } = await import("../src/cli/startup-ui.ts");
const { consumeStartupInput, startEarlyInputCapture } = await import("../src/main-early-input.ts");

const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TRUST_PROMPT = "Trust project folder?";

const settingsManager = {
	getTerminalCapabilityOverrides: () => ({}),
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
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

const fakeProcess = {
	pid: 1,
	platform: "linux" as NodeJS.Platform,
	on() {},
	off() {},
	removeListener() {},
	kill() {},
};

let projectDir: string;
beforeEach(() => {
	screens.created.length = 0;
	projectDir = mkdtempSync(join(tmpdir(), "atomic-startup-trust-type-ahead-"));
});
afterEach(() => {
	consumeStartupInput(undefined);
	rmSync(projectDir, { recursive: true, force: true });
});

function trustOptions() {
	return getProjectTrustOptions(projectDir, { includeSessionOnly: true }).map((option) => ({
		label: option.label,
		value: option,
	}));
}

/** The component the standalone startup dialog focused, which receives the dialog's keys. */
function dialog(): Component {
	const screen = screens.created.at(-1);
	assert.ok(screen, "a startup dialog is open");
	const focused = vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0] as Component | undefined;
	assert.ok(focused?.handleInput, "the startup dialog has focus");
	return focused;
}

function press(...keys: string[]): void {
	for (const key of keys) dialog().handleInput?.(key);
}

function settled<T>(promise: Promise<T>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	return new Promise((resolve) => setImmediate(() => resolve(done)));
}

test("type-ahead submitted before the startup trust prompt comes back as a draft and is not sent", async () => {
	const stdin = new FakeStdin();
	const capture = startEarlyInputCapture({ enabled: true, stdin, process: fakeProcess });
	assert.ok(capture);

	stdin.emit("reply with PONG\r");
	const answer = showStartupSelector(settingsManager, TRUST_PROMPT, trustOptions());
	// The dialog owns the terminal while it is open: its keys are not prompt text.
	assert.equal(stdin.listeners.length, 0);
	press(UP, UP, ENTER);
	assert.equal((await answer)?.label, "Trust (this session only)");
	stdin.emit(" please");

	assert.deepEqual(consumeStartupInput(capture), {
		text: "reply with PONG\n please",
		submissions: [],
		heldForStartupDecision: true,
	});
});

test("keeps text typed before, during and after startup questions in order (#5241)", async () => {
	const stdin = new FakeStdin();
	const capture = startEarlyInputCapture({ enabled: true, stdin, process: fakeProcess });
	assert.ok(capture);

	stdin.emit("first\rsecond");
	const firstAnswer = showStartupSelector(settingsManager, TRUST_PROMPT, trustOptions());
	press("third", DOWN, UP, ENTER);
	await firstAnswer;
	stdin.emit("fourth\rfifth");
	const secondAnswer = showStartupSelector(settingsManager, TRUST_PROMPT, trustOptions());
	press("sixth", DOWN, UP, ENTER);
	await secondAnswer;
	stdin.emit("seventh");

	assert.deepEqual(consumeStartupInput(capture), {
		text: "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh",
		submissions: [],
		heldForStartupDecision: true,
	});
});

test("text typed into the startup trust prompt is kept and its Enter grants nothing", async () => {
	const answer = showStartupSelector(settingsManager, TRUST_PROMPT, trustOptions());

	press("reply with the single word PONG", ENTER);
	assert.equal(await settled(answer), false, "Enter after typed text does not answer the trust prompt");

	press(DOWN, UP, ENTER);
	assert.equal((await answer)?.trusted, false);
	assert.deepEqual(consumeStartupInput(undefined), {
		text: "reply with the single word PONG",
		submissions: [],
		heldForStartupDecision: true,
	});
});

test("the startup trust prompt starts on a choice that trusts nothing", async () => {
	const answer = showStartupSelector(settingsManager, TRUST_PROMPT, trustOptions());

	press(ENTER);

	const chosen = await answer;
	assert.equal(chosen?.trusted, false);
	assert.deepEqual(chosen?.updates, []);
});

test("arrow keys and Enter still answer the startup trust prompt", async () => {
	const answer = showStartupSelector(settingsManager, TRUST_PROMPT, trustOptions());

	press(UP, UP, UP, UP, UP, ENTER);

	assert.equal((await answer)?.label, "Trust");
	assert.deepEqual(consumeStartupInput(undefined), { text: "", submissions: [] });
});
