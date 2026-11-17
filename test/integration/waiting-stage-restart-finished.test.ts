import { test } from "vitest";
import { killAndResume, killAndResumeFinishedTurns, STAGES } from "../helpers/waiting-stage-restart.js";

/**
 * Killing the root once every stage has the model's answer or its call's result, before the run records it
 * (#4375, #4309).
 * Shared fixtures and what each scenario checks: test/helpers/waiting-stage-restart.ts.
 */
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;

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
