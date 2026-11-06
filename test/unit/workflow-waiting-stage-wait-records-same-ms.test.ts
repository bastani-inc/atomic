import assert from "node:assert/strict";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	createStageReplayKeyGenerator,
	durableRecordedToolResults,
	durableWaitingStages,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import type { StageWaitToolResult } from "../../packages/workflows/src/shared/stage-wait.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const RESULT: StageWaitToolResult = {
	toolCallId: "call-alpha",
	toolName: "wait_for_ci",
	isError: false,
	content: [{ type: "text", text: "ci passed" }],
};

test("results recorded in the same millisecond as the wait's start are kept, and a reopened journal still has them (#4309)", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	const runId = crypto.randomUUID();
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "same-ms",
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const deps = {
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => 3_000,
	};
	const waiting: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "waiting",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		sessionId: "session-alpha",
		wait: { kind: "tool", since: 3_000, toolCalls: [{ toolCallId: "call-alpha", toolName: "wait_for_ci" }] },
	};

	assert.equal(await recordStageSessionCheckpoint(deps, waiting, { force: true }), true);
	assert.equal(await recordStageSessionCheckpoint(deps, { ...waiting, waitResults: [RESULT] }, { force: true }), true);

	assert.deepEqual(durableRecordedToolResults(backend, runId).get("stage:alpha:1"), [RESULT]);
	assert.deepEqual(
		durableWaitingStages(backend, runId).map((stage) => stage.sessionId),
		["session-alpha"],
	);

	const reopened = await JournalDurableBackend.open(journal);
	assert.deepEqual(durableRecordedToolResults(reopened, runId).get("stage:alpha:1"), [RESULT]);
	await backend.close();
});

test("the same record written again in the same millisecond is still one record (#4309)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	const runId = crypto.randomUUID();
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "same-ms",
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const deps = {
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => 3_000,
	};
	const withResults: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "waiting",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		sessionId: "session-alpha",
		wait: { kind: "tool", since: 3_000 },
		waitResults: [RESULT],
	};
	await recordStageSessionCheckpoint(deps, withResults, { force: true });
	await recordStageSessionCheckpoint(deps, { ...withResults, waitResults: [{ ...RESULT }] }, { force: true });

	const sessionRecords = backend
		.listCheckpoints(runId)
		.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.replayKey === "stage:alpha:1");
	assert.equal(sessionRecords.length, 1);
	await backend.close();
});

test("a wait that changes kind, prompt count or calls in the same millisecond is recorded as it changed (#4309)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	const runId = crypto.randomUUID();
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "same-ms",
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const deps = {
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => 3_000,
	};
	const stage: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "waiting",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		sessionId: "session-alpha",
	};
	const waits: NonNullable<StageSnapshot["wait"]>[] = [
		{ kind: "release", since: 3_000, promptsCompleted: 1 },
		{ kind: "idle", since: 3_000, promptsCompleted: 1 },
		{ kind: "idle", since: 3_000, promptsCompleted: 2 },
		{ kind: "tool", since: 3_000, toolCalls: [{ toolCallId: "call-1", toolName: "wait_for_ci" }] },
		{ kind: "tool", since: 3_000, toolCalls: [{ toolCallId: "call-2", toolName: "wait_for_ci" }] },
	];
	const recorded: (NonNullable<StageSnapshot["wait"]> | undefined)[] = [];
	for (const wait of waits) {
		await recordStageSessionCheckpoint(deps, { ...stage, wait }, { force: true });
		recorded.push(durableWaitingStages(backend, runId)[0]?.wait);
	}

	assert.deepEqual(recorded, waits);
	const sessionRecords = backend
		.listCheckpoints(runId)
		.filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.replayKey === "stage:alpha:1");
	assert.equal(sessionRecords.length, waits.length);
	await backend.close();
});

test("partial results recorded in the same millisecond keep every completed call (#4309)", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	const runId = crypto.randomUUID();
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "same-ms-partial",
		inputs: {},
		createdAt: 1_000,
		status: "running",
	});
	const deps = {
		workflowId: runId,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		nextReplayKey: createStageReplayKeyGenerator(runId),
		now: () => 3_000,
	};
	const second: StageWaitToolResult = { ...RESULT, toolCallId: "call-beta" };
	const stage: StageSnapshot = {
		id: "stage-alpha",
		name: "alpha",
		replayKey: "stage:alpha:1",
		status: "waiting",
		parentIds: [],
		toolEvents: [],
		startedAt: 1_000,
		sessionId: "session-alpha",
		wait: {
			kind: "tool",
			since: 3_000,
			toolCalls: [RESULT, second].map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
		},
	};
	await recordStageSessionCheckpoint(deps, { ...stage, waitResults: [RESULT] }, { force: true });
	await recordStageSessionCheckpoint(deps, { ...stage, waitResults: [RESULT, second] }, { force: true });
	assert.deepEqual(durableRecordedToolResults(backend, runId).get("stage:alpha:1"), [RESULT, second]);
	const reopened = await JournalDurableBackend.open(journal);
	assert.deepEqual(durableRecordedToolResults(reopened, runId).get("stage:alpha:1"), [RESULT, second]);
	await backend.close();
});
