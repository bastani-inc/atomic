/**
 * Direct-child status rendering must survive the removal of the multi-level
 * nested route/event pipeline.
 *
 * `foregroundStatusResult` used to append `formatNestedRunStatusLines(control.nestedChildren, …)`
 * to every live-run status block. That input was structurally always `undefined`
 * — the three env resolvers feeding the registry were unconditional
 * `return undefined`, so no event could ever reach it — and the formatter
 * returned `[]` for `undefined`. Deleting the pipeline therefore had to leave
 * this output byte-identical, and a parent must still see its own direct
 * children in the live status path.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { foregroundStatusResult } from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";

function statusText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

describe("direct-child status rendering", () => {
	test("a live foreground run reports exactly its own header block", () => {
		const result = foregroundStatusResult({
			runId: "run-1",
			mode: "parallel",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			currentAgent: "worker",
			currentIndex: 1,
		});

		assert.equal(
			statusText(result),
			["Run: run-1", "State: running", "Mode: parallel", "Current: worker step 2"].join("\n"),
		);
		assert.equal(result.details.mode, "management");
	});

	test("a live foreground run without a current agent omits that line rather than emitting an empty one", () => {
		const result = foregroundStatusResult({
			runId: "run-2",
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});

		assert.equal(statusText(result), ["Run: run-2", "State: running", "Mode: single"].join("\n"));
	});
});
