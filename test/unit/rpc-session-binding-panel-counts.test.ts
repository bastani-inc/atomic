import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.ts";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { engineAgentPanelCounts } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RpcSessionBinding } from "../../packages/coding-agent/src/modes/rpc/rpc-session-binding.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { taskRecord } from "../helpers/task-record.ts";

initTheme("dark");

type PanelState = Extract<InteractiveEngineMessage, { type: "engine_agent_panel_state" }>;

const runningAgent: TaskRecord = { ...taskRecord("a1"), agentName: "worker", title: "fix shipping batches" };
const finishedAgent: TaskRecord = {
	...runningAgent,
	execution: { kind: "settled", result: { kind: "completed", output: runningAgent.output } },
};

/** An owner task store whose records change and notify, enough for the panel's ranking pass. */
function changingStore(session: object, initial: TaskRecord[]) {
	let tasks = initial;
	let revision = 1;
	const listeners = new Set<() => void>();
	bindOwnerTaskStore(session, {
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
	} as never);
	return (next: TaskRecord[]) => {
		tasks = next;
		revision++;
		for (const listener of listeners) listener();
	};
}

const settle = async () => {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

test("the interactive engine sends the host the panel's agent and subagent counts", async () => {
	const harness = await createHarness();
	const keybindings = new KeybindingsManager();
	const lines: string[] = [];
	const runtime = new AgentSessionRuntime(
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
	const binding = new RpcSessionBinding({
		runtimeHost: runtime,
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi: new EngineCustomUiService(() => {}, keybindings),
		writeEngineLine: (line) => lines.push(line),
		requestShutdown: () => {},
	});
	/** The panel state the engine last wrote, as the host parses it. */
	const lastPanelState = (): PanelState | undefined =>
		lines
			.map((line) => parseInteractiveEngineMessage(line.trim()))
			.filter((message): message is PanelState => message?.type === "engine_agent_panel_state")
			.at(-1);
	const hostHint = () => {
		const state = lastPanelState();
		assert.ok(state, "the engine wrote a panel state");
		return mainComposerHintSegments(keybindings, () => engineAgentPanelCounts(state));
	};
	try {
		await binding.rebindSession();
		const replace = changingStore(harness.session, [runningAgent]);
		await settle();
		assert.deepEqual(lastPanelState(), {
			type: "engine_agent_panel_state",
			total: 1,
			agents: 1,
			needsInput: 0,
			shells: 0,
			subagents: 1,
		});
		assert.deepEqual(hostHint(), ["↓ 1 agent", "? keys"]);

		replace([finishedAgent]);
		await settle();
		assert.deepEqual(lastPanelState(), {
			type: "engine_agent_panel_state",
			total: 0,
			agents: 0,
			needsInput: 0,
			shells: 0,
			subagents: 1,
		});
		assert.deepEqual(hostHint(), ["/tasks to see subagents", "? keys"]);
	} finally {
		binding.disposeSubscriptions();
		await harness.cleanup();
	}
});
