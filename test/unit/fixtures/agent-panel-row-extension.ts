import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";

const provider = "isolation-fixture";
const model = "blocking-model";

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export default function agentPanelRowExtension(api: ExtensionAPI): void {
	api.registerProvider(provider, {
		api: "anthropic-messages",
		baseUrl: "https://isolation.invalid",
		apiKey: "fixture-key",
		models: [
			{
				id: model,
				name: "Agent panel fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8_192,
				maxTokens: 1_024,
			},
		],
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = reply();
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
	api.registerAgentPanelSource({
		items: () => [{ id: "fixture:run", kind: "agent", state: "running", name: "review", task: "stage one" }],
		subscribe: () => () => {},
	});
}
