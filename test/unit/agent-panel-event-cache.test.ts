import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	agentPanelHasRows,
	agentPanelRows,
	bindAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";

test.each(["running", "missing"])(
	"a focused pass that observes a retired stopped extension row %s invalidates the has-rows cache (#5233)",
	(change) => {
		const hub = new AgentPanelSourceHub();
		const stopped: AgentPanelItem = {
			id: "ext:helper",
			kind: "agent",
			name: "helper",
			task: "check",
			state: "stopped",
		};
		const other: AgentPanelItem = { id: "ext:other", kind: "agent", name: "other", task: "build", state: "running" };
		let items = [stopped, other];
		let notify = () => {};
		hub.register({
			items: () => items,
			subscribe: (listener) => {
				notify = listener;
				return () => {};
			},
		});
		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		assert.equal(agentPanelHasRows(session), true);
		// Nothing is active any more: the stopped row leaves with the finished one.
		items = [stopped, { ...other, state: "done" }];
		notify();
		assert.equal(agentPanelHasRows(session), false);
		items = change === "running" ? [{ ...stopped, state: "running" }] : [];
		notify();
		agentPanelRows(session);
		items = [stopped, { ...other, id: "ext:other-2" }];
		notify();
		assert.deepEqual(new Set(agentPanelRows(session).map((row) => row.id)), new Set([stopped.id, "ext:other-2"]));
		assert.equal(agentPanelHasRows(session), true, "the idle panel and its focus key agree with the focused panel");
	},
);

test("unchanged focused panel reads reuse the ranked row collection rather than copying all tasks (#5233)", async () => {
	const fixture = taskFixture();
	const session = {};
	try {
		await fixture.start("Background worker");
		bindOwnerTaskStore(session, fixture.store);
		const first = agentPanelRows(session);
		const second = agentPanelRows(session);
		assert.equal(second, first);
		assert.equal(second[0]?.task, "Background worker");
	} finally {
		await fixture.dispose();
	}
});

test("agent panel reuses ranked task metadata across activity updates and refreshes after settlement (#5224)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	let release = () => {};
	const session = {};
	try {
		await fixture.start("First worker");
		await fixture.start("Second worker");
		let taskReads = 0;
		const store = new Proxy(fixture.store, {
			get(target, key, receiver) {
				if (key === "backgroundTasks") taskReads++;
				return Reflect.get(target, key, receiver);
			},
		});
		bindOwnerTaskStore(session, store);
		release = bindAgentPanel(session, { setWidget() {}, requestRender() {} });
		assert.ok(taskReads > 0);
		agentPanelRows(session);
		const previousTasks = fixture.store.tasks;
		const previousFirst = previousTasks[0]!;
		taskReads = 0;
		for (let index = 0; index < 12; index++) {
			taskValue(
				fixture.runners[0]!.context.reportActivity({
					reportId: `panel-event-${index}`,
					change: { kind: "action", tool: "bash", text: `step ${index}` },
				}),
			);
			fixture.store.drain();
		}
		assert.equal(taskReads, 0, "activity-only updates must not rescan all native panel tasks");
		taskValue(
			fixture.runners[0]!.context.reportActivity({
				reportId: "panel-metrics",
				change: { kind: "metrics", elapsedMs: 5000, tokenCount: 7000 },
			}),
		);
		fixture.store.drain();
		const currentRow = agentPanelRows(session).find((row) => row.id === `task:${previousFirst.ref.taskId}`)!;
		assert.equal(currentRow.tokens, 7000);
		assert.ok(currentRow.elapsedMs! >= 5000);
		assert.equal(taskReads, 0, "metrics-only updates must refresh visible values without rescanning tasks");
		assert.equal(previousTasks[0], previousFirst, "a previously returned task list must remain unchanged");
		await fixture.settle(0);
		await vi.waitFor(() => assert.ok(taskReads > 0, "settlement must invalidate the ranked panel tasks"));
	} finally {
		release();
		await fixture.dispose();
	}
});
