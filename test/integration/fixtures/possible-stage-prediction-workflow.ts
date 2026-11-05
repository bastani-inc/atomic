/**
 * Project workflow fixture for the #4359 Intercom send scenario.
 *
 * `scripts/e2e/possible-stage-prediction-evidence.sh` copies this file into a scratch project's
 * `.atomic/workflows/` and lets the real Atomic CLI discover it, so it stays self-contained.
 *
 * The stand-in model endpoint (`possible-stage-prediction-model-server.ts`) holds every turn whose prompt carries
 * the stage marker, so `plan` stays running while the main chat sends to the run's future stages.
 */

import { workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "prediction-e2e",
	description: "Plans, then reviews in numbered rounds; the plan stage stays running for the scenario.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.task("plan", { prompt: "PREDICTION-E2E-STAGE: plan the work" });
		for (let round = 1; round <= 2; round += 1) {
			await ctx.task(`review-${round}`, { prompt: `PREDICTION-E2E-STAGE: review round ${round}` });
		}
		return {};
	},
});
