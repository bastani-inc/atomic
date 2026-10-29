import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

/**
 * Names this process. A pid cannot: an operating system may hand a dead process's pid to its replacement (Windows does
 * so within moments), while a fresh worker process always draws a fresh instance id when it loads this module.
 */
const instance = randomUUID();

export const child = workflow({
	name: "pool-lifecycle-child",
	description: "Waits at a tool boundary for coordinator lifecycle tests",
	inputs: { releasePath: Type.String() },
	outputs: {
		firstPid: Type.Number(),
		finalPid: Type.Number(),
		firstInstance: Type.String(),
		finalInstance: Type.String(),
	},
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => ({ pid: process.pid, instance }));
		const final = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return { pid: process.pid, instance };
		});
		return {
			firstPid: first.pid,
			finalPid: final.pid,
			firstInstance: first.instance,
			finalInstance: final.instance,
		};
	},
});
