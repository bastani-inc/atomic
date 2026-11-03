import { describe, test } from "vitest";
import {
	assertStopped,
	KILLED,
	REAL_CHILD_TIMEOUT_MS,
	RUNTIMES,
	runFixture,
} from "../helpers/workflow-stop-reason-containment.js";

/**
 * A dropped pool branch's ctx call does not end the process when its run was stopped some other way: by the background
 * runner, through its parent, by the caller's abort, or by a ctx.exit while it was paused (#3846). Split from
 * workflow-stop-reason-containment.test.ts so their child processes run in parallel.
 */
for (const runtime of RUNTIMES) {
	describe(`stopped workflow runs with dropped pool branches on ${runtime.name}`, () => {
		test(
			"a pool branch waiting on ctx.ui when the background runner kills the run does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["kill-detached", "ui", "before"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.stage after a kill through the background runner does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["kill-detached", "stage", "after"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a child workflow pool branch calling ctx.stage after its parent was killed does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["kill-nested", "stage", "after"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.stage after the caller aborted the run does not end the process (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["caller-abort", "stage", "after"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.exit while the run is paused ends the run as exited once it resumes (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["paused-exit", "exit", "during"]), {
					status: "completed",
					inspected: "completed",
					exitReason: "pool finished early",
					exited: true,
				});
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a pool branch calling ctx.exit while the run is paused does not turn a later kill into a failure (#3846)",
			() => {
				assertStopped(runFixture(runtime, ["paused-exit-then-kill", "exit", "during"]), KILLED);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
