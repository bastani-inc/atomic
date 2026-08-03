import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseSubagentNotifyContent } from "../../packages/subagents/src/extension/notification-content.ts";

describe("subagent notification content parsing", () => {
	test("parses generated headers, result text, and session metadata", () => {
		assert.deepEqual(
			parseSubagentNotifyContent(
				[
					"Background task completed: **worker** (1/2)",
					"",
					"first line",
					"second line",
					"",
					"Session file: /tmp/worker.jsonl",
				].join("\n"),
			),
			{
				agent: "worker",
				status: "completed",
				taskInfo: "(1/2)",
				resultPreview: "first line\nsecond line",
				sessionLabel: "session file",
				sessionValue: "/tmp/worker.jsonl",
			},
		);
	});

	test("preserves every status and accepted delimiter text verbatim", () => {
		for (const status of ["completed", "failed", "paused"] as const) {
			assert.deepEqual(
				parseSubagentNotifyContent(`Background task ${status}: **alpha**beta**\t(foo**bar)\n\nresult`),
				{
					agent: "alpha**beta",
					status,
					taskInfo: "(foo**bar)",
					resultPreview: "result",
				},
			);
		}
	});

	test("omits optional fields for a header without task or output", () => {
		assert.deepEqual(parseSubagentNotifyContent("Background task paused: **worker**\n\n"), {
			agent: "worker",
			status: "paused",
			resultPreview: "(no output)",
		});
	});

	test("parses a detached notice label with a known status", () => {
		assert.deepEqual(parseSubagentNotifyContent("Detached subagent task completed: **worker**\n\nresult"), {
			agent: "worker",
			status: "completed",
			resultPreview: "result",
		});
	});

	test("rejects unrelated content with an invalid notification shape", () => {
		for (const content of [
			"Detached subagent task unknown: **worker**\n\nresult",
			"Detached subagent task completed **worker**\n\nresult",
			"Detached subagent task completed: **worker\n\nresult",
			"The worker completed the task and reported a result.",
		]) {
			assert.equal(parseSubagentNotifyContent(content), undefined, content);
		}
	});

	test("rejects malformed notification headers", () => {
		for (const content of [
			"Background task completed: ****\n\nresult",
			"Background task unknown: **worker**\n\nresult",
			"Background task completed: **worker\n\nresult",
			"Background task completed: **worker**(1/2)\n\nresult",
			"Background task completed: **worker** (1/2))\n\nresult",
			"Background task completed: **worker** trailing\n\nresult",
			"Background task paused: **worker**\r\n\nresult",
			"Background task paused: **worker**\u2028\n\nresult",
			"Background task paused: **worker**\u2029\n\nresult",
		]) {
			assert.equal(parseSubagentNotifyContent(content), undefined, content);
		}
	});

	test("safely rejects a long malformed uncontrolled header", () => {
		const content = `Background task completed: **${"a** (".repeat(250_000)}`;
		assert.equal(parseSubagentNotifyContent(content), undefined);
	});
});
