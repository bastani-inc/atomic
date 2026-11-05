/**
 * Pooled root workflow for the ask_user_question load scenario (#4333).
 *
 * `scripts/e2e/ask-user-question-load-evidence.sh` copies this file into a scratch project's `.atomic/workflows/`, so
 * it stays self-contained. The script also sets `workflows.localWorkers` in the scratch agent settings, with the
 * module `ask-user-question-load-child.ts` as the worker definition, and passes that module's absolute path in
 * `AQ_LOAD_CHILD_MODULE`. This root loads the child with `loadWorkerWorkflow` and starts `AQ_LOAD_CHILDREN` of them
 * at once; the pool runs as many as it has workers and queues the rest, so children keep starting and finishing for
 * as long as the dialog is in use.
 */

import { loadWorkerWorkflow, workflow } from "@bastani/atomic/workflows";

export default workflow({
	name: "ask-user-question-load-pool",
	description: "Starts many child workflows on the local worker pool while a questionnaire is open.",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		const childModule = process.env.AQ_LOAD_CHILD_MODULE;
		if (childModule === undefined)
			throw new Error("AQ_LOAD_CHILD_MODULE is not set; run this workflow through the load evidence script");
		const children = Number(process.env.AQ_LOAD_CHILDREN ?? 24);
		const child = await loadWorkerWorkflow(childModule, "child");
		await Promise.allSettled(
			Array.from({ length: children }, (_, index) => ctx.workflow(child, { inputs: { index } })),
		);
		return {};
	},
});
