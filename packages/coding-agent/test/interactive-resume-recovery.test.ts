import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import { describe, it, vi } from "vitest";
import type { SessionRecoveryReport } from "../src/core/agent-session-types.ts";
import type { SessionRecoveryReason } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { formatSessionRecoveryStatus } from "../src/modes/interactive/interactive-session-runtime.ts";
import { createRpcInputScheduler } from "../src/modes/rpc/rpc-input-scheduler.ts";

const EMPTY_REPORT: SessionRecoveryReport = { replayed: 0, dropped: 0, completions: 0, notices: [] };

function resumeMode(order: string[], recover: (reason: SessionRecoveryReason) => void) {
	return {
		statusContainer: new Container(),
		settingsManager: { getClearOnShrink: () => false },
		firstRunNoticeVisible: false,
		ensureDeferredStartupComplete: async () => {},
		runtimeHost: {
			switchSession: async () => {
				order.push("switch");
				return { cancelled: false };
			},
		},
		renderCurrentSessionState: () => order.push("render"),
		showStatus: (message: string) => order.push(`status:${message}`),
		createProjectTrustContext: () => ({}),
		startSessionRecovery: (reason: SessionRecoveryReason) => {
			order.push("recover");
			recover(reason);
		},
	};
}

describe("interactive resume recovery (#3760)", () => {
	it("/resume renders the resumed transcript before it starts recovery (#3760)", async () => {
		const order: string[] = [];
		const reasons: SessionRecoveryReason[] = [];
		const mode = resumeMode(order, (reason) => reasons.push(reason));

		const result = await InteractiveMode.prototype.handleResumeSession.call(
			mode as unknown as InteractiveModeBase,
			"resumed-session",
		);

		assert.deepEqual(result, { cancelled: false });
		assert.deepEqual(order, ["switch", "render", "status:Resumed session", "recover"]);
		assert.deepEqual(reasons, ["resume"]);
	});

	it("a cancelled /resume starts no recovery (#3760)", async () => {
		const order: string[] = [];
		const mode = resumeMode(order, () => {});
		mode.runtimeHost.switchSession = async () => ({ cancelled: true });

		await InteractiveMode.prototype.handleResumeSession.call(mode as unknown as InteractiveModeBase, "other");

		assert.deepEqual(order, []);
	});

	it("startSessionRecovery reports what recovery did in the status line (#3760)", async () => {
		const statuses: string[] = [];
		const recovery = Promise.withResolvers<SessionRecoveryReport>();
		const session = { startPendingRecovery: vi.fn(() => recovery.promise) };
		const mode = {
			session,
			isShuttingDown: false,
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => statuses.push(`error:${message}`),
		};

		InteractiveMode.prototype.startSessionRecovery.call(mode as unknown as InteractiveModeBase, "startup");
		assert.deepEqual(session.startPendingRecovery.mock.calls, [["startup"]]);
		assert.deepEqual(statuses, [], "the transcript stays usable while recovery runs");
		recovery.resolve({ replayed: 2, dropped: 1, completions: 1, notices: ["Subagent w1 is gone."] });
		await vi.waitFor(() =>
			assert.deepEqual(statuses, [
				"Recovered interrupted work: replayed 2 interrupted deliveries, skipped 1 stale delivery, showed 1 background result",
			]),
		);
	});

	it("startSessionRecovery surfaces a failure instead of hiding it (#3760)", async () => {
		const statuses: string[] = [];
		const mode = {
			session: { startPendingRecovery: async () => Promise.reject(new Error("extension exploded")) },
			isShuttingDown: false,
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => statuses.push(`error:${message}`),
		};

		InteractiveMode.prototype.startSessionRecovery.call(mode as unknown as InteractiveModeBase, "resume");

		await vi.waitFor(() => assert.deepEqual(statuses, ["error:Session recovery failed: extension exploded"]));
	});

	it("an empty recovery adds no status noise (#3760)", () => {
		assert.equal(formatSessionRecoveryStatus(EMPTY_REPORT), undefined);
	});

	it("deferred startup starts recovery only after rebuilding the transcript with loaded extensions (#3760)", async () => {
		const order: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveModeBase;
		Object.defineProperties(mode, {
			session: {
				configurable: true,
				value: {
					reload: async () => order.push("reload"),
					resourceLoader: { getThemes: () => ({ themes: [] }) },
					extensionRunner: {},
					modelRuntime: { getError: () => undefined, getWarning: () => undefined },
				},
			},
			options: { configurable: true, value: {} },
		});
		Object.assign(mode, {
			chatContainer: new Container(),
			startupNoticesContainer: new Container(),
			resourceDisclosureContainer: new Container(),
			ui: { requestRender() {} },
			bindCurrentSessionExtensions: async () => order.push("bind"),
			applyRuntimeSettings() {},
			rebuildChatFromMessages: () => order.push("render"),
			promptTurnWorkingLoaderActive: false,
			stopWorkingLoader() {},
			themeController: { applyFromSettings: async () => {} },
			setupAutocompleteProvider() {},
			setupExtensionShortcuts() {},
			retryDeferredModelRestore: async () => {},
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor() {},
			showLoadedResources() {},
			showStartupNoticesIfNeeded() {},
			reportModelCatalogWarning() {},
			maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
			startSessionRecovery: (reason: SessionRecoveryReason) => order.push(`recover:${reason}`),
		});

		await mode.completeDeferredStartup();

		assert.deepEqual(order, ["bind", "reload", "render", "recover:startup"]);
	});

	it("failed deferred extension loading leaves interrupted work for a later resume (#3760)", async () => {
		const order: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveModeBase;
		Object.assign(mode, {
			chatContainer: new Container(),
			startupNoticesContainer: new Container(),
			ui: { requestRender() {} },
			bindCurrentSessionExtensions: async () => {
				throw new Error("extension load failed");
			},
			promptTurnWorkingLoaderActive: false,
			stopWorkingLoader() {},
			showError: (message: string) => order.push(`error:${message}`),
			maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
			startSessionRecovery: () => order.push("recover"),
		});

		await mode.completeDeferredStartup();

		assert.deepEqual(order, ["error:Extension loading failed: extension load failed"]);
	});

	it("an RPC recovery request never holds up ordinary commands such as prompts (#3760)", async () => {
		const started: string[] = [];
		const recovery = Promise.withResolvers<void>();
		const schedule = createRpcInputScheduler(async (line) => {
			const type = (JSON.parse(line) as { type: string }).type;
			started.push(type);
			if (type === "start_pending_recovery") await recovery.promise;
		});

		schedule(JSON.stringify({ id: "1", type: "start_pending_recovery", reason: "startup" }));
		schedule(JSON.stringify({ id: "2", type: "prompt", message: "typed while recovering" }));

		await vi.waitFor(() => assert.deepEqual(started, ["start_pending_recovery", "prompt"]));
		recovery.resolve();
	});
});
