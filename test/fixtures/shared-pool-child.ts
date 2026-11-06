import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { GitUnavailableError, WorkflowGitRequiredError, workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";
import { processIdentity } from "./process-instance.js";

/** The "host" a shared-pool fixture process stands in for; every process a host starts inherits it. */
function host(): string {
	return process.env.SHARED_POOL_HOST ?? "unknown";
}

/** Waits until children on `hosts` distinct hosts have arrived, so the fan-out demonstrably spans them. */
async function awaitHosts(directory: string, index: number, hosts: number): Promise<void> {
	writeFileSync(join(directory, `arrived-${host()}-${index}`), "");
	const deadline = Date.now() + 120_000;
	for (;;) {
		const arrived = new Set(
			readdirSync(directory)
				.filter((name) => name.startsWith("arrived-"))
				.map((name) => name.split("-")[1]),
		);
		if (arrived.size >= hosts) return;
		if (Date.now() >= deadline) throw new Error(`Only ${[...arrived].join(", ")} arrived at the fan-out barrier`);
		await delay(20);
	}
}

export const sharedChild = workflow({
	name: "shared-pool-child",
	description: "A pooled child that records which host ran each of its steps (#4310)",
	inputs: { directory: Type.String(), index: Type.Number(), hosts: Type.Number() },
	outputs: {
		firstHost: Type.String(),
		firstInstance: Type.String(),
		finalHost: Type.String(),
		finalInstance: Type.String(),
		stageReply: Type.String(),
	},
	async run(ctx) {
		const first = await ctx.tool("first", {}, async () => ({ ...processIdentity(), host: host() }));
		await ctx.tool("barrier", {}, async () => {
			await awaitHosts(ctx.inputs.directory, ctx.inputs.index, ctx.inputs.hosts);
			return true;
		});
		const stage = ctx.stage("agent", (await poolStageOptions(ctx.cwd ?? process.cwd(), false, "never")) as never);
		const stageReply = await stage.complete("Reply with your PID.");
		const final = await ctx.tool("final", {}, async () => {
			writeFileSync(join(ctx.inputs.directory, `started-${host()}-${ctx.inputs.index}-${process.pid}`), "");
			while (!existsSync(join(ctx.inputs.directory, "release"))) await delay(20);
			return { ...processIdentity(), host: host() };
		});
		return {
			firstHost: first.host,
			firstInstance: first.instance,
			finalHost: final.host,
			finalInstance: final.instance,
			stageReply: String(stageReply),
		};
	},
});

/** A bound child: it reports the directory it ran in, which placement chose, and the root's answer to its prompt (#4310). */
export const boundChild = workflow({
	name: "shared-pool-bound-child",
	description: "A pooled child bound to a workspace",
	inputs: {},
	outputs: { host: Type.String(), cwd: Type.String(), answer: Type.String() },
	async run(ctx) {
		const stage = ctx.stage("agent", (await poolStageOptions(ctx.cwd ?? process.cwd(), false, "never")) as never);
		await stage.complete("Reply with your PID.");
		// Answered by the root, on whichever host this child runs.
		const answer = await ctx.ui.input("Which branch should the worker use?");
		const where = await ctx.tool("where", {}, async () => ({ host: host(), cwd: ctx.cwd ?? process.cwd() }));
		return { ...where, answer: String(answer) };
	},
});

/**
 * A child for a pool spread over machines, which share no directory: it records which host ran each step, and works
 * for `workMs` between its first and last steps, so faults can land mid-run.
 */
export const distributedChild = workflow({
	name: "shared-pool-distributed-child",
	description: "A pooled child that records which host ran each of its steps, across machines (#4310)",
	inputs: { index: Type.Number(), workMs: Type.Number() },
	outputs: {
		firstHost: Type.String(),
		firstInstance: Type.String(),
		finalHost: Type.String(),
		finalInstance: Type.String(),
	},
	async run(ctx) {
		const first = await ctx.tool("first", { index: ctx.inputs.index }, async () => ({ ...processIdentity(), host: host() }));
		const stage = ctx.stage("agent", (await poolStageOptions(ctx.cwd ?? process.cwd(), false, "never")) as never);
		await stage.complete("Reply with your PID.");
		await ctx.tool("work", { index: ctx.inputs.index }, async () => {
			await delay(ctx.inputs.workMs);
			return host();
		});
		const final = await ctx.tool("final", { index: ctx.inputs.index }, async () => ({ ...processIdentity(), host: host() }));
		return {
			firstHost: first.host,
			firstInstance: first.instance,
			finalHost: final.host,
			finalInstance: final.instance,
		};
	},
});

/**
 * A bound child that fails where it runs because that host has no git: a WorkflowGitRequiredError whose worktree names
 * the host, with its GitUnavailableError cause, so the root can tell the typed failure crossed from that host (#4378).
 */
export const typedFailureChild = workflow({
	name: "shared-pool-typed-failure-child",
	description: "A pooled child that fails typed on the host that runs it",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.tool("worktree", {}, async () => {
			throw new WorkflowGitRequiredError(
				{
					workflow: "shared-pool-typed-failure-child",
					runId: "typed-child",
					source: "input",
					field: "worktree",
					gitWorktreeDir: `/worktrees/${host()}`,
				},
				new GitUnavailableError({ code: "offline", offlineVariable: "ATOMIC_OFFLINE", platform: "linux", arch: "x64" }),
			);
		});
		return {};
	},
});
