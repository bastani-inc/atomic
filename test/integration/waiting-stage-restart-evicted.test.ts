import { test } from "vitest";
import { killWhileEvictedAndResume, STAGES } from "../helpers/waiting-stage-restart.js";

/**
 * Killing the root while its run is evicted from memory with every stage waiting (#4373).
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
