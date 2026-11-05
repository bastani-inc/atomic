import assert from "node:assert/strict";
import { join } from "node:path";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	ForkCleanupError,
	ForkCopyFailedError,
	ForkSessionNotFoundError,
	ForkSessionUnavailableError,
	isForkCleanupError,
	isForkSessionNotFoundError,
	isForkSessionUnavailableError,
	isRetryableForkError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import * as poolSessionStores from "../../packages/workflows/src/workers/pool-session-store.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sessionIds(store: MemorySessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({ includeInternal: true })) ids.push(summary.id);
	return ids;
}

const definition = workflow({ name: "pooled-source", description: "", inputs: {}, outputs: {}, run: async () => ({}) });

async function pooledSource(seed: string, stages: readonly string[] = ["implement"], missing?: string) {
	const directory = makeTempDirectory("fork-pool-sessions-");
	cleanups.push(() => removeTempDirectory(directory));
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	cleanups.push(() => backend.close());
	await openSqlPoolQueue(backend.journal);
	const runId = testRunId(seed);
	const pool = await poolSessionStore(backend, runId);
	assert.ok(pool !== undefined, "the journal has pool session tables");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: directory,
	});
	const sessions = [];
	for (const [index, name] of [...stages, ...(missing === undefined ? [] : [missing])].entries()) {
		let sessionId = "missing-session";
		if (name !== missing) {
			const worker = await SessionManager.create(pool, directory);
			await worker.appendMessage({ role: "user", content: `${name} on a worker`, timestamp: 1 });
			sessionId = worker.getSessionId();
			sessions.push(await pool.load(sessionId));
		}
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `stage:${name}`,
			name,
			replayKey: `stage:${name}:1`,
			output: name,
			sessionId,
			completedAt: index + 1,
		});
	}
	await pool.close();
	return { backend, runId, sessions, directory };
}

const forkRequest = (
	runId: string,
	cwd: string,
	sourceSessionStore: MemorySessionStore,
	sessionStore: MemorySessionStore,
) => ({
	source: "sdk" as const,
	runId,
	carryMessages: "before" as const,
	definition,
	cwd,
	sourceSessionStore,
	sessionStore,
});

test("listForkPoints reads a stage session that a local worker kept in the journal (#4321)", async () => {
	const { backend, runId, sessions } = await pooledSource("fork-pool-points");
	const host = new MemorySessionStore();
	const points = [];
	for await (const point of durableForkPoints(backend, runId, { sourceSessionStore: host })) points.push(point);
	const [session] = sessions;
	assert.deepEqual(points, [
		{ stagePath: "implement", sessionId: session?.header.id, entryId: session?.entries.at(-1)?.id, completedAt: 1 },
	]);
	assert.deepEqual(await sessionIds(host), [], "the supplied store stays open and is not written");
});

test("forkRun copies a stage session that a local worker kept in the journal (#4321)", async () => {
	const { backend, runId, sessions, directory } = await pooledSource("fork-pool-copy");
	const host = new MemorySessionStore();
	const destination = new MemorySessionStore();
	const fork = await forkDurableRun(backend, forkRequest(runId, directory, host, destination));
	const [copy, ...more] = await sessionIds(destination);
	assert.ok(copy !== undefined, "the pooled session was copied into the fork's store");
	assert.deepEqual(more, []);
	const copied = await destination.load(copy);
	assert.equal(copied.header.parentSessionId, sessions[0]?.header.id);
	assert.equal(copied.header.workflow?.runId, fork.runId);
	assert.deepEqual(copied.entries, sessions[0]?.entries);
	const [checkpoint] = backend.listCheckpoints(fork.runId);
	assert.equal(checkpoint?.kind === "stage" ? checkpoint.sessionId : undefined, copy);
	assert.deepEqual(await sessionIds(host), [], "the supplied store stays open and is not written");
});

test("a stage session the supplied store holds is read without opening the journal's pool tables (#4321)", async () => {
	const { backend, runId, sessions } = await pooledSource("fork-pool-unopened");
	const host = new MemorySessionStore();
	const [session] = sessions;
	assert.ok(session !== undefined);
	await host.create(session.header, session.entries);
	const loads = vi.spyOn(SqlSessionStore.prototype, "load");
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const points = [];
	for await (const point of durableForkPoints(backend, runId, { sourceSessionStore: host })) points.push(point);
	assert.deepEqual(
		points.map((point) => point.entryId),
		[session.entries.at(-1)?.id],
	);
	assert.equal(loads.mock.calls.length, 0, "the pool session store was not read");
	assert.equal(closes.mock.calls.length, 0, "no pool session store was opened");
});

test("multiple pooled fork points reuse one reader and close it once (#4321)", async () => {
	const { backend, runId } = await pooledSource("fork-pool-reader-reuse", ["plan", "implement"]);
	const opens = vi.spyOn(poolSessionStores, "poolSessionStore");
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const listed: string[] = [];
	for await (const point of durableForkPoints(backend, runId, { sourceSessionStore: new MemorySessionStore() }))
		listed.push(point.stagePath);
	assert.deepEqual(listed, ["plan", "implement"]);
	assert.equal(opens.mock.calls.length, 1);
	assert.equal(closes.mock.calls.length, 1);
});

test("a listing stopped early closes the pool session store it opened (#4321)", async () => {
	const { backend, runId } = await pooledSource("fork-pool-early-stop", ["plan", "implement"]);
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const listed: string[] = [];
	for await (const point of durableForkPoints(backend, runId, { sourceSessionStore: new MemorySessionStore() })) {
		listed.push(point.stagePath);
		break;
	}
	assert.deepEqual(listed, ["plan"]);
	assert.equal(closes.mock.calls.length, 1, "the pool session store was closed once");
});

test("a session in neither the supplied store nor the journal's pool tables is reported as not found (#4321)", async () => {
	const { backend, runId } = await pooledSource("fork-pool-missing", ["implement"], "review");
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const listed: string[] = [];
	await assert.rejects(
		async () => {
			for await (const point of durableForkPoints(backend, runId, { sourceSessionStore: new MemorySessionStore() }))
				listed.push(point.stagePath);
		},
		(error: unknown) => {
			assert.ok(error instanceof ForkSessionNotFoundError);
			assert.ok(isForkSessionNotFoundError(error));
			assert.equal(error.code, "session-not-found");
			assert.equal(error.sessionId, "missing-session");
			assert.equal(error.stagePath, "review");
			assert.equal(error.storeSource, "supplied");
			assert.equal(error.retryable, false);
			assert.equal(error.cleanupCause, undefined);
			return true;
		},
	);
	assert.deepEqual(listed, ["implement"], "the pooled stage before the missing one is still listed");
	assert.equal(closes.mock.calls.length, 1, "the pool session store was closed once");
});

test("a pool session store that cannot be read fails the fork as a retryable ForkSessionUnavailableError that writes nothing (#4321)", async () => {
	const { backend, runId, sessions, directory } = await pooledSource("fork-pool-unavailable");
	const failure = new StorageUnavailableError(
		{ adapter: "pool-journal", location: "pool" },
		new Error("database is locked"),
	);
	vi.spyOn(SqlSessionStore.prototype, "load").mockRejectedValue(failure);
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const destination = new MemorySessionStore();
	await assert.rejects(
		forkDurableRun(backend, forkRequest(runId, directory, new MemorySessionStore(), destination)),
		(error: unknown) => {
			assert.ok(error instanceof ForkSessionUnavailableError);
			assert.ok(isForkSessionUnavailableError(error));
			assert.ok(isRetryableForkError(error));
			assert.equal(error.code, "session-unavailable");
			assert.equal(error.retryable, true);
			assert.equal(error.sessionId, sessions[0]?.header.id);
			assert.equal(error.runId, runId);
			assert.deepEqual(error.storage, { adapter: "node-sqlite", scope: "local-only" });
			assert.equal(error.cause, failure);
			return true;
		},
	);
	assert.equal(closes.mock.calls.length, 1, "the pool session store was closed once");
	assert.deepEqual(await sessionIds(destination), [], "no session was copied");
	assert.deepEqual(
		(await backend.journal.listRuns()).map((run) => run.runId),
		[runId],
		"no fork run was written",
	);
});

test("a pooled reader close failure is reported once with its typed cleanup step without losing the points (#4321)", async () => {
	const { backend, runId } = await pooledSource("fork-pool-close-failure");
	const failure = new Error("reader close failed");
	vi.spyOn(SqlSessionStore.prototype, "close").mockRejectedValue(failure);
	const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const listed: string[] = [];
	for await (const point of durableForkPoints(backend, runId, { sourceSessionStore: new MemorySessionStore() }))
		listed.push(point.stagePath);
	assert.deepEqual(listed, ["implement"]);
	assert.equal(warned.mock.calls.length, 1);
	const [error, ...extra] = warned.mock.calls[0]!;
	assert.ok(error instanceof ForkCleanupError);
	assert.ok(isForkCleanupError(error));
	assert.deepEqual(
		[error.code, error.step, error.runId, error.retryable],
		["cleanup-failed", "close-source-sessions", runId, false],
	);
	assert.equal(error.cause, failure);
	assert.deepEqual(extra, []);
});

test("an unexpected pool reader exception propagates instead of being recast as unavailable storage (#4321)", async () => {
	const { backend, runId, directory } = await pooledSource("fork-pool-unexpected-failure");
	const failure = new TypeError("reader invariant failed");
	vi.spyOn(SqlSessionStore.prototype, "load").mockRejectedValue(failure);
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const destination = new MemorySessionStore();
	await assert.rejects(
		forkDurableRun(backend, forkRequest(runId, directory, new MemorySessionStore(), destination)),
		(error) => error === failure,
	);
	assert.equal(closes.mock.calls.length, 1);
	assert.deepEqual(await sessionIds(destination), []);
	assert.deepEqual(
		(await backend.journal.listRuns()).map((run) => run.runId),
		[runId],
	);
});

/**
 * A paused run with local workers: a root stage finished in the host's store, and a stage of its child, which ran on a
 * worker, stopped mid-conversation with its session in the pool tables.
 */
async function pausedWorkerSource(seed: string) {
	const directory = makeTempDirectory("fork-pool-paused-");
	cleanups.push(() => removeTempDirectory(directory));
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	cleanups.push(() => backend.close());
	await openSqlPoolQueue(backend.journal);
	const runId = testRunId(seed);
	const pool = await poolSessionStore(backend, runId);
	assert.ok(pool !== undefined);
	const host = new MemorySessionStore();
	const childId = testRunId(`${seed}-child`);
	const scope = "workflow:impl:fp:1";
	const plan = await SessionManager.create(host, directory);
	await plan.appendMessage({ role: "user", content: "plan in the root", timestamp: 1 });
	const worker = await SessionManager.create(pool, directory);
	await worker.appendMessage({ role: "user", content: "implement on a worker", timestamp: 1 });
	const workerEntries = (await pool.load(worker.getSessionId())).entries;
	await pool.close();
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: directory,
		resources: { localWorkers: { count: 1, definitions: [] } },
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:plan",
		name: "plan",
		replayKey: "stage:plan:1",
		output: "planned",
		sessionId: plan.getSessionId(),
		completedAt: 1,
		topology: { version: 1, stageId: "plan-id", parentIds: [], run: { runId, runName: "root" } },
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: `${scope}:session:${worker.getSessionId()}:1`,
		name: "implement",
		replayKey: `${scope}:stage:implement:1`,
		sessionId: worker.getSessionId(),
		completedAt: 2,
		topology: {
			version: 1,
			stageId: "implement-id",
			parentIds: [],
			run: { runId: childId, runName: "impl", parentRunId: runId, rootRunId: runId },
		},
	});
	return { backend, runId, childId, host, workerSession: worker.getSessionId(), workerEntries, directory };
}

async function poolSession(source: { readonly backend: JournalDurableBackend; readonly runId: string }, id: string) {
	const pool = await poolSessionStore(source.backend, source.runId);
	assert.ok(pool !== undefined);
	try {
		return await pool.readHeader(id);
	} finally {
		await pool.close();
	}
}

test("a fork of a run with local workers copies a child stage's session into the pool tables for the fork's child run, and a root stage's into the fork's store (#4321)", async () => {
	const source = await pausedWorkerSource("fork-pool-paused");
	const destination = new MemorySessionStore();
	const fork = await forkDurableRun(
		source.backend,
		forkRequest(source.runId, source.directory, source.host, destination),
	);
	const resumed = source.backend.getStageSession(fork.runId, "workflow:impl:fp:1:stage:implement:1");
	assert.ok(resumed?.sessionId !== undefined && resumed.sessionId !== source.workerSession);
	assert.equal(resumed.sessionFile, undefined, "a worker reopens its session by id");
	const [checkpoint] = source.backend
		.listCheckpoints(fork.runId)
		.filter((entry) => entry.kind === "stage" && entry.sessionId === resumed.sessionId);
	const forkedChild = checkpoint?.kind === "stage" ? checkpoint.topology?.run?.runId : undefined;
	assert.ok(forkedChild !== undefined && forkedChild !== source.childId && forkedChild !== fork.runId);
	const header = await poolSession(source, resumed.sessionId);
	assert.deepEqual(
		header && {
			parentSessionId: header.parentSessionId,
			internal: header.internal,
			workflow: header.workflow,
		},
		{
			parentSessionId: source.workerSession,
			internal: true,
			workflow: { runId: forkedChild, stageId: "implement-id", stageName: "implement" },
		},
	);
	const pool = await poolSessionStore(source.backend, source.runId);
	assert.deepEqual((await pool!.load(resumed.sessionId)).entries, source.workerEntries);
	await pool!.close();
	const copies = await sessionIds(destination);
	assert.equal(copies.length, 1, "only the root stage's session goes to the fork's store");
	assert.equal((await destination.load(copies[0]!)).header.workflow?.runId, fork.runId);
	assert.equal(await destination.readHeader(resumed.sessionId), undefined);
});

test("a fork whose journal write fails removes its copies from the pool tables and the fork's store (#4321)", async () => {
	const source = await pausedWorkerSource("fork-pool-paused-write-fails");
	const destination = new MemorySessionStore();
	const created: string[] = [];
	const create = SqlSessionStore.prototype.create;
	vi.spyOn(SqlSessionStore.prototype, "create").mockImplementation(async function (
		this: SqlSessionStore,
		header,
		entries,
	) {
		created.push(header.id);
		return create.call(this, header, entries);
	});
	vi.spyOn(source.backend.journal, "createRunWithEvents").mockRejectedValue(new Error("disk full"));
	await assert.rejects(
		forkDurableRun(source.backend, forkRequest(source.runId, source.directory, source.host, destination)),
		(error: unknown) => error instanceof ForkCopyFailedError && error.cleanupCause === undefined,
	);
	assert.equal(created.length, 1, "the child stage's session was copied into the pool tables");
	assert.equal(await poolSession(source, created[0]!), undefined, "and removed again");
	assert.ok((await poolSession(source, source.workerSession)) !== undefined, "the source's session stays");
	assert.deepEqual(await sessionIds(destination), []);
});

interface SourceStage {
	readonly name: string;
	/** The run the stage belongs to: a child run, the root, or none recorded. */
	readonly run: "child" | "root" | "none";
	/** Where its session is: the journal's pool tables or the host's store. */
	readonly home: "pool" | "host";
}

/** A paused source with the given stages, with or without local workers, and with or without pool tables. */
async function stagedSource(
	seed: string,
	options: { readonly localWorkers: boolean; readonly poolTables: boolean; readonly stages: readonly SourceStage[] },
) {
	const directory = makeTempDirectory("fork-pool-staged-");
	cleanups.push(() => removeTempDirectory(directory));
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	cleanups.push(() => backend.close());
	if (options.poolTables) await openSqlPoolQueue(backend.journal);
	const runId = testRunId(seed);
	const pool = options.poolTables ? await poolSessionStore(backend, runId) : undefined;
	const host = new MemorySessionStore();
	const childId = testRunId(`${seed}-child`);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: directory,
		...(options.localWorkers ? { resources: { localWorkers: { count: 1, definitions: [] } } } : {}),
	});
	const sessions = new Map<string, string>();
	for (const [index, stage] of options.stages.entries()) {
		const store = stage.home === "pool" ? pool : host;
		assert.ok(store !== undefined);
		const session = await SessionManager.create(store, directory);
		await session.appendMessage({ role: "user", content: stage.name, timestamp: 1 });
		sessions.set(stage.name, session.getSessionId());
		const run =
			stage.run === "child"
				? { runId: childId, runName: "impl", parentRunId: runId, rootRunId: runId }
				: { runId, runName: "root" };
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `workflow:impl:fp:1:session:${stage.name}`,
			name: stage.name,
			replayKey: `workflow:impl:fp:1:stage:${stage.name}:1`,
			sessionId: session.getSessionId(),
			completedAt: index + 1,
			...(stage.run === "none" ? {} : { topology: { version: 1, stageId: `${stage.name}-id`, parentIds: [], run } }),
		});
	}
	await pool?.close();
	return { backend, runId, host, sessions, directory };
}

test("a fork copies every child stage session into one pool session store, which it opens and closes once (#4321)", async () => {
	const source = await stagedSource("fork-pool-one-store", {
		localWorkers: true,
		poolTables: true,
		stages: [
			{ name: "first", run: "child", home: "pool" },
			{ name: "second", run: "child", home: "pool" },
		],
	});
	const creates = vi.spyOn(SqlSessionStore.prototype, "create");
	const closes = vi.spyOn(SqlSessionStore.prototype, "close");
	const destination = new MemorySessionStore();
	const fork = await forkDurableRun(
		source.backend,
		forkRequest(source.runId, source.directory, source.host, destination),
	);
	assert.equal(creates.mock.instances.length, 2);
	assert.equal(creates.mock.instances[0], creates.mock.instances[1], "both copies go to one pool session store");
	assert.equal(
		closes.mock.calls.length,
		2,
		"the pool store read from and the pool store written to are each closed once",
	);
	assert.ok(closes.mock.instances.includes(creates.mock.instances[0]!));
	assert.deepEqual(await sessionIds(destination), []);
	for (const name of ["first", "second"]) {
		const copy = source.backend.getStageSession(fork.runId, `workflow:impl:fp:1:stage:${name}:1`)?.sessionId;
		assert.ok(copy !== undefined);
		assert.equal((await poolSession(source, copy))?.parentSessionId, source.sessions.get(name));
	}
});

test("a fork of a run with local workers fails before writing when the journal has no pool session tables for its copies (#4321)", async () => {
	const source = await stagedSource("fork-pool-no-tables", {
		localWorkers: true,
		poolTables: false,
		stages: [{ name: "implement", run: "child", home: "host" }],
	});
	const destination = new MemorySessionStore();
	await assert.rejects(
		forkDurableRun(source.backend, forkRequest(source.runId, source.directory, source.host, destination)),
		(error: unknown) => {
			assert.ok(error instanceof ForkCopyFailedError);
			assert.deepEqual([error.code, error.phase, error.retryable], ["copy-failed", "sessions", true]);
			assert.ok(error.cause instanceof Error);
			assert.equal(error.cause.message, "The journal has no pool session tables for the fork's workers");
			return true;
		},
	);
	assert.deepEqual(await sessionIds(destination), []);
	assert.deepEqual(
		(await source.backend.journal.listRuns()).map((run) => run.runId),
		[source.runId],
	);
});

test("a fork keeps a session in the fork's store when its run has no local workers, or its stage names no run (#4321)", async () => {
	for (const [label, localWorkers, run] of [
		["no local workers", false, "child"],
		["no recorded run", true, "none"],
	] as const) {
		const source = await stagedSource(`fork-pool-stays-${label.replaceAll(" ", "-")}`, {
			localWorkers,
			poolTables: true,
			stages: [{ name: "implement", run, home: "host" }],
		});
		const destination = new MemorySessionStore();
		const creates = vi.spyOn(SqlSessionStore.prototype, "create");
		const fork = await forkDurableRun(
			source.backend,
			forkRequest(source.runId, source.directory, source.host, destination),
		);
		const copy = source.backend.getStageSession(fork.runId, "workflow:impl:fp:1:stage:implement:1")?.sessionId;
		assert.ok(copy !== undefined, label);
		assert.equal((await destination.load(copy)).header.parentSessionId, source.sessions.get("implement"), label);
		assert.equal(creates.mock.calls.length, 0, `${label}: nothing is copied into the pool tables`);
		creates.mockRestore();
	}
});
