import assert from "node:assert/strict";
import type { WorktreeSnapshot } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import {
	createDurableTaskPrimitive,
	createStageReplayKeyGenerator,
	recordStageCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import {
	createCheckpointIdGenerator,
	createToolPrimitive,
} from "../../packages/workflows/src/durable/tool-primitive.js";
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import type { WorkflowSnapshotRecord } from "../../packages/workflows/src/durable/worktree-snapshot-recorder.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowTaskResult } from "../../packages/workflows/src/shared/types.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";

const WORKFLOW_ID = "wf-seams";

function snapshot(root: string, tree: string): WorktreeSnapshot {
	return {
		version: 1,
		id: tree,
		root,
		remotes: [],
		branch: null,
		head: "head",
		snapshot: "commit",
		tree,
		envHash: "env",
		delta: { base: "head", patch: null, bytes: 0 },
		chain: [{ tree, patch: null, bytes: 0 }],
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: "2026-01-01T00:00:00Z",
	};
}

function makeStage(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id: "stage-1",
		name: "analyze",
		status: "completed",
		parentIds: [],
		startedAt: 1000,
		endedAt: 2000,
		result: "analysis output",
		toolEvents: [],
		...overrides,
	};
}

let backend: JournalTestBackend;
beforeEach(async () => {
	backend = await JournalTestBackend.create();
	await backend.commitWorkflowRegistration({
		workflowId: WORKFLOW_ID,
		name: "seams",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
});
afterEach(() => backend.close());

interface RecorderCall {
	readonly checkpoint: DurableStageCheckpoint | DurableToolCheckpoint;
	readonly signal: AbortSignal | undefined;
	readonly directories: readonly string[] | undefined;
}

function spyRecorder(returns: readonly WorktreeSnapshot[]): { calls: RecorderCall[]; record: WorkflowSnapshotRecord } {
	const calls: RecorderCall[] = [];
	return {
		calls,
		record: async (checkpoint, signal, directories) => {
			calls.push({ checkpoint, signal, directories });
			return returns;
		},
	};
}

const stageDeps = (extra: object = {}) => ({
	workflowId: WORKFLOW_ID,
	backend,
	nextCheckpointId: createCheckpointIdGenerator(),
	nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
	...extra,
});

test("a live completed stage hands its checkpoint and directories to the recorder, which owns the commit, and shows the last snapshot (#4245)", async () => {
	const recorder = spyRecorder([snapshot("/workflow", "workflow-tree"), snapshot("/stage", "stage-tree")]);
	const stage = makeStage();
	const recorded = await recordStageCheckpoint(
		stageDeps({
			recordLiveCheckpoint: recorder.record,
			stageDirectories: (given: StageSnapshot) => [`/dir/${given.id}`],
		}),
		stage,
	);
	assert.equal(recorded, true);
	assert.equal(recorder.calls.length, 1);
	const [call] = recorder.calls;
	assert.equal(call!.checkpoint.kind, "stage");
	assert.equal(call!.checkpoint.name, "analyze");
	assert.equal(call!.signal, undefined);
	assert.deepEqual(call!.directories, ["/dir/stage-1"]);
	assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 0, "the recorder, not the stage, commits");
	assert.equal(stage.snapshot?.tree, "stage-tree");
	assert.equal(stage.snapshot?.root, "/stage");
});

test("a single snapshot is the stage's snapshot, and no snapshot leaves the stage without one (#4245)", async () => {
	const single = makeStage({ id: "single" });
	await recordStageCheckpoint(
		stageDeps({ recordLiveCheckpoint: spyRecorder([snapshot("/only", "only-tree")]).record }),
		single,
	);
	assert.equal(single.snapshot?.tree, "only-tree");
	const none = makeStage({ id: "none" });
	await recordStageCheckpoint(stageDeps({ recordLiveCheckpoint: spyRecorder([]).record }), none);
	assert.equal("snapshot" in none, false);
});

test("a stage whose deps name no directories asks the recorder for the workflow's alone (#4245)", async () => {
	const recorder = spyRecorder([]);
	await recordStageCheckpoint(stageDeps({ recordLiveCheckpoint: recorder.record }), makeStage());
	assert.equal(recorder.calls[0]!.directories, undefined);
});

test("failed, skipped and replayed stages, and stages without a recorder, are committed directly and never captured (#4245)", async () => {
	const recorder = spyRecorder([snapshot("/repo", "tree")]);
	const live = stageDeps({ recordLiveCheckpoint: recorder.record });
	await recordStageCheckpoint(live, makeStage({ id: "failed", name: "failed", status: "failed" }));
	await recordStageCheckpoint(live, makeStage({ id: "skipped", name: "skipped", status: "skipped" }));
	await recordStageCheckpoint(live, makeStage({ id: "replayed", name: "replayed", replayed: true }));
	assert.equal(recorder.calls.length, 0);
	await recordStageCheckpoint(stageDeps(), makeStage({ id: "plain", name: "plain" }));
	const names = backend
		.listCheckpoints(WORKFLOW_ID)
		.map((checkpoint) => checkpoint.kind === "stage" && checkpoint.name);
	assert.deepEqual(names.sort(), ["failed", "plain", "replayed", "skipped"]);
});

function taskResult(name: string): WorkflowTaskResult {
	return { name, stageName: name, text: "task text" } as WorkflowTaskResult;
}

test("a completed task hands the recorder its checkpoint and its own directory, and the workflow's alone without one (#4245)", async () => {
	const recorder = spyRecorder([]);
	const task = createDurableTaskPrimitive({
		workflowId: WORKFLOW_ID,
		backend,
		nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
		task: async (name) => taskResult(name),
		recordLiveCheckpoint: recorder.record,
	});
	await task("here", { prompt: "go", cwd: "/task/dir" });
	await task("there", { prompt: "go" });
	assert.equal(recorder.calls.length, 2);
	const [first, second] = recorder.calls;
	assert.equal(first!.checkpoint.kind, "stage");
	assert.ok(first!.checkpoint.checkpointId.startsWith("task:"));
	assert.equal(first!.checkpoint.name, "here");
	assert.ok(first!.signal instanceof AbortSignal);
	assert.deepEqual(first!.directories, ["/task/dir"]);
	assert.deepEqual(second!.directories, []);
	assert.equal("topology" in first!.checkpoint, false, "a task with no recorded topology carries none");
	assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 0, "the recorder commits");
});

test("a completed task without a recorder is committed directly (#4245)", async () => {
	const task = createDurableTaskPrimitive({
		workflowId: WORKFLOW_ID,
		backend,
		nextReplayKey: createStageReplayKeyGenerator(WORKFLOW_ID),
		task: async (name) => taskResult(name),
	});
	await task("direct", { prompt: "go", cwd: "/task/dir" });
	const committed = backend.listCheckpoints(WORKFLOW_ID);
	assert.equal(committed.length, 1);
	assert.ok(committed[0]!.kind === "stage" && committed[0]!.checkpointId.startsWith("task:"));
});

function toolPrimitive(recordLiveCheckpoint?: WorkflowSnapshotRecord) {
	return createToolPrimitive({
		workflowId: WORKFLOW_ID,
		backend,
		nextCheckpointId: createCheckpointIdGenerator(),
		throwIfCancelled: () => {},
		...(recordLiveCheckpoint === undefined ? {} : { recordLiveCheckpoint }),
	});
}

test("a completed tool call and a returned failure both hand their checkpoints to the recorder (#4245)", async () => {
	const recorder = spyRecorder([]);
	const tool = toolPrimitive(recorder.record);
	await tool("works", {}, async () => "ok");
	await tool(
		"fails",
		{},
		async () => {
			throw new Error("boom");
		},
		{ failureMode: "return" },
	);
	assert.deepEqual(
		recorder.calls.map(
			(call) => call.checkpoint.kind === "tool" && [call.checkpoint.name, call.checkpoint.outcomeKind],
		),
		[
			["works", undefined],
			["fails", "return_failure"],
		],
	);
	assert.ok(recorder.calls.every((call) => call.signal instanceof AbortSignal && call.directories === undefined));
	assert.equal(backend.listCheckpoints(WORKFLOW_ID).length, 0, "the recorder commits");
});

test("a completed tool call and a returned failure are committed directly without a recorder (#4245)", async () => {
	const tool = toolPrimitive();
	await tool("works", {}, async () => "ok");
	await tool(
		"fails",
		{},
		async () => {
			throw new Error("boom");
		},
		{ failureMode: "return" },
	);
	assert.deepEqual(
		backend
			.listCheckpoints(WORKFLOW_ID)
			.map((checkpoint) => checkpoint.kind === "tool" && [checkpoint.name, checkpoint.outcomeKind])
			.sort(),
		[
			["fails", "return_failure"],
			["works", undefined],
		],
	);
});

test("a scoped backend exposes the snapshot journal of the backend it wraps (#4245)", () => {
	const scoped = new ScopedDurableBackend(backend, { rootWorkflowId: WORKFLOW_ID, scopePrefix: "workflow:child:1" });
	assert.ok(backend.snapshotJournal);
	assert.equal(scoped.snapshotJournal, backend.snapshotJournal);
});
