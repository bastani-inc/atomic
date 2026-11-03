import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { RUNTIMES, report, runFixture } from "../helpers/workflow-unhandled-rejection-attribution.js";

/** Structural: each case starts a real Node or Bun child process that loads the workflow engine from source. */
const REAL_CHILD_TIMEOUT_MS = 120_000;

/**
 * A rejection no live run owns (a caught reason repeated later, an author error after the run's grace period, an
 * unrelated rejection after a contained one) is handed back to the runtime, not charged to a run (#3846). Split from
 * workflow-unhandled-rejection-attribution-concurrency.test.ts so their child processes run in parallel.
 */
for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
		test(
			"a primitive reason the author already caught does not fail its run when an unrelated rejection repeats it later (#3846)",
			() => {
				const outcome = runFixture(runtime, ["caught-primitive", "rolling"], ["--unhandled-rejections=warn"]);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.equal(report(outcome).status, "completed");
				assert.match(outcome.stderr, /shared-reason/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an error the author throws after the run ended and its grace period passed ends the process as before (#3846)",
			() => {
				const outcome = runFixture(runtime, ["late-author-error-after-grace", "rolling"]);
				assert.equal(outcome.exitCode, 1, `${outcome.stdout}\n${outcome.stderr}`);
				assert.match(outcome.stderr, /author error after the run ended/);
				assert.doesNotMatch(outcome.stderr, /run-rejection-boundary/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"an unrelated rejection after a contained one still ends the process and reports its own origin (#3846)",
			() => {
				const outcome = runFixture(runtime, ["tool-string", "tolerant", "unrelated"]);
				assert.equal(outcome.exitCode, 1, outcome.stdout);
				assert.equal(report(outcome).status, "failed");
				assert.match(outcome.stderr, /unrelated engine bug/);
				assert.match(outcome.stderr, /workflow-unhandled-rejection-unrelated\.ts:3/);
				assert.doesNotMatch(outcome.stderr, /run-rejection-boundary/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
