import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { taskClocksFor } from "../../packages/coding-agent/src/core/tasks/live-elapsed.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.ts";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.ts";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.ts";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { agentPanelRows } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { snapshotStageTasks } from "../../packages/workflows/src/workers/stage-watch-tasks.js";
import { taskFixture } from "../helpers/task-projection.ts";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark", false);
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
});

const stage = (id: string, status: StageSnapshot["status"]): StageSnapshot => ({
	id,
	name: id,
	status,
	parentIds: [],
	toolEvents: [],
});
const workflowRun = (id: string): RunSnapshot => ({
	id,
	name: id,
	inputs: {},
	status: "running",
	startedAt: 1_000,
	toolNodes: [],
	stages: [stage("review", "running")],
});
const runningAgent: AgentPanelItem = {
	id: "ext:live",
	kind: "agent",
	state: "running",
	name: "worker",
	task: "keep going",
};

/** A panel whose rows are a workflow store's runs and, while `agentRuns` is true, a running subagent. */
function workflowPanel() {
	const store = createStore();
	let agentRuns = false;
	let notify = () => {};
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [
			...panelItemsFromSnapshot(store.graphSnapshot(), 10_000, store),
			...(agentRuns ? [runningAgent] : []),
		],
		subscribe: (listener) => {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	return {
		store,
		setAgentRunning(running: boolean) {
			agentRuns = running;
			notify();
		},
		changed: () => notify(),
		items: () => [
			...panelItemsFromSnapshot(store.graphSnapshot(), 10_000, store),
			...(agentRuns ? [runningAgent] : []),
		],
		ids: () => agentPanelRows(session).map((row) => row.id),
	};
}

describe("a row that runs again before the panel updates is listed again while work runs (#5504)", () => {
	test("an interrupted subagent resumed and interrupted again between two updates (#5504)", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("interrupted");
			await fixture.start("finishes");
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			bindOwnerTaskStore(session, fixture.store);
			const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
			const mainTitles = () => new Set(agentPanelRows(session).map((row) => row.task));
			const footerTitles = () =>
				new Set(
					renderTaskFooter(fixture.store.backgroundTasks, 120, clocks)
						.map((line) => line.replace(/\x1b\[[\d;:]*m/g, ""))
						.map((line) => /worker {2}(\S+)/.exec(line)?.[1]),
				);
			const interrupted = fixture.store.tasks[0]!.ref.taskId;

			fixture.store.setTurnInterrupted(interrupted, true);
			await fixture.settle(1);
			assert.deepEqual(mainTitles(), new Set(), "nothing runs: the interrupted subagent leaves");
			assert.deepEqual(footerTitles(), new Set());

			await fixture.start("new");
			assert.deepEqual(mainTitles(), new Set(["new"]), "new work does not bring it back");
			assert.deepEqual(footerTitles(), new Set(["new"]));

			// Resumed, then interrupted again before either view updates.
			fixture.store.setTurnInterrupted(interrupted, false);
			fixture.store.setTurnInterrupted(interrupted, true);
			assert.deepEqual(mainTitles(), new Set(["interrupted", "new"]), "it ran again, so it is listed again");
			assert.deepEqual(footerTitles(), new Set(["interrupted", "new"]));
		} finally {
			await fixture.dispose();
		}
	});

	test("a worker stage footer sees a subagent interrupted again between snapshots (#5567)", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("interrupted");
			const child = fixture.store.tasks[0]!.ref.taskId;
			const worker = ownerTaskViewSource(fixture.store);
			const root = new PooledStageTaskSource(async () => undefined);
			const paint = () => {
				root.apply(structuredClone(snapshotStageTasks(worker)));
				return renderTaskFooter(root, 120).join("\n");
			};
			fixture.store.setTurnInterrupted(child, true);
			assert.equal(paint(), "");
			await fixture.start("unrelated");
			assert.doesNotMatch(paint(), /interrupted/);
			fixture.store.setTurnInterrupted(child, false);
			fixture.store.setTurnInterrupted(child, true);
			assert.match(paint(), /interrupted/);
		} finally {
			await fixture.dispose();
		}
	});

	test("an interrupted subagent that left and is then stopped without running stays out (#5504)", async () => {
		const fixture = taskFixture();
		try {
			await fixture.start("interrupted");
			await fixture.start("finishes");
			const hub = new AgentPanelSourceHub();
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			bindOwnerTaskStore(session, fixture.store);
			const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
			const mainTitles = () => new Set(agentPanelRows(session).map((row) => row.task));
			const footerTitles = () =>
				new Set(
					renderTaskFooter(fixture.store.backgroundTasks, 120, clocks)
						.map((line) => line.replace(/\x1b\[[\d;:]*m/g, ""))
						.map((line) => /worker {2}(\S+)/.exec(line)?.[1]),
				);
			fixture.store.setTurnInterrupted(fixture.store.tasks[0]!.ref.taskId, true);
			await fixture.settle(1);
			assert.deepEqual(mainTitles(), new Set());
			assert.deepEqual(footerTitles(), new Set());
			await fixture.start("new");

			fixture.runners[0]!.result.resolve({ kind: "cancelled", cause: "user" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			fixture.store.drain();
			assert.deepEqual(mainTitles(), new Set(["new"]), "stopping it is not a run: it stays out");
			assert.deepEqual(footerTitles(), new Set(["new"]));
		} finally {
			await fixture.dispose();
		}
	});

	test("a paused workflow run resumed and paused again between two updates (#5504)", () => {
		const panel = workflowPanel();
		panel.store.recordRunStart(workflowRun("w"));
		panel.store.recordRunPaused("w", 2_000);
		panel.changed();
		assert.deepEqual(panel.ids(), [], "nothing runs: the paused run leaves");

		panel.setAgentRunning(true);
		assert.deepEqual(panel.ids(), ["ext:live"], "new work does not bring it back");

		// Resumed, then paused again before the panel updates.
		panel.store.recordRunResumed("w", 3_000);
		panel.store.recordRunPaused("w", 3_001);
		panel.changed();
		assert.deepEqual(new Set(panel.ids()), new Set(["ext:live", "run:w"]), "it ran again, so it is listed again");
	});

	test("a blocked workflow run that runs and blocks again between two updates (#5504)", () => {
		const panel = workflowPanel();
		const blocked = (blockedAt: number) =>
			panel.store.recordRunBlocked("w", "stage review failed", {
				failureKind: "provider",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
				resumable: true,
				blockedAt,
			});
		panel.store.recordRunStart(workflowRun("w"));
		blocked(2_000);
		panel.changed();
		assert.deepEqual(panel.ids(), [], "nothing runs: the blocked run leaves");

		panel.setAgentRunning(true);
		assert.deepEqual(panel.ids(), ["ext:live"], "new work does not bring it back");

		blocked(3_000);
		panel.changed();
		assert.deepEqual(new Set(panel.ids()), new Set(["ext:live", "run:w"]), "it ran again, so it is listed again");
	});

	test("a restored workflow that runs and blocks again in the same millisecond reappears in both panels (#5567)", () => {
		const panel = workflowPanel();
		const model = new AgentPanelModel();
		const rows = () => {
			panel.changed();
			return [
				panel.ids().sort(),
				model
					.rows(panel.items())
					.map((item) => item.id)
					.sort(),
			];
		};
		const block = () =>
			panel.store.recordRunBlocked("w", "provider unavailable", {
				failureKind: "provider",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
				resumable: true,
				blockedAt: 2_000,
			});
		panel.store.recordRunStart(workflowRun("w"));
		block();
		assert.deepEqual(rows(), [[], []]);
		panel.setAgentRunning(true);
		const snapshot = structuredClone(panel.store.run("w")!);
		panel.store.clear();
		panel.store.recordRunStart(snapshot);
		assert.deepEqual(rows(), [["ext:live"], ["ext:live"]], "restoring the same attempt is not a resume");
		const first = Number(panel.items()[0]!.runGeneration);
		panel.store.recordRunStart(workflowRun("w"));
		block();
		assert.deepEqual(rows(), [
			["ext:live", "run:w"],
			["ext:live", "run:w"],
		]);
		assert.ok(Number(panel.items()[0]!.runGeneration) > first);
	});

	test("restoring an earlier snapshot cannot reuse a later attempt's generation (#5567)", () => {
		const panel = workflowPanel();
		const pause = () => panel.store.recordRunPaused("w", 2000);
		panel.store.recordRunStart(workflowRun("w"));
		pause();
		const earlier = structuredClone(panel.store.run("w")!);
		panel.store.recordRunResumed("w", 2000);
		pause();
		const latest = Number(panel.items()[0]!.runGeneration);
		panel.store.recordRunStart(earlier);
		panel.store.recordRunResumed("w", 2000);
		pause();
		assert.ok(Number(panel.items()[0]!.runGeneration) > latest);
	});

	test("an extension's stopped row with a new run identity is listed again while work runs (#5504)", () => {
		const stopped = (runGeneration: string): AgentPanelItem => ({
			id: "ext:job",
			kind: "agent",
			state: "stopped",
			name: "indexer",
			task: "scan",
			runGeneration,
		});
		const items: AgentPanelItem[] = [stopped("1")];
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
		const ids = () => agentPanelRows(session).map((row) => row.id);
		const set = (next: AgentPanelItem[]) => {
			items.splice(0, items.length, ...next);
			notify();
		};
		assert.deepEqual(ids(), []);
		set([stopped("1"), runningAgent]);
		assert.deepEqual(ids(), ["ext:live"], "the same run: still out");
		set([stopped("2"), runningAgent]);
		assert.deepEqual(new Set(ids()), new Set(["ext:job", "ext:live"]), "a new run: listed again");
	});

	test("the panel model agrees for a paused run resumed and paused again between two updates (#5504)", () => {
		const panel = workflowPanel();
		const model = new AgentPanelModel(() => 10_000);
		const modelIds = () => model.rows(panel.items()).map((row) => row.id);
		panel.store.recordRunStart(workflowRun("w"));
		panel.store.recordRunPaused("w", 2_000);
		assert.deepEqual(modelIds(), []);
		panel.setAgentRunning(true);
		assert.deepEqual(modelIds(), ["ext:live"]);
		panel.store.recordRunResumed("w", 3_000);
		panel.store.recordRunPaused("w", 3_001);
		assert.deepEqual(new Set(modelIds()), new Set(["ext:live", "run:w"]));
	});
});
