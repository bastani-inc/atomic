import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

/** Changes a file of its checkout in one tool, so the tool's checkpoint carries a worktree snapshot (#5077). */
export const snapshotChild = workflow({
	name: "snapshot-pool-child",
	description: "Changes a file of its checkout in one tool, then completes",
	inputs: { content: Type.String() },
	outputs: {},
	async run(ctx) {
		await ctx.tool("edit", {}, async () => {
			writeFileSync(join(ctx.cwd ?? process.cwd(), "a.txt"), ctx.inputs.content);
			return "edited";
		});
		return {};
	},
});
