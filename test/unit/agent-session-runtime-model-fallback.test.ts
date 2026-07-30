import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";

const warning = "unsupported configured provider";
const createRuntime = (async () => {
	throw new Error("not used");
}) as CreateAgentSessionRuntimeFactory;

function lockedRuntime(): AgentSessionRuntime {
	return new AgentSessionRuntime(
		{} as AgentSession,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
		[],
		warning,
		"configured-provider-unsupported",
	);
}

test("explicit changed model selection resolves fallback by provider and id", () => {
	const previous = getModel("anthropic", "claude-sonnet-4-5");
	const selected = getModel("openai", "gpt-5.6-sol");
	assert.ok(previous);
	assert.ok(selected);
	const runtime = lockedRuntime();

	runtime.resolveModelFallbackAfterExplicitModelSelection(previous, selected);

	assert.equal(runtime.modelFallbackMessage, undefined);
	assert.equal(runtime.modelFallbackReason, undefined);
});

test("null, undefined, and same provider/id selections preserve fallback", () => {
	const previous = getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(previous);
	for (const selected of [null, undefined, { ...previous, contextWindow: previous.contextWindow + 1 }]) {
		const runtime = lockedRuntime();
		runtime.resolveModelFallbackAfterExplicitModelSelection(previous, selected);
		assert.equal(runtime.modelFallbackMessage, warning);
		assert.equal(runtime.modelFallbackReason, "configured-provider-unsupported");
	}
});
