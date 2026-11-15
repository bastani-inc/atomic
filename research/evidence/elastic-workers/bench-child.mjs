// Pooled child of the elastic-workers benchmark (#4768). Each `ctx.tool` call with a no-op body is one durable
// checkpoint, so the time a call takes is the cost of committing one checkpoint through the pool: the worker's IPC
// to its coordinator, the fenced commit in the shared journal, and the worker's catch-up fold.
// With `stageMs > 0` the child also runs one agent stage on a stub model that answers after `stageMs`, which adds
// the stage's session writes; with `model` set to `provider/id` the stage runs on that real model instead.
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AuthStorage, getAgentDir, ModelRuntime, SettingsManager } from "@bastani/atomic";
import { workflow } from "@bastani/atomic/workflows";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function stubStageOptions(cwd, stageMs) {
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider("bench-stub", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "stub",
		models: [{ id: "stub", name: "Stub", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			setTimeout(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: `ok from ${process.pid}` }], stopReason: "stop", usage },
				});
				stream.end();
			}, stageMs);
			return stream;
		},
	});
	return {
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: modelRuntime.getModel("bench-stub", "stub"),
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false }, retry: { enabled: false } }),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	};
}

async function realStageOptions(cwd, reference) {
	const agentDir = getAgentDir();
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.create(`${agentDir}/auth.json`), modelsPath: null });
	const [provider, ...id] = reference.split("/");
	return {
		cwd,
		modelRuntime,
		model: modelRuntime.getModel(provider, id.join("/")),
		settingsManager: SettingsManager.inMemory({ sessionSummary: { enabled: false } }),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	};
}

export const benchChild = workflow({
	name: "elastic-bench-child",
	description: "Commits `steps` checkpoints and reports how long each took",
	inputs: {
		index: Type.Number(),
		steps: Type.Number(),
		payloadBytes: Type.Number(),
		workMs: Type.Number(),
		stageMs: Type.Optional(Type.Number()),
		model: Type.Optional(Type.String()),
	},
	outputs: {
		host: Type.String(),
		latenciesMs: Type.Array(Type.Number()),
		stageMs: Type.Number(),
		reply: Type.String(),
		startedAt: Type.Number(),
		endedAt: Type.Number(),
	},
	async run(ctx) {
		const pad = "x".repeat(ctx.inputs.payloadBytes);
		const latencies = [];
		const startedAt = Date.now();
		const half = Math.floor(ctx.inputs.steps / 2);
		const steps = async (from, to) => {
			for (let step = from; step < to; step++) {
				if (ctx.inputs.workMs > 0) await delay(ctx.inputs.workMs);
				const began = performance.now();
				await ctx.tool(`step-${step}`, { step }, async () => ({ step, pad }));
				latencies.push(Math.round((performance.now() - began) * 100) / 100);
			}
		};
		await steps(0, half);
		let stageMs = 0;
		let reply = "";
		if ((ctx.inputs.stageMs ?? 0) > 0 || ctx.inputs.model) {
			const cwd = ctx.cwd ?? process.cwd();
			const options = ctx.inputs.model ? await realStageOptions(cwd, ctx.inputs.model) : await stubStageOptions(cwd, ctx.inputs.stageMs);
			const began = performance.now();
			reply = String(await ctx.stage("agent", options).complete("Reply with one short sentence naming the color of the sky."));
			stageMs = Math.round(performance.now() - began);
		}
		await steps(half, ctx.inputs.steps);
		return { host: process.env.ELASTIC_BENCH_HOST ?? hostname(), latenciesMs: latencies, stageMs, reply: reply.slice(0, 200), startedAt, endedAt: Date.now() };
	},
});
