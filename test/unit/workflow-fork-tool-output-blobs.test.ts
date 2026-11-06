import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { sessionBlobOutput } from "../../packages/coding-agent/src/core/session-tool-output.ts";
import { isSessionBlobError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isForkCopyFailedError } from "../../packages/workflows/src/durable/fork-errors.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { forkStageSession } from "../../packages/workflows/src/shared/stage-session-store.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

useTemporaryAgentDir();

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

const OUTPUT = "a released stage's whole output";
const HASH = createHash("sha256").update(OUTPUT, "utf8").digest("hex");

/** A stage session whose released stage kept `OUTPUT` as a blob, between two messages. */
async function stageSession(store: SessionStore) {
	const manager = await SessionManager.create(store, process.cwd());
	const before = await manager.appendMessage({ role: "user", content: "run it", timestamp: 1 });
	await sessionBlobOutput(manager, "call-1")!(OUTPUT);
	await manager.appendMessage({ role: "user", content: "after", timestamp: 2 });
	return { manager, before };
}

/** `store` without its blobs, as a custom store may be; `creates` counts the sessions it was asked to create. */
function blobless(store: SessionStore): SessionStore & { readonly creates: string[] } {
	const creates: string[] = [];
	return {
		creates,
		descriptor: { adapter: "custom", location: "custom" },
		create: (header, entries) => {
			creates.push(header.id);
			return store.create(header, entries);
		},
		append: (sessionId, entries, options) => store.append(sessionId, entries, options),
		replace: (sessionId, header, entries, options) => store.replace(sessionId, header, entries, options),
		load: (sessionId) => store.load(sessionId),
		readHeader: (sessionId) => store.readHeader(sessionId),
		delete: (sessionId) => store.delete(sessionId),
		list: (query) => store.list(query),
		findMostRecent: (query) => store.findMostRecent(query),
		close: () => store.close(),
	};
}

async function sessionIds(store: SessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({ includeInternal: true })) ids.push(summary.id);
	return ids;
}

test("a forked stage session holds the blobs its copied entries reference (#4379)", async () => {
	const source = new MemorySessionStore();
	const destination = new MemorySessionStore();
	const { manager, before } = await stageSession(source);

	const whole = await forkStageSession(source, manager.getSessionId(), process.cwd(), {}, destination);
	const atStart = await forkStageSession(source, manager.getSessionId(), process.cwd(), {}, destination, before);
	await source.delete(manager.getSessionId());

	assert.equal(Buffer.from((await destination.getBlob(whole.getSessionId(), HASH))!).toString(), OUTPUT);
	assert.equal(await destination.getBlob(atStart.getSessionId(), HASH), undefined, "the branch has no reference");
});

test("a stage session fork into a store that holds no blobs fails before it writes (#4379)", async () => {
	const source = new MemorySessionStore();
	const inner = new MemorySessionStore();
	const { manager } = await stageSession(source);

	const destination = blobless(inner);

	await assert.rejects(
		forkStageSession(source, manager.getSessionId(), process.cwd(), {}, destination),
		(error) => isSessionBlobError(error) && error.code === "blobs-unsupported" && error.adapter === "custom",
	);
	assert.deepEqual(destination.creates, []);
	assert.deepEqual(await sessionIds(inner), []);
});

async function forkedRun(destination: SessionStore, source = new MemorySessionStore()) {
	const backend = await createMemoryTestBackend();
	const { manager } = await stageSession(source);
	const def = workflow({
		name: "fork-tool-output",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("saved", { prompt: "saved" });
			await ctx.stage("next").complete("next");
			return {};
		},
	});
	const runId = testRunId("fork-tool-output-source");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: def.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: join(process.cwd(), "source"),
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "task:stage:task:saved:1",
		name: "saved",
		replayKey: "stage:task:saved:1",
		sessionId: manager.getSessionId(),
		output: { name: "saved", stageName: "saved", text: "saved", sessionId: manager.getSessionId() },
		completedAt: 2,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:stage:next:1",
		name: "next",
		replayKey: "stage:next:1",
		output: "next",
		completedAt: 3,
	});
	const fork = () =>
		forkDurableRun(backend, {
			source: "sdk",
			runId,
			fromStage: "next",
			cwd: process.cwd(),
			carryMessages: "before",
			definition: def,
			sessionStore: destination,
			sourceSessionStore: source,
		});
	return { backend, fork };
}

test("a forked run's copied stage sessions hold the blobs of the sessions they copy (#4379)", async () => {
	const destination = new MemorySessionStore();
	const { backend, fork } = await forkedRun(destination);

	const { runId } = await fork();

	const copied = backend.listCheckpoints(runId).find((checkpoint) => checkpoint.kind === "stage");
	assert.ok(copied?.kind === "stage" && copied.sessionId !== undefined);
	assert.equal(Buffer.from((await destination.getBlob(copied.sessionId, HASH))!).toString(), OUTPUT);
});

test("a forked run whose session store holds no blobs fails its copy and leaves no copied session (#4379)", async () => {
	const inner = new MemorySessionStore();
	const destination = blobless(inner);
	const { fork } = await forkedRun(destination);

	await assert.rejects(fork(), (error) => {
		assert.ok(isForkCopyFailedError(error));
		assert.ok(isSessionBlobError(error.cause));
		assert.equal(error.cause.code, "blobs-unsupported");
		return true;
	});
	assert.deepEqual(destination.creates, [], "the copy failed before it created a session");
	assert.deepEqual(await sessionIds(inner), []);
});

test("a source store that fails to read a blob fails the copy, which is retryable and leaves no copied session (#4379)", async () => {
	const source = new MemorySessionStore();
	const failure = new StorageUnavailableError(source.descriptor, new Error("disk read failed"));
	const destination = new MemorySessionStore();
	const { fork } = await forkedRun(destination, source);
	source.getBlob = async () => {
		throw failure;
	};

	await assert.rejects(fork(), (error) => {
		assert.ok(isForkCopyFailedError(error));
		assert.equal(error.retryable, true);
		assert.equal(error.cause, failure);
		return true;
	});
	assert.deepEqual(await sessionIds(destination), []);
});
