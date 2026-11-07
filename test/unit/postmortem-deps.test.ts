import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	createPostMortemHandleResolver,
	postMortemDepsForRun,
} from "../../packages/workflows/src/extension/postmortem-deps.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionCreateOptions } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { mockSession } from "./executor-shared.js";

let tempRoot = "";
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "atomic-nested-postmortem-"));
	stageControlRegistry.clear();
	store.clear();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
	rmSync(tempRoot, { recursive: true, force: true });
});

test("nested post-mortem chat reopens in the durable root cwd while retaining child ownership", async () => {
	for (const durableCwdField of ["workflowCwd", "invocationCwd"] as const) {
		stageControlRegistry.clear();
		store.clear();
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const durableCwd = join(tempRoot, durableCwdField);
		await backend.commitWorkflowRegistration({
			workflowId: "root-run",
			rootWorkflowId: "root-run",
			name: "root-workflow",
			inputs: {},
			createdAt: 1,
			status: "completed",
			invocationCwd: durableCwdField === "invocationCwd" ? durableCwd : join(tempRoot, "invocation"),
			...(durableCwdField === "workflowCwd" ? { workflowCwd: durableCwd } : {}),
		});
		assert.equal(backend.getWorkflow("child-run"), undefined);

		const sessionFile = join(tempRoot, `${durableCwdField}.jsonl`);
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: 4,
					id: `${durableCwdField}-session`,
					createdAt: new Date().toISOString(),
					cwd: durableCwd,
				}),
				JSON.stringify({
					type: "message",
					id: `${durableCwdField}-message`,
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "Original stage request", timestamp: Date.now() },
				}),
			].join("\n")}\n`,
		);
		const stage = {
			id: "duplicate-stage-id",
			name: "nested-completed-stage",
			status: "completed" as const,
			parentIds: [],
			toolEvents: [],
			sessionFile,
			sessionId: `${durableCwdField}-session`,
		};
		store.recordRunStart({
			id: "child-run",
			name: "nested-workflow",
			inputs: {},
			status: "completed",
			toolNodes: [],
			stages: [stage],
			startedAt: 2,
			endedAt: 3,
			parentRunId: "root-run",
			parentStageId: "nested-call",
			rootRunId: "root-run",
		});

		let createOptions: StageSessionCreateOptions | undefined;
		const deps = postMortemDepsForRun("child-run", {
			adapters: {
				agentSession: {
					async create(options) {
						createOptions = options;
						return { ...mockSession(), sessionFile };
					},
				},
			},
			resolveDefaultStageSessionDir: () => tempRoot,
		});
		assert.equal(deps.cwd, durableCwd);
		assert.notEqual(deps.cwd, process.cwd());

		const result = await ensurePostMortemStageHandle("child-run", stage, deps);
		assert.equal(result.ok, true);
		if (!result.ok) continue;
		await result.handle.ensureAttached();

		assert.equal(createOptions?.cwd, durableCwd);
		assert.equal(stageControlRegistry.get("child-run", "duplicate-stage-id"), result.handle);
		assert.equal(stageControlRegistry.get("root-run", "duplicate-stage-id"), undefined);
	}
});

test("a nested stage's post-mortem chat follows the restores its root run recorded (#4329)", async () => {
	const restore = {
		from: "/node-a/repo",
		to: join(tempRoot, "restored"),
		snapshotId: "s".repeat(64),
		tree: "t".repeat(40),
		restoredAt: "2026-11-07T00:00:00.000Z",
	};
	const deps = (runId: string) =>
		postMortemDepsForRun(runId, { adapters: {}, resolveDefaultStageSessionDir: () => tempRoot });
	assert.equal(deps("child-run").worktreeRootMappings, undefined);
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	await backend.commitWorkflowRegistration({
		workflowId: "root-run",
		rootWorkflowId: "root-run",
		name: "root-workflow",
		inputs: {},
		createdAt: 1,
		status: "completed",
		invocationCwd: tempRoot,
		worktreeRootMappings: [restore],
	});
	store.recordRunStart({
		id: "child-run",
		name: "nested-workflow",
		inputs: {},
		status: "completed",
		toolNodes: [],
		stages: [],
		startedAt: 2,
		endedAt: 3,
		parentRunId: "root-run",
		parentStageId: "nested-call",
		rootRunId: "root-run",
	});

	assert.deepEqual(deps("child-run").worktreeRootMappings, [restore]);
	assert.deepEqual(deps("root-run").worktreeRootMappings, [restore]);
});

const POOLED_SCOPE = "workflow:pooled-child:1";
const NESTED_SCOPE = `${POOLED_SCOPE}:workflow:nested:1`;

function topology(stageId: string, runId: string, parentRunId: string, parentStageId: string) {
	return {
		version: 1 as const,
		stageId,
		parentIds: [],
		sourceOrder: 0,
		status: "running" as const,
		run: { runId, runName: runId, parentRunId, parentStageId, rootRunId: "root-run" },
	};
}

/** A stage session checkpoint a worker records under the pooled child's scope. */
function session(stageId: string, runId: string, sessionId: string | undefined, completedAt: number) {
	const [parentRunId, parentStageId] = runId === "child-run" ? ["root-run", "boundary-1"] : ["child-run", "nested-1"];
	return {
		kind: "stage" as const,
		workflowId: "root-run",
		checkpointId: `${NESTED_SCOPE}:session:${stageId}:${runId}:${completedAt}`,
		name: stageId,
		replayKey: `${NESTED_SCOPE}:${stageId}:1`,
		...(sessionId === undefined ? {} : { sessionId }),
		completedAt,
		topology: topology(stageId, runId, parentRunId!, parentStageId!),
	};
}

interface PooledPostMortem {
	readonly backend: JournalDurableBackend<SqlRunJournal>;
	readonly loaded: string[];
	readonly fullReads: () => number;
	readonly resolve: (runId: string, stageId: string) => ReturnType<ReturnType<typeof createPostMortemHandleResolver>>;
}

/**
 * A live pooled root that keeps only its own checkpoints, with a grandchild stage on a local worker whose sessions are
 * in the journal under the root's child scope, beside sessions of another stage and of another run with the same
 * stage id.
 */
async function pooledPostMortem(
	runs: (stage: StageSnapshot) => readonly Parameters<typeof store.recordRunStart>[0][],
): Promise<PooledPostMortem> {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(join(tempRoot, "journal.sqlite")));
	cleanups.push(() => backend.close());
	setDurableBackend(backend);
	await backend.commitWorkflowRegistration({
		workflowId: "root-run",
		rootWorkflowId: "root-run",
		name: "root-workflow",
		inputs: {},
		createdAt: 1,
		status: "running",
		invocationCwd: tempRoot,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: "root-run",
		checkpointId: `boundary-start:${POOLED_SCOPE}`,
		name: "workflow:pooled-child",
		replayKey: POOLED_SCOPE,
		completedAt: 2,
		topology: {
			version: 1,
			stageId: "boundary-1",
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: { runId: "root-run", runName: "root-workflow" },
			boundary: {
				version: 1,
				event: "start",
				status: "running",
				replayScope: POOLED_SCOPE,
				alias: "pooled-child",
				workflow: "pooled-child",
				invocationFingerprint: "fingerprint",
				child: {
					runId: "child-run",
					runName: "child-run",
					parentRunId: "root-run",
					parentStageId: "boundary-1",
					rootRunId: "root-run",
				},
			},
		},
	});
	await backend.retainOwnCheckpoints("root-run");
	// A stage of the root itself with the same stage id, recorded before stages named their run.
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: "root-run",
		checkpointId: "root-stage-1",
		name: "stage-1",
		replayKey: "stage-1:1",
		sessionId: "root-session",
		completedAt: 20,
		topology: { version: 1, stageId: "stage-1", parentIds: [] },
	});
	// The stage opens a session, replaces it, then records progress without one; later records belong to another
	// stage of the same run and to a stage with the same id in another run.
	for (const checkpoint of [
		session("stage-1", "grandchild-run", "replaced-session", 10),
		session("stage-1", "grandchild-run", "pooled-session", 11),
		session("stage-1", "grandchild-run", undefined, 12),
		session("stage-2", "grandchild-run", "other-stage-session", 13),
		session("stage-1", "child-run", "other-run-session", 14),
	])
		await backend.commitCheckpoint(checkpoint);
	assert.equal(
		backend.listCheckpoints("root-run").some((checkpoint) => checkpoint.checkpointId.startsWith(`${POOLED_SCOPE}:`)),
		false,
		"the root keeps none of its child's checkpoints in memory",
	);
	const stage: StageSnapshot = {
		id: "stage-1",
		name: "stage-1",
		status: "running",
		parentIds: [],
		toolEvents: [],
		replayKey: "stage-1:1",
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
	};
	for (const run of runs(stage)) store.recordRunStart(run);
	store.recordRunEnd("grandchild-run", "failed", undefined, "the pool gave up on the child");
	const loaded: string[] = [];
	const sessions: Pick<SessionStore, "load"> = {
		async load(id) {
			loaded.push(id);
			if (id !== "pooled-session") throw new Error(`no session ${id}`);
			return {
				header: { type: "session", version: 4, id, createdAt: new Date().toISOString(), cwd: tempRoot },
				entries: [
					{
						type: "message",
						id: "request",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "user", content: "Original stage request", timestamp: Date.now() },
					},
				],
				lastSeq: 1,
			} as Awaited<ReturnType<SessionStore["load"]>>;
		},
	};
	const read = backend.journal.read.bind(backend.journal);
	let fullReads = 0;
	backend.journal.read = (runId: string, fromSeq?: number) => {
		if (fromSeq === undefined || fromSeq <= 1) fullReads++;
		return read(runId, fromSeq);
	};
	return {
		backend,
		loaded,
		fullReads: () => fullReads,
		resolve: createPostMortemHandleResolver({
			adapters: { sessionStore: sessions as SessionStore, agentSession: { create: async () => mockSession() } },
			resolveDefaultStageSessionDir: () => tempRoot,
		}),
	};
}

const runBase = { inputs: {}, toolNodes: [], startedAt: 1, status: "running" as const };
const rootRun = {
	...runBase,
	id: "root-run",
	name: "root-workflow",
	stages: [
		{
			id: "boundary-1",
			name: "workflow:pooled-child",
			status: "running" as const,
			parentIds: [],
			toolEvents: [],
			replayKey: POOLED_SCOPE,
		},
	],
};
const childRun = {
	...runBase,
	id: "child-run",
	name: "child-run",
	parentRunId: "root-run",
	parentStageId: "boundary-1",
	rootRunId: "root-run",
	stages: [],
};
const grandchildRun = (stage: StageSnapshot, parent: Partial<RunSnapshot> = {}) => ({
	...runBase,
	id: "grandchild-run",
	name: "grandchild-run",
	parentRunId: "child-run",
	parentStageId: "nested-1",
	rootRunId: "root-run",
	stages: [stage],
	...parent,
});

test("a pooled stage's post-mortem chat reopens the last session its root left in the journal, read from its child's scope (#4318)", async () => {
	const pooled = await pooledPostMortem((stage) => [rootRun, childRun, grandchildRun(stage)]);
	const result = await pooled.resolve("grandchild-run", "stage-1");
	assert.equal(result?.ok, true, JSON.stringify(result));
	assert.deepEqual(pooled.loaded, ["pooled-session"]);
	assert.equal(pooled.fullReads(), 0, "the child's scope is read through the journal's key index");
});

for (const [shape, runs] of [
	["its parent run is missing", (stage: StageSnapshot) => [rootRun, grandchildRun(stage)]],
	["its root run is missing", (stage: StageSnapshot) => [childRun, grandchildRun(stage)]],
	["its run has no parent", (stage: StageSnapshot) => [rootRun, grandchildRun(stage, { parentRunId: undefined })]],
	[
		"its parents form a cycle",
		(stage: StageSnapshot) => [
			rootRun,
			{ ...childRun, parentRunId: "grandchild-run", parentStageId: "stage-1" },
			grandchildRun(stage),
		],
	],
] as const)
	test(`a pooled stage's post-mortem chat reads the root's whole journal when ${shape} (#4318)`, async () => {
		const pooled = await pooledPostMortem(runs);
		const result = await pooled.resolve("grandchild-run", "stage-1");
		assert.equal(result?.ok, true, JSON.stringify(result));
		assert.deepEqual(pooled.loaded, ["pooled-session"]);
		assert.equal(pooled.fullReads(), 1);
	});

test("a stage that did not run on a local worker reads no pooled session for its post-mortem chat (#4318)", async () => {
	const pooled = await pooledPostMortem((stage) => {
		const { workerExecution: _workerExecution, ...local } = stage;
		return [rootRun, childRun, grandchildRun({ ...local, status: "completed" })];
	});
	const result = await pooled.resolve("grandchild-run", "stage-1");
	assert.deepEqual(result, { ok: false, reason: "no_session" });
	assert.deepEqual(pooled.loaded, []);
});

test("a pooled stage without a durable backend has no post-mortem session (#4318)", async () => {
	setDurableBackend(undefined);
	const stage: StageSnapshot = {
		id: "stage-1",
		name: "stage-1",
		status: "running",
		parentIds: [],
		toolEvents: [],
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
	};
	for (const run of [rootRun, childRun, grandchildRun(stage)]) store.recordRunStart(run);
	store.recordRunEnd("grandchild-run", "failed");
	const resolve = createPostMortemHandleResolver({
		adapters: { agentSession: { create: async () => mockSession() } },
		resolveDefaultStageSessionDir: () => tempRoot,
	});
	assert.deepEqual(await resolve("grandchild-run", "stage-1"), { ok: false, reason: "no_session" });
});
