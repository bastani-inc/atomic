import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import type { ExtensionAPI as CodingAgentExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";
import type { WorkflowToolResult } from "../../../packages/workflows/src/extension/render-result.js";
import { registerWorkflowTool } from "../../../packages/workflows/src/extension/workflow-tool-registration.js";
import type { WorkflowToolRegistrar } from "../../../packages/workflows/src/extension/workflow-tool-registration.js";

const provider = "workflow-timeout-fixture";
const model = "workflow-timeout-model";
const FIXTURE_TIMEOUT_MS = 25;

type WorkflowTimeoutFixtureAPI = CodingAgentExtensionAPI & WorkflowToolRegistrar;

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

export default function workflowPublicTimeoutFixture(api: WorkflowTimeoutFixtureAPI): void {
	api.registerProvider(provider, {
		api: "anthropic-messages",
		baseUrl: "https://workflow-timeout.invalid",
		apiKey: "fixture-key",
		models: [
			{
				id: model,
				name: "Workflow timeout fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
			},
		],
		streamSimple: (_activeModel, context) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const userTurns = context.messages.filter((entry) => entry.role === "user").length;
				const toolResults = context.messages.filter((entry) => entry.role === "toolResult").length;
				const action = userTurns > 1 ? "interrupt" : "list";
				const reason = toolResults < userTurns ? "toolUse" : "stop";
				const finalMessage =
					reason === "toolUse"
						? assistant(
								[{ type: "toolCall", id: `workflow-timeout-${userTurns}`, name: "workflow", arguments: { action } }],
								"toolUse",
							)
						: assistant([{ type: "text", text: `workflow ${action} timeout observed` }], "stop");
				stream.push({ type: "start", partial: { ...finalMessage, content: [] } });
				stream.push({ type: "done", reason, message: finalMessage });
			});
			return stream;
		},
	});

	registerWorkflowTool(
		api,
		async (args, _ctx, signal) => {
			const action = args.action ?? "run";
			return new Promise<WorkflowToolResult>((_resolve, reject) => {
				if (action !== "interrupt") return;
				signal?.addEventListener("abort", () => reject(new Error("Agent process stopped")), { once: true });
			});
		},
		async (_policy, run) => run(),
		{ requestTimeoutMs: FIXTURE_TIMEOUT_MS },
	);
}
