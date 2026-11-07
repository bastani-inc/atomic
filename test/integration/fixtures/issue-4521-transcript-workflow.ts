/**
 * Project workflow fixture for the issue #4521 terminal scenario (scripts/e2e/issue-4521-evidence.sh).
 *
 * One stage whose stand-in model (issue-4521-transcript-provider.ts) answers with a thinking block, a tool call
 * with sixty lines of output and a 150-line reply, then holds the stage open in a long tool call so its chat
 * stays live while the scenario scrolls it.
 */

import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "issue-4521-transcript-stage",
	description: "A live stage with a long transcript, for the issue #4521 scrolling scenario.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("viewer").prompt("STAGE_TASK_4521: answer at length");
		return {};
	},
});
