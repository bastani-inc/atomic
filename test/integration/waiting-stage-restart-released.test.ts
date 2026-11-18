import { test } from "vitest";
import { killAndResume, killAndResumeBetweenTurns, STAGES } from "../helpers/waiting-stage-restart.js";

/**
 * Killing the root while every stage waits released: on its call, after `stage.release()`, or by the idle scan
 * (#4309).
 * Shared fixtures and what each scenario checks: test/helpers/waiting-stage-restart.ts.
 */
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime}: killing the root while ${STAGES} stages wait released and resuming continues every stage without prompting again (#4309, #5539)`,
		() => killAndResume(runtime, "wait"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: killing the root while ${STAGES} stages wait after stage.release() resumes them without prompting again, and their next message reopens the saved session (#4309)`,
		() => killAndResumeBetweenTurns(runtime, "release"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: killing the root while ${STAGES} held stages wait released by the idle scan resumes them without sending any prompt (#4309)`,
		() => killAndResumeBetweenTurns(runtime, "idle"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
}
