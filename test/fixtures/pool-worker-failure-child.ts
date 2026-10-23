import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

const UNANSWERED_REQUESTS = 3;

async function waitFor(path: string): Promise<void> {
	while (!existsSync(path)) await delay(20);
}

export const unansweredChild = workflow({
	name: "unanswered-pool-child",
	description: "Dies after sending requests the root has not answered",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("checkpoint", {}, async () => process.pid);
		const finalPid = await ctx.tool("die", {}, async () => {
			const dying = join(ctx.inputs.directory, "dying");
			if (existsSync(dying)) return process.pid;
			writeFileSync(dying, String(process.pid));
			await waitFor(join(ctx.inputs.directory, "go"));
			for (let index = 1; index <= UNANSWERED_REQUESTS; index++) {
				const request = { id: 1_000_000 + index, kind: "unanswerable" };
				if (index < UNANSWERED_REQUESTS) process.send?.(request);
				else process.send?.(request, () => process.kill(process.pid, "SIGKILL"));
			}
			return new Promise<number>(() => {});
		});
		return { firstPid, finalPid };
	},
});

export const releasedChild = workflow({
	name: "released-pool-child",
	description: "Waits for a release file after a committed checkpoint",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const firstPid = await ctx.tool("checkpoint", {}, async () => process.pid);
		const finalPid = await ctx.tool("wait", {}, async () => {
			writeFileSync(join(ctx.inputs.directory, `started-${ctx.inputs.index}`), String(process.pid));
			await waitFor(join(ctx.inputs.directory, "release"));
			return process.pid;
		});
		return { firstPid, finalPid };
	},
});
