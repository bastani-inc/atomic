import assert from "node:assert/strict";
import { test } from "vitest";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelRows, bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";

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
		assert.ok(taskReads > 0, "settlement must invalidate the ranked panel tasks");
	} finally {
		release();
		await fixture.dispose();
	}
});
