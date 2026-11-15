import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { workflow } from "@bastani/atomic/workflows";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { Type } from "typebox";
import { poolStageOptions } from "./pool-stage-options.js";

/** Where a pooled child of this fixture holds: inside `start`, inside the stage's turn, or inside `finish`. */
export type HoldPoint = "start" | "turn" | "finish" | "none";

/**
 * Notes that `step` ran in this process, and, at the hold point, writes `holding-<step>` with this pid and waits for the
 * test's `release` file. The marker files sit beside the journal, never in it: a test connection racing the pool's
 * writers for the journal's lock would fail with `database is locked`.
 */
async function step(directory: string, name: string, hold: HoldPoint, signal?: AbortSignal): Promise<boolean> {
	appendFileSync(join(directory, "steps.log"), `${name} ${process.pid}\n`);
	if (hold !== name) return true;
	writeFileSync(join(directory, `holding-${name}`), String(process.pid));
	while (!existsSync(join(directory, "release"))) {
		if (signal?.aborted) return false;
		await delay(20);
	}
	return true;
}

/**
 * A pooled child whose agent stage follows a tool and is followed by another (#4888): `start`, the stage `agent`'s
 * call, then `finish`. Each step logs the pid that ran it to `steps.log`, so a test tells a replayed step from a re-run one.
 */
export const child = workflow({
	name: "pool-tool-stage-child",
	description: "A tool, an agent stage, then a tool that can hold",
	inputs: { directory: Type.String(), hold: Type.String(), intercom: Type.Boolean() },
	outputs: { reply: Type.String(), finishPid: Type.Number() },
	async run(ctx) {
		const { directory } = ctx.inputs;
		const hold = ctx.inputs.hold as HoldPoint;
		const options = await poolStageOptions(directory, false, 0);
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
				const message = {
					role: "assistant" as const,
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: [{ type: "text" as const, text: `agent ${process.pid}` }],
					stopReason: "stop" as const,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				void (async () => {
					if (!(await step(directory, "turn", hold, streamOptions?.signal))) {
						stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
					} else stream.push({ type: "done", reason: "stop", message });
					stream.end();
				})();
				return stream;
			},
		});
		// The stage is created before `start`, and only its call follows it: the stage's recorded parent is `start`, which
		// replays after the stage does (#4888).
		const builtins = { ...options.builtins, intercom: ctx.inputs.intercom };
		const agent = ctx.stage("agent", { ...options, builtins } as never);
		await ctx.tool("start", {}, async () => {
			await step(directory, "start", hold);
			return process.pid;
		});
		const reply = await agent.complete("Reply");
		const finishPid = await ctx.tool("finish", {}, async () => {
			await step(directory, "finish", hold);
			return process.pid;
		});
		return { reply, finishPid };
	},
});
