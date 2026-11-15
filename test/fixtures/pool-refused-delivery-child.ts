import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { poolStageOptions } from "./pool-stage-options.js";

/**
 * A pooled child whose Intercom stage starts once the test sets `test_pool_gate.released`, so a message queued before
 * then reaches the stage as pre-start context. Its reply is the context its model saw.
 */
export const child = workflow({
	name: "pool-refused-delivery-child",
	description: "Pooled stage that replies with its context",
	inputs: { journalPath: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const options = await poolStageOptions(ctx.cwd!, false, process.pid);
		options.modelRuntime.registerProvider("pool-fixture", {
			api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture",
			models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
			streamSimple(model, context) {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: {
					role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
					content: [{ type: "text", text: JSON.stringify(context.messages) }], stopReason: "stop",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
				stream.end();
				return stream;
			},
		});
		const stage = ctx.stage("agent", { ...options, builtins: { ...options.builtins, intercom: true } } as never);
		await ctx.tool("gate", {}, async () => {
			const database = new TestSqliteDatabase(ctx.inputs.journalPath);
			try {
				while (!database.query("SELECT released FROM test_pool_gate").get()?.released) await delay(25);
			} finally {
				database.close();
			}
			return true;
		});
		return { text: await stage.complete("Reply") };
	},
});
