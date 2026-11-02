import { appendFileSync } from "node:fs";
import v8 from "node:v8";
import vm from "node:vm";
import { workflow } from "@bastani/atomic/workflows";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** Heap in use right after two full collections, so only what is still reachable counts. */
function heapAfterCollection(): number {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc") as () => void;
	v8.setFlagsFromString("--no-expose-gc");
	gc();
	gc();
	return process.memoryUsage().heapUsed;
}

/**
 * A pooled child with one agent stage whose reply, `bytes` characters long, is also the child's output. When it starts,
 * it appends to `log` the heap its worker still holds, after a full collection, with the worker's pid: what the worker
 * kept of the children it ran before, their stages and runs among it. Like an extension's delayed startup work, it also
 * leaves a ten-minute timer behind, which keeps the async context the child ran in for as long as it waits.
 */
export const child = workflow({
	name: "pool-memory-stage-child",
	description: "Pooled child with one agent stage and a large reply",
	inputs: { index: Type.Number(), bytes: Type.Number(), log: Type.String(), cwd: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const { index, bytes, log, cwd } = ctx.inputs;
		appendFileSync(log, `${JSON.stringify({ index, pid: process.pid, heapUsed: heapAfterCollection() })}\n`);
		setTimeout(() => {}, 600_000).unref();
		const options = await poolStageOptions(cwd, false, process.pid);
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
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						content: [{ type: "text", text: `reply ${index} `.repeat(Math.ceil(bytes / 10)).slice(0, bytes) }],
						stopReason: "stop",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
				stream.end();
				return stream;
			},
		});
		return { text: await ctx.stage("agent", options as never).complete("Reply") };
	},
});
