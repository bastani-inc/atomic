import type { JsonObject, TranscriptContext } from "@bastani/pi-ai";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/context-types.js";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.js";
import { decisionMessage, decisionModel, inferenceUserContent, messageStream } from "../helpers/structured-output.js";

export function workflowDecisionArgs(value: JsonObject) {
	return {
		instructions: "Return the scripted result for this workflow stage test.",
		state: { scriptedResult: value },
	};
}

export const workflowDecisionContext = {
	model: decisionModel,
	modelRegistry: {
		getAll: () => [decisionModel],
		streamSimple: (_model: typeof decisionModel, context: TranscriptContext) => {
			const content = inferenceUserContent(context);
			if (typeof content !== "string") throw new Error("Workflow fixture requires JSON state");
			const payload = JSON.parse(content) as { state?: { scriptedResult?: JsonObject } };
			const result = payload.state?.scriptedResult;
			if (!result || typeof result !== "object" || Array.isArray(result)) {
				throw new Error("Workflow fixture requires a scripted object result");
			}
			return messageStream(decisionMessage(result as JsonObject));
		},
	},
} as ExtensionContext;

export function executeWorkflowDecision(tool: ToolDefinition, toolCallId: string, value: JsonObject) {
	return tool.execute(toolCallId, workflowDecisionArgs(value), undefined, undefined, workflowDecisionContext);
}
