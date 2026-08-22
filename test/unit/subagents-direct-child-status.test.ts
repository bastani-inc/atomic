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
 * children in both the live and the retained status paths.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	foregroundStatusResult,
	rememberForegroundRun,
	retainedForegroundStatusResult,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";
import type { SingleResult, SubagentState } from "../../packages/subagents/src/shared/types.js";

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function childResult(agent: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent,
		task: `${agent} task`,
		status: "ok",
		messages: [],
		usage: emptyUsage,
		finalOutput: `${agent} output`,
		...overrides,
	} as SingleResult;
}

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

	test("a retained run still lists every direct child with its status and output", () => {
		const state = makeState();
		rememberForegroundRun(state, {
			runId: "run-3",
			mode: "parallel",
			cwd: "/tmp/project",
			children: [childResult("alpha"), childResult("beta", { status: "error", error: "beta failed" })].map(
				(result, index) => ({
					index,
					result,
					execution: { runtimeCwd: "/tmp/project", options: { runId: "run-3", index } },
				}),
			),
		});

		const result = retainedForegroundStatusResult(state, "run-3");
		assert.ok(result, "a remembered run must be resolvable by id");
		const lines = statusText(result).split("\n");

		assert.equal(lines[0], "Run: run-3");
		assert.equal(lines[2], "Mode: parallel");
		assert.ok(
			lines.includes("Child 1: alpha (completed)"),
			`expected the first direct child, got:\n${lines.join("\n")}`,
		);
		assert.ok(
			lines.includes("Child 2: beta (failed)"),
			`expected the second direct child, got:\n${lines.join("\n")}`,
		);
		assert.ok(lines.includes("alpha output"), "a completed child's output must still be shown");
	});

	test("an unknown run id resolves to undefined instead of an empty status block", () => {
		assert.equal(retainedForegroundStatusResult(makeState(), "missing"), undefined);
	});
});
