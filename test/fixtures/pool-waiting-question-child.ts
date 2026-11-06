import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** The question the waiting child's stage asks. */
export const WAITING_QUESTION = {
	questions: [
		{
			question: "Release the build?",
			header: "Release",
			options: [
				{ label: "yes", description: "Release it" },
				{ label: "no", description: "Hold it" },
			],
		},
	],
};

function text(message: { readonly content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("")
		: "";
}

/**
 * A pooled child whose agent stage asks `ask_user_question` and releases its session at once while it waits for the
 * answer (#4374), then replies with the answer. Its outputs name the worker process it ran on.
 */
export const questionChild = workflow({
	name: "pool-waiting-question-child",
	description: "Local worker child whose stage waits released on a question",
	inputs: {},
	outputs: { text: Type.String(), pid: Type.Number() },
	async run(ctx) {
		const options = await poolStageOptions(ctx.cwd!, false, process.pid);
		options.modelRuntime.registerProvider("pool-fixture", {
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			apiKey: "fixture",
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
				const result = context.messages.at(-1)?.role === "toolResult" ? context.messages.at(-1) : undefined;
				const content: AssistantMessage["content"] =
					result !== undefined
						? [{ type: "text", text: `answered: ${text(result)}` }]
						: [{ type: "toolCall", id: "question-call", name: "ask_user_question", arguments: WAITING_QUESTION }];
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content,
					stopReason: result !== undefined ? "stop" : "toolUse",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "toolUse", message });
				stream.end();
				return stream;
			},
		});
		const stage = ctx.stage("agent", { ...options, releaseWhenWaiting: { afterMs: 0 } } as never);
		return { text: await stage.complete("Ask before releasing"), pid: process.pid };
	},
});

/** A pooled child that only reports, through one durable tool call, the worker process it ran on. */
export const quickChild = workflow({
	name: "pool-waiting-quick-child",
	description: "Local worker child that completes at once",
	inputs: { index: Type.Number() },
	outputs: { index: Type.Number(), pid: Type.Number() },
	async run(ctx) {
		const { index } = ctx.inputs;
		return await ctx.tool("report", { index }, async () => ({ index, pid: process.pid }));
	},
});
