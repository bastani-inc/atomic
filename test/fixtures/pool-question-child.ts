import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** The question the stage asks, with a preview: the form must carry its exact parameters. */
export const POOL_QUESTION = {
	questions: [
		{
			question: "Ship the release from the worker?",
			header: "Ship",
			multiSelect: false,
			options: [
				{ label: "yes", description: "Ship it now", preview: "release-preview-marker" },
				{ label: "no", description: "Hold the release", preview: "hold-preview-marker" },
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
 * A pooled child whose agent stage asks `ask_user_question`, then replies with the tool's result,
 * so a test sees which answer reached the worker. With `afterAnyResult`, the model replies to the
 * latest tool result even when a later message asks it to continue, as a model that does not
 * re-ask an interrupted question does.
 */
function questionChild(name: string, afterAnyResult: boolean) {
	return workflow({
		name,
		description: "Local worker ask_user_question fixture",
		inputs: {},
		outputs: { text: Type.String() },
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
					const result = afterAnyResult
						? context.messages.findLast((message) => message.role === "toolResult")
						: context.messages.at(-1)?.role === "toolResult"
							? context.messages.at(-1)
							: undefined;
					const asked = result !== undefined;
					const content: AssistantMessage["content"] = asked
						? [{ type: "text", text: `answered: ${text(result)}` }]
						: [{ type: "toolCall", id: "question-call", name: "ask_user_question", arguments: POOL_QUESTION }];
					const message: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						content,
						stopReason: asked ? "stop" : "toolUse",
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
					stream.push({ type: "done", reason: asked ? "stop" : "toolUse", message });
					stream.end();
					return stream;
				},
			});
			const stage = ctx.stage("agent", options as never);
			return { text: await stage.complete("Ask before shipping") };
		},
	});
}

export const child = questionChild("pool-question-child", false);

/** Replies to an interrupted question's result instead of asking again. */
export const noReaskChild = questionChild("pool-question-no-reask-child", true);
