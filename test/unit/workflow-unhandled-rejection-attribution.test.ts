import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { assertContained, RUNTIMES, runFixture } from "../helpers/workflow-unhandled-rejection-attribution.js";

/** Structural: each case starts a real Node or Bun child process that loads the workflow engine from source. */
const REAL_CHILD_TIMEOUT_MS = 120_000;

/** A ctx call's rejection that a pool fork leaves unhandled fails its run, not the process (#3846). */
for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
		for (const [failure, reason] of [
			["tool-string", /boom-string/],
			["tool-undefined", /undefined/],
			["tool-number", /4242/],
		] as const) {
			test(
				`a ctx.tool rejecting with ${failure} left unhandled by a pool fork fails its run instead of the process (#3846)`,
				() => {
					const reported = assertContained(runFixture(runtime, [failure, "tolerant"]));
					assert.match(reported.error ?? "", reason);
				},
				REAL_CHILD_TIMEOUT_MS,
			);
		}

		test(
			"a ctx.tool rejecting with an error from another module left unhandled by a pool fork fails its run (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["tool-foreign-error", "tolerant"]));
				assert.match(reported.error ?? "", /tool failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a ctx.task rejection left unhandled by a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["task-rejects", "tolerant"]));
				assert.match(reported.error ?? "", /prompt failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"a stage prompt rejection left unhandled by a pool fork fails its run instead of the process (#3846)",
			() => {
				const reported = assertContained(runFixture(runtime, ["stage-rejects", "tolerant"]));
				assert.match(reported.error ?? "", /prompt failed outside the workflow module/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
