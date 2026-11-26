import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildReport, renderMarkdown, suiteResult } from "../distributed/harness/report.mjs";

const resume = { name: "resume", file: "test/distributed/scenarios/resume.test.ts", action: "run" as const };
const vitestReport = {
	testResults: [
		{
			name: "/repo/test/distributed/scenarios/resume.test.ts",
			status: "failed",
			assertionResults: [
				{ fullName: "resume opens on node C", status: "passed", duration: 1200.4 },
				{
					fullName: "resume restores on node B",
					status: "failed",
					duration: 800,
					failureMessages: [
						"\u001b[31mAssertionError\u001b[39m: refused for atomic_runtime:s3cr3t-password\n    at x",
					],
				},
			],
		},
	],
};

describe("distributed run report", () => {
	test("a suite's result lists its tests, with failures uncoloured and the run's secrets redacted", () => {
		const result = suiteResult(resume, vitestReport, ["s3cr3t-password"]);
		assert.equal(result.status, "failed");
		assert.equal(result.durationMs, 2000);
		assert.deepEqual(result.tests[1], {
			name: "resume restores on node B",
			status: "failed",
			durationMs: 800,
			failure: "AssertionError: refused for atomic_runtime:[redacted]\n    at x",
		});
	});

	test("a suite the plan skipped says why, and one the run never reached counts as not run", () => {
		assert.deepEqual(suiteResult({ ...resume, action: "skip", reason: "no replica" }, undefined, []), {
			name: "resume",
			status: "skipped",
			reason: "no replica",
			durationMs: 0,
			tests: [],
		});
		assert.equal(suiteResult(resume, { testResults: [] }, []).status, "not-run");
	});

	test("a run passes only when no suite failed or went unrun and teardown removed everything", () => {
		const passed = suiteResult(
			resume,
			{
				testResults: [
					{
						...vitestReport.testResults[0]!,
						status: "passed",
						assertionResults: [{ fullName: "ok", status: "passed", duration: 1 }],
					},
				],
			},
			[],
		);
		const base = {
			runId: "20261126-100000-ab12",
			commit: "abc123",
			startedAt: "2026-11-26T10:00:00.000Z",
			finishedAt: "2026-11-26T10:30:00.000Z",
			options: { seed: 7 },
			faultOrder: [],
			events: [],
		};
		assert.equal(buildReport({ ...base, suites: [passed], teardown: { status: "removed" } }).status, "passed");
		assert.equal(buildReport({ ...base, suites: [passed], teardown: { status: "kept" } }).status, "passed");
		assert.equal(buildReport({ ...base, suites: [passed], teardown: { status: "failed" } }).status, "failed");
		assert.equal(
			buildReport({ ...base, suites: [passed, suiteResult(resume, undefined, [])], teardown: { status: "removed" } })
				.status,
			"failed",
		);
	});

	test("the Markdown report leads with the outcome, then each suite, each failure and each fault", () => {
		const report = buildReport({
			runId: "20261126-100000-ab12",
			commit: "abc123",
			startedAt: "2026-11-26T10:00:00.000Z",
			finishedAt: "2026-11-26T10:30:00.000Z",
			options: { seed: 7 },
			faultOrder: ["primary-pause"],
			suites: [suiteResult(resume, vitestReport, [])],
			events: [
				{
					at: "2026-11-26T10:10:00.000Z",
					scenario: "faults",
					fault: "primary-pause",
					service: "primary",
					phase: "start",
				},
				{ at: "2026-11-26T10:10:01.000Z", scenario: "faults", event: "traffic" },
			],
			teardown: { status: "removed" },
		});
		const markdown = renderMarkdown(report);
		assert.match(markdown, /^# Distributed tests: failed\n/);
		assert.match(markdown, /\| resume \| failed \| 2\.0 s \|/);
		assert.match(markdown, /### resume restores on node B\n\n```text\nAssertionError: refused/);
		assert.match(markdown, /Fault order: primary-pause\./);
		assert.match(markdown, /\| 2026-11-26T10:10:00\.000Z \| faults \| primary-pause \| primary \| start \|/);
		assert.doesNotMatch(markdown, /traffic/);
		assert.match(markdown, /Teardown: removed/);
	});
});
