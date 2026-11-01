import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** What the stage's background shell prints before it waits to be stopped. */
export const POOL_TASK_OUTPUT = "pooled-shell-started";

/**
 * A pooled child whose agent stage starts one background shell task and then holds its turn until
 * the test creates the file at `gatePath`, so a test can list, read and stop the stage's task from
 * the root while the stage runs on its local worker (#3996).
 */
export const child = workflow({
	name: "pool-task-stage-child",
	description: "Local worker stage with a background shell task",
	inputs: { gatePath: Type.String() },
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
			streamSimple(model, context, streamOptions) {
				const launched = context.messages.some((message) => message.role === "toolResult");
				const stream = createAssistantMessageEventStream();
				const reply = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage => ({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content,
					stopReason,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				void (async () => {
					if (!launched) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: reply(
								[
									{
										type: "toolCall",
										id: "shell-call",
										name: "bash",
										arguments: {
											command: `echo ${POOL_TASK_OUTPUT}; sleep 600`,
											wait: { kind: "background" },
										},
									},
								],
								"toolUse",
							),
						});
						stream.end();
						return;
					}
					// The turn holds while the test works with the background task.
					while (!existsSync(ctx.inputs.gatePath) && !streamOptions?.signal?.aborted) await delay(25);
					stream.push({ type: "done", reason: "stop", message: reply([{ type: "text", text: "done" }], "stop") });
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", options as never);
		return { text: await stage.complete("Start the build in the background") };
	},
});
