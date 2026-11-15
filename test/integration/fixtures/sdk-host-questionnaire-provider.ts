// #3105: deterministic inference only; real stage sessions, tools and broker.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai/compat";

export default function (pi: ExtensionAPI): void {
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "ask_user_question") {
			appendFileSync(join(ctx.cwd, "questionnaire-results.jsonl"), `${JSON.stringify(event.details)}\n`);
		}
	});
	pi.registerProvider("host-questionnaire-fixture", {
		api: "host-questionnaire-fixture",
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
				typeof last?.content === "string"
					? last.content
					: (last?.content ?? [])
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("");
			const params = /^questionnaire (.+)$/s.exec(text)?.[1];
			const content: AssistantMessage["content"] = params
				? [
						{
							type: "toolCall",
							id: "questionnaire-fixture",
							name: "ask_user_question",
							arguments: JSON.parse(params),
						},
					]
				: [{ type: "text", text: "Fixture complete." }];
			const output: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				content,
				stopReason: params ? "toolUse" : "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: params ? "toolUse" : "stop", message: output });
			stream.end();
			return stream;
		},
	});
}
