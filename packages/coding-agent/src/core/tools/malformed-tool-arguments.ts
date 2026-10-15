import { type ToolCall, validateToolArguments } from "@bastani/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

function findIssuingToolCall(messages: readonly AgentMessage[], args: unknown): ToolCall | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content.find((part): part is ToolCall => part.type === "toolCall" && part.arguments === args);
	}
	return undefined;
}

export function rejectMalformedToolArguments(tool: AgentTool, getMessages: () => readonly AgentMessage[]): AgentTool {
	const prepareArguments = tool.prepareArguments;
	return {
		...tool,
		prepareArguments: (args) => {
			const toolCall = findIssuingToolCall(getMessages(), args);
			if (toolCall?.argumentsError) validateToolArguments(tool, toolCall);
			return prepareArguments ? prepareArguments(args) : args;
		},
	};
}
