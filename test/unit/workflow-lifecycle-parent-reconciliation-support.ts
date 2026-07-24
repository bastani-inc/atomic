import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai/compat";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.js";

export const lifecycleConfig = {
	enabled: true,
	notifyOn: ["completed", "failed", "blocked", "awaiting_input"] as const,
};

export function assertWorkflowToolOrdering(context: { messages: Context["messages"] }): void {
	const toolResultIndex = context.messages.findIndex(
		(message) => message.role === "toolResult" && message.toolName === "workflow",
	);
	assert.notEqual(toolResultIndex, -1, "the admitted status=running workflow result must reach the provider");
	const toolResult = context.messages[toolResultIndex];
	assert.ok(toolResult && toolResult.role === "toolResult");
	assert.equal((toolResult.details as { status?: string } | undefined)?.status, "running");
	const callId = toolResult.toolCallId;
	const assistantIndex = context.messages.findIndex(
		(message) => message.role === "assistant" && message.content.some(
			(part) => part.type === "toolCall" && part.id === callId && part.name === "workflow",
		),
	);
	assert.equal(toolResultIndex, assistantIndex + 1, "no lifecycle user turn may split the workflow tool call from its result");
}

export function providerSawWorkflowState(context: Context | undefined, workflowName: string, state: string): boolean {
	return context?.messages.some(
		(message) => message.role === "user" && getMessageText(message).includes(`Workflow "${workflowName}" ${state}`),
	) === true;
}
