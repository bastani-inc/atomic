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
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { agentPanelRows } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
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

const runningAgent: AgentPanelItem = {
	id: "ext:live",
	kind: "agent",
	state: "running",
	name: "worker",
	task: "keep going",
};

/** A panel whose rows are a workflow store's runs and, while `agentRuns` is true, a running subagent. */
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
});
