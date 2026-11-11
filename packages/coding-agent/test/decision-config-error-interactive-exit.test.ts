import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { DecisionConfigError } from "../src/core/decision/errors.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import type { ActivityWatchdogDiagnostic } from "../src/modes/interactive-engine/activity-watchdog.js";
import "../src/modes/interactive/interactive-deferred-startup.js";
import "../src/modes/interactive/interactive-session-runtime.js";
import * as refusedSetting from "../src/modes/interactive/refused-decision-setting.js";

class ExitCalled extends Error {}

const refused = new DecisionConfigError({
	code: "invalid-setting",
	source: "settings",
	field: "decisionModel",
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
	assert.ok(mode.stop.mock.calls.some((args: unknown[]) => args.length === 1 && args[0] === "transcript"));
	assert.equal(stderr.mock.calls.length, 1);
	assert.ok(String(stderr.mock.calls[0]![0]).includes(refused.message));
	assert.ok(exit.mock.calls.some((args) => args.length === 1 && args[0] === 1));
});

test("any other failure leaves the TUI running", () => {
	const { exit, stderr } = exitSpies();
	const mode = { stop: vi.fn() };
	for (const error of [new Error("bad extension"), undefined])
		refusedSetting.exitOnRefusedDecisionSetting(mode, error);
	assert.equal(mode.stop.mock.calls.length, 0);
	assert.equal(stderr.mock.calls.length, 0);
	assert.equal(exit.mock.calls.length, 0);
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
	await assert.rejects(InteractiveModeBase.prototype.completeDeferredStartup.call(mode as never), ExitCalled);
	assert.ok(mode.stop.mock.calls.some((args: unknown[]) => args.length === 1 && args[0] === "transcript"));
	assert.ok(exit.mock.calls.some((args) => args.length === 1 && args[0] === 1));
	assert.equal(mode.showError.mock.calls.length, 0);
});

test("an engine diagnostic carrying a refused decision setting stops Atomic; failures are shown and a successful restart is silent", () => {
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
	assert.ok(exit.mock.calls.some((args) => args.length === 1 && args[0] === 1));
	assert.equal(mode.showError.mock.calls.length, 0);
	InteractiveModeBase.prototype.handleEngineDiagnostic.call(mode as never, {
		...failure,
		error: new Error("bad extension"),
	});
	assert.ok(mode.showError.mock.calls.some((args: unknown[]) => args.length === 1 && args[0] === failure.message));
	InteractiveModeBase.prototype.handleEngineDiagnostic.call(mode as never, {
		activity: undefined,
		elapsedMs: 0,
		level: "blocking",
		source: "recovery",
		message: "Engine restarted",
	});
	assert.equal(mode.stopWorkingLoader.mock.calls.length, 1);
	assert.equal(
		mode.showStatus.mock.calls.some((args: unknown[]) => args[0] === "Engine restarted"),
		false,
		"a successful engine restart shows nothing",
	);
	assert.equal(mode.stop.mock.calls.length, 1);
});
