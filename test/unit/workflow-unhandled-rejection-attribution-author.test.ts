import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	assertContained,
	assertExited,
	REAL_CHILD_TIMEOUT_MS,
	RUNTIMES,
	runFixture,
} from "../helpers/workflow-unhandled-rejection-attribution.js";

/**
 * An error from the author's own code in a pool fork (after a ctx call, from a helper module or a fire-and-forget
 * function), or a ctx.exit there, settles its run and leaves the process running (#3846). Split from
 * workflow-unhandled-rejection-attribution.test.ts so the two halves' child processes run in parallel.
 */
for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
		test(
			"an error the author throws after ctx.workflow in a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["author-error-after-workflow", "rolling"]));
				assert.match(reported.error ?? "", /author error after child/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a direct fs failure after ctx.tool in a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["fs-error-after-tool", "rolling"]));
				assert.match(reported.error ?? "", /ENOENT: no such file or directory, rename/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error from a helper module awaited by a pool fork after ctx.tool fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["helper-error-after-tool", "rolling"]));
				assert.match(reported.error ?? "", /helper failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"ctx.exit called in a pool fork with a dropped finally promise ends the run as exited, not the process (#3846)",
			() => {
				assertExited(runFixture(runtime, ["exit-after-workflow", "rolling"]));
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a child workflow fork that calls ctx.stage after its parent exited does not end the process (#3846)",
			() => {
				const reported = assertExited(runFixture(runtime, ["exit-during-child-fork", "rolling"]));
				assert.equal(reported.runs?.find((entry) => entry.workflow === "forking-child")?.status, "cancelled");
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"ctx.exit called in a pool fork leaves a concurrent run from the same module untouched (#3846)",
			() => {
				const reported = assertExited(runFixture(runtime, ["exit-after-workflow", "rolling", "same-module"]));
				assert.deepEqual(reported.healthy, { status: "completed" });
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error thrown by a fire-and-forget function after the run ended does not terminate the process (#3846)",
			() => {
				const outcome = runFixture(runtime, ["late-author-error", "rolling"]);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
