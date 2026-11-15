import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { processIdentity } from "./process-instance.js";

const UNANSWERED_REQUESTS = 3;

/**
 * Writes a marker the root polls for with its content in place: `writeFileSync` creates the file before it writes,
 * so the root could otherwise find it empty and read the pid as 0.
 */
function writeMarker(path: string, content: string): void {
	writeFileSync(`${path}.partial`, content);
	renameSync(`${path}.partial`, path);
}

async function waitFor(path: string): Promise<void> {
	while (!existsSync(path)) await delay(20);
}

export const unansweredChild = workflow({
	name: "unanswered-pool-child",
	description: "Dies after sending requests the root has not answered",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => processIdentity());
		const final = await ctx.tool("die", {}, async () => {
			const dying = join(ctx.inputs.directory, "dying");
			if (existsSync(dying)) return processIdentity();
			writeMarker(dying, String(process.pid));
			await waitFor(join(ctx.inputs.directory, "go"));
			for (let index = 1; index <= UNANSWERED_REQUESTS; index++) {
				const request = { id: 1_000_000 + index, kind: "unanswerable" };
				if (index < UNANSWERED_REQUESTS) process.send?.(request);
				else process.send?.(request, () => process.kill(process.pid, "SIGKILL"));
			}
			return new Promise<ReturnType<typeof processIdentity>>(() => {});
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});

export const releasedChild = workflow({
	name: "released-pool-child",
	description: "Waits for a release file after a committed checkpoint",
	inputs: { directory: Type.String(), index: Type.Number() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => processIdentity());
		const final = await ctx.tool("wait", {}, async () => {
			writeMarker(join(ctx.inputs.directory, `started-${ctx.inputs.index}`), String(process.pid));
			await waitFor(join(ctx.inputs.directory, "release"));
			return processIdentity();
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
