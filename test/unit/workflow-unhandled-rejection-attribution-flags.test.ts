import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	REAL_CHILD_TIMEOUT_MS,
	RUNTIMES,
	report,
	runFixture,
} from "../helpers/workflow-unhandled-rejection-attribution.js";

/**
 * The runtime's `--unhandled-rejections` mode still decides what an unrelated rejection does once the engine contained
 * a run's own (#3846). Split from workflow-unhandled-rejection-attribution-concurrency.test.ts so their child processes
 * run in parallel.
 */
for (const runtime of RUNTIMES) {
	describe(`workflow unhandled rejection attribution on ${runtime.name}`, () => {
		test(
			"--unhandled-rejections on the command line wins over NODE_OPTIONS for an unrelated rejection (#3846)",
			() => {
				const outcome = runFixture(
					runtime,
					["tool-string", "tolerant", "unrelated"],
					["--unhandled-rejections=throw"],
					{ NODE_OPTIONS: "--unhandled-rejections=warn" },
				);
				assert.equal(outcome.exitCode, 1, `${outcome.stdout}\n${outcome.stderr}`);
				assert.match(outcome.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections=warn keeps an unrelated rejection non-fatal and reports it (#3846)",
			() => {
				const outcome = runFixture(
					runtime,
					["tool-string", "tolerant", "unrelated"],
					["--unhandled-rejections=warn"],
				);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.equal(report(outcome).status, "failed");
				assert.match(outcome.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections=none keeps an unrelated rejection non-fatal and silent (#3846)",
			() => {
				const outcome = runFixture(
					runtime,
					["tool-string", "tolerant", "unrelated"],
					["--unhandled-rejections=none"],
				);
				assert.equal(outcome.exitCode, 0, `${outcome.stdout}\n${outcome.stderr}`);
				assert.equal(report(outcome).status, "failed");
				assert.doesNotMatch(outcome.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);

		test(
			"--unhandled-rejections=warn-with-error-code sets the error code for an unrelated rejection only (#3846)",
			() => {
				const flags = ["--unhandled-rejections=warn-with-error-code"];
				const contained = runFixture(runtime, ["tool-string", "tolerant"], flags);
				assert.equal(contained.exitCode, 0, `${contained.stdout}\n${contained.stderr}`);
				assert.equal(report(contained).status, "failed");
				const unrelated = runFixture(runtime, ["tool-string", "tolerant", "unrelated"], flags);
				assert.equal(unrelated.exitCode, 1, `${unrelated.stdout}\n${unrelated.stderr}`);
				assert.match(unrelated.stderr, /unrelated engine bug/);
			},
			REAL_CHILD_TIMEOUT_MS,
		);
	});
}
