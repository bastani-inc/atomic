import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";

/** A fault of the pool, as a lost delivery reports it: the attempt that meets it ends and the child replays. */
export const FENCED_STAGE_FAULT = "Worker exited before delivery acknowledgement";

/** The next free `<prefix>-<n>` marker in `directory`, created; returns `n`. */
function mark(directory: string, prefix: string): number {
	let n = 1;
	while (existsSync(join(directory, `${prefix}-${n}`))) n++;
	writeFileSync(join(directory, `${prefix}-${n}`), String(process.pid));
	return n;
}

/**
 * A pooled child with one agent stage. Its first run's stage starts a turn that holds until it is aborted, and while it
 * holds, the run fails on a fault of the pool, which ends the attempt with the stage's session still open. Every later
 * run's stage replies at once and the child completes. Each run leaves `run-<n>` and each turn `turn-<n>` in `directory`.
 */
export const child = workflow({
	name: "pool-fenced-stage-child",
	description: "Local worker stage whose first attempt is fenced while the stage is open",
	inputs: { directory: Type.String() },
	outputs: { text: Type.String() },
	async run(ctx) {
		const { directory } = ctx.inputs;
		const first = mark(directory, "run") === 1;
		const cwd = ctx.cwd!;
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider("pool-fixture", {
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
			streamSimple(model, _context, options) {
				const stream = createAssistantMessageEventStream();
				const reply = (text: string, stopReason: "stop" | "aborted"): AssistantMessage => ({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: [{ type: "text", text }],
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
				mark(directory, "turn");
				void (async () => {
					if (first) {
						while (!options?.signal?.aborted) await delay(25);
						stream.push({ type: "error", reason: "aborted", error: reply("", "aborted") });
					} else stream.push({ type: "done", reason: "stop", message: reply("done", "stop") });
					stream.end();
				})();
				return stream;
			},
		});
		const stage = ctx.stage("agent", {
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: modelRuntime.getModel("pool-fixture", "fixture")!,
			settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		} as never);
		const text = stage.complete("Reply");
		if (first) {
			text.catch(() => {});
			while (!existsSync(join(directory, "turn-1"))) await delay(25);
			await ctx.tool("deliver", {}, async () => {
				throw new Error(FENCED_STAGE_FAULT);
			});
		}
		return { text: await text };
	},
});
