import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowInputSchemaMap } from "../../packages/workflows/src/shared/types.js";
import {
	inputsSummary,
	runRowDescription,
	shortFailureReason,
	type WorkflowsListingDefinition,
	workflowsListingItems,
} from "../../packages/workflows/src/tui/workflows-listing.js";

const NOW = 10_000_000;

function run(over: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "status">): RunSnapshot {
	return {
		name: "ralph",
		inputs: {},
		stages: [],
		toolNodes: [],
		startedAt: NOW - 12 * 60_000,
		...over,
	} as RunSnapshot;
}

const STAGE_NAMES = ["plan", "build", "implement", "review", "verify"];
function stages(statuses: readonly StageSnapshot["status"][]): StageSnapshot[] {
	return statuses.map(
		(status, index) => ({ id: `s${index}`, name: STAGE_NAMES[index] ?? `s${index}`, status }) as StageSnapshot,
	);
}

function definition(
	name: string,
	description: string,
	inputs: WorkflowInputSchemaMap = {},
): WorkflowsListingDefinition {
	return { normalizedName: name, description, inputs };
}

test("/workflows lists runs newest first, then definitions by name, in two groups (#5224)", () => {
	const items = workflowsListingItems(
		[
			run({ id: "old", status: "completed", startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 }),
			run({ id: "new", status: "running", name: "review-pr" }),
			run({ id: "child", status: "running", parentRunId: "new" } as Partial<RunSnapshot> &
				Pick<RunSnapshot, "id" | "status">),
		],
		[definition("ralph", "iterate a fix until its checks pass"), definition("deep-research", "research a topic")],
		NOW,
	);
	assert.deepEqual(
		items.map((item) => [item.group, item.id]),
		[
			["Runs", "run:new"],
			["Runs", "run:old"],
			["Definitions", "definition:deep-research"],
			["Definitions", "definition:ralph"],
		],
		"a child run is not listed on its own",
	);
	assert.deepEqual(items[0]?.value, { kind: "run", runId: "new" });
	assert.deepEqual(items[3]?.value, { kind: "definition", name: "ralph" });
});

test("a run's second line reads status · stage n/m <stage> · elapsed · cost (#5224)", () => {
	const live = run({
		id: "r",
		status: "running",
		stages: stages(["completed", "completed", "running", "pending", "pending"]),
		budgetState: { accounting: { cost: 1.84 } } as RunSnapshot["budgetState"],
	});
	assert.equal(runRowDescription(live, NOW), "running · stage 3/5 implement · 12m · $1.84");
	const done = run({
		id: "d",
		status: "completed",
		stages: stages(["completed", "completed"]),
		startedAt: NOW - 2 * 3_600_000 - 12 * 60_000,
		endedAt: NOW - 2 * 3_600_000,
	});
	assert.equal(runRowDescription(done, NOW), "completed · stage 2/2 · 2h ago · 12m");
});

test("a failed run names its failed stage and a short reason, never a stack trace (#5224)", () => {
	const failed = run({
		id: "f",
		status: "failed",
		stages: stages(["completed", "failed", "pending"]),
		failedStageId: "s1",
		endedAt: NOW - 60_000,
		error: "Error: gate failed: 2 jobs\n    at verify (/x/y.ts:1:2)\n    at run (/x/z.ts:3:4)",
	});
	const text = runRowDescription(failed, NOW);
	assert.match(text, /^failed · stage 2\/3 build · 1m ago · 11m · ✗ gate failed: 2 jobs$/);
	assert.doesNotMatch(text, /\bat verify\b/);
	assert.equal(shortFailureReason({ error: "x".repeat(100) })?.length, 60);
	const item = workflowsListingItems([failed], [], NOW)[0];
	assert.equal(item?.tag, "✗");
	assert.equal(item?.tagTone, "error");
	const stopped = workflowsListingItems([run({ id: "s", status: "cancelled", endedAt: NOW })], [], NOW)[0];
	assert.equal(stopped?.tag, "◼", "stopped looks different from failed");
	assert.match(stopped?.description ?? "", /^stopped/);
});

test("a definition's row summarises its inputs and how many are required (#5224)", () => {
	assert.equal(inputsSummary({}), "no inputs");
	const inputs = {
		objective: { type: "string", required: true },
		max_loops: { type: "number", default: 10 },
	} as unknown as WorkflowInputSchemaMap;
	assert.equal(inputsSummary(inputs), "2 inputs (1 required)");
	const item = workflowsListingItems([], [definition("ralph", "iterate a fix\nmore detail", inputs)], NOW)[0];
	assert.equal(item?.description, "iterate a fix · 2 inputs (1 required)");
});

test("runs of one workflow are told apart by their first input, and a run waiting on a question says so (#5224)", () => {
	const waiting = run({
		id: "11111111-aaaa",
		status: "running",
		name: "approve-demo",
		inputs: { topic: "rename a file" },
		stages: [
			{
				id: "s0",
				name: "plan",
				status: "running",
				pendingPrompt: { kind: "select", message: "Approve this plan?" },
			},
		] as never,
	});
	const other = run({ id: "22222222-bbbb", status: "running", name: "approve-demo", inputs: {}, startedAt: NOW - 60_000 });
	const [first, second] = workflowsListingItems([waiting, other], [], NOW);
	assert.equal(first?.label, "approve-demo · 22222222", "no input: the run's short id");
	assert.equal(second?.label, "approve-demo · rename a file");
	assert.match(second?.description ?? "", /^needs input · Approve this plan\? · /);
	assert.equal(second?.tag, "◆");
});
