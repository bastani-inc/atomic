import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** The stage acknowledges a steer or follow-up whose text starts with these. */
export const ROUNDS_STEER = "rounds-steer";
export const ROUNDS_FOLLOW_UP = "rounds-follow-up";
/** While `release` is missing from the child's cwd, the agent holds before its next round. */
export const ROUNDS_RELEASE_FILE = "release";

type Message = { readonly role: string; readonly content?: unknown };

function text(message: Message | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("")
		: "";
}

/**
 * A pooled child whose agent stage works in rounds of real `bash` tool calls, the way a long
 * agent turn does; after the first round it holds before each further tool call until the test
 * creates `release`. It acknowledges a steer by ending its turn, then answers a queued follow-up
 * in the next turn.
 */
export const child = workflow({
	name: "pool-rounds-child",
	description: "Local worker stage that runs tool rounds",
	inputs: { cwd: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const options = await poolStageOptions(ctx.inputs.cwd, false, process.pid);
		const release = join(ctx.inputs.cwd, ROUNDS_RELEASE_FILE);
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
			streamSimple(model, context, streamOptions) {
				const messages = context.messages as readonly Message[];
				const last = messages.at(-1);
				const rounds = messages.filter((message) => message.role === "toolResult").length;
				const acked = messages.some(
					(message) => message.role === "assistant" && text(message).startsWith(`ack ${ROUNDS_STEER}`),
				);
				const steer = messages.find((message) => message.role === "user" && text(message).startsWith(ROUNDS_STEER));
				let content: AssistantMessage["content"];
				if (last?.role === "user" && text(last).startsWith(ROUNDS_FOLLOW_UP))
					content = [{ type: "text", text: `ack ${text(last)}` }];
				else if (steer !== undefined && !acked) content = [{ type: "text", text: `ack ${text(steer)} after ${rounds} rounds` }];
				else if (acked) content = [{ type: "text", text: "done" }];
				else
					content = [
						{
							type: "toolCall",
							id: `round-${rounds + 1}-${Date.now()}`,
							name: "bash",
							arguments: {
								command: `echo round ${rounds + 1}`,
							},
						},
					];
				const toolUse = content[0]?.type === "toolCall";
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content,
					stopReason: toolUse ? "toolUse" : "stop",
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
				void (async () => {
					stream.push({ type: "start", partial: { ...message, content: [] } });
					// After its first round the agent thinks until released: a kill lands mid-turn, after a
					// finished tool call, as it does in a long agent turn.
					while (toolUse && rounds >= 1 && !existsSync(release)) {
						if (streamOptions?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
							stream.end();
							return;
						}
						await delay(25);
					}
					stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", options as never);
		return { text: await stage.complete("Work in rounds") };
	},
});
