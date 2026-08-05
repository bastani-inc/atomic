import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	attachNestedChildrenToResultChildren,
	compactNestedResultChildren,
	resolveSubagentResultStatus,
} from "../../packages/subagents/src/intercom/result-intercom.js";
import {
	MAX_SUBAGENT_NESTING_DEPTH,
	type NestedRunSummary,
	type PublicNestedRunSummary,
	type SubagentResultIntercomChild,
} from "../../packages/subagents/src/shared/types.js";

function nested(
	id: string,
	parentRunId = "root",
	parentStepIndex?: number,
	children: NestedRunSummary[] = [],
): NestedRunSummary {
	return {
		id,
		parentRunId,
		...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
		depth: 0,
		path: [{ runId: parentRunId }],
		state: "complete",
		agent: id,
		children,
	};
}

function nestedChain(level: number, maxLevel: number): NestedRunSummary {
	return nested(
		`level${level}`,
		level === 0 ? "root" : `level${level - 1}`,
		undefined,
		level < maxLevel ? [nestedChain(level + 1, maxLevel)] : [],
	);
}

describe("subagent result intercom helpers", () => {
	test("resolves result status from typed statuses and legacy state projections", () => {
		assert.equal(resolveSubagentResultStatus({ detached: true, success: true }), "detached");
		assert.equal(resolveSubagentResultStatus({ status: "interrupted" }), "paused");
		assert.equal(resolveSubagentResultStatus({ state: "paused" }), "paused");
		assert.equal(resolveSubagentResultStatus({ status: "ok" }), "completed");
		assert.equal(resolveSubagentResultStatus({ status: "error" }), "failed");
		assert.equal(resolveSubagentResultStatus({ status: "skipped" }), "failed");
	});

	test("attaches nested children by parent step index and compacts depth", () => {
		const children: SubagentResultIntercomChild[] = [
			{ agent: "worker-a", status: "completed", index: 0, summary: "done" },
			{ agent: "worker-b", status: "completed", index: 1, summary: "done" },
		];
		const nestedChildren = [nested("nested-a", "root", 0), nested("nested-b", "root", 1)];

		const attached = attachNestedChildrenToResultChildren("root", children, nestedChildren);

		assert.deepEqual(
			attached.map((child) => child.children?.map((run) => run.id)),
			[["nested-a"], ["nested-b"]],
		);
	});

	test("compacts nested result trees to bounded breadth and five-level depth", () => {
		const deep = nestedChain(0, MAX_SUBAGENT_NESTING_DEPTH + 1);
		const compact = compactNestedResultChildren(
			Array.from({ length: 20 }, (_, index) => ({ ...deep, id: `run${index}` })),
		);

		assert.equal(compact?.length, 16);
		let cursor: PublicNestedRunSummary | undefined = compact?.[0];
		for (let level = 1; level <= MAX_SUBAGENT_NESTING_DEPTH; level++) {
			cursor = cursor?.children?.[0];
			assert.equal(cursor?.id, `level${level}`);
		}
		assert.equal(cursor?.children, undefined);
	});
});
