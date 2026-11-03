import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	assertContained,
	REAL_CHILD_TIMEOUT_MS,
	RUNTIMES,
	type Runtime,
	report,
	runFixture,
} from "../helpers/workflow-unhandled-rejection-attribution.js";

const [NODE, BUN] = RUNTIMES;

describe("workflow unhandled rejection attribution through async context", () => {
	test(
		"a string the author throws after ctx.workflow in a pool fork fails its run on a runtime that exposes async context (#3846)",
		() => {
			const reported = assertContained(runFixture(NODE as Runtime, ["author-string-after-workflow", "rolling"]));
			assert.match(reported.error ?? "", /author string after child/);
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"a failing pool leaves a concurrent run from the same module untouched where async context identifies the run (#3846)",
		() => {
			const reported = assertContained(
				runFixture(NODE as Runtime, ["author-string-after-workflow", "rolling", "same-module"]),
			);
			assert.deepEqual(reported.healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"a shared adapter error one run caught fails only the run whose dropped fork rethrew it where async context identifies the run (#3846)",
		() => {
			const reported = assertContained(
				runFixture(NODE as Runtime, ["shared-error-dropped-in-fork", "rolling", "shared-catcher"]),
			);
			assert.deepEqual(reported.healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"an error an ended run's fire-and-forget function throws leaves the next run from the same module untouched where async context identifies the run (#3846)",
		() => {
			const outcome = runFixture(NODE as Runtime, ["late-author-error", "rolling", "sequential-same-module"]);
			assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
			assert.deepEqual(report(outcome).healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);

	test(
		"an error an ended run's fire-and-forget function throws leaves a concurrent run from the same module untouched where async context identifies the run (#3846)",
		() => {
			const outcome = runFixture(NODE as Runtime, ["late-author-error", "rolling", "same-module"]);
			assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
			assert.deepEqual(report(outcome).healthy, { status: "completed" });
		},
		REAL_CHILD_TIMEOUT_MS,
	);
});

describe("workflow unhandled rejection attribution when two runs of one module could have thrown the error", () => {
	for (const [failure, poolStyle, companion] of [
		["late-author-error", "rolling", "same-module"],
		["author-error-after-workflow", "tolerant", "same-module"],
		["late-author-error", "rolling", "sequential-same-module"],
	] as const) {
		test(
			`an author error from ${failure} fails neither ${companion === "same-module" ? "run of the same module" : "its run nor the next run of the same module"} and is handed back to the runtime (#3846)`,
			() => {
				const outcome = runFixture(
					BUN as Runtime,
					[failure, poolStyle, companion],
					["--unhandled-rejections=warn"],
				);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.deepEqual(report(outcome).healthy, { status: "completed" });
				assert.match(outcome.stderr, /author error/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	}
});
