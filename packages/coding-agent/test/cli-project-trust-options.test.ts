import assert from "node:assert/strict";
import type { Component } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ExtensionUIDialogOptions, ProjectTrustContext } from "../src/core/extensions/types.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const screens = vi.hoisted(() => ({
	created: [] as Array<{ stop: () => void; setFocus: (component: Component) => void }>,
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

const { createProjectTrustContext } = await import("../src/cli/project-trust.ts");
const { consumeStartupInput } = await import("../src/main-early-input.ts");
const settingsManager = {
	getTerminalCapabilityOverrides: () => ({}),
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
} as SettingsManager;

type Method = "select" | "confirm" | "input";
function ask(context: ProjectTrustContext, method: Method, options: ExtensionUIDialogOptions) {
	switch (method) {
		case "select":
			return context.ui.select("Choose", ["A", "B"], options);
		case "confirm":
			return context.ui.confirm("Approve", "Continue?", options);
		case "input":
			return context.ui.input("Reason", undefined, options);
	}
}

beforeEach(() => {
	screens.created.length = 0;
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	consumeStartupInput(undefined);
});

test.each(["select", "confirm", "input"] as const)("project trust %s closes on abort (#5241)", async (method) => {
	const context = createProjectTrustContext({ cwd: process.cwd(), mode: "interactive", settingsManager, hasUI: true });
	const controller = new AbortController();
	const answer = ask(context, method, { signal: controller.signal });
	controller.abort();
	await vi.advanceTimersByTimeAsync(25);
	const screen = screens.created.at(-1)!;
	const stopped = vi.mocked(screen.stop).mock.calls.length;
	if (stopped === 0) {
		vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0].handleInput?.("\x1b");
		await vi.advanceTimersByTimeAsync(25);
	}
	await answer;
	assert.equal(stopped, 1);
});

test.each(["select", "confirm", "input"] as const)("project trust %s closes on timeout (#5241)", async (method) => {
	const context = createProjectTrustContext({ cwd: process.cwd(), mode: "interactive", settingsManager, hasUI: true });
	const answer = ask(context, method, { timeout: 1000 });
	await vi.advanceTimersByTimeAsync(1025);
	const screen = screens.created.at(-1)!;
	const stopped = vi.mocked(screen.stop).mock.calls.length;
	if (stopped === 0) {
		vi.mocked(screen.setFocus).mock.calls.at(-1)?.[0].handleInput?.("\x1b");
		await vi.advanceTimersByTimeAsync(25);
	}
	await answer;
	assert.equal(stopped, 1);
});
