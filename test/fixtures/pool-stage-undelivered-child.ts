import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** Text the stage streams before it holds its turn. */
export const UNDELIVERED_STAGE_FIRST_DELTA = "streamed-before-hold ";

/** Marker files in the child's `directory`: the test leaves `killed` before it kills the first attempt, then `finish`. */
export const UNDELIVERED_STAGE_KILLED = "killed";
export const UNDELIVERED_STAGE_FINISH = "finish";

/**
 * A pooled child whose agent stage streams a first delta and holds its turn, so a steer sent meanwhile is queued in it.
 * The test then kills the first attempt. The replacement finishes the stage without a turn when `replayFinishes` is
 * set, as a replay that finishes the stage before the root resends the steer does; otherwise its turn holds until the
 * test creates `finish`, so the root resends the steer into it.
 */
export const child = workflow({
	name: "pool-stage-undelivered-child",
	description: "Local worker stage whose replacement finishes before a pending message is resent",
	inputs: { directory: Type.String(), replayFinishes: Type.Boolean() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const { directory, replayFinishes } = ctx.inputs;
		const replacement = existsSync(join(directory, UNDELIVERED_STAGE_KILLED));
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
			streamSimple(model, _context, streamOptions) {
				const stream = createAssistantMessageEventStream();
				const partial = (text: string): AssistantMessage => ({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: [{ type: "text", text }],
					stopReason: "stop",
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
					stream.push({ type: "start", partial: partial("") });
					stream.push({ type: "text_start", contentIndex: 0, partial: partial("") });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: UNDELIVERED_STAGE_FIRST_DELTA,
						partial: partial(UNDELIVERED_STAGE_FIRST_DELTA),
					});
					// The first attempt holds until it is killed; the replacement until the test lets it finish.
					while (!existsSync(join(directory, UNDELIVERED_STAGE_FINISH))) {
						if (streamOptions?.signal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: { ...partial(UNDELIVERED_STAGE_FIRST_DELTA), stopReason: "aborted" },
							});
							stream.end();
							return;
						}
						await delay(25);
					}
					const full = `${UNDELIVERED_STAGE_FIRST_DELTA}done`;
					stream.push({ type: "text_end", contentIndex: 0, content: full, partial: partial(full) });
					stream.push({ type: "done", reason: "stop", message: partial(full) });
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", options as never);
		if (replacement && replayFinishes) return { text: "finished-by-replay" };
		return { text: await stage.complete("Stream a reply") };
	},
});
