import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** The group the pooled stage joins on its first worker (#4079). */
export const POOL_JOIN_GROUP = "pool-stage-team";

function done(model: { api: string; provider: string; id: string }, content: AssistantMessage["content"], toolUse: boolean) {
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
	stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
	stream.end();
	return stream;
}

/**
 * A pooled stage that joins {@link POOL_JOIN_GROUP} on its first worker, then holds that worker until the test kills
 * it. On the replacement worker the stage resumes its saved session and never joins again: it marks the directory
 * `resumed-<pid>` and holds until `release` appears. A replacement that finds no saved join marks `fresh-session`.
 */
export const child = workflow({
	name: "pool-intercom-join-child",
	description: "Offline pooled stage that joins an Intercom group, then resumes on a replacement worker",
	inputs: { directory: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const firstPid = await ctx.tool("pid", {}, async () => process.pid);
		const options = await poolStageOptions(ctx.cwd!, false, firstPid);
		const { directory } = ctx.inputs;
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
				const joined = context.messages.some((message) => message.role === "toolResult");
				if (!joined && process.pid === firstPid)
					return done(
						model,
						[
							{
								type: "toolCall",
								id: "join-call",
								name: "intercom",
								arguments: { action: "join", group: POOL_JOIN_GROUP },
							},
						],
						true,
					);
				if (process.pid === firstPid) {
					writeFileSync(join(directory, `joined-${process.pid}`), "");
					// Held until the test kills this worker.
					return createAssistantMessageEventStream();
				}
				if (!joined) writeFileSync(join(directory, "fresh-session"), "");
				const stream = createAssistantMessageEventStream();
				void (async () => {
					writeFileSync(join(directory, `resumed-${process.pid}`), "");
					while (!existsSync(join(directory, "release"))) await delay(25);
					const finished = done(model, [{ type: "text", text: "resumed" }], false);
					for await (const event of finished) stream.push(event);
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", { ...options, builtins: { ...options.builtins, intercom: true } } as never);
		return { text: await stage.complete("Join the team, then wait") };
	},
});
