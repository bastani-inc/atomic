import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("provider guidance distinguishes main-chat defaults from the builtins' auto default", () => {
	const guide = readFileSync(resolve("packages/coding-agent/docs/providers.md"), "utf8");
	for (const obsolete of [
		"Built-in workflow and subagent fallback chains use",
		"agents use GPT-5.6 Luna",
		"Goal and Ralph orchestration, Ralph research, and the debugger use GPT-6 Astra",
		"Open Claude Design starts with Anthropic Fable",
		"Built-in workflow and subagent chains include",
	])
		assert.ok(!guide.includes(obsolete), `Obsolete builtin policy: ${obsolete}`);
	assert.match(guide, /Builtin workflows and subagents default to `model: "auto"`/);
	assert.ok(guide.includes("Atomic defaults xAI sessions to `grok-4.7`"));
	assert.ok(guide.includes("Z.AI and Z.AI Coding Plan (China) default to `glm-5.3`"));
});
