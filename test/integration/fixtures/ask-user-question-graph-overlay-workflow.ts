/**
 * Project workflow fixture for the graph-viewer `ask_user_question` overlay
 * scenario.
 *
 * `scripts/e2e/ask-user-question-graph-overlay-evidence.sh` copies this file
 * into a scratch project's `.atomic/workflows/` and lets the real Atomic CLI
 * discover it, so it has to stay self-contained: no relative imports survive
 * the copy.
 *
 * One agent stage, one prompt. The stand-in model endpoint
 * (`ask-user-question-graph-overlay-model-server.ts`) answers that prompt with
 * a real `ask_user_question` tool call, so the stage blocks on a questionnaire
 * mounted through the stage UI broker — the overlay path the workflow graph
 * viewer used to reject outright.
 */

import { workflow } from "@bastani/workflows";

export default workflow({
	name: "ask-user-question-graph-overlay",
	description: "Single stage that asks the user a question so the graph viewer has to mount an overlay custom UI.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		// The marker identifies this turn to the stand-in model endpoint, which
		// shares the session with the main chat and answers only this prompt with
		// the `ask_user_question` tool call.
		await ctx.stage("asking").prompt("GRAPH-OVERLAY-STAGE-PROMPT: ask the user which option to take");
		return {};
	},
});
