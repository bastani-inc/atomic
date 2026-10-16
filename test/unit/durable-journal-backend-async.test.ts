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

test("reset preserves an unsnapshotted registration's cache, storage and close cleanup", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	backends.push(backend);
	try {
		for (let index = 0; index < 5; index++)
			await backend.registerWorkflow({
				workflowId: `old-${index}`,
				name: "test",
				inputs: {},
				createdAt: 1,
				status: "paused",
			});
		const resetting = backend.reset();
		const registering = backend.registerWorkflow({
			workflowId: "new",
			name: "test",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		await Promise.all([resetting, registering]);
		const cachedStatus = backend.getWorkflow("new")?.status;
		const storedStatus = (await journal.getRun("new"))?.status;
		const holderBeforeClose = (await journal.leaseState("new"))?.holderId;
		await backend.close();
		const leaseAfterClose = await journal.leaseState("new");
		assert.deepEqual(
			{ cachedStatus, storedStatus, holderBeforeClose, leaseAfterClose },
			{
				cachedStatus: "paused",
				storedStatus: "paused",
				holderBeforeClose: backend.holderId,
				leaseAfterClose: undefined,
			},
		);
		assert.deepEqual(
			(await journal.listRuns()).map((run) => run.runId),
			["new"],
		);
		for (let index = 0; index < 5; index++) {
			assert.equal(backend.getWorkflow(`old-${index}`), undefined);
			assert.equal(await journal.leaseState(`old-${index}`), undefined);
		}
	} finally {
		await backend.close();
		await journal.close();
	}
});

test("reset removes cached state for a run already deleted from storage", async () => {
	const { backend: writer, journal } = await open();
	await writer.recordCheckpoint(checkpoint());
	await writer.reservePendingPrompt("run", "prompt");
	const observer = await JournalDurableBackend.open(journal, { ownsJournal: false });
	backends.unshift(observer);
	assert.equal(observer.getWorkflow("run")?.pendingPrompts, 1);
	assert.equal(observer.getToolOutput("run", "one"), "one");
	await writer.deleteWorkflow("run");
	await observer.reset();
	assert.equal(observer.getWorkflow("run"), undefined);
	assert.deepEqual(observer.listCheckpoints("run"), []);
	assert.deepEqual(await journal.listRuns(), []);
	assert.equal(await journal.leaseState("run"), undefined);
});

test("reset keeps registrations admitted after its catalog snapshot independent", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	backends.push(backend);
	const entered = gate();
	const proceed = gate();
	const listRuns = journal.listRuns.bind(journal);
	try {
		await backend.registerWorkflow({ workflowId: "old", name: "test", inputs: {}, createdAt: 1, status: "paused" });
		journal.listRuns = async (...args) => {
			const runs = await listRuns(...args);
			entered.resolve();
			await proceed.promise;
			return runs;
		};
		const resetting = backend.reset();
		await entered.promise;
		await backend.registerWorkflow({ workflowId: "new", name: "test", inputs: {}, createdAt: 1, status: "paused" });
		assert.equal(backend.getWorkflow("new")?.status, "paused");
		proceed.resolve();
		await resetting;
		assert.equal(backend.getWorkflow("new")?.status, "paused");
		assert.equal((await journal.getRun("new"))?.status, "paused");
		assert.equal(backend.getWorkflow("old"), undefined);
		assert.equal(await journal.getRun("old"), undefined);
		await backend.close();
		assert.equal(await journal.leaseState("new"), undefined);
	} finally {
		proceed.resolve();
		await backend.close();
		await journal.close();
	}
});

test("reset deletion serializes same-run recreation and close drains it without blocking another run", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	backends.push(backend);
	const entered = gate();
	const proceed = gate();
	const deleteOwnedRun = journal.deleteOwnedRun.bind(journal);
	try {
		await backend.registerWorkflow({ workflowId: "run", name: "old", inputs: {}, createdAt: 1, status: "paused" });
		await backend.recordCheckpoint(checkpoint("old"));
		await backend.reservePendingPrompt("run", "old-prompt");
		journal.deleteOwnedRun = async (...args) => {
			entered.resolve();
			await proceed.promise;
			await deleteOwnedRun(...args);
		};
		const resetting = backend.reset();
		await entered.promise;
		const registering = backend.registerWorkflow({
			workflowId: "run",
			name: "new",
			inputs: {},
			createdAt: 2,
			status: "paused",
		});
		const saving = backend.recordCheckpoint(checkpoint("new"));
		await backend.registerWorkflow({ workflowId: "other", name: "test", inputs: {}, createdAt: 1, status: "paused" });
		assert.equal((await journal.getRun("other"))?.status, "paused");
		const closing = backend.close();
		await assert.rejects(
			backend.registerWorkflow({
				workflowId: "late",
				name: "test",
				inputs: {},
				createdAt: 1,
				status: "paused",
			}),
			JournalBackendClosedError,
		);
		proceed.resolve();
		await Promise.all([resetting, registering, saving, closing]);
		assert.equal(backend.getWorkflow("run")?.name, "new");
		assert.equal(backend.getWorkflow("run")?.pendingPrompts, 0);
		assert.equal(backend.getToolOutput("run", "old"), undefined);
		assert.equal(backend.getToolOutput("run", "new"), "new");
		assert.equal(backend.getWorkflow("other")?.status, "paused");
		assert.deepEqual((await journal.listRuns()).map((run) => run.runId).sort(), ["other", "run"]);
		assert.equal(await journal.leaseState("run"), undefined);
		assert.equal(await journal.leaseState("other"), undefined);
	} finally {
		proceed.resolve();
		await backend.close();
		await journal.close();
	}
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

test.each(["queued", "in-flight"] as const)(
	"retirement around the first %s acquisition releases the admitted registration's lease",
	async (timing) => {
		vi.useFakeTimers();
		const journal = new MemoryRunJournal();
		const backend = await JournalDurableBackend.open(journal);
		backends.push(backend);
		const entered = gate();
		const proceed = gate();
		if (timing === "in-flight") {
			const takeover = journal.takeoverExpired.bind(journal);
			journal.takeoverExpired = async (...args) => {
				const result = await takeover(...args);
				entered.resolve();
				await proceed.promise;
				return result;
			};
		}
		await backend.withWorkflowLease("run", async () => {
			const retire = backend.captureWorkflowRetirement("run");
			const registration = backend.registerWorkflow({
				workflowId: "run",
				name: "test",
				inputs: {},
				createdAt: 1,
				status: "paused",
			});
			if (timing === "in-flight") await entered.promise;
			const retirement = retire();
			proceed.resolve();
			await Promise.all([registration, retirement]);
			await assert.rejects(backend.setWorkflowStatus("run", "completed"), JournalExecutionRetiredError);
		});
		assert.equal(backend.getWorkflow("run")?.status, "paused");
		assert.equal(await journal.leaseState("run"), undefined);
		const contender = await JournalDurableBackend.open(journal, { ownsJournal: false });
		try {
			await contender.setWorkflowStatus("run", "running");
			assert.equal((await journal.leaseState("run"))?.holderId, contender.holderId);
			assert.equal(contender.getWorkflow("run")?.status, "running");
		} finally {
			await contender.close();
		}
		await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS * 2);
		assert.equal(await journal.leaseState("run"), undefined);
		assert.equal(await backend.workflowOwnership("run"), "available");
	},
);

test("retirement joins close while the first admitted registration is still queued", async () => {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	backends.push(backend);
	try {
		await backend.withWorkflowLease("run", async () => {
			const retire = backend.captureWorkflowRetirement("run");
			const registration = backend.registerWorkflow({
				workflowId: "run",
				name: "test",
				inputs: {},
				createdAt: 1,
				status: "paused",
			});
			const closing = backend.close();
			await Promise.all([registration, closing, retire()]);
		});
		assert.equal(backend.getWorkflow("run")?.status, "paused");
		assert.equal(await journal.leaseState("run"), undefined);
	} finally {
		await backend.close();
		await journal.close();
	}
});
