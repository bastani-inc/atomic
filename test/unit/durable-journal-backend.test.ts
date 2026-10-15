import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	JournalDurableBackend,
	JournalOwnershipError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqliteRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { Lease, RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import {
	JournalCounterRangeError,
	RUN_EVENT_TYPES,
	StaleLeaseError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { classifyControlError } from "../../packages/workflows/src/extension/workflow-control-failure.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const opened: JournalDurableBackend[] = [];
const dirs: string[] = [];
function database(): string {
	const dir = makeTempDirectory("journal-backend-");
	dirs.push(dir);
	return join(dir, "journal.sqlite");
}
async function open(path = database()): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(path);
	opened.push(backend);
	return backend;
}
function register(backend: JournalDurableBackend): void {
	backend.registerWorkflow({ workflowId: "run", name: "test", inputs: {}, createdAt: 1, status: "running" });
}
function checkpoint(output = "saved") {
	return {
		kind: "tool" as const,
		workflowId: "run",
		checkpointId: "one",
		name: "tool",
		argsHash: "hash",
		output,
		completedAt: 2,
	};
}

afterEach(async () => {
	try {
		for (const backend of opened.splice(0)) await backend.close();
	} finally {
		vi.useRealTimers();
		for (const dir of dirs.splice(0)) removeTempDirectory(dir);
	}
});

test("journal backend writes checkpoints durably before returning and rebuilds on open", async () => {
	const path = database();
	const backend = await open(path);
	register(backend);
	backend.recordCheckpoint(checkpoint());
	const reader = await open(path);
	assert.equal(reader.getToolOutput("run", "hash"), "saved");
	assert.deepEqual(reader.listCheckpoints("run"), backend.listCheckpoints("run"));
});

const FRESH_PROCESS_TIMEOUT_MS = 60_000;
test(
	"fresh processes write, close and reopen identical catalog and checkpoints",
	() => {
		const path = database();
		const fixture = resolve("test/fixtures/journal-backend-child.ts");
		const writer = spawnSyncCollect([bunExecutable(), fixture, path, "write"], { timeout: FRESH_PROCESS_TIMEOUT_MS });
		assert.equal(writer.exitCode, 0, writer.stderr.toString());
		const reader = spawnSyncCollect([bunExecutable(), fixture, path, "read"], { timeout: FRESH_PROCESS_TIMEOUT_MS });
		assert.equal(reader.exitCode, 0, reader.stderr.toString());
		assert.deepEqual(JSON.parse(reader.stdout.toString()), JSON.parse(writer.stdout.toString()));
	},
	FRESH_PROCESS_TIMEOUT_MS,
);

test("checkpoint identity is first-writer-wins without adding a duplicate event", async () => {
	const backend = await open();
	register(backend);
	await backend.recordCheckpointAsync(checkpoint());
	const before = backend.journal.readEntries("run");
	await backend.recordCheckpointAsync(checkpoint("changed"));
	assert.equal(backend.getToolOutput("run", "hash"), "saved");
	assert.deepEqual(backend.journal.readEntries("run"), before);
});

test("two backends on one file cannot append to the same fresh lease", async () => {
	const path = database();
	const first = await open(path);
	register(first);
	const second = await open(path);
	assert.notEqual(first.holderId, second.holderId);
	const before = first.journal.readEntries("run");
	assert.throws(
		() => second.recordCheckpoint(checkpoint()),
		(error: Error) => {
			assert.ok(error instanceof JournalOwnershipError);
			assert.equal(error.runId, "run");
			assert.equal(error.holderId, first.holderId);
			assert.equal(classifyControlError(error), "owned_elsewhere");
			return true;
		},
	);
	assert.deepEqual(first.journal.readEntries("run"), before);
	assert.equal(second.listCheckpoints("run").length, 0);
});

test("lease expiry takeover fences the previous writer and maps lost ownership", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	const first = await open(path);
	register(first);
	const oldEpoch = first.journal.leaseState("run")!.epoch;
	vi.setSystemTime(1_000 + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1);
	const second = await open(path);
	second.recordCheckpoint(checkpoint("new holder"));
	const currentEpoch = second.journal.leaseState("run")!.epoch;
	assert.equal(currentEpoch, oldEpoch + 1);
	const before = second.journal.readEntries("run");
	assert.throws(
		() => first.recordCheckpoint(checkpoint("stale")),
		(error: Error) => {
			assert.ok(error instanceof JournalOwnershipError);
			assert.ok(error.cause instanceof StaleLeaseError);
			assert.equal(error.cause.runId, "run");
			assert.equal(error.cause.heldEpoch, oldEpoch);
			assert.equal(error.cause.currentEpoch, currentEpoch);
			assert.equal(classifyControlError(error), "owned_elsewhere");
			return true;
		},
	);
	assert.deepEqual(second.journal.readEntries("run"), before);
	assert.equal(second.getToolOutput("run", "hash"), "new holder");
});

test("lease renewal follows the existing liveness cadence and prevents stale takeover", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	const path = database();
	const first = await open(path);
	register(first);
	const initial = first.journal.leaseState("run")!;
	vi.advanceTimersByTime(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	assert.equal(first.journal.leaseState("run")!.renewedAt, 1_000 + STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	vi.advanceTimersByTime(FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
	const second = await open(path);
	assert.throws(() => second.recordCheckpoint(checkpoint()), JournalOwnershipError);
	assert.equal(first.journal.leaseState("run")!.epoch, initial.epoch);
	await first.close();
	vi.advanceTimersByTime(FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
	second.recordCheckpoint(checkpoint());
	assert.equal(second.getToolOutput("run", "hash"), "saved");
});

test("status claims use full snapshots, omit absent fields and clear omitted owners", async () => {
	const path = database();
	const backend = await open(path);
	backend.registerWorkflow({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
		modelOwner: "owner",
		releasedModelOwner: "old",
	});
	const previous = backend.getWorkflow("run")!;
	assert.equal(
		await backend.transitionWorkflowStatus("run", ["running"], "paused", 0, undefined, previous.updatedAt),
		true,
	);
	const latest = backend.journal.readEntries("run").at(-1)!;
	assert.equal(latest.event.type, RUN_EVENT_TYPES.statusChanged);
	const payload = JSON.parse(JSON.stringify(latest.event.payload)) as Record<string, string | number>;
	assert.equal(payload.status, "paused");
	assert.equal(payload.workflowId, "run");
	assert.equal(payload.completedCheckpoints, 0);
	for (const key of ["modelOwner", "releasedModelOwner", "resumable", "error", "failureKind", "sessionFile"])
		assert.equal(Object.hasOwn(payload, key), false, key);
	const reader = await open(path);
	assert.deepEqual(reader.getWorkflow("run"), backend.getWorkflow("run"));
	assert.equal(reader.getWorkflow("run")?.modelOwner, undefined);
	const before = backend.journal.readEntries("run");
	assert.equal(await backend.transitionWorkflowStatus("run", ["running"], "completed"), false);
	assert.equal(
		await backend.transitionWorkflowStatus("run", ["paused"], "completed", undefined, undefined, previous.updatedAt),
		false,
	);
	assert.deepEqual(backend.journal.readEntries("run"), before);
});

test("checkpoint payloads preserve unusual text, duplicate arrays and completion ordering on reopen", async () => {
	const path = database();
	const backend = await open(path);
	register(backend);
	backend.recordCheckpoint({
		...checkpoint(),
		checkpointId: "later",
		completedAt: 10,
		output: { raw: "\u0000\ud800", list: [2, 1, 2] },
	});
	backend.recordCheckpoint({ ...checkpoint(), checkpointId: "earlier", completedAt: 5 });
	const reader = await open(path);
	assert.deepEqual(reader.listCheckpoints("run"), backend.listCheckpoints("run"));
	assert.deepEqual(reader.getToolOutput("run", "hash"), { raw: "\u0000\ud800", list: [2, 1, 2] });
	assert.deepEqual(
		reader.listCheckpoints("run").map((entry) => entry.checkpointId),
		["earlier", "later"],
	);
});

test("journal asynchronous method return identities remain Promises and read remains AsyncIterable", async () => {
	const journal = new SqliteRunJournal(database());
	try {
		const created = journal.createRun({ runId: "run", name: "test", cwd: "", createdAt: 0, status: "running" });
		assert.ok(created instanceof Promise);
		assert.equal(await created, "created");
		const result = journal.acquire("run", "holder");
		assert.ok(result instanceof Promise);
		const outcome = await result;
		assert.equal(outcome.status, "acquired");
		if (outcome.status !== "acquired") assert.fail("expected lease");
		const appended = journal.append(outcome.lease, { type: RUN_EVENT_TYPES.runStarted, payload: {} });
		assert.ok(appended instanceof Promise);
		await appended;
		assert.equal(typeof journal.read("run")[Symbol.asyncIterator], "function");
	} finally {
		await journal.close();
	}
});

test("a stale holder cannot delete the new holder's run", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	const first = await open(path);
	register(first);
	vi.setSystemTime(1_000 + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1);
	const second = await open(path);
	second.recordCheckpoint(checkpoint());
	const before = second.journal.readEntries("run");
	await assert.rejects(first.deleteWorkflow("run"), JournalOwnershipError);
	assert.deepEqual(second.journal.readEntries("run"), before);
});

test("a status sequence conflict returns false and refreshes the winning snapshot", async () => {
	class ContendedJournal extends SqliteRunJournal {
		contend = false;
		override appendSync(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }) {
			if (this.contend && options?.expectSeq !== undefined) {
				this.contend = false;
				super.appendSync(lease, event);
			}
			return super.appendSync(lease, event, options);
		}
	}
	const journal = new ContendedJournal(database());
	const backend = new JournalDurableBackend(journal);
	opened.push(backend);
	register(backend);
	journal.contend = true;
	assert.equal(await backend.transitionWorkflowStatus("run", ["running"], "paused"), false);
	assert.equal(backend.getWorkflow("run")?.status, "paused");
	assert.equal(journal.readEntries("run").length, 2);
});

test("prompt reservation generations and releases rebuild from durable events", async () => {
	const path = database();
	const backend = await open(path);
	register(backend);
	const firstToken = backend.reservePendingPrompt("run", "prompt");
	await backend.close();
	const resumed = await open(path);
	assert.deepEqual(resumed.pendingPromptToken("run", "prompt"), firstToken);
	resumed.releasePendingPrompt("run", "prompt", firstToken);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 0);
	const nextToken = resumed.reservePendingPrompt("run", "prompt");
	assert.equal(nextToken.generation, firstToken.generation + 1);
	resumed.releasePendingPrompt("run", "prompt", firstToken);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 1);
	resumed.releasePendingPrompt("run", "prompt", nextToken);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 0);
});

test("pending messages, settlement and delivery accounting survive reopen without rewriting text or order", async () => {
	const path = database();
	const backend = await open(path);
	register(backend);
	const message: PendingStageMessage = {
		id: "message",
		runId: "run",
		stageKey: "stage",
		from: { id: "sender" },
		message: { id: "wire", timestamp: 1, content: { text: " raw\u0000\ud800 " } },
		queuedAt: "verbatim timestamp",
		status: "queued",
	};
	assert.equal(await backend.persistPendingStageMessages("run", [message, message]), true);
	await backend.archivePendingStageMessage("run", message);
	const delivery = {
		runId: "run",
		stageId: "stage",
		sessionId: "session",
		admission: "context" as const,
		deliveredAt: "raw time",
	};
	await backend.archivePendingStageDeliveryReceipt("run", message.id, delivery, {
		messageRunId: "run",
		deliveryCount: 2,
	});
	await backend.archivePendingStageDeliveryReceipt("run", message.id, delivery, {
		messageRunId: "run",
		deliveryCount: 3,
	});
	await backend.close();
	const resumed = await open(path);
	assert.deepEqual(resumed.getWorkflow("run")?.pendingStageMessages, [message, message]);
	assert.deepEqual(await resumed.readSettledPendingStageMessage("run", message.id), message);
	assert.equal(await resumed.hasPendingStageDeliveryReceipt("run", message.id, delivery), true);
	assert.equal(await resumed.readPendingStageMessageDeliveryCount("run", message.id), 2);
});

test("additive checkpoints propagate typed counter violations instead of hiding them", async () => {
	class FailingJournal extends SqliteRunJournal {
		fail = false;
		override appendSync(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }) {
			if (this.fail) throw new JournalCounterRangeError(lease.runId, "seq", Number.MAX_SAFE_INTEGER + 1, "overflow");
			return super.appendSync(lease, event, options);
		}
	}
	const journal = new FailingJournal(database());
	const backend = new JournalDurableBackend(journal);
	opened.push(backend);
	register(backend);
	journal.fail = true;
	await assert.rejects(backend.recordAdditiveCheckpointBestEffort(checkpoint()), (error: Error) => {
		assert.ok(error instanceof JournalCounterRangeError);
		assert.equal(error.runId, "run");
		assert.equal(error.field, "seq");
		assert.equal(error.value, Number.MAX_SAFE_INTEGER + 1);
		assert.equal(error.reason, "overflow");
		return true;
	});
	assert.equal(journal.readEntries("run").length, 1);
	assert.equal(backend.listCheckpoints("run").length, 0);
});

test("status snapshots preserve unchanged active prompt reservations across reopen", async () => {
	const path = database();
	const backend = await open(path);
	register(backend);
	const token = backend.reservePendingPrompt("run", "prompt");
	backend.setWorkflowStatus("run", "paused");
	await backend.close();
	const resumed = await open(path);
	resumed.releasePendingPrompt("run", "prompt", token);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 0);
});

test("lease handoff refreshes the projection before writing a status snapshot", async () => {
	const path = database();
	const first = await open(path);
	register(first);
	const second = await open(path);
	first.recordCheckpoint(checkpoint());
	await first.persistSummary("run", "keep summary", 1);
	const token = first.reservePendingPrompt("run", "prompt");
	await first.close();
	second.setWorkflowStatus("run", "paused");
	assert.equal(second.getWorkflow("run")?.completedCheckpoints, 1);
	assert.equal(second.getWorkflow("run")?.summary, "keep summary");
	assert.equal(second.getWorkflow("run")?.pendingPrompts, 1);
	second.releasePendingPrompt("run", "prompt", token);
	assert.equal(second.getWorkflow("run")?.pendingPrompts, 0);
});

test("catalog and targeted hydration remove deleted runs and rebuild recreated run identities", async () => {
	const path = database();
	const writer = await open(path);
	register(writer);
	writer.recordCheckpoint(checkpoint("old"));
	writer.setWorkflowStatus("run", "completed");
	const reader = await open(path);
	assert.equal((await reader.prepareWorkflowCatalog()).completed.length, 1);
	await writer.deleteWorkflow("run");
	assert.equal((await reader.prepareWorkflowCatalog()).completed.length, 0);
	assert.equal(reader.getWorkflow("run"), undefined);
	register(writer);
	writer.recordCheckpoint({ ...checkpoint("new"), checkpointId: "new" });
	await reader.hydrateWorkflow("run");
	assert.deepEqual(
		reader.listCheckpoints("run").map((entry) => entry.checkpointId),
		["new"],
	);
	assert.equal(reader.getToolOutput("run", "hash"), "new");
	await writer.deleteWorkflow("run");
	register(writer);
	writer.recordCheckpoint({ ...checkpoint("recreated"), checkpointId: "recreated" });
	await reader.hydrateWorkflow("run");
	assert.deepEqual(
		reader.listCheckpoints("run").map((entry) => entry.checkpointId),
		["recreated"],
	);
	assert.equal(reader.getToolOutput("run", "hash"), "recreated");
});
