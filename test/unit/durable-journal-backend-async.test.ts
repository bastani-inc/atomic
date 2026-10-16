import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	JournalBackendClosedError,
	JournalDurableBackend,
	JournalExecutionRetiredError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const backends: JournalDurableBackend[] = [];
async function open() {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	backends.push(backend);
	await backend.registerWorkflow({ workflowId: "run", name: "test", inputs: {}, createdAt: 1, status: "paused" });
	return { backend, journal };
}
function checkpoint(id = "one", workflowId = "run") {
	return {
		kind: "tool" as const,
		workflowId,
		checkpointId: id,
		name: "tool",
		argsHash: id,
		output: id,
		completedAt: 2,
	};
}

afterEach(async () => {
	for (const backend of backends.splice(0)) await backend.close();
	vi.useRealTimers();
});

test("a status claim racing a checkpoint serializes one run without blocking another", async () => {
	const { backend, journal } = await open();
	await backend.registerWorkflow({ workflowId: "other", name: "test", inputs: {}, createdAt: 1, status: "running" });
	const entered = gate();
	const proceed = gate();
	const append = journal.append.bind(journal);
	const events: string[] = [];
	journal.append = async (lease, event, options) => {
		if (lease.runId === "run" && event.type === RUN_EVENT_TYPES.statusChanged) {
			entered.resolve();
			await proceed.promise;
		}
		events.push(`${lease.runId}:${event.type}`);
		return append(lease, event, options);
	};
	const claim = backend.transitionWorkflowStatus("run", ["paused"], "running");
	await entered.promise;
	const saved = backend.recordCheckpoint(checkpoint());
	try {
		await backend.recordCheckpoint(checkpoint("independent", "other"));
		assert.equal(backend.getToolOutput("other", "independent"), "independent");
		assert.equal(backend.getToolOutput("run", "one"), undefined);
	} finally {
		proceed.resolve();
	}
	assert.equal(await claim, true);
	await saved;
	assert.equal(backend.getWorkflow("run")?.status, "running");
	assert.equal(backend.getToolOutput("run", "one"), "one");
	assert.deepEqual(events, ["other:CheckpointRecorded", "run:StatusChanged", "run:CheckpointRecorded"]);
	assert.equal(await backend.transitionWorkflowStatus("run", ["paused"], "completed"), false);
});

test("owned appends fold their returned entry without rereading and duplicate keys cannot rewind the cursor", async () => {
	const { backend, journal } = await open();
	const read = journal.read.bind(journal);
	const append = journal.append.bind(journal);
	const operations: string[] = [];
	const readCursors: number[] = [];
	journal.read = (runId, fromSeq) => {
		operations.push("read");
		readCursors.push(fromSeq ?? 1);
		return read(runId, fromSeq);
	};
	journal.append = async (...args) => {
		operations.push("append");
		return append(...args);
	};
	await backend.recordCheckpoint(checkpoint());
	assert.equal(operations.at(-1), "append");
	await backend.recordCheckpoint(checkpoint("two"));
	await backend.recordCheckpoint({ ...checkpoint(), output: "discarded" });
	assert.equal(backend.getToolOutput("run", "one"), "one");
	assert.equal(backend.getToolOutput("run", "two"), "two");
	assert.equal(backend.listCheckpoints("run").length, 2);
	const beforeClaim = readCursors.length;
	assert.equal(await backend.transitionWorkflowStatus("run", ["paused"], "running"), true);
	const claimCursors = readCursors.slice(beforeClaim);
	assert.ok(claimCursors.length > 0);
	assert.ok(claimCursors.every((cursor) => cursor >= 4));
	const rows = [];
	for await (const entry of read("run")) rows.push(entry);
	assert.deepEqual(
		rows.map((entry) => entry.seq),
		[1, 2, 3, 4],
	);
});

test("close drains every accepted mutation before releasing and rejects new mutations immediately", async () => {
	const { backend, journal } = await open();
	const entered = gate();
	const proceed = gate();
	const append = journal.append.bind(journal);
	const release = journal.release.bind(journal);
	const close = journal.close.bind(journal);
	const operations: string[] = [];
	journal.append = async (...args) => {
		entered.resolve();
		await proceed.promise;
		const outcome = await append(...args);
		operations.push("append");
		return outcome;
	};
	journal.release = async (lease) => {
		operations.push("release");
		await release(lease);
	};
	journal.close = async () => {
		operations.push("close");
		await close();
	};
	const first = backend.recordCheckpoint(checkpoint());
	await entered.promise;
	const second = backend.recordCheckpoint(checkpoint("two"));
	const third = backend.setWorkflowStatus("run", "completed");
	const closing = backend.close();
	assert.equal(backend.close(), closing);
	try {
		await assert.rejects(backend.recordCheckpoint(checkpoint("late")), JournalBackendClosedError);
		assert.deepEqual(operations, []);
	} finally {
		proceed.resolve();
	}
	await Promise.all([first, second, third, closing]);
	assert.deepEqual(operations, ["append", "append", "append", "release", "close"]);
	assert.equal(backend.getWorkflow("run")?.status, "completed");
	await assert.rejects(backend.workflowOwnership("run"), JournalBackendClosedError);
});

test("renewal ticks share one in-flight renewal and release waits for it", async () => {
	vi.useFakeTimers();
	const { backend, journal } = await open();
	const entered = gate();
	const proceed = gate();
	const renew = journal.renew.bind(journal);
	const release = journal.release.bind(journal);
	const operations: string[] = [];
	journal.renew = async (lease) => {
		operations.push("renew");
		entered.resolve();
		await proceed.promise;
		await renew(lease);
	};
	journal.release = async (lease) => {
		operations.push("release");
		await release(lease);
	};
	await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	await entered.promise;
	try {
		await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS * 3);
		assert.deepEqual(operations, ["renew"]);
	} finally {
		proceed.resolve();
	}
	await backend.releaseWorkflow("run");
	assert.deepEqual(operations, ["renew", "release"]);
	assert.equal(await journal.leaseState("run"), undefined);
});

test("close drains an accepted reset while its catalog read is pending", async () => {
	const { backend, journal } = await open();
	const entered = gate();
	const proceed = gate();
	const listRuns = journal.listRuns.bind(journal);
	journal.listRuns = async (...args) => {
		entered.resolve();
		await proceed.promise;
		return listRuns(...args);
	};
	const resetting = backend.reset();
	await entered.promise;
	const closing = backend.close();
	proceed.resolve();
	await Promise.all([resetting, closing]);
	assert.equal(backend.getWorkflow("run"), undefined);
});

test("close during renewal still releases every run's lease", async () => {
	vi.useFakeTimers();
	const { backend, journal } = await open();
	await backend.registerWorkflow({ workflowId: "other", name: "test", inputs: {}, createdAt: 1, status: "running" });
	const entered = gate();
	const proceed = gate();
	const renew = journal.renew.bind(journal);
	const release = journal.release.bind(journal);
	const operations: string[] = [];
	journal.renew = async (lease) => {
		operations.push(`renew:${lease.runId}`);
		entered.resolve();
		await proceed.promise;
		await renew(lease);
	};
	journal.release = async (lease) => {
		operations.push(`release:${lease.runId}`);
		await release(lease);
	};
	await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	await entered.promise;
	const closing = backend.close();
	proceed.resolve();
	await closing;
	assert.deepEqual(operations, ["renew:run", "release:run", "release:other"]);
});

test("retirement drains an admitted terminal mutation but rejects new writes from the retired execution", async () => {
	const { backend, journal } = await open();
	const entered = gate();
	const proceed = gate();
	const finishBody = gate();
	const read = journal.read.bind(journal);
	let blocked = false;
	journal.read = async function* (runId, fromSeq) {
		if (!blocked) {
			blocked = true;
			entered.resolve();
			await proceed.promise;
		}
		for await (const entry of read(runId, fromSeq)) yield entry;
	};
	let retire!: () => void | Promise<void>;
	let saving!: Promise<boolean>;
	const execution = backend.withWorkflowLease("run", async () => {
		retire = backend.captureWorkflowRetirement("run");
		saving = backend.persistPendingStageMessages("run", []);
		await finishBody.promise;
		await assert.rejects(backend.setWorkflowStatus("run", "completed"), JournalExecutionRetiredError);
	});
	await entered.promise;
	const retirement = retire();
	try {
		proceed.resolve();
		assert.equal(await saving, true);
		await retirement;
	} finally {
		proceed.resolve();
		finishBody.resolve();
		await execution;
		await retirement;
	}
	const entries = [];
	for await (const entry of journal.read("run")) entries.push(entry);
	assert.equal(entries.at(-1)?.event.type, RUN_EVENT_TYPES.messageQueued);
	assert.equal(await backend.workflowOwnership("run"), "available");
});
