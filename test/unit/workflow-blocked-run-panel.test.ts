import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.ts";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { engineAgentPanelCounts } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	type AgentPanelCounts,
	agentPanelRows,
	bindAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { assert, createStore, run, test, workflow } from "./executor-shared.js";
import { counters, detachingAdapters, FakeCiService } from "./waiting-stage-helpers.js";

let previousKeys: ReturnType<typeof getKeybindings>;
let keybindings: KeybindingsManager;
beforeEach(() => {
	initTheme("dark", false);
	previousKeys = getKeybindings();
	keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
});
afterEach(() => {
	setKeybindings(previousKeys);
});

/** The session store's own failure while it is unreachable, as its adapter reports it. */
function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

/** A run whose released stage cannot reopen its session when it wakes: the engine blocks it on that stage. */
async function blockedRunItem(): Promise<AgentPanelItem> {
	const service = new FakeCiService();
	const store = createStore();
	const definition = workflow({
		name: "reopen-after-wait",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("implement", { prompt: "watch ci" });
			return {};
		},
	});
	const blocked = await run(
		definition,
		{},
		{
			store,
			durableBackend: await createMemoryTestBackend(),
			releaseWhenWaiting: { afterMs: 0 },
			adapters: detachingAdapters(service, counters(), {
				failCreationAfter: 1,
				creationFailure: () => storeUnavailable(),
				resumable: true,
			}),
			onStageLifecycleEvent: (_runId: string, event: StageLifecycleEvent) => {
				if (event.type === "stage_waiting") service.finishAll();
			},
		},
	);
	assert.equal(blocked.status, "running", "blocked resumably, still live");
	assert.ok(store.run(blocked.runId)?.blockedAt !== undefined);
	const item = panelItemsFromSnapshot(store.runs()).find((candidate) => candidate.id === `run:${blocked.runId}`);
	assert.ok(item);
	return item;
}

const stoppedAgent: AgentPanelItem = { id: "ext:stopped", kind: "agent", state: "stopped", name: "worker", task: "t" };
const runningAgent: AgentPanelItem = { id: "ext:live", kind: "agent", state: "running", name: "worker", task: "u" };

function panelOf(items: AgentPanelItem[]) {
	let notify = () => {};
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => items,
		subscribe: (listener) => {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	return {
		session,
		set(next: AgentPanelItem[]) {
			items.splice(0, items.length, ...next);
			notify();
		},
		ids: () => agentPanelRows(session).map((row) => row.id),
	};
}

describe("a run blocked on a stage whose session store stays unreachable (#5490)", () => {
	test("reads as paused in the panel, naming the stage and the reason (#5490)", async () => {
		const item = await blockedRunItem();
		assert.equal(item.state, "paused");
		assert.match(item.task, /^stage implement · /u);
		assert.ok(item.reason !== undefined && item.reason.length > 0);
		assert.equal(item.progress, undefined);
	});

	test("rests like a paused subagent in the engine's ranking, the panel model and both hosts' hints (#5490)", async () => {
		const blocked = await blockedRunItem();
		const panel = panelOf([blocked, stoppedAgent, runningAgent]);
		let nextCounts = Promise.withResolvers<AgentPanelCounts>();
		// What the isolated engine sends its host, as the host reads it.
		const dispose = bindAgentPanel(panel.session, { setWidget() {}, requestRender() {} } as never, (counts) => {
			const message = parseInteractiveEngineMessage(
				serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }).trim(),
			);
			assert.ok(message?.type === "engine_agent_panel_state");
			nextCounts.resolve(engineAgentPanelCounts(message));
		});
		try {
			const active = await nextCounts.promise;
			assert.deepEqual(
				mainComposerHintSegments(keybindings, () => active),
				["↓ 2 agents", "? keys"],
			);
			assert.deepEqual(
				new Set(panel.ids()),
				new Set([blocked.id, "ext:stopped", "ext:live"]),
				"listed while work runs",
			);
			const model = new AgentPanelModel(() => 1_000);
			assert.deepEqual(
				new Set(model.rows([blocked, stoppedAgent, runningAgent]).map((row) => row.id)),
				new Set(panel.ids()),
			);

			nextCounts = Promise.withResolvers<AgentPanelCounts>();
			panel.set([blocked, stoppedAgent]);
			const hostCounts = await nextCounts.promise;
			assert.deepEqual(panel.ids(), [], "nothing runs: the blocked run and the stopped subagent leave");
			assert.deepEqual(
				model.rows([blocked, stoppedAgent]).map((row) => row.id),
				[],
			);
			assert.deepEqual(
				mainComposerHintSegments(keybindings, panel.session),
				["/workflows to see runs", "? keys"],
				"in process",
			);
			assert.deepEqual(
				mainComposerHintSegments(keybindings, () => hostCounts),
				["/workflows to see runs", "? keys"],
				"isolated host",
			);
		} finally {
			dispose();
		}
	});
});
