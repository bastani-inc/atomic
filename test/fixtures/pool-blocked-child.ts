import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/atomic-ai";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";

/**
 * Pooled children that block their run on a recoverable failure while a file in their directory says so, and run
 * through once it is gone (#5534). Each records in its directory what it did, one line per time:
 * - `entries`: the child's body started (its first run, and each replay of it);
 * - `effects`: the shell command its stage ran in the background completed;
 * - `requests`: its stage's provider took a request.
 */
export const SESSIONS_DOWN = "sessions-down";
export const PROVIDER_DOWN = "provider-down";
export const FAILING = "failing";

/** How many lines `name` in `directory` has: how many times the child did that. */
export function timesDone(directory: string, name: "entries" | "effects" | "requests"): number {
	const file = join(directory, name);
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

/** The session store's failure while it is unreachable, as its adapter reports it. */
function unreachable(): Error {
	return Object.assign(new Error("connect ECONNREFUSED"), { name: "StorageUnavailableError", code: "ECONNREFUSED" });
}

/**
 * `target` with every method failing as an unreachable store's while the file `down` exists: what a stage reads as it
 * reopens its session fails, and nothing else is read while the stage waits released.
 */
function unreachableWhile<T extends object>(target: T, down: string): T {
	return new Proxy(target, {
		get(object, key) {
			const value = Reflect.get(object, key, object) as unknown;
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (existsSync(down)) throw unreachable();
				return (value as (...args: unknown[]) => unknown).apply(object, args);
			};
		},
	});
}

/**
 * A child whose stage runs a shell command in the background, releases its session while it waits, and, woken by the
 * command's end, cannot reopen the session while `sessions-down` exists, which the command itself creates: what the
 * reopen reads fails as an unreachable store does, so the run blocks resumably on the stage (#4309). The command
 * completes once; a resume continues the stage from its result.
 */
export const sessionBlockedChild = workflow({
	name: "pool-session-blocked-child",
	description: "A pooled child whose woken stage cannot reopen its session store",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		const { directory } = ctx.inputs;
		appendFileSync(join(directory, "entries"), `${process.pid}\n`);
		const down = join(directory, SESSIONS_DOWN);
		const options = await poolStageOptions(ctx.cwd!, false, 0);
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
			streamSimple(model, context) {
				const results = context.messages.filter((message) => message.role === "toolResult");
				const task = /task-[0-9a-z-]+/.exec(JSON.stringify(results[0]))?.[0] ?? "";
				const effects = join(directory, "effects");
				const content: AssistantMessage["content"] =
					results.length === 0
						? [
								{
									type: "toolCall",
									id: "dispatch",
									name: "bash",
									arguments: {
										command: `sleep 1; touch '${down}'; echo build passed >> '${effects}'; echo ok`,
										wait: { kind: "background" },
									},
								},
							]
						: results.length === 1
							? [{ type: "toolCall", id: "collect", name: "bash", arguments: { action: "wait", id: task } }]
							: [{ type: "text", text: "done" }];
				const stopReason = results.length === 2 ? "stop" : "toolUse";
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: stopReason,
					message: {
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
					},
				} as never);
				stream.end();
				return stream;
			},
		});
		const stage = ctx.stage("build", {
			...options,
			model: options.modelRuntime.getModel("pool-fixture", "fixture")!,
			settingsManager: unreachableWhile(options.settingsManager, down),
			releaseWhenWaiting: { afterMs: 0 },
		} as never);
		await stage.complete("watch the build");
		return {};
	},
});

/**
 * A child whose stage's provider answers every request with a 503 while `provider-down` exists: the run blocks
 * resumably on the stage, on the provider's outage, and its stage answers once the provider is back.
 */
export const providerBlockedChild = workflow({
	name: "pool-provider-blocked-child",
	description: "A pooled child blocked on its stage's provider outage",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		const { directory } = ctx.inputs;
		appendFileSync(join(directory, "entries"), `${process.pid}\n`);
		const options = await poolStageOptions(ctx.cwd!, false, 0);
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
				appendFileSync(join(directory, "requests"), `${process.pid}\n`);
				const down = existsSync(join(directory, PROVIDER_DOWN));
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: down ? [] : [{ type: "text", text: "reviewed" }],
					stopReason: down ? "error" : "stop",
					...(down ? { errorMessage: "503 Service Unavailable: the provider is overloaded" } : {}),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				const stream = createAssistantMessageEventStream();
				stream.push(
					(down ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }) as never,
				);
				stream.end();
				return stream;
			},
		});
		await ctx
			.stage("review", { ...options, model: options.modelRuntime.getModel("pool-fixture", "fixture")! } as never)
			.complete("review the change");
		return {};
	},
});

/** A child whose own step fails while `failing` exists in its directory: a failure of its own, not a block. */
export const failingChild = workflow({
	name: "pool-failing-child",
	description: "A pooled child that fails on its own logic",
	inputs: { directory: Type.String() },
	outputs: {},
	async run(ctx) {
		appendFileSync(join(ctx.inputs.directory, "entries"), `${process.pid}\n`);
		await ctx.tool("check", {}, async () => {
			if (existsSync(join(ctx.inputs.directory, FAILING))) throw new Error("the check failed");
			return "ok";
		});
		return {};
	},
});
