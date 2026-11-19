import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_PROMPT_GUIDANCE } from "../../packages/subagents/src/extension/prompt-guidance.js";

const guidance = DEFAULT_PROMPT_GUIDANCE.join("\n");

test("the parent delegates bounded specialist work rather than every task", () => {
	assert.match(guidance, /single subagent/);
	assert.match(guidance, /parallel tasks for independent work/);
	assert.match(guidance, /Honor requests to work inline/);
	assert.match(guidance, /testing, review and evidence inline/);
	assert.match(guidance, /Do not claim completed work was undone/);
	assert.match(guidance, /debugger subagent for actual failures/);
	assert.doesNotMatch(
		guidance,
		/all non-trivial operations should be delegated|spawn a debugger subagent first|Prefer async mode for every subagent launch/,
	);
});

test("model overrides use the configured catalog, never credentials or invented model IDs", () => {
	for (const phrase of [
		"each named agent use its declared model and fallback policy",
		"omit the explicit model argument",
		"documented task requirement",
		"Do not choose an ad hoc model merely for diversity",
		'`model: "auto"`, which the builtin agents declare, runs the user\'s configured default model',
		"or the current session's model when no default is configured",
		'subagent({ action: "models" })',
		"Pin only a returned fullId",
		"thinking level listed for that entry",
		"no catalog model fits",
		"leave the child unpinned",
		"Do not inspect credentials",
	])
		assert.ok(guidance.includes(phrase), phrase);
});

test("children coordinate directly in their inherited group and can reach their supervisor across groups", () => {
	assert.match(guidance, /inherit the launching session's group across single, parallel, and follow-up work/);
	assert.match(guidance, /contact_supervisor available for cross-group escalation/);
	assert.match(guidance, /Default to peer-to-peer \(swarm\)/);
	assert.match(
		guidance,
		/There are no limits on communication between agents; it is encouraged whenever you need to\./,
	);
	assert.match(guidance, /the supervisor is not a message relay/);
	assert.doesNotMatch(guidance, /do not coordinate spontaneously|bound the exchange/i);
	assert.match(
		guidance,
		/for very complex work or when the user asks for heavy parallelism, run hundreds or thousands of agents/,
	);
	assert.match(guidance, /self-organize into teams .* and coordinate peer-to-peer/);
});
