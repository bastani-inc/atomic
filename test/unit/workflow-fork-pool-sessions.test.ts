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
	const pool = await poolSessionStore(backend);
	assert.ok(pool !== undefined, "the journal has pool session tables");
	const runId = testRunId(seed);
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
