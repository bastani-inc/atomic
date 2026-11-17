import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.ts";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { registerStartupInputListeners } from "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { createRpcExtensionUIContext } from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import type { RpcEvent } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { taskRecord } from "../helpers/task-record.js";

initTheme("dark");

/** An owner task store whose records change and notify, enough for the panel's ranking pass. */
function shellStore(session: object) {
	const shell: TaskRecord = { ...taskRecord("sh1", "command"), title: "sleep 300" };
	let tasks: TaskRecord[] = [shell];
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
		finishShell() {
			tasks = [{ ...shell, execution: { kind: "settled", result: { kind: "completed", output: shell.output } } }];
			revision++;
			for (const listener of listeners) listener();
		},
	};
}

function engineClient() {
	let engineMessageListener: ((message: InteractiveEngineMessage) => void) | undefined;
	const client = {
		onInteractiveEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			engineMessageListener = listener;
			return () => {};
		},
		onEvent(_listener: (event: RpcEvent) => void) {
			return () => {};
		},
		onGenerationEnded(_listener: (event: InteractiveEngineGenerationEnded) => void) {
			return () => {};
		},
		getGeneration: () => 1,
		getState: async () => ({ resourceExtensions: [] }),
		requestInternal: <T>() => Promise.resolve(undefined as T),
		stop: async () => {},
		restart: async () => {},
	};
	/** One line the engine writes on its stdout, as the host's client delivers it. */
	const deliver = (line: string) => {
		const message = parseInteractiveEngineMessage(line);
		if (message) engineMessageListener?.(message);
	};
	return { client, deliver };
}

function hostMode(runtimeHost: object, keybindings: KeybindingsManager) {
	const mode = Object.create(InteractiveModeBase.prototype) as InteractiveModeBase;
	let renders = 0;
	mode.keybindings = keybindings;
	mode.addTuiInputListener = () => () => {};
	mode.ui = { requestRender: () => renders++, hasOverlay: () => false } as never;
	mode.runtimeHost = runtimeHost as never;
	registerStartupInputListeners(mode);
	return { renders: () => renders };
}

test("in the isolated engine, a shell finishing with no panel rows repaints the host footer", async () => {
	const harness = await createHarness();
	try {
		const keybindings = new KeybindingsManager();
		const { client, deliver } = engineClient();
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
		const host = hostMode(runtime, keybindings);

		// The engine side, wired as its RPC session binding wires it.
		const engineSession = {};
		const shells = shellStore(engineSession);
		const customUi = new EngineCustomUiService(deliver, keybindings);
		const engineUi = createRpcExtensionUIContext({
			output: () => {},
			pendingExtensionRequests: new Map(),
			customUi,
		});
		const unbind = bindAgentPanel(engineSession as never, engineUi, (counts) => {
			deliver(serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }));
		});
		try {
			assert.deepEqual(mainComposerHintSegments(keybindings), ["1 shell", "/tasks to manage", "? keys"]);
			const before = host.renders();
			shells.finishShell();
			await Promise.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(mainComposerHintSegments(keybindings), ["? keys"]);
			assert.ok(host.renders() > before, "the host repaints its footer without a mounted panel widget");
		} finally {
			unbind();
			await runtime.dispose();
		}
	} finally {
		await harness.cleanup();
	}
});

test("in process, a shell finishing with no panel rows repaints the footer", async () => {
	const session = {};
	const shells = shellStore(session);
	let renders = 0;
	const unbind = bindAgentPanel(
		session as never,
		{
			setWidget() {},
			requestRender: () => renders++,
		} as never,
	);
	try {
		const keybindings = new KeybindingsManager();
		assert.deepEqual(mainComposerHintSegments(keybindings, session as never), [
			"1 shell",
			"/tasks to manage",
			"? keys",
		]);
		const before = renders;
		shells.finishShell();
		await Promise.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(mainComposerHintSegments(keybindings, session as never), ["? keys"]);
		assert.ok(renders > before, "the footer repaints without a mounted panel widget");
	} finally {
		unbind();
	}
});
