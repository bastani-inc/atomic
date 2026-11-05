import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { DecisionConfigError } from "../src/core/decision/errors.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.ts";
import "../src/modes/interactive/interactive-deferred-startup.ts";
import "../src/modes/interactive/interactive-session-runtime.ts";

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
			InteractiveModeBase.prototype.exitOnRefusedDecisionSetting.call(
				mode as never,
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
		InteractiveModeBase.prototype.exitOnRefusedDecisionSetting.call(mode as never, error);
	expect(mode.stop).not.toHaveBeenCalled();
	expect(stderr).not.toHaveBeenCalled();
	expect(exit).not.toHaveBeenCalled();
});

test("deferred startup stops on a project setting refused when the project is trusted at the prompt", async () => {
	const exitOnRefusedDecisionSetting = vi.fn();
	const showError = vi.fn();
	const mode = {
		bindCurrentSessionExtensions: async () => {
			throw refused;
		},
		exitOnRefusedDecisionSetting,
		promptTurnWorkingLoaderActive: true,
		deferredStartupPending: true,
		showError,
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		chatContainer: undefined,
	};
	await InteractiveModeBase.prototype.completeDeferredStartup.call(mode as never);
	expect(exitOnRefusedDecisionSetting).toHaveBeenCalledWith(refused);
	expect(showError).toHaveBeenCalledWith(`Extension loading failed: ${refused.message}`);
});

test("an engine diagnostic carrying a refused decision setting stops Atomic; others are shown", () => {
	const exitOnRefusedDecisionSetting = vi.fn();
	const mode = {
		exitOnRefusedDecisionSetting,
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
	InteractiveModeBase.prototype.handleEngineDiagnostic.call(mode as never, failure);
	expect(exitOnRefusedDecisionSetting).toHaveBeenCalledWith(failure.error);
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
});
