import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { taskPanelItems } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import {
	bindTaskClockSource,
	taskClockOf,
	taskClocksFor,
} from "../../packages/coding-agent/src/core/tasks/live-elapsed.ts";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { taskFixture } from "../helpers/task-projection.js";

test("unchanged panel task projections do not add clock bindings on every refresh (#5224)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("projection");
		await fixture.start("another projection");
		const source = ownerTaskViewSource(fixture.store);
		const before = taskPanelItems(source, new Set());
		const writes = vi.spyOn(WeakMap.prototype, "set");
		try {
			const after = taskPanelItems(source, new Set());
			assert.ok(writes.mock.calls.length <= 1, `${writes.mock.calls.length} clock binding writes`);
			assert.equal(after[0]?.task, before[0]?.task);
		} finally {
			writes.mockRestore();
		}
		const task = source.backgroundTasks[0]!;
		const changed = { ...task, title: "updated", metrics: { ...task.metrics, elapsedMs: 42_000 } };
		const changedSource = { backgroundTasks: [changed] };
		bindTaskClockSource(changedSource, source);
		const updated = taskPanelItems(changedSource, new Set())[0]!;
		assert.equal(updated.task, "updated");
		assert.equal(updated.elapsedMs, 42_000);

		const independent = { backgroundTasks: [task] };
		const independentClocks = taskClocksFor(independent);
		const independentRow = taskPanelItems(independent, new Set())[0]!;
		assert.equal(taskClockOf(independentRow), independentClocks);
		assert.notEqual(taskClockOf(independentRow), taskClockOf(before[0]!));
	} finally {
		await fixture.dispose();
	}
});
