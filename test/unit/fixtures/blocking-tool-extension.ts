import { writeFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.js";
if (process.env.ATOMIC_BLOCKING_EXTENSION_INIT === "1") {
	const deadline = performance.now() + 1_000;
	while (performance.now() < deadline) {
		// Intentionally block module evaluation in the engine child.
	}
}


const provider = "isolation-fixture";
const model = "blocking-model";

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

export default function blockingToolExtension(api: ExtensionAPI): void {
	api.registerProvider(provider, {
		api: "anthropic-messages",
		baseUrl: "https://isolation.invalid",
		apiKey: "fixture-key",
		models: [{
			id: model,
			name: "Blocking isolation fixture",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		}],
		streamSimple: (_activeModel, context) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const hasToolResult = context.messages.some((entry) => entry.role === "toolResult");
				const reason = hasToolResult ? "stop" : "toolUse";
				const finalMessage = hasToolResult
					? message([{ type: "text", text: "done" }], reason)
					: message([{ type: "toolCall", id: "busy-call", name: "busy_loop", arguments: {} }], reason);
				stream.push({ type: "start", partial: { ...finalMessage, content: [] } });
				stream.push({ type: "done", reason, message: finalMessage });
			});
			return stream;
		},
	});

	api.on("session_start", async (_event, ctx) => {
		if (process.env.ATOMIC_STARTUP_CUSTOM_UI !== "1") return;
		await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => ({
			render: (width) => [`startup:${width}`],
			handleInput: (data) => { if (data === "\r") done(); },
			invalidate: () => {},
		}));
	});

	api.registerTool({
		name: "busy_loop",
		label: "Busy loop",
		description: "Synthetic blocking tool for interactive-engine isolation regression coverage",
		parameters: Type.Object({}),
		execute: async () => {
			const pidFile = process.env.ATOMIC_BLOCKING_TOOL_PID_FILE;
			if (!pidFile) throw new Error("ATOMIC_BLOCKING_TOOL_PID_FILE is required");
			writeFileSync(pidFile, String(process.pid), "utf8");
			const deadline = performance.now() + 5_000;
			while (performance.now() < deadline) {
				// Intentionally never yield.
			}
			return { content: [{ type: "text", text: "finished" }], details: {} };
		},
	});
}
