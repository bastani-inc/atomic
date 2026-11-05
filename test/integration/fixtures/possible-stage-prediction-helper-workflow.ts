/**
 * Project workflow fixture for the #4359 predicted-stage scenario.
 *
 * Its stage names come from a helper, so the launch scan cannot read them and the decision model predicts them from
 * candidates in this source. `scripts/e2e/possible-stage-prediction-evidence.sh predicted` copies it into a scratch
 * project's `.atomic/workflows/`; the stand-in endpoint holds `review-1` open so the run stays live.
 */

import { workflow } from "@bastani/atomic/workflows";

function stageName(kind: string, round: number): string {
	return `${kind}-${round}`;
}

export default workflow({
	name: "prediction-e2e-helper",
	description: "Reviews, then summarizes, under helper-built stage names.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.task(stageName("review", 1), { prompt: "PREDICTION-E2E-STAGE: review the change" });
		await ctx.task(stageName("summary", 2), { prompt: "PREDICTION-E2E-STAGE: summarize the review" });
		return {};
	},
});
