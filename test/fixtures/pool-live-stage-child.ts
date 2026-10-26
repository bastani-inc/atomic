import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { poolStageOptions } from "./pool-stage-options.js";

/** Text the stage streams before it holds mid-turn, and after the test releases it. */
export const LIVE_STAGE_FIRST_DELTA = "streamed-before-hold ";
export const LIVE_STAGE_SECOND_DELTA = "streamed-after-release";

async function released(journalPath: string): Promise<void> {
	for (;;) {
		const database = new TestSqliteDatabase(journalPath);
		try {
			if (database.query("SELECT released FROM test_live_stage_gate").get()?.released) return;
		} finally {
			database.close();
		}
		await delay(25);
	}
}

/**
 * A pooled child whose one agent stage streams a reply in two deltas and holds between
 * them until the test sets `test_live_stage_gate.released`, so a test can watch it
 * mid-turn on its local worker.
 */
export const child = workflow({
	name: "pool-live-stage-child",
	description: "Local worker stage that streams slowly",
	inputs: { journalPath: Type.String() },
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
			streamSimple(model) {
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
					const full = LIVE_STAGE_FIRST_DELTA + LIVE_STAGE_SECOND_DELTA;
					stream.push({ type: "start", partial: partial("") });
					stream.push({ type: "text_start", contentIndex: 0, partial: partial("") });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: LIVE_STAGE_FIRST_DELTA,
						partial: partial(LIVE_STAGE_FIRST_DELTA),
					});
					await released(ctx.inputs.journalPath);
					stream.push({ type: "text_delta", contentIndex: 0, delta: LIVE_STAGE_SECOND_DELTA, partial: partial(full) });
					stream.push({ type: "text_end", contentIndex: 0, content: full, partial: partial(full) });
					stream.push({ type: "done", reason: "stop", message: partial(full) });
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", options as never);
		return { text: await stage.complete("Stream a reply") };
	},
});
