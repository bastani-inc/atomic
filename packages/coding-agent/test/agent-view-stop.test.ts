import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import type { Terminal } from "@bastani/atomic-tui";
import { test } from "vitest";
import {
	type AgentSessionRuntime,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { NO_QUEUED_MESSAGES } from "../src/core/queued-message-delivery.ts";
import { SessionManager } from "../src/core/session-manager.js";
import { InteractiveMode } from "../src/index.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import type { InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.js";

/** A real interactive mode over a real session costs a full startup. */
const REAL_MODE_TIMEOUT_MS = 60_000;

class QuietTerminal implements Terminal {
	columns = 120;
	rows = 30;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

/**
 * An isolated-engine host whose engine is the test: the session is a real in-process one, and the engine's messages
 * and generation endings are delivered by hand.
 */
function engineStandIn(base: AgentSessionRuntime, cwd: string, agentDir: string) {
	const engineListeners = new Set<(message: InteractiveEngineMessage) => void>();
	const endedListeners = new Set<(event: { expected: boolean; generation: number }) => void>();
	const requests: object[] = [];
	const runtime = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
	const subscribe =
		<T>(listeners: Set<T>) =>
		(listener: T) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
	const none = () => () => {};
	const members: Record<string, unknown> = {
		session: base.session,
		services: base.services,
		cwd,
		agentDir,
		agentPanelCounts: { total: 0, agents: 0, needsInput: 0, shells: 0, subagents: 0 },
		onEngineMessage: subscribe(engineListeners),
		onGenerationEnded: subscribe(endedListeners),
		onEngineRecovered: none,
		onQueuedDeliveriesForgotten: none,
		onQueuedMessagesTaken: none,
		queuedMessagesUnderWay: () => NO_QUEUED_MESSAGES,
		onDiagnostic: none,
		onSessionStatsChanged: none,
		onRemoteCommandsChanged: none,
		onProjectTrustChanged: none,
		onResourceExtensionsChanged: none,
		onKeybindingState: undefined,
		takeSubagentChatQueues: () => [],
		discardLostQueue: () => {},
		getGeneration: () => 1,
		requestAgentView: async (command: object) => {
			requests.push(command);
			return undefined;
		},
		getRemoteCommands: () => [],
		getResourceExtensions: () => [],
		getResourceOverlaps: () => [],
		getResourceIssues: () => ({ errors: [], diagnostics: [], overlaps: [], warnings: [] }),
		getResourceErrors: () => [],
		getResourceDiagnostics: () => [],
		isProjectTrustPending: () => false,
		pendingProjectResourcesTrusted: () => false,
		waitUntilBound: async () => {},
		isBound: () => true,
		dispose: async () => {},
		setExtensionUIHandler: none,
		sendEngineMessage: () => {},
		initializeFromEngine: async () => {},
		loadDeferredResources: async () => {},
	};
	for (const [key, value] of Object.entries(members))
		Object.defineProperty(runtime, key, { value, configurable: true, writable: true });
	return { runtime, engineListeners, endedListeners, requests };
}

test(
	"a stopped interactive mode leaves no single-screen listener on the engine and asks it for nothing",
	async () => {
		initTheme("dark");
		const cwd = mkdtempSync(join(tmpdir(), "atomic-view-stop-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-view-stop-agent-"));
		const faux = registerFauxProvider();
		const model = faux.getModel();
		try {
			const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
			const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
			const base = await createAgentSessionRuntime(
				async (options) => {
					const services = await createAgentSessionServices({
						cwd: options.cwd,
						agentDir: options.agentDir,
						modelRuntime,
						resourceLoaderOptions: {
							cwd: options.cwd,
							agentDir: options.agentDir,
							builtinPackagePaths: [],
							extensionFactories: [],
							noSkills: true,
							noPromptTemplates: true,
							noThemes: true,
							noContextFiles: true,
						},
					});
					const created = await createUnstartedAgentSessionFromServices({
						services,
						sessionManager: options.sessionManager,
						sessionStartEvent: options.sessionStartEvent,
						model,
						builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
					});
					return { ...created, services, diagnostics: services.diagnostics };
				},
				{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
			);
			const engine = engineStandIn(base, cwd, agentDir);
			const mode = new InteractiveMode(engine.runtime, { terminal: new QuietTerminal() });
			// Without `fd` on PATH, startup's tool check reports after stop and draws; that is not the agent view's.
			mode.ensureManagedToolsReady = async () => {};
			await mode.init();

			mode.stop();

			assert.equal(engine.engineListeners.size, 0, "engine message listeners left after stop");
			assert.equal(engine.endedListeners.size, 0, "generation listeners left after stop");
			const warnings: string[] = [];
			let renders = 0;
			mode.showWarning = (message: string) => warnings.push(message);
			mode.ui.requestRender = () => {
				renders++;
			};
			for (const listener of [...engine.endedListeners]) listener({ expected: false, generation: 1 });
			for (const listener of [...engine.engineListeners]) listener({ type: "engine_view_agent", taskId: "task-1" });
			// Longer than the working line's clock tick: a timer left running would draw meanwhile.
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.deepEqual(engine.requests, []);
			assert.deepEqual(warnings, []);
			assert.equal(renders, 0);
			await base.dispose();
		} finally {
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
	REAL_MODE_TIMEOUT_MS,
);
