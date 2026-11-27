import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.js";

test("every shipped builtin agent runs the default model without pinned fallback chains", async () => {
	const { agents, diagnostics } = await loadAgentsFromDirWithDiagnostics(
		resolve("packages/subagents/agents"),
		"builtin",
	);
	assert.deepEqual(diagnostics, []);
	assert.equal(agents.length, 9);
	for (const agent of agents) {
		assert.equal(agent.model, "auto", agent.name);
		assert.equal(agent.fallbackModels?.length ?? 0, 0, agent.name);
	}
});
