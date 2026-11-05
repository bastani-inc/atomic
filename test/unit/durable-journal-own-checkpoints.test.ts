/**
 * A pooled root's backend keeps only the root's own checkpoints in memory (#4318). These tests take over a recorded
 * root the way a resumed pooled root does, over a SQL journal, and check each way the parent reads its children's
 * checkpoints against a backend that keeps every one: the boundary replay that releases them, the journal reads
 * that bring them back, cached-child reconstruction, inspection, and what happens once the backend stops owning it.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { type DurableWorkflowBackend, readDurableCheckpoints } from "../../packages/workflows/src/durable/backend.js";
import { createDurableChildWorkflowPrimitive } from "../../packages/workflows/src/durable/child-primitive.js";
import { durableNestedRunCatalog } from "../../packages/workflows/src/durable/completed-catalog.js";
import { durableCompletedNestedRunSubtree } from "../../packages/workflows/src/durable/completed-subtree.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	type JournalEntry,
	RUN_EVENT_TYPES,
	StorageUnavailableError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { inspectTargetedDurableWorkflow } from "../../packages/workflows/src/durable/targeted-inspection.js";
import {
	DURABLE_STAGE_TOPOLOGY_VERSION,
	DURABLE_TOOL_TOPOLOGY_VERSION,
	type DurableCheckpoint,
	type DurableStageCheckpoint,
	type DurableToolCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const ROOT = testRunId("pooled-root-own-checkpoints");
const CHILDREN = 6;
const CHILD_TOOLS = 4;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const grandchild = workflow({
	name: "pooled-grandchild",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("nested-step", {}, async () => "nested");
		return {};
	},
});

const child = workflow({
	name: "pooled-child",
	description: "",
	inputs: { item: Type.String() },
	outputs: { value: Type.String() },
	run: async (ctx) => {
		await ctx.stage("work").complete(`done-${ctx.inputs.item}`);
		for (let step = 0; step < CHILD_TOOLS; step++)
			await ctx.tool("step", { item: ctx.inputs.item, step }, async () => `${ctx.inputs.item}-${step}`);
		// One child starts a workflow of its own: its boundary checkpoints are the child's, under the child's scope.
		if (ctx.inputs.item === "item-0") await ctx.workflow(grandchild);
		return { value: ctx.inputs.item };
	},
});

const root = workflow({
	name: "pooled-root",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("prepare", {}, async () => "prepared");
		await Promise.all(
			Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { item: `item-${index}` } })),
		);
		await ctx.tool("finish", {}, async () => {
			throw new Error("interrupted after every child completed");
		});
		return {};
	},
}) as WorkflowDefinition;

interface Recorded {
	readonly path: string;
	/** A backend over the journal that keeps every checkpoint, folded from the journal as it is now. */
	full(): Promise<JournalDurableBackend<SqlRunJournal>>;
	/** A backend that took over the root and keeps only its own checkpoints, as a resumed pooled root's parent does. */
	narrowed(): Promise<JournalDurableBackend<SqlRunJournal>>;
}

/** A pooled root with in-process children recorded into a SQL journal, interrupted after every child completed. */
async function recorded(): Promise<Recorded> {
	const directory = makeTempDirectory("journal-own-checkpoints-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "journal.sqlite");
	const writer = await JournalDurableBackend.open(await openSqlRunJournal(path));
	cleanups.push(() => writer.close());
	try {
		const result = await run(
			root,
			{},
			{
				cwd: directory,
				snapshots: { enabled: false, autoCollect: false },
				runId: ROOT,
				registry: createRegistry([root, child, grandchild] as WorkflowDefinition[]),
				store: createStore(),
				durableBackend: writer,
				adapters: { complete: { complete: async (text: string) => text } },
			},
		);
		assert.equal(result.status, "failed");
	} finally {
		await writer.close();
	}
	const open = async () => {
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [] });
		cleanups.push(() => backend.close());
		await backend.hydrateWorkflow(ROOT);
		return backend;
	};
	return {
		path,
		full: open,
		async narrowed() {
			const backend = await open();
			// Any write of the root takes its lease, as the resumed root's registration does.
			await backend.commitCheckpoint(ownTool("resumed", 10_000_000));
			await backend.retainOwnCheckpoints(ROOT);
			return backend;
		},
	};
}

/** A `ctx.tool` checkpoint of the root itself, with the topology its graph reconstruction needs. */
function ownTool(id: string, completedAt: number): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: id,
		name: id,
		argsHash: id,
		output: id,
		completedAt,
		topology: {
			version: DURABLE_TOOL_TOPOLOGY_VERSION,
			nodeId: id,
			ordinal: 0,
			order: completedAt,
			parentIds: [],
			run: { runId: ROOT, runName: "pooled-root" },
		},
	};
}

function scopes(checkpoints: readonly DurableCheckpoint[]): string[] {
	return checkpoints.flatMap((checkpoint) =>
		checkpoint.kind === "stage" &&
		checkpoint.topology?.boundary?.event === "start" &&
		checkpoint.topology.run?.runId === ROOT
			? [checkpoint.replayKey]
			: [],
	);
}

function under(scope: string, checkpoint: DurableCheckpoint): boolean {
	return checkpoint.checkpointId.startsWith(`${scope}:`);
}

function own(checkpoints: readonly DurableCheckpoint[]): DurableCheckpoint[] {
	const opened = scopes(checkpoints);
	return checkpoints.filter((checkpoint) => !opened.some((scope) => under(scope, checkpoint)));
}

function childTool(checkpoints: readonly DurableCheckpoint[], scope: string): DurableToolCheckpoint {
	const tool = checkpoints.find(
		(checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool" && under(scope, checkpoint),
	);
	assert.ok(tool !== undefined, `a tool checkpoint under ${scope}`);
	return tool;
}

function boundaryChildRunId(checkpoints: readonly DurableCheckpoint[], scope: string): string {
	for (const checkpoint of checkpoints)
		if (checkpoint.kind === "stage" && checkpoint.replayKey === scope && checkpoint.topology?.boundary !== undefined)
			return checkpoint.topology.boundary.child.runId;
	return assert.fail(`no boundary for ${scope}`);
}

/**
 * Checkpoints in a fixed order: a run's own checkpoint and one of a child's recorded in the same millisecond list in
 * either order when the child's are read back from the journal.
 */
function byIdentity(checkpoints: readonly DurableCheckpoint[]): DurableCheckpoint[] {
	return [...checkpoints].sort(
		(left, right) =>
			left.completedAt - right.completedAt ||
			`${left.kind}:${left.checkpointId}`.localeCompare(`${right.kind}:${right.checkpointId}`),
	);
}

/** Counts the whole-run reads of a backend's journal from now on. */
function countFullReads(backend: JournalDurableBackend<SqlRunJournal>): () => number {
	const journal = backend.journal;
	const read = journal.read.bind(journal);
	let reads = 0;
	journal.read = (runId: string, fromSeq?: number): AsyncIterable<JournalEntry> => {
		if (fromSeq === undefined || fromSeq <= 1) reads++;
		return read(runId, fromSeq);
	};
	return () => reads;
}

test("a resumed pooled root keeps its children's checkpoints until each boundary releases them, then only its own (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const keepingAll = await recording.full();
	const full = keepingAll.listCheckpoints(ROOT);
	const opened = scopes(full);
	assert.equal(opened.length, CHILDREN);
	assert.deepEqual(
		backend.listCheckpoints(ROOT),
		full,
		"a resumed root holds what it folded before its pool attached",
	);

	// A prompt answer and a stage session of the first child, folded while its scope is still retained.
	const [first] = opened;
	await backend.commitCheckpoint({
		kind: "ui",
		workflowId: ROOT,
		checkpointId: `${first}:ui:1`,
		promptKind: "input",
		message: "question",
		promptHash: `${first}:prompt`,
		response: "answer",
		completedAt: 10_000_003,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${first}:session:retained`,
		name: "retained",
		replayKey: `${first}:retained:1`,
		output: "retained output",
		sessionId: "retained-session",
		completedAt: 10_000_004,
	});
	const retainedLookups = () => ({
		ui: backend.getUiResponse(ROOT, `${first}:prompt`),
		stage: backend.getStageOutput(ROOT, `${first}:retained:1`),
		session: backend.getStageSession(ROOT, `${first}:retained:1`)?.sessionId,
	});
	assert.deepEqual(retainedLookups(), { ui: "answer", stage: "retained output", session: "retained-session" });
	const released = () =>
		[...opened, "workflow:never-opened:1"].map((scope) => backend.checkpointScopeReleased(ROOT, scope));
	assert.deepEqual(released(), [...opened.map(() => false), false]);
	assert.equal(keepingAll.checkpointScopeReleased(ROOT, first!), false);
	const version = backend.nestedSnapshotVersion(ROOT);
	const ownHashes = own(full).flatMap((checkpoint) => (checkpoint.kind === "tool" ? [checkpoint.argsHash] : []));
	assert.ok(ownHashes.length > 0);
	for (const [index, scope] of opened.entries()) {
		const tool = childTool(full, scope);
		assert.deepEqual(backend.getToolOutput(ROOT, tool.argsHash), tool.output);
		backend.releaseCheckpointScope(ROOT, scope);
		backend.releaseCheckpointScope(ROOT, scope);
		assert.equal(backend.getToolOutput(ROOT, tool.argsHash), undefined, `${scope} left memory`);
		for (const later of opened.slice(index + 1))
			assert.deepEqual(backend.getToolOutput(ROOT, childTool(full, later).argsHash), childTool(full, later).output);
		for (const hash of ownHashes)
			assert.deepEqual(backend.getToolCheckpoint(ROOT, hash), keepingAll.getToolCheckpoint(ROOT, hash));
	}
	assert.deepEqual(retainedLookups(), { ui: undefined, stage: undefined, session: undefined });
	assert.deepEqual(released(), [...opened.map(() => true), false]);
	assert.deepEqual(backend.listCheckpoints(ROOT), own(full));
	assert.equal(backend.getWorkflow(ROOT)?.completedCheckpoints, full.length + 2);
	assert.equal(
		backend.nestedSnapshotVersion(ROOT),
		version,
		"releasing a replayed child changes no other child's runs",
	);

	// A child checkpoint folded after its boundary was released is counted and left in the journal.
	await backend.commitCheckpoint(ownTool(`${opened[0]}:late`, 10_000_001));
	assert.deepEqual(backend.listCheckpoints(ROOT), own(full));
	assert.equal(backend.getWorkflow(ROOT)?.completedCheckpoints, full.length + 3);
});

test("a pooled root reads one child's checkpoints through the journal's key index, or every checkpoint, as a backend keeping all lists them (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const full = (await recording.full()).listCheckpoints(ROOT);
	const opened = scopes(full);
	for (const scope of opened) backend.releaseCheckpointScope(ROOT, scope);
	const fullReads = countFullReads(backend);
	for (const scope of opened)
		assert.deepEqual(
			byIdentity(await backend.readCheckpoints(ROOT, scope)),
			byIdentity(full.filter((checkpoint) => !opened.some((other) => other !== scope && under(other, checkpoint)))),
			scope,
		);
	assert.equal(fullReads(), 0, "a child's checkpoints are read by key range, not by reading the whole root");
	assert.deepEqual(await backend.readCheckpoints(ROOT), full);
	assert.equal(fullReads(), 1);

	// A checkpoint the pool wrote that this backend has not folded yet is read once it is folded.
	const late = ownTool(`${opened[1]}:not-folded`, 10_000_005);
	const state = await backend.journal.leaseState(ROOT);
	assert.ok(state !== undefined);
	await backend.journal.append(
		{ runId: ROOT, holderId: state.holderId, epoch: state.epoch },
		{ type: RUN_EVENT_TYPES.checkpointRecorded, payload: late as never },
		{ key: JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, late.kind, late.checkpointId]) },
	);
	const ids = (checkpoints: readonly DurableCheckpoint[]) => checkpoints.map((checkpoint) => checkpoint.checkpointId);
	assert.ok(!ids(await backend.readCheckpoints(ROOT, opened[1])).includes(late.checkpointId));
	assert.ok(!ids(await backend.readCheckpoints(ROOT)).includes(late.checkpointId));
	await backend.catchUpWorkflow(ROOT);
	assert.ok(ids(await backend.readCheckpoints(ROOT, opened[1])).includes(late.checkpointId));
	assert.ok(ids(await backend.readCheckpoints(ROOT)).includes(late.checkpointId));
	assert.ok(!ids(backend.listCheckpoints(ROOT)).includes(late.checkpointId));
});

test("rebuilding a pooled root keeps released children out and retained ones in (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const full = (await recording.full()).listCheckpoints(ROOT);
	const [released] = scopes(full);
	backend.releaseCheckpointScope(ROOT, released!);
	await backend.hydrateWorkflow(ROOT);
	assert.deepEqual(
		backend.listCheckpoints(ROOT),
		full.filter((checkpoint) => !under(released!, checkpoint)),
	);
	assert.equal(backend.getWorkflow(ROOT)?.completedCheckpoints, full.length);
});

test("a cached child of a pooled root replays the subtree a full backend rebuilds after other children left memory (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const opened = scopes(backend.listCheckpoints(ROOT));
	const childRunId = (scope: string) => boundaryChildRunId(backend.listCheckpoints(ROOT), scope);
	const [replayed, ...remaining] = opened;
	const replayedRunId = childRunId(replayed!);
	assert.ok(durableCompletedNestedRunSubtree(backend, ROOT, replayedRunId) !== undefined);
	backend.releaseCheckpointScope(ROOT, replayed!);
	// A checkpoint of the root itself changes its nested snapshot version, so the next replay rebuilds its runs from
	// what the root still holds.
	await backend.commitCheckpoint(ownTool("between-replays", 10_000_002));
	const full = await recording.full();
	for (const scope of remaining) {
		const runId = childRunId(scope);
		const subtree = durableCompletedNestedRunSubtree(backend, ROOT, runId);
		assert.ok(subtree !== undefined, `${scope} replays`);
		assert.deepEqual(subtree, durableCompletedNestedRunSubtree(full, ROOT, runId));
		backend.releaseCheckpointScope(ROOT, scope);
	}
});

test("inspecting a pooled root its backend runs reads every checkpoint (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	for (const scope of scopes(backend.listCheckpoints(ROOT))) backend.releaseCheckpointScope(ROOT, scope);
	const inspected = await inspectTargetedDurableWorkflow(backend, ROOT);
	const expected = await inspectTargetedDurableWorkflow(await recording.full(), ROOT);
	if (inspected.kind !== "found" || expected.kind !== "found") assert.fail(`${inspected.kind} / ${expected.kind}`);
	const graph = (runs: readonly RunSnapshot[]) =>
		runs.map(({ id, status, parentRunId, parentStageId, stages, toolNodes }) => ({
			id,
			status,
			parentRunId,
			parentStageId,
			stages,
			toolNodes,
		}));
	assert.deepEqual(graph(inspected.runs), graph(expected.runs));
	assert.equal(inspected.runs.length, CHILDREN + 2, "the root, each of its children and one grandchild");
});

test("a pooled root its backend stops owning is read in full again (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const full = (await recording.full()).listCheckpoints(ROOT);
	for (const scope of scopes(full)) backend.releaseCheckpointScope(ROOT, scope);
	await backend.releaseWorkflow(ROOT);
	assert.deepEqual(await backend.readCheckpoints(ROOT), full, "a read before its rebuild reads the journal");
	await backend.catchUpWorkflow(ROOT);
	assert.deepEqual(backend.listCheckpoints(ROOT), full);
	// Rebuilt in full, the run catches up from where it is again.
	const fullReads = countFullReads(backend);
	await backend.catchUpWorkflow(ROOT);
	assert.equal(fullReads(), 0);
});

test("a catalog refresh reads a pooled root its backend stopped owning in full (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const full = (await recording.full()).listCheckpoints(ROOT);
	for (const scope of scopes(full)) backend.releaseCheckpointScope(ROOT, scope);
	await backend.releaseWorkflow(ROOT);
	await backend.hydrateResumableWorkflows();
	assert.deepEqual(backend.listCheckpoints(ROOT), full);
});

test("deleting a pooled root forgets that its backend kept only the root's own checkpoints (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const held = backend.listCheckpoints(ROOT);
	const [scope] = scopes(held);
	const start = held.find((checkpoint) => checkpoint.checkpointId === `boundary-start:${scope}`);
	assert.ok(start !== undefined);
	backend.releaseCheckpointScope(ROOT, scope!);
	await backend.deleteWorkflow(ROOT);
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "pooled-root",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	await backend.commitCheckpoint(start);
	await backend.commitCheckpoint(ownTool(`${scope}:after-delete`, 10_000_020));
	assert.ok(backend.listCheckpoints(ROOT).some((checkpoint) => checkpoint.checkpointId === `${scope}:after-delete`));
});

test("checkpoints a pooled root reads back from the journal look as its index keeps them (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const [scope] = scopes(backend.listCheckpoints(ROOT));
	backend.releaseCheckpointScope(ROOT, scope!);
	const sessionFile = join(dirname(recording.path), "legacy.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 4, id: "legacy-session", createdAt: new Date().toISOString(), cwd: dirname(recording.path) })}\n`,
	);
	const bare: DurableStageCheckpoint = {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${scope}:bare`,
		name: "bare",
		replayKey: `${scope}:bare:1`,
		completedAt: 10_000_010,
	};
	const legacy: DurableStageCheckpoint = {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${scope}:legacy`,
		name: "legacy",
		replayKey: `${scope}:legacy:1`,
		sessionFile,
		completedAt: 10_000_011,
	};
	const tool: DurableToolCheckpoint = {
		kind: "tool",
		workflowId: ROOT,
		checkpointId: `${scope}:bare-tool`,
		name: "bare-tool",
		argsHash: `${scope}:bare-tool`,
		output: 1,
		completedAt: 10_000_012,
	};
	for (const checkpoint of [bare, legacy, tool]) await backend.commitCheckpoint(checkpoint);
	const read = new Map(
		(await backend.readCheckpoints(ROOT, scope)).map((checkpoint) => [checkpoint.checkpointId, checkpoint]),
	);
	const implied = (checkpoint: DurableStageCheckpoint) => ({
		version: DURABLE_STAGE_TOPOLOGY_VERSION,
		stageId: checkpoint.checkpointId,
		parentIds: [],
	});
	assert.deepEqual(read.get(bare.checkpointId), { ...bare, topology: implied(bare) });
	assert.deepEqual(read.get(legacy.checkpointId), {
		...legacy,
		sessionId: "legacy-session",
		topology: implied(legacy),
	});
	assert.deepEqual(read.get(tool.checkpointId), tool);
});

test("nested run reconstruction reads a child its backend left in storage as not loaded, and any other missing child as incomplete (#4318)", async () => {
	const recording = await recorded();
	const keepingAll = await recording.full();
	const full = keepingAll.listCheckpoints(ROOT);
	// A child without nested runs of its own, so its subtree is its run alone.
	const left = scopes(full).find(
		(scope) => !full.some((checkpoint) => under(scope, checkpoint) && checkpoint.checkpointId.includes("boundary-")),
	)!;
	const leftRunId = boundaryChildRunId(full, left);
	const withoutLeft = full.filter((checkpoint) => !under(left, checkpoint));
	const backend = (released?: DurableWorkflowBackend["checkpointScopeReleased"]) =>
		({
			getWorkflow: (workflowId: string) => keepingAll.getWorkflow(workflowId),
			listCheckpoints: () => withoutLeft,
			...(released === undefined ? {} : { checkpointScopeReleased: released }),
		}) as Pick<
			DurableWorkflowBackend,
			"getWorkflow" | "listCheckpoints" | "checkpointScopeReleased"
		> as DurableWorkflowBackend;
	const runIds = (from: DurableWorkflowBackend) =>
		durableNestedRunCatalog(from, ROOT)
			.runs.map((run) => run.id)
			.sort();
	const expected = durableNestedRunCatalog(keepingAll, ROOT)
		.runs.map((run) => run.id)
		.filter((id) => id !== leftRunId)
		.sort();
	assert.ok(expected.length >= CHILDREN);
	assert.deepEqual(runIds(backend((workflowId, scope) => workflowId === ROOT && scope === left)), expected);
	assert.deepEqual(runIds(backend(() => false)), []);
	assert.deepEqual(runIds(backend()), []);
	assert.deepEqual(await readDurableCheckpoints(backend(), ROOT, left), withoutLeft);
});

test("a backend that does not own a root keeps every checkpoint of it (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.full();
	const full = backend.listCheckpoints(ROOT);
	await backend.retainOwnCheckpoints(ROOT);
	for (const scope of scopes(full)) backend.releaseCheckpointScope(ROOT, scope);
	await backend.catchUpWorkflow(ROOT);
	assert.deepEqual(backend.listCheckpoints(ROOT), full);
	// It lists what it holds without reading the journal again.
	const fullReads = countFullReads(backend);
	let rangeReads = 0;
	Object.assign(backend.journal, {
		readKeyRange: () => {
			rangeReads++;
			return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) };
		},
	});
	assert.deepEqual(await backend.readCheckpoints(ROOT, scopes(full)[0]), full);
	assert.deepEqual(await backend.readCheckpoints(ROOT), full);
	assert.deepEqual([fullReads(), rangeReads], [0, 0]);
});

test("a pooled root's failed journal read of a child rejects with the journal's error and leaves its index as it was (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const full = (await recording.full()).listCheckpoints(ROOT);
	const opened = scopes(full);
	for (const released of opened) backend.releaseCheckpointScope(ROOT, released);
	const [scope] = opened;
	const held = backend.listCheckpoints(ROOT);
	const failure = new StorageUnavailableError(
		{ adapter: "sqlite", location: recording.path },
		new Error("disk I/O error"),
		"SQLITE_IOERR",
	);
	const journal = backend.journal as SqlRunJournal & { readKeyRange?: () => AsyncIterable<JournalEntry> };
	journal.readKeyRange = () => ({
		[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
	});
	await assert.rejects(backend.readCheckpoints(ROOT, scope), (error) => error === failure);
	delete journal.readKeyRange;
	assert.deepEqual(backend.listCheckpoints(ROOT), held);
	assert.deepEqual(
		byIdentity(await backend.readCheckpoints(ROOT, scope)),
		byIdentity(
			full.filter((checkpoint) => !scopes(full).some((other) => other !== scope && under(other, checkpoint))),
		),
	);
});

test("a cached child boundary lets its root's backend go of the child's checkpoints after replaying it (#4318)", async () => {
	const recording = await recorded();
	const backend = await recording.narrowed();
	const held = backend.listCheckpoints(ROOT);
	const [, scope] = scopes(held);
	const start = held.find((checkpoint) => checkpoint.checkpointId === `boundary-start:${scope}`);
	assert.ok(start?.kind === "stage" && start.topology?.run !== undefined);
	const item = held.find(
		(checkpoint) =>
			checkpoint.kind === "stage" &&
			checkpoint.replayKey === scope &&
			checkpoint.topology?.boundary?.event === "terminal",
	);
	const replay = (from: DurableWorkflowBackend) => {
		const recordedStages: string[] = [];
		const primitive = createDurableChildWorkflowPrimitive({
			workflowId: ROOT,
			rootWorkflowId: ROOT,
			backend: from,
			nextReplayKey: () => scope!,
			recordCachedStage: (_name, replayKey) => {
				recordedStages.push(replayKey);
			},
			runTopology: start.topology!.run!,
			setChildDurableInvocation: () => assert.fail("a cached child is not invoked again"),
			workflow: async () => assert.fail("a cached child does not run again"),
		});
		const output =
			item?.kind === "stage" ? (item.output as { readonly outputs: { readonly value: string } }) : undefined;
		return { recordedStages, result: primitive(child, { inputs: { item: output!.outputs.value } }) };
	};
	// A backend without scopes to release replays the child alike.
	const keepingAll = await recording.full();
	const plain = replay(
		Object.create(keepingAll, { releaseCheckpointScope: { value: undefined } }) as DurableWorkflowBackend,
	);
	assert.equal((await plain.result).status, "completed");
	assert.deepEqual(plain.recordedStages, [scope]);
	const pooled = replay(backend);
	assert.equal((await pooled.result).status, "completed");
	assert.ok(!backend.listCheckpoints(ROOT).some((checkpoint) => under(scope!, checkpoint)));
	assert.equal(backend.checkpointScopeReleased(ROOT, scope!), true);
});
