import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader-core.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";

test("registered base guidance honors complex inline requests and retains defaults: subagent", async () => {
	const tools: Array<{ name: string; promptGuidelines?: string[] }> = [];
	const shutdown: Array<() => Promise<void>> = [];
	try {
		const extension = await loadExtensionFromFactory(
			registerSubagentExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);
		shutdown.push(async () => {
			for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler();
		});
		const tool = extension.tools.get("subagent");
		assert.ok(tool, "actual subagent extension registers the tool");
		tools.push(tool.definition);
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["subagent"],
		);
		assert.ok(
			tools.every((tool) => tool.promptGuidelines?.length),
			"use actual registered guidance",
		);
		const prompt = buildSystemPrompt({
			cwd: process.cwd(),
			selectedTools: ["read", "bash", "subagent"],
			promptGuidelines: tools.flatMap((tool) => tool.promptGuidelines ?? []),
		});
		assert.ok(prompt.includes("**Subagent orchestration**"));
		assert.equal(prompt.includes("**Workflow discovery and lifecycle**"), false);
		assert.doesNotMatch(
			prompt,
			/Because workflows are the default[\s\S]*use a workflow and let its stages delegate specialists/,
		);
		assert.match(prompt, /coordinate children from codemode/);
		assert.match(prompt, /Honor requests to work inline/);
		assert.match(prompt, /testing, review and evidence inline/);
		assert.match(prompt, /Do not claim (?:already-)?completed work was undone/);
	} finally {
		for (const stop of shutdown) await stop();
	}
});
