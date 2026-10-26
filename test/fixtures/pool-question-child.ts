import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { passReaskGate } from "./pool-reask-gate.js";
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

/** A user message carrying this marker is a follow-up the chat child replies to, instead of asking. */
export const FOLLOW_UP_MARKER = "follow-up:";

/**
 * A pooled child whose agent stage asks `ask_user_question`, then replies with the tool's result,
 * so a test sees which answer reached the worker. With `afterAnyResult`, the model replies to the
 * latest tool result even when a later message asks it to continue, as a model that does not
 * re-ask an interrupted question does. With `replyToFollowUps`, a user message carrying
 * {@link FOLLOW_UP_MARKER} gets `heard <count>x: <text>`, counting that text's user messages.
 */
function questionChild(name: string, afterAnyResult: boolean, replyToFollowUps = false, gated = false) {
	return workflow({
		name,
		description: "Local worker ask_user_question fixture",
		inputs: { journalPath: Type.Optional(Type.String()) },
		outputs: { text: Type.String() },
		async run(ctx) {
			// A replacement attempt waits here, before its stage resumes and asks again (#4022).
			if (gated && ctx.inputs.journalPath !== undefined) await passReaskGate(ctx.inputs.journalPath);
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
					const last = context.messages.at(-1);
					const result = afterAnyResult
						? context.messages.findLast((message) => message.role === "toolResult")
						: last?.role === "toolResult"
							? last
							: undefined;
					const followUp =
						replyToFollowUps && last?.role === "user" && text(last).includes(FOLLOW_UP_MARKER) ? text(last) : undefined;
					const asked = result !== undefined || followUp !== undefined;
					const content: AssistantMessage["content"] =
						followUp !== undefined
							? [
									{
										type: "text",
										text: `heard ${context.messages.filter((message) => message.role === "user" && text(message) === followUp).length}x: ${followUp}`,
									},
								]
							: asked
								? [{ type: "text", text: `answered: ${text(result)}` }]
								: [
										{
											type: "toolCall",
											id: replyToFollowUps ? `question-call-${context.messages.length}` : "question-call",
											name: "ask_user_question",
											arguments: POOL_QUESTION,
										},
									];
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

/** Asks again after each user message, except a follow-up, which it answers. */
export const chatChild = questionChild("pool-question-chat-child", false, true);

/** Like {@link noReaskChild}, but its replacement attempt waits at a gate before it asks again (#4022). */
export const gatedNoReaskChild = questionChild("pool-question-gated-child", true, false, true);
