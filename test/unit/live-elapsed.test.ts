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
	assert.equal(liveElapsedMs("shared-clock", 9000, false, now), 9000, "a finished task reports its own time");
	assert.equal(liveElapsedMs("shared-clock", 1000, true, now), 1000, "and is seen afresh if it runs again");
});
