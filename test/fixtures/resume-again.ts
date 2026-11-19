import { appendFileSync } from "node:fs";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

export function resumeAgain(log: string, outcome: string) {
	const child = workflow({
		name: "check-again",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("check", {}, async () => {
				if (outcome === "blocked")
					throw Object.assign(new Error("the queued instruction could not be delivered"), {
						code: "pending_stage_delivery_failed",
					});
				throw new Error("check failed");
			});
			return {};
		},
	});
	return workflow({
		name: "resume-again",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			appendFileSync(log, `${process.pid}\n`);
			await ctx.workflow(child);
			return {};
		},
	});
}
