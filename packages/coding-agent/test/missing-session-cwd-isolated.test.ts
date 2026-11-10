/**
 * Interactive mode runs its session in an engine process. A resume or import whose session's working directory is gone
 * fails in the engine, so the typed error must cross the RPC boundary for the host to offer Continue, Fork or Cancel
 * (earendil-works/pi#11060).
 */

import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { isMissingSessionCwdError, MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.ts";

let pair: EngineHostPair | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await pair?.cleanup();
	pair = undefined;
});

const missingCwd = () =>
	new MissingSessionCwdError({
		sessionFile: "/sessions/s.jsonl",
		sessionCwd: "/renamed-from",
		fallbackCwd: "/renamed-to",
	});

type ResumeHandler = (
	this: InteractiveModeBase,
	sessionId: string,
	options?: unknown,
	sessionDirectory?: string,
) => Promise<{ cancelled: boolean }>;
type ImportHandler = (this: InteractiveModeBase, text: string) => Promise<void>;

function hostMode(runtimeHost: AgentSessionRuntime, choice: "continue" | "fork" | undefined) {
	const showStatus = vi.fn();
	const handleFatalRuntimeError = vi.fn(async () => ({ cancelled: true }));
	const switchToForkedSession = vi.fn(async () => ({ cancelled: false }));
	const mode = {
		statusContainer: new Container(),
		settingsManager: { getClearOnShrink: () => false },
		ensureDeferredStartupComplete: async () => {},
		clearWorkingLoader() {},
		loadingAnimation: undefined,
		runtimeHost,
		sessionManager: { getBranch: () => [], getWorktreeSnapshotRecords: () => new Map() },
		showStatus,
		showWarning: vi.fn(),
		showError: vi.fn(),
		showExtensionConfirm: vi.fn(async () => true),
		promptForMissingSessionCwd: vi.fn(async () => choice),
		switchToForkedSession,
		handleFatalRuntimeError,
		createProjectTrustContext: () => ({}),
		renderCurrentSessionState: vi.fn(),
		firstRunNoticeVisible: false,
		clearFirstRunOnboardingUi: vi.fn(),
		startSessionRecovery: vi.fn(),
		getPathCommandArgument: (InteractiveMode.prototype as unknown as { getPathCommandArgument: unknown })
			.getPathCommandArgument,
	};
	return { mode: mode as unknown as InteractiveModeBase, showStatus, handleFatalRuntimeError, switchToForkedSession };
}

const resumeHandler = InteractiveMode.prototype.handleResumeSession as unknown as ResumeHandler;
const importHandler = (InteractiveMode.prototype as unknown as { handleImportCommand: ImportHandler })
	.handleImportCommand;

describe("a missing session cwd reported by the interactive engine (earendil-works/pi#11060)", () => {
	it("reaches the host as the typed error when a resume fails", async () => {
		pair = await createEngineHostPair({});
		const failure = missingCwd();
		pair.failCommand("switch_session", failure.message, failure);

		const rejection = await pair.runtime
			.switchSession("session-id", { sessionDirectory: "/sessions" })
			.catch((e) => e);

		expect(rejection).toBeInstanceOf(MissingSessionCwdError);
		expect(isMissingSessionCwdError(rejection)).toBe(true);
		expect(rejection).toMatchObject({ code: "session-cwd-missing", retryable: false, issue: failure.issue });
		expect(rejection.fields()).toEqual(failure.fields());
	});

	it("reaches the host as the typed error when an import fails", async () => {
		pair = await createEngineHostPair({});
		const failure = missingCwd();
		pair.failCommand("import_session", failure.message, failure);

		const rejection = await pair.runtime.importFromJsonl("/exports/s.jsonl").catch((e) => e);

		expect(rejection).toBeInstanceOf(MissingSessionCwdError);
		expect(rejection.issue).toEqual(failure.issue);
	});

	it("leaves any other engine failure a plain error", async () => {
		pair = await createEngineHostPair({});
		pair.failCommand("switch_session", "storage is down");

		const rejection = await pair.runtime.switchSession("session-id").catch((e) => e);

		expect(rejection).not.toBeInstanceOf(MissingSessionCwdError);
		expect(isMissingSessionCwdError(rejection)).toBe(false);
		expect(rejection).toMatchObject({ message: "storage is down" });
	});

	it("lets /resume offer the choice, and Continue asks the engine to run the session in the current cwd", async () => {
		pair = await createEngineHostPair({});
		pair.failCommand("switch_session", "unused", missingCwd());
		const { mode } = hostMode(pair.runtime, "continue");
		const retryFails = () => pair?.failCommand("switch_session", "the retry reached the engine");
		mode.promptForMissingSessionCwd = vi.fn(async () => {
			retryFails();
			return "continue" as const;
		});

		await expect(resumeHandler.call(mode, "session-id", undefined, "/sessions")).rejects.toThrow(
			"the retry reached the engine",
		);

		expect(mode.promptForMissingSessionCwd).toHaveBeenCalledTimes(1);
		const requests = pair.commandsReceived.filter((command) => command.type === "switch_session");
		expect(requests).toMatchObject([
			{ sessionId: "session-id", sessionDirectory: "/sessions" },
			{ sessionId: "session-id", sessionDirectory: "/sessions", cwdOverride: "/renamed-to" },
		]);
		expect((requests[0] as { cwdOverride?: string }).cwdOverride).toBeUndefined();
	});

	it("lets /resume cancel without a second request to the engine", async () => {
		pair = await createEngineHostPair({});
		pair.failCommand("switch_session", "unused", missingCwd());
		const { mode, showStatus, handleFatalRuntimeError } = hostMode(pair.runtime, undefined);

		const result = await resumeHandler.call(mode, "session-id");

		expect(result).toEqual({ cancelled: true });
		expect(pair.commandsReceived.filter((command) => command.type === "switch_session")).toHaveLength(1);
		expect(showStatus).toHaveBeenCalledWith("Resume cancelled");
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	it("lets /resume fork the session instead of asking the engine again", async () => {
		pair = await createEngineHostPair({});
		pair.failCommand("switch_session", "unused", missingCwd());
		const { mode, switchToForkedSession } = hostMode(pair.runtime, "fork");

		await resumeHandler.call(mode, "session-id", undefined, "/sessions");

		expect(switchToForkedSession).toHaveBeenCalledWith(
			{ sessionId: "session-id", sessionDirectory: "/sessions" },
			"/renamed-to",
			undefined,
		);
		expect(pair.commandsReceived.filter((command) => command.type === "switch_session")).toHaveLength(1);
	});

	it("lets /import offer the choice, and Continue asks the engine to import into the current cwd", async () => {
		pair = await createEngineHostPair({});
		pair.failCommand("import_session", "unused", missingCwd());
		const { mode } = hostMode(pair.runtime, "continue");
		mode.promptForMissingSessionCwd = vi.fn(async () => {
			pair?.failCommand("import_session", "the retry reached the engine");
			return "continue" as const;
		});

		await expect(importHandler.call(mode, "/import /exports/s.jsonl")).rejects.toThrow(
			"the retry reached the engine",
		);

		const requests = pair.commandsReceived.filter((command) => command.type === "import_session");
		expect(requests).toMatchObject([
			{ inputPath: "/exports/s.jsonl" },
			{ inputPath: "/exports/s.jsonl", cwdOverride: "/renamed-to" },
		]);
	});

	it("opens the imported session in the current cwd on the host too after Continue", async () => {
		const imported = vi.fn(async () => ({ cancelled: false }));
		pair = await createEngineHostPair({ engineRuntimeHost: { importFromJsonl: imported } });
		vi.spyOn(pair.runtime.session.sessionManager, "isPersisted").mockReturnValue(true);
		const mirrored = vi.spyOn(AgentSessionRuntime.prototype, "switchSession").mockResolvedValue({ cancelled: false });

		const result = await pair.runtime.importFromJsonl("/exports/s.jsonl", "/renamed-to");

		expect(result).toEqual({ cancelled: false });
		expect(imported).toHaveBeenCalledWith("/exports/s.jsonl", "/renamed-to");
		expect(mirrored).toHaveBeenCalledWith(
			pair.engine.session.sessionId,
			expect.objectContaining({ cwdOverride: "/renamed-to" }),
		);
	});
});
