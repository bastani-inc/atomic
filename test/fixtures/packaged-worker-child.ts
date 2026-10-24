import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export const child = workflow({
	name: "packaged-worker-child",
	description: "Commits one checkpoint on a packaged worker and echoes its input",
	inputs: { token: Type.String() },
	outputs: { pid: Type.Number(), parentPid: Type.Number(), token: Type.String() },
	async run(ctx) {
		const pid = await ctx.tool("checkpoint", {}, async () => process.pid);
		return { pid, parentPid: process.ppid, token: ctx.inputs.token };
	},
});
