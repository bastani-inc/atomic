import { test } from "vitest";
import { killAndResume, killAndResumeFinishedTurns, STAGES } from "../helpers/waiting-stage-restart.js";

/**
 * Killing the root once every stage has the model's answer or its call's result, before the run records it
 * (#4375, #4309).
 * Shared fixtures and what each scenario checks: test/helpers/waiting-stage-restart.ts.
 */
// Two cold source loads, 20 stages' checkpoint/recovery work, and broker/directory cleanup (see the shared helper).
const WORKFLOW_MODULE_LOAD_TIMEOUT_MS = 120_000;
const WORKFLOW_CHECKPOINT_TIMEOUT_MS = 20_000;
const RESTART_CLEANUP_HEADROOM_MS = 20_000;
const PROCESS_RESTART_TIMEOUT_MS =
	2 * WORKFLOW_MODULE_LOAD_TIMEOUT_MS + WORKFLOW_CHECKPOINT_TIMEOUT_MS + RESTART_CLEANUP_HEADROOM_MS;

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime}: killing the root after ${STAGES} stages got the model's final answer but before they recorded their completion finishes every stage from its transcript without another model call (#4375)`,
		() => killAndResumeFinishedTurns(runtime),
		PROCESS_RESTART_TIMEOUT_MS,
	);
}

test(
	`node: killing the root after ${STAGES} stages recorded their results but before the model answered continues every turn without prompting or dispatching again (#4309)`,
	() => killAndResume("node", "answer"),
	PROCESS_RESTART_TIMEOUT_MS,
);
