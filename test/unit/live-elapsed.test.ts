import assert from "node:assert/strict";
import { test } from "vitest";
import { liveElapsedMs } from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";

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
	assert.equal(liveElapsedMs("shared-clock", 1000, true, now), 1000, "a task that runs again is seen afresh");
});
