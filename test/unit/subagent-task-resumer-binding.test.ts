import assert from "node:assert/strict";
import { test } from "vitest";
import { taskResumer } from "../../packages/coding-agent/src/core/tasks/task-resumer.js";
import { bindSubagentTaskResumer } from "../../packages/subagents/src/runs/foreground/subagent-task-resumer.js";

test("a finished subagent's chat can resume it even when the task owner opens after the session starts (#5224)", () => {
	const supervisor = {};
	let open = false;
	const ctx = {
		getAgentTaskHost: () => {
			if (!open) throw new Error("Task owner is closed");
			return { ownerBinding: { supervisor } };
		},
	};
	const binding = bindSubagentTaskResumer({} as never, ctx as never);
	try {
		assert.equal(taskResumer(supervisor), undefined, "nothing to bind to yet");
		open = true;
		binding.ensure();
		assert.ok(taskResumer(supervisor), "the next turn binds it");
	} finally {
		binding.dispose();
	}
	assert.equal(taskResumer(supervisor), undefined, "disposing unbinds it");
});
