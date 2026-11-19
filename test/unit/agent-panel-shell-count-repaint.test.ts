import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.ts";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { attachInteractiveEngineHost } from "../../packages/coding-agent/src/modes/interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { taskRecord } from "../helpers/task-record.js";

initTheme("dark");

/** An owner task store whose records change and notify, enough for the panel's ranking pass. */
function changingStore(session: object, initial: TaskRecord[]) {
	let tasks = initial;
	let revision = 1;
	const listeners = new Set<() => void>();
	const store = {
		get tasks() {
			return tasks;
		},
		get backgroundTasks() {
			return tasks;
		},
		get ownerTasks() {
			return tasks;
		},
		get ownerBackgroundTasks() {
			return tasks;
		},
		settlementOrder: new Map(),
		get panelRevision() {
			return revision;
		},
		taskRecord: (id: string) => tasks.find((task) => task.ref.taskId === id),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	bindOwnerTaskStore(session, store as never);
	return {
		replace(next: TaskRecord[]) {
			tasks = next;
			revision++;
			for (const listener of listeners) listener();
		},
	};
}

const runningShell: TaskRecord = { ...taskRecord("sh1", "command"), title: "sleep 300" };
const finishedShell: TaskRecord = {
	...runningShell,
	execution: { kind: "settled", result: { kind: "completed", output: runningShell.output } },
};
const runningAgent: TaskRecord = { ...taskRecord("a1"), agentName: "worker", title: "fix shipping batches" };

/**
 * The real path in isolated mode: the engine's panel bridge and RPC UI context with its custom UI service,
 * the engine's stdout lines, and the host runtime with its engine host attachment.
 */
async function isolatedHost(initial: TaskRecord[]) {
	const harness = await createHarness();
	const keybindings = new KeybindingsManager();
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const client = {
		onInteractiveEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			engineListeners.push(listener);
			return () => {
				const index = engineListeners.indexOf(listener);
				if (index !== -1) engineListeners.splice(index, 1);
			};
		},
		onInteractiveEngineKeybindingState: () => () => {},
		onExtensionUIRequest: () => () => {},
		onEvent: () => () => {},
		onGenerationEnded: () => () => {},
		getGeneration: () => 1,
		getState: async () => ({ resourceExtensions: [] }),
		requestInternal: <T>() => Promise.resolve(undefined as T),
		stop: async () => {},
		restart: async () => {},
	};
	const deliver = (line: string) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) for (const listener of [...engineListeners]) listener(message);
	};
	const localRuntime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("unused runtime factory");
		},
	);
	const runtime = new IsolatedInteractiveRuntime(
		localRuntime,
		async () => {
			throw new Error("unused isolated runtime factory");
		},
		client as never,
	);
	const footer = () => mainComposerHintSegments(keybindings, () => runtime.agentPanelCounts);
	/** What the host footer reads each time the host repaints. */
	const painted: string[][] = [];
	const hostUi = {
		setWidget: () => {},
		requestRender: () => painted.push(footer()),
		custom: async () => undefined,
		notify: () => {},
	} as unknown as ExtensionUIContext;
	const detachHost = attachInteractiveEngineHost(runtime as never, hostUi, () => {}, {
		isFullscreen: () => false,
		onRendererReplaced: () => () => {},
	});

	const engineSession = {};
	const store = changingStore(engineSession, initial);
	const customUi = new EngineCustomUiService(deliver, keybindings);
	const engineUi = createRpcExtensionUIContext({ output: () => {}, pendingExtensionRequests: new Map(), customUi });
	const unbind = bindAgentPanel(engineSession as never, engineUi, (counts) => {
		deliver(serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }));
	});
	return {
		store,
		footer,
		painted,
		async dispose() {
			unbind();
			detachHost();
			await runtime.dispose();
			await harness.cleanup();
		},
	};
}

test("in the isolated engine, a shell finishing with no panel rows repaints the host footer", async () => {
	const host = await isolatedHost([runningShell]);
	try {
		assert.deepEqual(host.footer(), ["1 shell", "/tasks to manage", "? keys"]);
		host.store.replace([finishedShell]);
		await vi.waitFor(() =>
			assert.deepEqual(host.painted.at(-1), ["? keys"], "the host repaints after the counts change"),
		);
	} finally {
		await host.dispose();
	}
});

test("in the isolated engine, the last subagent leaving the panel repaints the host footer", async () => {
	const host = await isolatedHost([runningAgent]);
	try {
		assert.deepEqual(host.footer(), ["↓ 1 agent", "? keys"]);
		host.store.replace([]);
		await vi.waitFor(() =>
			assert.deepEqual(host.painted.at(-1), ["? keys"], "the host repaints after the counts change"),
		);
	} finally {
		await host.dispose();
	}
});

test("in process, a shell finishing with no panel rows repaints the footer", async () => {
	const session = {};
	const store = changingStore(session, [runningShell]);
	const keybindings = new KeybindingsManager();
	const painted: string[][] = [];
	const unbind = bindAgentPanel(
		session as never,
		{
			setWidget() {},
			requestRender: () => painted.push(mainComposerHintSegments(keybindings, session as never)),
		} as never,
	);
	try {
		assert.deepEqual(mainComposerHintSegments(keybindings, session as never), [
			"1 shell",
			"/tasks to manage",
			"? keys",
		]);
		store.replace([finishedShell]);
		await vi.waitFor(() =>
			assert.deepEqual(painted.at(-1), ["? keys"], "the footer repaints without a mounted panel widget"),
		);
	} finally {
		unbind();
	}
});
