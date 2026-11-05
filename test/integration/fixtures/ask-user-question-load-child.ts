/**
 * Pooled child workflow for the ask_user_question load scenario (#4333).
 *
 * `scripts/e2e/ask-user-question-load-evidence.sh` copies this file next to the scratch project and lists it under
 * `workflows.localWorkers.definitions`, so each pool worker imports it by path and runs it as a first-level child of
 * `ask-user-question-load-workflow.ts`. It has to stay a module of its own that exports `child`: a worker re-imports
 * its entry module, and a closure inside the root's file cannot cross the process boundary.
 *
 * One agent stage streams from the stand-in endpoint (`ask-user-question-load-model-server.ts`), which keeps stage
 * events, journal writes and pool coordination flowing while the dialog is in use.
 */

import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export const child = workflow({
	name: "ask-user-question-load-child",
	description: "One streaming agent stage, run on a local pool worker.",
	inputs: { index: Type.Number() },
	outputs: {},
	run: async (ctx) => {
		await ctx.stage(`stream-${ctx.inputs.index}`).prompt(`AQ-LOAD-STREAM pooled child ${ctx.inputs.index}`);
		return {};
	},
});
