import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const screens = vi.hoisted(() => ({ created: [] as Array<{ stop: () => void; start: () => void }> }));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
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

const { showStartupInput, showStartupSelector } = await import("../src/cli/startup-ui.ts");

const settingsManager = {
	getTerminalCapabilityOverrides: () => ({}),
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
} as unknown as SettingsManager;

const OPTIONS = [
	{ label: "Trust", value: true },
	{ label: "Do not trust", value: false },
];

beforeEach(() => {
	screens.created.length = 0;
});

test("closes the standalone startup selector when its abort signal fires", async () => {
	const controller = new AbortController();
	const selection = showStartupSelector(settingsManager, "Trust project folder?", OPTIONS, {
		signal: controller.signal,
	});
	assert.equal(screens.created.length, 1);

	controller.abort();

	assert.equal(await selection, undefined);
	assert.equal(vi.mocked(screens.created[0]!.stop).mock.calls.length, 1);
});

test("closes the standalone startup input when its abort signal fires", async () => {
	const controller = new AbortController();
	const typed = showStartupInput(settingsManager, "Reason", undefined, { signal: controller.signal });

	controller.abort();

	assert.equal(await typed, undefined);
	assert.equal(vi.mocked(screens.created[0]!.stop).mock.calls.length, 1);
});

test("does not open a standalone startup dialog for an already aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();
	const dialogOptions = { signal: controller.signal };

	assert.equal(await showStartupSelector(settingsManager, "Trust project folder?", OPTIONS, dialogOptions), undefined);
	assert.equal(await showStartupInput(settingsManager, "Reason", undefined, dialogOptions), undefined);
	assert.equal(screens.created.length, 0);
});
