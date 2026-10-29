import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";
import { processIdentity, processInstance } from "./process-instance.js";

const leaf = workflow({
	name: "pool-leaf", description: "", inputs: {}, outputs: { pid: Type.Number() },
	async run(ctx) { return { pid: await ctx.tool("leaf", {}, async () => process.pid) }; },
});

async function awaitFanOut(path: string) {
	const database = new TestSqliteDatabase(path);
	database.run("PRAGMA query_only=ON");
	const deadline = Date.now() + 30_000;
	try {
		while (Number(database.query("SELECT COUNT(*) AS count FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'").get()!.count) < 2) {
			if (Date.now() >= deadline) throw new Error("Fan-out checkpoint barrier timed out");
			await delay(20);
		}
	} finally { database.close(); }
}

export const child = workflow({
	name: "pool-child",
	description: "Local worker execution fixture",
	inputs: { crash: Type.Boolean(), during: Type.Boolean(), journalPath: Type.String() },
	outputs: {
		firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String(),
		stagePid: Type.String(), leafPid: Type.Number(),
	},
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => processIdentity());
		await awaitFanOut(ctx.inputs.journalPath);
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), ctx.inputs.crash && ctx.inputs.during, first.instance) as never);
		const stagePid = await stage.complete("Reply with your PID.");
		const nested = await ctx.workflow(leaf);
		const final = await ctx.tool("finish", {}, async () => {
			if (ctx.inputs.crash && !ctx.inputs.during && first.instance === processInstance) process.kill(process.pid, "SIGKILL");
			return processIdentity();
		});
		return {
			firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance,
			stagePid, leafPid: nested.outputs.pid!,
		};
	},
});

export const stalledChild = workflow({
	name: "stalled-pool-child",
	description: "Stops renewing after a committed checkpoint",
	inputs: {},
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => processIdentity());
		if (first.instance === processInstance) process.kill(process.pid, "SIGSTOP");
		const final = await ctx.tool("finish", {}, async () => processIdentity());
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});

function withholdUsageReports() {
	const send = process.send?.bind(process);
	if (!send) throw new Error("Usage report barrier requires a worker IPC channel");
	process.send = ((message: { kind?: string; id?: number }, ...rest: unknown[]) => {
		if (message?.kind !== "usage") return (send as (...args: unknown[]) => boolean)(message, ...rest);
		const callback = rest.find((entry) => typeof entry === "function") as ((error: null) => void) | undefined;
		queueMicrotask(() => {
			callback?.(null);
			process.emit("message", { id: message.id, value: undefined } as never, undefined as never);
		});
		return true;
	}) as typeof process.send;
}

export const billedCrashChild = workflow({
	name: "billed-crash-child",
	description: "Dies after a billed stage checkpoint commits; the first process never delivers a usage report",
	inputs: {},
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => processIdentity());
		if (first.instance === processInstance) withholdUsageReports();
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), false, first.instance) as never);
		await stage.complete("Reply with your PID.");
		const final = await ctx.tool("finish", {}, async () => {
			if (first.instance === processInstance) process.kill(process.pid, "SIGKILL");
			return processIdentity();
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
