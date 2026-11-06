import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	listCompletedFromBackend,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import {
	ForkPoolSessionsUnavailableError,
	isForkPoolSessionsUnavailableError,
	isRetryableForkError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { postMortemDepsForRun } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	closeCoordinationJournals,
	coordinationPath,
	openCoordinationJournal,
	poolDurableJournal,
	registerPoolJournal,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { testRunId } from "../helpers/run-id.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const definition = workflow({
	name: "mixed-placement",
	description: "",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});
const localWorkers = { count: 1, definitions: [] };

type Placement = "shared" | "local";

/** A finished root whose child workflow ran one stage on a local worker. */
interface PooledRoot {
	readonly runId: string;
	readonly childRunId: string;
	readonly sessionId: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openJournal(directory: string): Promise<RunJournal> {
	return resolveRunJournal({
		agentDir: join(directory, "agent"),
		journal: { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" },
	});
}

function poolStoreIn(journal: RunJournal) {
	const storage = sqlPoolStorage(journal);
	assert.ok(storage !== undefined, "the journal has pool tables");
	return openPoolSessions(storage);
}

/** Whether `journal`'s pool tables hold the session `id`. */
async function holds(journal: RunJournal, id: string): Promise<boolean> {
	const sessions = await poolStoreIn(journal);
	try {
		return (await sessions.readHeader(id)) !== undefined;
	} finally {
		await sessions.close();
	}
}

const childStageKey = "workflow:pooled-child:1:stage:implement:1";

/** Records `root` with its child's boundary and pooled stage, its stage session in `pool`, and finishes it. */
async function finishedRoot(
	backend: JournalDurableBackend,
	journal: RunJournal,
	pool: RunJournal,
	runId: string,
	placement: Placement,
	directory: string,
): Promise<PooledRoot> {
	const childRunId = `${runId}-child`;
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		invocationCwd: directory,
		resources: placement === "shared" ? { localWorkers, workers: { placement: "shared" } } : { localWorkers },
	});
	// A shared root's pool runs in the journal itself, which records it; a local one runs in the machine's database.
	if (placement === "shared") {
		const owned = (await journal.leaseState(runId))!;
		await (await openSqlPoolQueue(journal)).initialize(
			{ runId, holderId: owned.holderId!, epoch: owned.epoch },
			90_000,
		);
	}
	const sessions = await poolStoreIn(pool);
	const worker = await SessionManager.create(sessions, directory);
	await worker.appendMessage({ role: "user", content: `implement for ${runId}`, timestamp: 1 });
	await sessions.close();
	const rootRun = { runId, runName: definition.name };
	const childRun = {
		runId: childRunId,
		runName: "pooled-child",
		parentRunId: runId,
		parentStageId: "boundary",
		rootRunId: runId,
	};
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "root-boundary",
		name: "workflow:pooled-child",
		replayKey: "workflow:pooled-child:1",
		output: { workflow: "pooled-child", runId: childRunId, status: "completed", exited: false, outputs: {} },
		completedAt: 2,
		topology: { version: 1, stageId: "boundary", parentIds: [], run: rootRun },
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: `workflow:pooled-child:1:session:${worker.getSessionId()}:1`,
		name: "implement",
		replayKey: childStageKey,
		output: "implemented",
		sessionId: worker.getSessionId(),
		completedAt: 2,
		topology: { version: 1, stageId: "implement", parentIds: [], run: childRun },
	});
	await backend.commitWorkflowStatus(runId, "completed");
	return { runId, childRunId, sessionId: worker.getSessionId() };
}

/**
 * A machine that ran a root with shared placement and a root without it on one libSQL journal, then restarted: the
 * shared root's pooled stage session is in the journal's pool tables, the other's in the machine's coordination
 * database, and nothing in this process registers either.
 */
async function restartedMixedMachine() {
	const directory = makeLibsqlDirectory("pooled-mixed-placement-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const before = await openJournal(directory);
	const coordination = await openCoordinationJournal(coordinationPath(poolDurableJournal(before)));
	registerPoolJournal(before, coordination);
	await openSqlPoolQueue(coordination);
	await openSqlPoolQueue(before);
	const running = await JournalDurableBackend.open(before);
	let roots: Record<Placement, PooledRoot>;
	try {
		roots = {
			shared: await finishedRoot(running, before, before, testRunId("mixed-shared-root"), "shared", directory),
			local: await finishedRoot(running, before, coordination, testRunId("mixed-local-root"), "local", directory),
		};
	} finally {
		await running.close();
		await closeCoordinationJournals();
	}
	const journal = await openJournal(directory);
	const backend = await JournalDurableBackend.open(journal);
	cleanups.push(async () => {
		await backend.close();
		await closeCoordinationJournals();
	});
	return {
		directory,
		journal,
		backend,
		roots,
		coordination: await openCoordinationJournal(coordinationPath(poolDurableJournal(journal))),
	};
}

const forkRequest = (runId: string, cwd: string, sessionStore = new MemorySessionStore()) => ({
	source: "sdk" as const,
	runId,
	carryMessages: "before" as const,
	definition,
	cwd,
	sourceSessionStore: new MemorySessionStore(),
	sessionStore,
});

test("after a restart, the catalog and post-mortem chat reopen the pooled stages of a shared root and a non-shared root on one journal (#4357)", async () => {
	const machine = await restartedMixedMachine();
	const runStore = createStore();
	configureTestStoreBackend(runStore, machine.backend);
	const registry = createStageControlRegistry();
	const entries = listCompletedFromBackend(machine.backend);
	const reopened: Record<string, unknown> = {};
	for (const [placement, root] of Object.entries(machine.roots)) {
		const entry = entries.find((candidate) => candidate.workflowId === root.runId);
		assert.ok(entry !== undefined, root.runId);
		const runs = await completedWorkflowRunSnapshots(machine.backend, entry, new MemorySessionStore());
		const child = runs.find((run: RunSnapshot) => run.id === root.childRunId);
		const stage = child?.stages.find((candidate) => candidate.name === "implement");
		assert.equal(stage?.sessionId, root.sessionId, `the catalog keeps ${root.runId}'s pooled stage session`);
		for (const run of runs) runStore.recordRunStart(run);
		const outcome = await ensurePostMortemStageHandle(
			root.childRunId,
			stage!,
			postMortemDepsForRun(root.childRunId, {
				adapters: { sessionStore: new MemorySessionStore(), agentSession: { create: async () => assert.fail() } },
				resolveDefaultStageSessionDir: () => undefined,
				store: runStore,
				stageControlRegistry: registry,
			}),
		);
		reopened[placement] = outcome.ok ? "reopened" : outcome.reason;
	}
	registry.clear();
	assert.deepEqual(reopened, { shared: "reopened", local: "reopened" });
});

test("a fork copies its child stages' sessions where its recorded placement keeps its pool, on a machine that runs both (#4357)", async () => {
	const machine = await restartedMixedMachine();
	const copiedTo: Record<string, readonly boolean[]> = {};
	for (const [placement, root] of Object.entries(machine.roots)) {
		const fork = await forkDurableRun(machine.backend, forkRequest(root.runId, machine.directory));
		const copy = machine.backend.getStageSession(fork.runId, childStageKey)?.sessionId;
		assert.ok(copy !== undefined && copy !== root.sessionId, root.runId);
		copiedTo[placement] = [await holds(machine.journal, copy), await holds(machine.coordination, copy)];
	}
	assert.deepEqual(copiedTo, { shared: [true, false], local: [false, true] }, "[in the journal, on this machine]");
});

test("a shared root's fork that has not run yet is read from its journal by a later fork and by post-mortem chat (#4357)", async () => {
	const machine = await restartedMixedMachine();
	const fork = await forkDurableRun(machine.backend, forkRequest(machine.roots.shared.runId, machine.directory));
	const copy = machine.backend.getStageSession(fork.runId, childStageKey)?.sessionId;
	assert.ok(copy !== undefined);
	const listed: (string | undefined)[] = [];
	for await (const point of durableForkPoints(machine.backend, fork.runId, {
		sourceSessionStore: new MemorySessionStore(),
	}))
		listed.push(point.sessionId);
	assert.ok(listed.includes(copy), "a later fork lists the copy from the journal");

	const runStore = createStore();
	configureTestStoreBackend(runStore, machine.backend);
	const childRunId = machine.backend
		.listCheckpoints(fork.runId)
		.flatMap((checkpoint) => (checkpoint.kind === "stage" && checkpoint.sessionId === copy ? [checkpoint] : []))[0]
		?.topology?.run?.runId;
	assert.ok(childRunId !== undefined);
	runStore.recordRunStart({
		id: childRunId,
		name: "pooled-child",
		inputs: {},
		status: "completed",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		parentRunId: fork.runId,
		parentStageId: "boundary",
		rootRunId: fork.runId,
	});
	const sessions = await postMortemDepsForRun(childRunId, {
		adapters: {} as never,
		resolveDefaultStageSessionDir: () => undefined,
		store: runStore,
	}).pooledSessionStore?.();
	try {
		assert.equal((await sessions?.readHeader(copy))?.id, copy, "post-mortem chat reopens the fork's copy");
	} finally {
		await sessions?.close();
	}
});

test("a fork of a shared root whose journal has no pool tables fails with ForkPoolSessionsUnavailableError before copying anything (#4357)", async () => {
	const directory = makeLibsqlDirectory("pooled-shared-no-tables-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const journal = await openJournal(directory);
	const backend = await JournalDurableBackend.open(journal);
	cleanups.push(() => backend.close());
	const runId = testRunId("shared-root-without-pool");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: directory,
		resources: { localWorkers, workers: { placement: "shared" } },
	});
	const host = new MemorySessionStore();
	const stages = [
		{ name: "plan", run: { runId, runName: definition.name } },
		{ name: "implement", run: { runId: "child", runName: "pooled-child", parentRunId: runId, rootRunId: runId } },
	];
	for (const [index, { name, run }] of stages.entries()) {
		const session = await SessionManager.create(host, directory);
		await session.appendMessage({ role: "user", content: name, timestamp: 1 });
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `stage:${name}`,
			name,
			replayKey: `stage:${name}:1`,
			output: name,
			sessionId: session.getSessionId(),
			completedAt: index + 1,
			topology: { version: 1, stageId: `${name}-id`, parentIds: [], run },
		});
	}
	const destination = new MemorySessionStore();
	const creates = vi.spyOn(destination, "create");
	const poolCreates = vi.spyOn(SqlSessionStore.prototype, "create");
	const writes = vi.spyOn(journal as Required<Pick<RunJournal, "createRunWithEvents">>, "createRunWithEvents");
	await assert.rejects(
		forkDurableRun(backend, { ...forkRequest(runId, directory, destination), sourceSessionStore: host }),
		(error: unknown) => {
			assert.ok(error instanceof ForkPoolSessionsUnavailableError, String(error));
			assert.ok(isForkPoolSessionsUnavailableError(error));
			assert.equal(isRetryableForkError(error), false);
			assert.deepEqual(
				[error.code, error.runId, error.placement, error.retryable],
				["pool-sessions-unavailable", runId, "shared", false],
			);
			assert.deepEqual(error.fields, { runId, forkRunId: error.forkRunId, placement: "shared" });
			assert.equal(
				error.hint,
				`Nothing was written. No pool of run ${runId} ran on this journal; fork it from a stage before its child workflows ran with /workflow fork ${runId} --from <stage>.`,
			);
			return true;
		},
	);
	assert.equal(creates.mock.calls.length, 0, "the root stage's session was not copied first");
	assert.equal(poolCreates.mock.calls.length, 0, "nothing was copied into any pool tables");
	assert.equal(writes.mock.calls.length, 0, "no fork run was written");
});
