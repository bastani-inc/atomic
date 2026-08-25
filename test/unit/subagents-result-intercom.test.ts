import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	buildSubagentResultIntercomPayload,
	resolveSubagentResultStatus,
} from "../../packages/subagents/src/intercom/result-intercom.js";
import type { SubagentResultIntercomChild } from "../../packages/subagents/src/shared/types.js";

describe("subagent result intercom helpers", () => {
	test("resolves result status from typed statuses and legacy state projections", () => {
		assert.equal(resolveSubagentResultStatus({ detached: true, success: true }), "detached");
		assert.equal(resolveSubagentResultStatus({ status: "interrupted" }), "interrupted");
		assert.equal(resolveSubagentResultStatus({ state: "interrupted" }), "interrupted");
		assert.equal(resolveSubagentResultStatus({ status: "ok" }), "completed");
		assert.equal(resolveSubagentResultStatus({ status: "error" }), "failed");
		assert.equal(resolveSubagentResultStatus({ status: "skipped" }), "failed");
	});

	test("a result payload reports the parent's direct children and nothing below them", () => {
		const children: SubagentResultIntercomChild[] = [
			{ agent: "worker-a", status: "completed", index: 0, summary: "done a" },
			{ agent: "worker-b", status: "failed", index: 1, summary: "  " },
		];

		const payload = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "root",
			mode: "parallel",
			children,
		});

		assert.deepEqual(
			payload.children.map((child) => child.agent),
			["worker-a", "worker-b"],
		);
		// Delegation is one level deep, so no child can carry descendants of its own.
		for (const child of payload.children) {
			assert.equal("children" in child, false);
		}
		assert.equal(payload.status, "failed");
		assert.equal(payload.children[1]?.summary, "(no output)", "an empty summary falls back rather than vanishing");
		assert.match(payload.message, /Children: 1 completed, 1 failed/);
		assert.doesNotMatch(payload.message, /Nested subagents:/);
	});

	test("grouped intercom status is cancelled only when every child is interrupted with abort", () => {
		const cancelled = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "cancel",
			mode: "parallel",
			children: [
				{ agent: "analysis", status: "interrupted", cause: "abort", summary: "Run cancelled by parent." },
				{ agent: "reviewer", status: "interrupted", cause: "abort", summary: "Run cancelled by parent." },
			],
		});
		assert.equal(cancelled.status, "interrupted");
		assert.match(cancelled.message, /^Status: cancelled$/m);
		assert.match(cancelled.message, /Children: 2 cancelled/);

		const errorNamedAbort = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "error-abort",
			mode: "single",
			children: [{ agent: "analysis", status: "failed", cause: "abort", summary: "abort" }],
		});
		assert.match(errorNamedAbort.message, /^Status: failed$/m);
		assert.doesNotMatch(errorNamedAbort.message, /Status: cancelled/);

		const empty = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "empty",
			mode: "parallel",
			children: [],
		});
		assert.match(empty.message, /^Status: failed$/m);
		assert.doesNotMatch(empty.message, /Status: cancelled/);
	});

	test("a mixed completed and parent-cancelled set reports Status: cancelled", () => {
		const payload = buildSubagentResultIntercomPayload({
			to: "orchestrator",
			runId: "mixed-complete-cancel",
			mode: "parallel",
			children: [
				{ agent: "worker", status: "completed", summary: "done", artifactPath: "/no/out", sessionPath: "/no/sess" },
				{ agent: "analysis", status: "interrupted", cause: "abort", summary: "Run cancelled by parent." },
			],
		});
		assert.equal(payload.status, "interrupted");
		assert.match(payload.message, /^Status: cancelled$/m);
		assert.match(payload.message, /Children: 1 completed, 1 cancelled/);
		assert.match(payload.message, /Output artifact: \/no\/out[\s\S]*Session: \/no\/sess/);
		assert.doesNotMatch(payload.message, /^Status: interrupted$/m);
		assert.doesNotMatch(payload.message, / — interrupted$/m);
	});
});
