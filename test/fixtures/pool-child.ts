import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { poolStageOptions } from "./pool-stage-options.js";

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
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), stagePid: Type.String(), leafPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("checkpoint", {}, async () => process.pid);
		await awaitFanOut(ctx.inputs.journalPath);
		const stage = ctx.stage("agent", await poolStageOptions(ctx.cwd ?? process.cwd(), ctx.inputs.crash && ctx.inputs.during, firstPid) as never);
		const stagePid = await stage.complete("Reply with your PID.");
		const nested = await ctx.workflow(leaf);
		const finalPid = await ctx.tool("finish", {}, async () => {
			if (ctx.inputs.crash && !ctx.inputs.during && firstPid === process.pid) process.kill(process.pid, "SIGKILL");
			return process.pid;
		});
		return { firstPid, finalPid, stagePid, leafPid: nested.outputs.pid! };
	},
});

export const stalledChild = workflow({
	name: "stalled-pool-child",
	description: "Stops renewing after a committed checkpoint",
	inputs: {},
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("checkpoint", {}, async () => process.pid);
		if (firstPid === process.pid) process.kill(process.pid, "SIGSTOP");
		const finalPid = await ctx.tool("finish", {}, async () => process.pid);
		return { firstPid, finalPid };
	},
});
