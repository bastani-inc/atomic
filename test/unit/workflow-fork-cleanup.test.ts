import assert from "node:assert/strict";
import type { SessionStore } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	ForkClaimReleaseError,
	ForkCleanupError,
	ForkCopyFailedError,
	ForkSessionNotFoundError,
	isForkError,
	rehydrateForkError,
	type SerializedForkError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

const stores = vi.hoisted(() => ({
	shared: undefined as SessionStore | undefined,
	opened: [] as { cwd: string | undefined; closes: number }[],
	closeFailures: new Map<string, Error>(),
	openFailures: new Map<string, Error>(),
}));

vi.mock("../../packages/workflows/src/shared/stage-session-store.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/workflows/src/shared/stage-session-store.js")>();
	return {
		...original,
		stageSessionStore: async (options: { cwd?: string }) => {
			const failure = stores.openFailures.get(options.cwd ?? "");
			if (failure !== undefined) throw failure;
			const entry = { cwd: options.cwd, closes: 0 };
			stores.opened.push(entry);
			return new Proxy(stores.shared!, {
				get(target, property) {
					if (property === "close")
						return async () => {
							entry.closes++;
							const failure = stores.closeFailures.get(options.cwd ?? "");
							if (failure !== undefined) throw failure;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

afterEach(async () => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
	stores.opened.length = 0;
	stores.closeFailures.clear();
	stores.openFailures.clear();
	stores.shared = undefined;
	await closeMemoryTestBackends();
});

const definition = workflow({
	name: "cleanup-source",
	description: "",
	inputs: {},
	outputs: {},
	run: async () => ({}),
});
const request = (runId: string) => ({
	source: "sdk" as const,
	runId,
	carryMessages: "before" as const,
	definition,
	cwd: "/destination",
});

function stage(runId: string, name: string, sessionId: string): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: runId,
		checkpointId: `stage:${name}`,
		name,
		replayKey: `stage:${name}:1`,
		completedAt: 1,
		output: name,
		sessionId,
	};
}

/** A paused source run in `/source` whose stages ran in the given sessions; missing ones are never created. */
async function sourceRun(label: string, sessions: readonly string[], missing: readonly string[] = []) {
	const backend = await createMemoryTestBackend();
	const shared = new MemorySessionStore();
	stores.shared = shared;
	const sourceId = testRunId(label);
	await backend.commitWorkflowRegistration({
		workflowId: sourceId,
		name: definition.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: "/source",
	});
	for (const name of sessions) {
		const session = await SessionManager.create(shared, "/source");
		await session.appendMessage({ role: "user", content: name, timestamp: 1 });
		await backend.commitCheckpoint(stage(sourceId, name, session.getSessionId()));
	}
	for (const sessionId of missing) await backend.commitCheckpoint(stage(sourceId, sessionId, sessionId));
	await backend.releaseWorkflow(sourceId);
	return { backend, shared, sourceId };
}

function warned(warn: { mock: { calls: unknown[][] } }): ForkCleanupError[] {
	return warn.mock.calls.map((call) => {
		assert.equal(call.length, 1, "each failure is logged on its own");
		assert.ok(call[0] instanceof ForkCleanupError);
		return call[0];
	});
}

test("a fork that was written resolves when closing its session stores fails, and logs each failure once (#4321)", async () => {
	const { backend, shared, sourceId } = await sourceRun("cleanup-written", ["plan"]);
	const sourceClose = new Error("source close failed");
	const destinationClose = new Error("destination close failed");
	stores.closeFailures.set("/source", sourceClose);
	stores.closeFailures.set("/destination", destinationClose);
	const writes = vi.spyOn(backend.journal, "createRunWithEvents");
	const hydrate = vi.spyOn(backend, "hydrateWorkflow");
	const deletes = vi.spyOn(shared, "delete");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const fork = await forkDurableRun(backend, request(sourceId));
	assert.deepEqual([writes.mock.calls.length, hydrate.mock.calls.length, deletes.mock.calls.length], [1, 1, 0]);
	assert.equal((await backend.journal.listRuns()).length, 2);
	assert.equal(backend.getWorkflow(fork.runId)?.forkedFrom?.runId, sourceId);
	assert.deepEqual(stores.opened, [
		{ cwd: "/source", closes: 1 },
		{ cwd: "/destination", closes: 1 },
	]);
	assert.deepEqual(
		warned(warn).map((failure) => [failure.step, failure.runId, failure.forkRunId, failure.cause]),
		[
			["close-source-sessions", sourceId, undefined, sourceClose],
			["close-destination-sessions", sourceId, fork.runId, destinationClose],
		],
	);
});

test("a missing source session stays the error when closing the source store also fails, and nothing is written (#4321)", async () => {
	const { backend, shared, sourceId } = await sourceRun("cleanup-missing", ["plan"], ["lost-session"]);
	const closeFailure = new Error("source close failed");
	stores.closeFailures.set("/source", closeFailure);
	const writes = vi.spyOn(backend.journal, "createRunWithEvents");
	const creates = vi.spyOn(shared, "create");
	const release = vi.spyOn(backend.journal, "release");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkDurableRun(backend, request(sourceId)).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkSessionNotFoundError);
	assert.ok(isForkError(error));
	assert.equal(error.sessionId, "lost-session");
	assert.ok(error.cleanupCause instanceof ForkCleanupError);
	assert.deepEqual(
		[error.cleanupCause.step, error.cleanupCause.runId, error.cleanupCause.forkRunId, error.cleanupCause.cause],
		["close-source-sessions", sourceId, undefined, closeFailure],
	);
	assert.deepEqual(
		[writes.mock.calls.length, creates.mock.calls.length, release.mock.calls.length, warn.mock.calls.length],
		[0, 0, 1, 0],
	);
	assert.equal((await backend.journal.listRuns()).length, 1);
	assert.deepEqual(stores.opened, [{ cwd: "/source", closes: 1 }]);
});

test("a failed session copy keeps its ForkCopyFailedError when removing the copies and closing the store both fail (#4321)", async () => {
	const { backend, shared, sourceId } = await sourceRun("cleanup-copy", ["plan", "build"]);
	const createFailure = new Error("store full");
	const deleteFailure = new Error("delete failed");
	const closeFailure = new Error("destination close failed");
	stores.closeFailures.set("/destination", closeFailure);
	const create = shared.create.bind(shared);
	const created: string[] = [];
	vi.spyOn(shared, "create").mockImplementation(async (header, entries) => {
		if (created.length === 1) throw createFailure;
		created.push(header.id);
		return create(header, entries);
	});
	const deletes = vi.spyOn(shared, "delete").mockRejectedValue(deleteFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkDurableRun(backend, request(sourceId)).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.deepEqual([error.phase, error.cause], ["sessions", createFailure]);
	assert.ok(error.cleanupCause instanceof AggregateError);
	assert.equal(error.cleanupCause.message, "2 fork cleanup steps failed");
	const [removal, close] = error.cleanupCause.errors as ForkCleanupError[];
	assert.ok(removal instanceof ForkCleanupError && close instanceof ForkCleanupError);
	assert.deepEqual(
		[removal.step, removal.forkRunId, removal.cause, close.step, close.forkRunId, close.cause],
		[
			"remove-copied-sessions",
			error.forkRunId,
			deleteFailure,
			"close-destination-sessions",
			error.forkRunId,
			closeFailure,
		],
	);
	assert.deepEqual(
		deletes.mock.calls.map(([id]) => id),
		created,
	);
	assert.equal(warn.mock.calls.length, 0);
	assert.equal((await backend.journal.listRuns()).length, 1);
	assert.deepEqual(stores.opened, [
		{ cwd: "/source", closes: 1 },
		{ cwd: "/destination", closes: 1 },
	]);
});

test("an abort while copying rejects with its reason and logs each failed cleanup step once (#4321)", async () => {
	const { backend, shared, sourceId } = await sourceRun("cleanup-abort", ["plan", "build"]);
	const deleteFailure = new Error("delete failed");
	const closeFailure = new Error("destination close failed");
	stores.closeFailures.set("/destination", closeFailure);
	const controller = new AbortController();
	const reason = new Error("caller cancelled");
	const create = shared.create.bind(shared);
	const created: string[] = [];
	vi.spyOn(shared, "create").mockImplementation(async (header, entries) => {
		created.push(header.id);
		const result = await create(header, entries);
		controller.abort(reason);
		return result;
	});
	const deletes = vi.spyOn(shared, "delete").mockRejectedValue(deleteFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkDurableRun(backend, { ...request(sourceId), signal: controller.signal }).catch(
		(problem: Error) => problem,
	);
	assert.equal(error, reason);
	assert.deepEqual(
		deletes.mock.calls.map(([id]) => id),
		created,
	);
	assert.equal(created.length, 1);
	assert.deepEqual(
		warned(warn).map((failure) => [failure.step, failure.cause]),
		[
			["remove-copied-sessions", deleteFailure],
			["close-destination-sessions", closeFailure],
		],
	);
	assert.equal((await backend.journal.listRuns()).length, 1);
});

test("every cleanup failure and a failed claim release stay on the primary error in order, across the wire too (#4321)", async () => {
	const { backend, shared, sourceId } = await sourceRun("cleanup-all", ["plan"]);
	const journalFailure = new Error("disk full");
	const deleteFailure = new Error("delete failed");
	const closeFailure = new Error("destination close failed");
	const releaseFailure = new Error("release failed");
	stores.closeFailures.set("/destination", closeFailure);
	vi.spyOn(backend.journal, "createRunWithEvents").mockRejectedValue(journalFailure);
	vi.spyOn(shared, "delete").mockRejectedValue(deleteFailure);
	const release = vi.spyOn(backend.journal, "release").mockRejectedValue(releaseFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkDurableRun(backend, request(sourceId)).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.deepEqual([error.phase, error.cause], ["journal", journalFailure]);
	assert.ok(error.cleanupCause instanceof AggregateError);
	assert.equal(error.cleanupCause.message, "3 fork cleanup steps failed");
	const [removal, close, released] = error.cleanupCause.errors as Error[];
	assert.ok(removal instanceof ForkCleanupError && close instanceof ForkCleanupError);
	assert.ok(released instanceof ForkClaimReleaseError);
	assert.deepEqual(
		[removal.step, removal.cause, close.step, close.cause, released.runId, released.cause],
		["remove-copied-sessions", deleteFailure, "close-destination-sessions", closeFailure, sourceId, releaseFailure],
	);
	assert.deepEqual([release.mock.calls.length, warn.mock.calls.length], [1, 0]);
	const back = rehydrateForkError(JSON.parse(JSON.stringify(error)) as SerializedForkError);
	assert.ok(back instanceof ForkCopyFailedError);
	assert.ok(back.cleanupCause instanceof AggregateError);
	assert.deepEqual(
		(back.cleanupCause.errors as Error[]).map((failure) => [
			failure.constructor,
			(failure as ForkCleanupError).fields,
		]),
		[
			[ForkCleanupError, removal.fields],
			[ForkCleanupError, close.fields],
			[ForkClaimReleaseError, released.fields],
		],
	);
});

test("fork points finish, or keep their own error, when closing the source store fails (#4321)", async () => {
	const { backend, sourceId } = await sourceRun("cleanup-points", ["plan", "build"], ["lost-session"]);
	const closeFailure = new Error("source close failed");
	stores.closeFailures.set("/source", closeFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const first = [];
	for await (const point of durableForkPoints(backend, sourceId)) {
		first.push(point.stagePath);
		break;
	}
	assert.deepEqual(first, ["plan"]);
	assert.deepEqual(
		warned(warn).map((failure) => [failure.step, failure.runId, failure.forkRunId, failure.cause]),
		[["close-source-sessions", sourceId, undefined, closeFailure]],
	);
	warn.mockClear();
	const listed: string[] = [];
	const error = await (async () => {
		for await (const point of durableForkPoints(backend, sourceId)) listed.push(point.stagePath);
	})().catch((problem: Error) => problem);
	assert.deepEqual(listed, ["plan", "build"]);
	assert.ok(error instanceof ForkSessionNotFoundError);
	assert.ok(error.cleanupCause instanceof ForkCleanupError);
	assert.deepEqual([error.cleanupCause.step, error.cleanupCause.cause], ["close-source-sessions", closeFailure]);
	assert.equal(warn.mock.calls.length, 0);
	assert.deepEqual(stores.opened, [
		{ cwd: "/source", closes: 1 },
		{ cwd: "/source", closes: 1 },
	]);
});

test("a complete fork-point listing logs a failed close of the source store once and lists every point (#4321)", async () => {
	const { backend, sourceId } = await sourceRun("cleanup-points-complete", ["plan", "build"]);
	const closeFailure = new Error("source close failed");
	stores.closeFailures.set("/source", closeFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const listed: string[] = [];
	for await (const point of durableForkPoints(backend, sourceId)) listed.push(point.stagePath);
	assert.deepEqual(listed, ["plan", "build"]);
	assert.deepEqual(
		warned(warn).map((failure) => [failure.step, failure.forkRunId, failure.cause]),
		[["close-source-sessions", undefined, closeFailure]],
	);
	assert.deepEqual(stores.opened, [{ cwd: "/source", closes: 1 }]);
});

test("a destination session store that cannot be opened is a ForkCopyFailedError with nothing to clean up (#4321)", async () => {
	const { backend, sourceId } = await sourceRun("cleanup-open", ["plan"]);
	const openFailure = new Error("EACCES");
	stores.openFailures.set("/destination", openFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkDurableRun(backend, request(sourceId)).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.deepEqual([error.phase, error.cause, error.retryable], ["sessions", openFailure, true]);
	assert.equal(Object.hasOwn(error, "cleanupCause"), false);
	assert.equal(warn.mock.calls.length, 0);
	assert.deepEqual(stores.opened, [{ cwd: "/source", closes: 1 }]);
	assert.equal((await backend.journal.listRuns()).length, 1);
});
