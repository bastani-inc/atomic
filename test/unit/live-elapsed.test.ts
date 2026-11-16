import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { liveElapsedMs, observeTaskClocks } from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { taskFixture } from "../helpers/task-projection.js";

test("the agent panel and a later view share one clock for a running task (#5224)", () => {
	let now = 100_000;
	const model = new AgentPanelModel(() => now);
	const row = {
		id: "task:shared-clock",
		kind: "agent" as const,
		state: "running" as const,
		name: "w",
		task: "t",
		elapsedMs: 2000,
	};
	assert.equal(model.rows([row])[0]?.elapsedMs, 2000);
	now += 6000;
	assert.equal(model.rows([row])[0]?.elapsedMs, 8000, "the panel's clock runs between reports");
	assert.equal(
		liveElapsedMs("shared-clock", 2000, true, now),
		8000,
		"a view opened later reads the same elapsed time",
	);
	now += 4000;
	const finished = { ...row, state: "stopped" as const, elapsedMs: 2000 };
	assert.equal(model.rows([finished])[0]?.elapsedMs, 12_000, "a finished row keeps the time it reached");
	now += 60_000;
	assert.equal(model.rows([finished])[0]?.elapsedMs, 12_000, "and stops counting");
	assert.equal(liveElapsedMs("shared-clock", 20_000, false, now), 20_000, "a larger reported time wins");
	assert.equal(liveElapsedMs("shared-clock", 1000, true, now), 20_000, "a resumed task keeps its elapsed time");
});

test("cancelling tasks keep one monotone elapsed time across the panel and task views (#5239)", () => {
	let now = 0;
	const panel = new AgentPanelModel(() => now);
	const row = {
		id: "task:cancelling-clock",
		kind: "agent" as const,
		state: "running" as const,
		name: "worker",
		task: "finish cleanup",
		elapsedMs: 5000,
	};
	const observe = (kind: string) =>
		observeTaskClocks(
			[{ ref: { taskId: "cancelling-clock" }, execution: { kind }, metrics: { elapsedMs: 5000 } }],
			now,
		);
	observe("running");
	assert.equal(panel.rows([row])[0]?.elapsedMs, 5000);
	now = 60_000;
	observe("running");
	assert.equal(panel.rows([row])[0]?.elapsedMs, 65_000);
	for (now = 61_000; now <= 62_000; now += 1000) {
		observe("cancelling");
		assert.equal(panel.rows([{ ...row, state: "stopping" }])[0]?.elapsedMs, now + 5000);
	}
	observe("settled");
	assert.equal(panel.rows([{ ...row, state: "done" }])[0]?.elapsedMs, 68_000);
	now += 100_000;
	assert.equal(panel.rows([{ ...row, state: "done" }])[0]?.elapsedMs, 68_000);
});

test("cached workflow rows advance between source changes and stop while paused (#5239)", () => {
	let now = 0;
	const panel = new AgentPanelModel(() => now);
	const row = {
		id: "run:cached-workflow-clock",
		kind: "workflow" as const,
		state: "running" as const,
		name: "ship",
		task: "stage publish",
		elapsedMs: 5000,
	};
	assert.equal(panel.rows([row])[0]?.elapsedMs, 5000);
	now = 10_000;
	assert.equal(panel.rows([row])[0]?.elapsedMs, 15_000);
	assert.equal(panel.rows([{ ...row, state: "paused" }])[0]?.elapsedMs, 15_000);
	now += 60_000;
	assert.equal(panel.rows([{ ...row, state: "paused" }])[0]?.elapsedMs, 15_000);
	assert.equal(panel.rows([row])[0]?.elapsedMs, 15_000);
	now += 1000;
	assert.equal(panel.rows([row])[0]?.elapsedMs, 16_000);
	assert.equal(panel.rows([{ ...row, state: "done" }])[0]?.elapsedMs, 16_000);
});

test("new task clocks never evict a still-running task's elapsed time (#5239)", () => {
	assert.equal(liveElapsedMs("retained-running-clock", 0, true, 0), 0);
	assert.equal(liveElapsedMs("retained-running-clock", 0, true, 100_000), 100_000);
	for (let index = 0; index < 2050; index++) liveElapsedMs(`new-clock-${index}`, 0, true, 100_000);
	assert.equal(liveElapsedMs("retained-running-clock", 0, true, 100_000), 100_000);
	for (let index = 0; index < 2050; index++) liveElapsedMs(`new-clock-${index}`, 0, false, 100_000);
	assert.equal(liveElapsedMs("retained-running-clock", 0, true, 101_000), 101_000);
});

test("the task store records settlement time even when no panel is visible (#5239)", async () => {
	let now = 100_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	try {
		await fixture.start();
		const task = fixture.store.tasks[0]!;
		assert.equal(liveElapsedMs(task.ref.taskId, 0, true, now), 0);
		now += 60_000;
		await fixture.settle();
		assert.equal(fixture.store.tasks[0]?.execution.kind, "settled");
		now += 600_000;
		assert.equal(liveElapsedMs(task.ref.taskId, 0, false, now), 60_000);
	} finally {
		await fixture.dispose();
		clock.mockRestore();
	}
});

test("a task's stop is recorded when it happens, so a view that first looks much later reads its real time (#5224)", () => {
	const task = (kind: string) => ({
		ref: { taskId: "observed-stop" },
		execution: { kind },
		metrics: { elapsedMs: 1000 },
	});
	observeTaskClocks([task("running")], 0);
	observeTaskClocks([task("settled")], 60_000);
	assert.equal(
		liveElapsedMs("observed-stop", 1000, false, 660_000),
		61_000,
		"not the 11 minutes until the view looked",
	);
});
