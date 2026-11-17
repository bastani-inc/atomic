import { test } from "vitest";
import { killWhileEvictedAndResume, STAGES } from "../helpers/waiting-stage-restart.js";

/**
 * Killing the root while its run is evicted from memory with every stage waiting (#4373).
 * Shared fixtures and what each scenario checks: test/helpers/waiting-stage-restart.ts.
 */
const WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS = 60_000;
const PROCESS_RESTART_TIMEOUT_MS = 3 * WORKFLOW_CHILD_STARTUP_AND_CHECKPOINT_TIMEOUT_MS;

for (const runtime of ["node", "bun"] as const) {
	test(
		`${runtime}: killing the root while its run is evicted with ${STAGES} stages waiting resumes every stage without prompting again (#4373)`,
		() => killWhileEvictedAndResume(runtime, "evict"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
	test(
		`${runtime}: killing the root while its evicted stages wait on a tool after an earlier prompt answers that prompt from the record and continues the waiting turn (#4373)`,
		() => killWhileEvictedAndResume(runtime, "turns"),
		PROCESS_RESTART_TIMEOUT_MS,
	);
}
