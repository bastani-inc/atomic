import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	priorChildRunAccounting,
	priorRunAccounting,
	RUN_USAGE_CHECKPOINT_NAME,
	recordChildRunUsageCheckpointAsync,
} from "../../packages/workflows/src/durable/run-timing.js";
import type { RunBudgetAccountingState, RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT = "root-run";
const CHILD = "child-run";

const accounting = (tokens: number, cost = 0): RunBudgetAccountingState => ({
	baseline: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost },
	tokens,
	cost,
	perCounter: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const run = (id: string, charged?: RunBudgetAccountingState): RunSnapshot => ({
	id,
	name: id,
	inputs: {},
	status: "running",
	toolNodes: [],
	stages: [],
	startedAt: 0,
	...(charged === undefined ? {} : { budgetState: { accounting: charged } }),
});

async function rootBackend(progress = true) {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "root",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	if (progress)
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: ROOT,
			checkpointId: "stage-session:stage:p0:1:seed",
			name: "p0",
			replayKey: "stage:p0:1",
			startedAt: 2,
			completedAt: 3,
		});
	return backend;
}

const ownRecord = (tokens: number, cost = 0) => ({
	kind: "tool" as const,
	workflowId: ROOT,
	checkpointId: `run-usage:${tokens}:${cost}`,
	name: RUN_USAGE_CHECKPOINT_NAME,
	argsHash: RUN_USAGE_CHECKPOINT_NAME,
	output: { accounting: accounting(tokens, cost) },
	completedAt: 10,
});

describe("child usage records on the root run (#5053)", () => {
	test("a child's record restores the child's accounting and, when larger, its root's (#5053)", async () => {
		const backend = await rootBackend();
		await backend.commitCheckpoint(ownRecord(5));
		await recordChildRunUsageCheckpointAsync(backend, run(ROOT, accounting(25)), run(CHILD, accounting(20)));

		assert.equal(priorChildRunAccounting(backend, ROOT, CHILD)?.tokens, 20);
		assert.equal(priorRunAccounting(backend, ROOT)?.tokens, 25, "the child's write carried the root's later charges");
	});

	test("the root's own record wins when it charged more than any child's record (#5053)", async () => {
		const backend = await rootBackend();
		await recordChildRunUsageCheckpointAsync(backend, run(ROOT, accounting(25)), run(CHILD, accounting(20)));
		await backend.commitCheckpoint(ownRecord(35));

		assert.equal(priorRunAccounting(backend, ROOT)?.tokens, 35);
	});

	test("equal token counts are ordered by cost (#5053)", async () => {
		const backend = await rootBackend();
		await backend.commitCheckpoint(ownRecord(25, 0.5));
		await recordChildRunUsageCheckpointAsync(backend, run(ROOT, accounting(25, 0.75)), run(CHILD, accounting(20)));
		assert.equal(priorRunAccounting(backend, ROOT)?.cost, 0.75);

		const lower = await rootBackend();
		await lower.commitCheckpoint(ownRecord(25, 0.75));
		await recordChildRunUsageCheckpointAsync(lower, run(ROOT, accounting(25, 0.5)), run(CHILD, accounting(20)));
		assert.equal(priorRunAccounting(lower, ROOT)?.cost, 0.75);
	});

	test("a child record without its root's accounting leaves the root's own (#5053)", async () => {
		const backend = await rootBackend();
		await backend.commitCheckpoint(ownRecord(5));
		await recordChildRunUsageCheckpointAsync(backend, run(ROOT), run(CHILD, accounting(20)));

		assert.equal(priorChildRunAccounting(backend, ROOT, CHILD)?.tokens, 20);
		assert.equal(priorRunAccounting(backend, ROOT)?.tokens, 5);
	});

	test("nothing is recorded for an uncharged child or a root with no durable progress (#5053)", async () => {
		const uncharged = await rootBackend();
		await recordChildRunUsageCheckpointAsync(uncharged, run(ROOT, accounting(5)), run(CHILD));
		assert.equal(priorChildRunAccounting(uncharged, ROOT, CHILD), undefined);
		assert.equal(priorRunAccounting(uncharged, ROOT), undefined);

		const fresh = await rootBackend(false);
		await recordChildRunUsageCheckpointAsync(fresh, run(ROOT, accounting(5)), run(CHILD, accounting(5)));
		assert.equal(fresh.listCheckpoints(ROOT).length, 0, "a record never makes a run resumable");
	});

	test("an unchanged child record is written once (#5053)", async () => {
		const backend = await rootBackend();
		const before = backend.listCheckpoints(ROOT).length;
		for (let index = 0; index < 3; index++)
			await recordChildRunUsageCheckpointAsync(backend, run(ROOT, accounting(25)), run(CHILD, accounting(20)));
		assert.equal(backend.listCheckpoints(ROOT).length, before + 1);
		await recordChildRunUsageCheckpointAsync(backend, run(ROOT, accounting(30)), run(CHILD, accounting(20)));
		assert.equal(backend.listCheckpoints(ROOT).length, before + 2, "a root change alone is recorded");
	});
});
