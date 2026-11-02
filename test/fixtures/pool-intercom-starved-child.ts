import { dirname, join } from "node:path";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { sleep, writeTextSync } from "../helpers/runtime.js";
import { poolStageOptions } from "./pool-stage-options.js";

/** Waits until the test raises `test_pool_gate.released` to at least `level`. */
async function gate(journalPath: string, level: number): Promise<true> {
	const database = new TestSqliteDatabase(journalPath);
	try {
		while (Number(database.query("SELECT released FROM test_pool_gate").get()?.released ?? 0) < level) await sleep(25);
	} finally {
		database.close();
	}
	return true;
}

/** Where the stage labelled `label` writes the context of its first turn: beside the journal. */
function contextPath(journalPath: string, label: string): string {
	return join(dirname(journalPath), `context-${label}.json`);
}

/**
 * A pooled Intercom-capable stage that starts once the gate reaches 1. Its first turn writes the context it received
 * to `context-<label>.json` beside the journal and then stays in progress until the gate reaches 2, so a test can queue messages
 * before the stage starts and inspect the root while the stage is still running.
 */
export const child = workflow({
	name: "pool-intercom-starved-child",
	description: "Offline pooled stage that starts after queued Intercom messages",
	inputs: { journalPath: Type.String(), label: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const { journalPath, label } = ctx.inputs;
		const options = await poolStageOptions(ctx.cwd!, false, process.pid);
		options.modelRuntime.registerProvider("pool-fixture", {
			api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "fixture",
			models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
			streamSimple(model, context) {
				const stream = createAssistantMessageEventStream();
				const text = JSON.stringify(context.messages);
				writeTextSync(contextPath(journalPath, label), text);
				void gate(journalPath, 2).then(() => {
					stream.push({ type: "done", reason: "stop", message: {
						role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
						content: [{ type: "text", text }], stopReason: "stop",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					} });
					stream.end();
				});
				return stream;
			},
		});
		const stage = ctx.stage("agent", { ...options, builtins: { ...options.builtins, intercom: true } } as never);
		await ctx.tool("start", {}, () => gate(journalPath, 1));
		return { text: await stage.complete(`Reply to ${label}`) };
	},
});
