/**
 * Project workflow fixture for stage-output-transcript terminal evidence.
 *
 * The stage's file-only prompt returns a receipt as the workflow result, so a
 * real `/workflow status <runId>` command renders the exact receipt a downstream
 * file-only consumer receives. The model endpoint and evidence extension supply
 * the deliverable/late-notification sequence. The workflow also writes the exact
 * returned receipt to an evidence-only state file so a CLI extension command can
 * render it without the run-detail panel's deliberate width truncation.
 */

import { writeFile } from "node:fs/promises";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
export default workflow({
	name: "stage-output-transcript-e2e",
	description: "Real terminal evidence for nominated stage output and companion transcript.",
	inputs: {},
	outputs: { receipt: Type.String() },
	run: async (ctx) => {
		const receipt = await ctx.stage("output-stage").prompt("Produce the complete stage deliverable.", {
			output: "stage-output.md",
			outputMode: "file-only",
		});
		const receiptPath = process.env.STAGE_OUTPUT_TRANSCRIPT_RECEIPT_STATE;
		if (receiptPath) await writeFile(receiptPath, receipt, "utf8");
		return { receipt };
	},
});
