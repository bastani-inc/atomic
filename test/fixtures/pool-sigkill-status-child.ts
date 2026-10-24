import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";

/**
 * Stage options whose fixture model answers at once, or, when `block` is set,
 * holds its reply until `release` exists so a pooled child can be caught
 * mid-stage with its session transcript already journaled.
 */
async function fixtureStageOptions(directory: string, index: number, block: boolean) {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("sigkill-fixture", {
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
			void (async () => {
				if (block) {
					writeFileSync(join(directory, `started-${index}-${process.pid}`), "");
					while (!existsSync(join(directory, "release"))) await delay(20);
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						content: [{ type: "text", text: String(process.pid) }],
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
			})();
			return stream;
		},
	});
	return {
		cwd: directory,
		agentDir: directory,
		modelRuntime,
		model: modelRuntime.getModel("sigkill-fixture", "fixture")!,
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	};
}

export const sessionChild = workflow({
	name: "sigkill-status-pool-child",
	description: "Journals a completed stage transcript, then fails, finishes, or holds a second stage mid-turn",
	inputs: { directory: Type.String(), index: Type.Number(), outcome: Type.String() },
	outputs: { pid: Type.Number() },
	async run(ctx) {
		const { directory, index } = ctx.inputs;
		await ctx.stage("draft", (await fixtureStageOptions(directory, index, false)) as never).complete("Draft.");
		if (ctx.inputs.outcome === "fail") throw new Error("pooled child failed after journaling its stage session");
		const reply = await ctx
			.stage("review", (await fixtureStageOptions(directory, index, ctx.inputs.outcome === "hold")) as never)
			.complete("Review.");
		return { pid: Number(reply) };
	},
});
