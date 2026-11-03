import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { assertStopped, QUIT, RUNTIMES, runFixture } from "../helpers/workflow-stop-reason-containment.js";

/** Structural: each case starts a real Node or Bun child process that loads the workflow engine from source. */
const REAL_CHILD_TIMEOUT_MS = 120_000;

/** A dropped pool branch's ctx call after `/workflow quit` paused its run does not end the process (#3846). */
for (const runtime of RUNTIMES) {
	describe(`stopped workflow runs with dropped pool branches on ${runtime.name}`, () => {
		for (const call of ["stage", "task", "workflow"]) {
			test(
				`a pool branch calling ctx.${call} after /workflow quit paused the run does not end the process (#3846)`,
				() => {
					assertStopped(runFixture(runtime, ["quit", call, "after"]), QUIT);
				},
				REAL_CHILD_TIMEOUT_MS,
			);
		}
		test(
			"a pool branch calling ctx.stage long after /workflow quit paused the run does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["quit", "stage", "late"]), QUIT);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.stage while /workflow quit is still settling does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["quit", "stage", "during"]), QUIT);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a quit pool leaves a concurrent healthy run completed (#3846)",
			() => {
				const reported = assertStopped(runFixture(runtime, ["quit", "stage", "after", "healthy"]), QUIT);
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
