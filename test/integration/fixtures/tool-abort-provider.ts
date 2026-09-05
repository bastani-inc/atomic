/** Offline provider fixture: exercise the real registered workflow tool, with no model/network calls. */
import type { ExtensionAPI } from "@bastani/atomic";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("tool-abort-fixture", {
		api: "tool-abort-fixture",
		apiKey: "fixture-only",
		baseUrl: "http://127.0.0.1:1/unused",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1);
			const text =
				last?.role === "user"
					? typeof last.content === "string"
						? last.content
						: last.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("")
					: "";
			const runId = /^interrupt-tool ([0-9a-f-]{36})$/.exec(text)?.[1];
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content:
					runId === undefined
						? [{ type: "text", text: "Fixture complete." }]
						: [
								{
									type: "toolCall",
									id: `abort-${runId}`,
									name: "workflow",
									arguments: { action: "interrupt", runId, stageId: "hang-tool" },
								},
							],
				stopReason: runId === undefined ? "stop" : "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			queueMicrotask(() => {
				stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
				stream.end();
			});
			return stream;
		},
	});
}
