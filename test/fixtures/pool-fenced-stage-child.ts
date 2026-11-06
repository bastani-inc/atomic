import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { WorkerLostError, workflow } from "@bastani/atomic/workflows";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";


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
 * run's stage replies at once and the child completes. Each run leaves `run-<n>` and each turn `turn-<n>` in `directory`,
 * holding the pid of the worker that ran it. With `shutdownMs`, the first run's stage session takes that long to shut
 * down, as an extension's `session_shutdown` cleanup can; it leaves `shutdown-1` when it starts and `shutdown-2` when
 * it ends.
 */
export const child = workflow({
	name: "pool-fenced-stage-child",
	description: "Local worker stage whose first attempt is fenced while the stage is open",
	inputs: { directory: Type.String(), shutdownMs: Type.Optional(Type.Number()) },
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
		const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } });
		const { shutdownMs } = ctx.inputs;
		let resourceLoader: DefaultResourceLoader | undefined;
		if (first && shutdownMs !== undefined) {
			resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager,
				noExtensions: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", async () => {
							mark(directory, "shutdown");
							await delay(shutdownMs);
							mark(directory, "shutdown");
						});
					},
				],
			});
			await resourceLoader.reload();
		}
		const stage = ctx.stage("agent", {
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: modelRuntime.getModel("pool-fixture", "fixture")!,
			settingsManager,
			builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
			...(resourceLoader === undefined ? {} : { resourceLoader }),
		} as never);
		const text = stage.complete("Reply");
		if (first) {
			text.catch(() => {});
			while (!existsSync(join(directory, "turn-1"))) await delay(25);
			await ctx.tool("deliver", {}, async () => {
				// A fault of the pool, as a lost delivery reports it: the attempt that meets it ends and the child replays.
				throw new WorkerLostError({ phase: "delivery" });
			});
		}
		return { text: await text };
	},
});
