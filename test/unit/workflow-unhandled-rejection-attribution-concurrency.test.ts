import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { assertContained, RUNTIMES, runFixture } from "../helpers/workflow-unhandled-rejection-attribution.js";

/** Structural: each case starts a real Node or Bun child process that loads the workflow engine from source. */
const REAL_CHILD_TIMEOUT_MS = 120_000;

/**
 * An unhandled rejection fails only the run it belongs to while other runs (child workflows, a concurrent run of the
 * same or another module, a run that caught the same error) go on (#3846).
 */
for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
		test(
			"an error the author throws while child workflows of the same module run fails the parent and cancels the children (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["author-error-during-child", "rolling"]));
				assert.equal(reported.error, "author error while child runs");
				const parent = reported.runs?.find((entry) => entry.workflow === "parent-of-slow-child");
				const child = reported.runs?.find((entry) => entry.workflow === "slow-child");
				assert.equal(parent?.error, "author error while child runs");
				assert.equal(child?.status, "killed");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an unhandled rejection fails its run while the body is still waiting on a child workflow (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["dropped-error-while-waiting", "rolling"]));
				assert.equal(reported.error, "dropped while the body waits");
				assert.equal(reported.runs?.find((entry) => entry.workflow === "stalled-child")?.status, "killed");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a shared adapter error one run caught and another dropped fails only the run that dropped it (#3846)",
			() => {
				const reported = assertContained(
					runFixture(runtime, ["shared-error-dropped", "rolling", "shared-catcher"]),
				);
				assert.equal(reported.error, "shared prompt adapter error");
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a failing ctx call in a pool leaves a concurrent run from the same module untouched (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["tool-foreign-error", "tolerant", "same-module"]));
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a failing pool leaves a concurrent run in another module untouched (#3846)",
			() => {
				const reported = assertContained(
					runFixture(runtime, ["author-error-after-workflow", "rolling", "healthy"]),
				);
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
