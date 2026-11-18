import assert from "node:assert/strict";
import { test } from "vitest";
import {
	bindTaskClock,
	liveElapsedMs,
	taskClocksFor,
} from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";

test("the agent panel and a later view share one clock per task source (#5224)", () => {
	let now = 100_000;
	const source = {};
	const clocks = taskClocksFor(source);
	const model = new AgentPanelModel(() => now);
	const row = bindTaskClock(
		{
			id: "task:shared-clock",
			kind: "agent" as const,
			state: "running" as const,
			name: "w",
			task: "t",
			elapsedMs: 2000,
		},
		clocks,
	);
	assert.equal(model.rows([row])[0]?.elapsedMs, 2000);
	now += 6000;
	assert.equal(model.rows([row])[0]?.elapsedMs, 8000, "the panel's clock runs between reports");
	assert.equal(
		taskClocksFor(source).elapsedMs("shared-clock", 2000, true, now),
		8000,
		"a view opened later on the same source reads the same elapsed time",
	);
	assert.equal(
		taskClocksFor({}).elapsedMs("shared-clock", 1000, true, now),
		1000,
		"an unrelated source with the same task id has its own clock",
	);
	now += 4000;
	clocks.settle("shared-clock", 2000, now);
	const finished = bindTaskClock({ ...row, state: "stopped" as const, elapsedMs: 2000 }, clocks);
	// Another subagent still runs, so the stopped one stays listed.
	const live = { ...row, id: "task:still-running", state: "running" as const };
	const stoppedRow = () => model.rows([finished, live]).find((candidate) => candidate.id === finished.id);
	assert.equal(stoppedRow()?.elapsedMs, 12_000, "a finished row keeps the time it reached");
	now += 60_000;
	assert.equal(stoppedRow()?.elapsedMs, 12_000, "and stops counting");
	assert.equal(clocks.elapsedMs("shared-clock", 20_000, false, now), 20_000, "a larger reported time wins");
	assert.equal(
		clocks.elapsedMs("shared-clock", 1000, true, now),
		20_000,
		"a settled clock never restarts on a stale running read",
	);
	clocks.delete("shared-clock");
	assert.equal(clocks.elapsedMs("shared-clock", 1000, true, now), 1000, "an evicted task id is seen afresh");
	assert.equal(liveElapsedMs("restarted-clock", 2000, true, now), 2000);
	assert.equal(liveElapsedMs("restarted-clock", 9000, false, now + 7000), 9000);
	assert.equal(
		liveElapsedMs("restarted-clock", 1000, true, now + 8000),
		9000,
		"a task that runs again continues from the time it reached, so paused time is not counted",
	);
});
