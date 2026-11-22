/** Offline provider fixture: exercise the real registered workflow tool, with no model/network calls. */
import type { ExtensionAPI } from "@bastani/atomic";
import { type AssistantMessage, createAssistantMessageEventStream, type JsonObject } from "@bastani/atomic-ai/compat";

function parseWorkflowToolRequest(text: string): JsonObject | undefined {
	const launch = /^launch-workflow (\S+)$/.exec(text)?.[1];
	if (launch !== undefined) return { action: "run", workflow: launch, inputs: {} };
	const status = /^status-workflow ([0-9a-f-]{36})$/.exec(text)?.[1];
	if (status !== undefined) return { action: "status", runId: status };
	const quit = /^quit-workflow ([0-9a-f-]{36})$/.exec(text)?.[1];
	if (quit !== undefined) return { action: "quit", runId: quit };
	const resume = /^resume-workflow ([0-9a-f-]{36})$/.exec(text)?.[1];
	if (resume !== undefined) return { action: "resume", runId: resume };
	if (text === "reload-workflow") return { action: "reload" };
	const pauseTool = /^pause-tool ([0-9a-f-]{36})$/.exec(text)?.[1];
	if (pauseTool !== undefined) return { action: "pause", runId: pauseTool, stageId: "hang-tool" };
	return undefined;
}

export default function (atomic: ExtensionAPI): void {
	atomic.registerProvider("tool-abort-fixture", {
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
			const toolArgs = parseWorkflowToolRequest(text.trim());
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content:
					toolArgs === undefined
						? [{ type: "text", text: "Fixture complete." }]
						: [
								{
									type: "toolCall",
									id: `wf-${Date.now()}`,
									name: "workflow",
									arguments: toolArgs,
								},
							],
				stopReason: toolArgs === undefined ? "stop" : "toolUse",
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
