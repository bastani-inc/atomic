import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { isSubagentChildSession } from "../../src/core/agent-session-tasks.js";
import { SESSION_HISTORY_TOOL_NAME } from "../../src/core/compaction/index.js";
import { createHarness, type Harness } from "./harness.js";

const chunk = Array.from({ length: 300 }, (_, line) => `line ${line} of a large file the subagent read`).join("\n");

const readChunk: AgentTool = {
	name: "read_chunk",
	label: "Read chunk",
	description: "Returns a large block of text",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: chunk }], details: {} }),
};

function toolResultText(harness: Harness, toolName: string): string[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === toolName
			? [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")]
			: [],
	);
}

describe("an agent without read or search after a clear", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	test("a restricted subagent clears like any session and then reads only its own history", async () => {
		const ended = new AbortController();
		const toolsPerRequest: string[][] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32_000, maxTokens: 1_000 }],
			tools: [readChunk],
			settings: {
				compaction: { enabled: true, reserveTokens: 29_500 },
				retry: { enabled: false },
				sessionSummary: { enabled: false },
			},
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: false,
				inheritSkills: false,
				depth: 1,
				executionEnded: ended.signal,
			},
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		harness.session.setActiveToolsByName(["read_chunk"]);
		assert.equal(isSubagentChildSession(harness.session), true);
		assert.ok(!harness.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));

		// Tools reach a request through system declarations; collect every tool declared in it.
		const recordTools = (context: { messages: Array<{ role: string; toolsAdded?: Array<{ name: string }> }> }) =>
			toolsPerRequest.push(
				context.messages
					.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
					.map((tool) => tool.name)
					.sort(),
			);
		harness.setResponses([
			(context) => {
				recordTools(context);
				return fauxAssistantMessage([fauxToolCall("read_chunk", {}, { id: "read-1" })], { stopReason: "toolUse" });
			},
			(context) => {
				recordTools(context);
				return fauxAssistantMessage(
					[fauxToolCall(SESSION_HISTORY_TOOL_NAME, { pattern: "line 42 of a large file" }, { id: "history-1" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				recordTools(context);
				return fauxAssistantMessage(
					[fauxToolCall(SESSION_HISTORY_TOOL_NAME, { lines: "1-2" }, { id: "history-2" })],
					{
						stopReason: "toolUse",
					},
				);
			},
			(context) => {
				recordTools(context);
				return fauxAssistantMessage("recovered and done");
			},
		]);
		await harness.session.prompt("Read the file and summarize it");

		const [end] = harness.eventsOfType("compaction_end");
		assert.equal(end?.result?.form, "cleared", "the post-tool clear ran in the subagent");
		assert.ok(end?.result?.compactedText.includes(SESSION_HISTORY_TOOL_NAME));
		assert.equal(harness.session.getLastAssistantText(), "recovered and done");
		assert.deepEqual(toolsPerRequest[0], ["read_chunk"]);
		assert.deepEqual(toolsPerRequest[1], ["read_chunk", SESSION_HISTORY_TOOL_NAME]);

		const url = `history://sessions/${harness.session.sessionId}`;
		const [searched, read] = toolResultText(harness, SESSION_HISTORY_TOOL_NAME);
		assert.ok(searched?.includes(`${url}:`), searched);
		assert.ok(searched?.includes("line 42 of a large file the subagent read"), searched);
		assert.match(read ?? "", new RegExp(`^# session ${harness.session.sessionId} entries 1-2 of \\d+\n`, "u"));
		assert.ok(read?.includes("Read the file and summarize it"), read);
		const definition = harness.session.getToolDefinition(SESSION_HISTORY_TOOL_NAME);
		assert.ok(definition, "the history tool is registered");
		assert.deepEqual(Object.keys((definition.parameters as { properties: object }).properties).sort(), [
			"lines",
			"pattern",
		]);
		ended.abort();
	});

	test("an agent with read and search gets no extra tool after a clear", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		assert.ok(harness.session.getActiveToolNames().includes("read"));
		assert.ok(harness.session.getActiveToolNames().includes("search"));
		const result = await harness.session.compact();
		assert.ok(!harness.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		assert.ok(!result.compactedText.includes(SESSION_HISTORY_TOOL_NAME));
		assert.ok(result.compactedText.includes(`read history://sessions/${harness.session.sessionId}:N-M`));
	});
});
