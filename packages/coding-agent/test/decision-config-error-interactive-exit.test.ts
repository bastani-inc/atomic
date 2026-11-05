import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { DecisionConfigError } from "../src/core/decision/errors.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.ts";
import "../src/modes/interactive/interactive-deferred-startup.ts";
import "../src/modes/interactive/interactive-session-runtime.ts";
import * as refusedSetting from "../src/modes/interactive/refused-decision-setting.ts";

class ExitCalled extends Error {}

const refused = new DecisionConfigError({
	code: "renamed-setting",
	source: "settings",
	field: "routerModel",
	scope: "project",
});

function exitSpies() {
	const exit = vi.spyOn(process, "exit").mockImplementation(() => {
		throw new ExitCalled();
	});
	const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
	return { exit, stderr };
}

afterEach(() => {
	vi.restoreAllMocks();
});

test("a refused decision setting found after startup stops the TUI, prints its message once and exits 1 (#4358)", () => {
	const { exit, stderr } = exitSpies();
	const mode = { stop: vi.fn() };
	assert.throws(
		() =>
			refusedSetting.exitOnRefusedDecisionSetting(
				mode,
				new Error("Interactive engine resource loading failed", { cause: refused }),
			),
		ExitCalled,
	);
	expect(mode.stop).toHaveBeenCalledWith("transcript");
	expect(stderr).toHaveBeenCalledTimes(1);
	expect(String(stderr.mock.calls[0]![0])).toContain(refused.message);
	expect(exit).toHaveBeenCalledWith(1);
});

test("any other failure leaves the TUI running", () => {
	const { exit, stderr } = exitSpies();
	const mode = { stop: vi.fn() };
	for (const error of [new Error("bad extension"), undefined])
		refusedSetting.exitOnRefusedDecisionSetting(mode, error);
	expect(mode.stop).not.toHaveBeenCalled();
	expect(stderr).not.toHaveBeenCalled();
	expect(exit).not.toHaveBeenCalled();
});

test("deferred startup stops on a project setting refused when the project is trusted at the prompt", async () => {
	const { exit } = exitSpies();
	const mode = {
		bindCurrentSessionExtensions: async () => {
			throw refused;
		},
		stop: vi.fn(),
		promptTurnWorkingLoaderActive: true,
		deferredStartupPending: true,
		showError: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		chatContainer: undefined,
	};
	await expect(InteractiveModeBase.prototype.completeDeferredStartup.call(mode as never)).rejects.toBeInstanceOf(
		ExitCalled,
	);
	expect(mode.stop).toHaveBeenCalledWith("transcript");
	expect(exit).toHaveBeenCalledWith(1);
	expect(mode.showError).not.toHaveBeenCalled();
});

test("an engine diagnostic carrying a refused decision setting stops Atomic; others are shown", () => {
	const { exit } = exitSpies();
	const mode = {
		stop: vi.fn(),
		stopWorkingLoader: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	const failure: ActivityWatchdogDiagnostic = {
		activity: undefined,
		elapsedMs: 0,
		level: "unresponsive",
		message: "Interactive engine resource loading failed: renamed setting",
		error: new Error("wrapped", { cause: refused }),
	};
	assert.throws(() => InteractiveModeBase.prototype.handleEngineDiagnostic.call(mode as never, failure), ExitCalled);
	expect(exit).toHaveBeenCalledWith(1);
	expect(mode.showError).not.toHaveBeenCalled();
	InteractiveModeBase.prototype.handleEngineDiagnostic.call(mode as never, {
		...failure,
		error: new Error("bad extension"),
	});
	expect(mode.showError).toHaveBeenCalledWith(failure.message);
	InteractiveModeBase.prototype.handleEngineDiagnostic.call(mode as never, {
		activity: undefined,
		elapsedMs: 0,
		level: "blocking",
		source: "recovery",
		message: "Engine restarted",
	});
	expect(mode.stopWorkingLoader).toHaveBeenCalledTimes(1);
	expect(mode.showStatus).toHaveBeenCalledWith("Engine restarted", undefined);
	expect(mode.stop).toHaveBeenCalledTimes(1);
});
