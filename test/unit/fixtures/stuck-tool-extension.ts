import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";

const provider = "stuck-tool-fixture";
const model = "stuck-tool-model";

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
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

/**
 * A model that calls `stuck` once, then answers, and a `stuck` tool that ignores its turn's abort: it writes
 * ATOMIC_STUCK_TOOL_STARTED_FILE when it starts and returns only once `<that file>.release` exists. Each model request
 * appends a line to ATOMIC_STUCK_TOOL_REQUESTS_FILE.
 */
export default function stuckToolExtension(api: ExtensionAPI): void {
	api.registerProvider(provider, {
		api: "anthropic-messages",
		baseUrl: "https://stuck-tool.invalid",
		apiKey: "fixture-key",
		models: [
			{
				id: model,
				name: "Stuck tool fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 1_024,
			},
		],
		streamSimple: (_activeModel, context) => {
			const requests = process.env.ATOMIC_STUCK_TOOL_REQUESTS_FILE;
			if (requests) appendFileSync(requests, "request\n");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const answered = context.messages.some((entry) => entry.role === "toolResult");
				const reason = answered ? "stop" : "toolUse";
				const final = answered
					? message([{ type: "text", text: "done" }], reason)
					: message([{ type: "toolCall", id: "stuck-1", name: "stuck", arguments: {} }], reason);
				stream.push({ type: "start", partial: { ...final, content: [] } });
				stream.push({ type: "done", reason, message: final });
			});
			return stream;
		},
	});

	api.registerTool({
		name: "stuck",
		label: "Stuck",
		description: "A call that does not stop when its turn is interrupted",
		parameters: Type.Object({}),
		execute: async () => {
			const started = process.env.ATOMIC_STUCK_TOOL_STARTED_FILE;
			if (!started) throw new Error("ATOMIC_STUCK_TOOL_STARTED_FILE is required");
			writeFileSync(started, String(process.pid), "utf8");
			while (!existsSync(`${started}.release`)) await Bun.sleep(20);
			writeFileSync(`${started}.returned`, "");
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	});
}
