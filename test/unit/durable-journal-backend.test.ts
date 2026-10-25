import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DurableNestedTopologyError } from "../../packages/workflows/src/durable/boundary-topology.js";
import {
	JournalDurableBackend,
	JournalOwnershipError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	JOURNAL_READ_PAGE_SIZE,
	openSqlRunJournal,
	SqlRunJournal,
} from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	JOURNAL_COLUMNS,
	JournalCounterRangeError,
	RUN_EVENT_TYPES,
	StaleLeaseError,
	StorageUnavailableError,
	JOURNAL_TABLES as tableNames,
} from "../../packages/workflows/src/durable/journal/types.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	reclaimReleasedRunsOwnedBy,
	releasePausedRunsOwnedBy,
} from "../../packages/workflows/src/durable/sdk-owner-release.js";
import type { DurableWorkflowHandle } from "../../packages/workflows/src/durable/types.js";
import { classifyControlError } from "../../packages/workflows/src/extension/workflow-control-failure.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { JournalTestDatabase } from "../helpers/journal-database.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

/** The journal shape of one pending-stage list change item, as asserted by these tests. */
type PendingStageListChangeItem =
	| readonly [start: number, count: number]
	| {
			readonly patch: number;
			readonly set?: Readonly<Record<string, string | number | boolean>>;
			readonly unset?: readonly string[];
	  };

async function entries(journal: RunJournal): Promise<JournalEntry[]> {
	const result: JournalEntry[] = [];
	for await (const entry of journal.read("run")) result.push(entry);
	return result;
}
async function interleavedJournal(
	path: string,
	before: (runId: string) => void | Promise<void>,
): Promise<SqlRunJournal> {
	const journal = await openSqlRunJournal(path);
	const takeover = journal.takeoverExpired.bind(journal);
	journal.takeoverExpired = async (...args) => {
		await before(args[0]);
		return takeover(...args);
	};
	return journal;
}
const JOURNAL_TABLES = Object.fromEntries(
	Object.entries(tableNames).map(([key, name]) => [key, `wf_${name}`]),
) as Record<keyof typeof tableNames, string>;
function expire(path: string): void {
	const connection = new JournalTestDatabase(path);
	try {
		connection.run(
			"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? - 1",
			FOREIGN_LIVE_WORKFLOW_WINDOW_MS,
		);
	} finally {
		connection.close();
	}
}
const opened: JournalDurableBackend[] = [];
const dirs: string[] = [];
function database(): string {
	const dir = makeTempDirectory("journal-backend-");
	dirs.push(dir);
	return join(dir, "journal.sqlite");
}
async function open(path = database()): Promise<JournalDurableBackend> {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	opened.push(backend);
	return backend;
}
async function register(backend: JournalDurableBackend): Promise<void> {
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
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

test("ownership probes use store-clock lease age despite a skewed process clock", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	const observer = await open(path);
	const clock = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
	try {
		assert.equal(await observer.workflowOwnership("run"), "foreign");
		expire(path);
		clock.mockReturnValue(0);
		assert.equal(await observer.workflowOwnership("run"), "available");
	} finally {
		clock.mockRestore();
	}
});

test("journal backend writes checkpoints durably before returning and rebuilds on open", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	await backend.commitCheckpoint(checkpoint());
	const reader = await open(path);
	assert.equal(reader.getToolOutput("run", "hash"), "saved");
	assert.deepEqual(reader.listCheckpoints("run"), backend.listCheckpoints("run"));
});

test("opening rejects a boundary record without its invocation fingerprint", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	const lease = await writer.journal.leaseState("run");
	assert.ok(lease);
	await writer.journal.append(lease, {
		type: RUN_EVENT_TYPES.checkpointRecorded,
		payload: {
			kind: "stage",
			workflowId: "run",
			checkpointId: "boundary",
			name: "workflow:child",
			replayKey: "child:1",
			completedAt: 2,
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: [],
				boundary: {
					version: 1,
					replayScope: "child:1",
					alias: "child",
					workflow: "child",
					event: "start",
					status: "running",
					child: {
						runId: "child",
						runName: "child",
						parentRunId: "run",
						parentStageId: "boundary",
						rootRunId: "run",
					},
				},
			},
		},
	});
	await writer.close();
	await assert.rejects(JournalDurableBackend.open(await openSqlRunJournal(path)), (error: Error) => {
		assert.ok(error instanceof DurableNestedTopologyError);
		assert.equal(error.reason, "missing invocation fingerprint at boundary");
		return true;
	});
});

test("opening folds every journal event exactly once through paged reads", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	for (let index = 0; index <= JOURNAL_READ_PAGE_SIZE * 2; index++)
		await writer.commitCheckpoint({ ...checkpoint(`output ${index}`), checkpointId: `checkpoint ${index}` });
	const events = (await entries(writer.journal)).length;
	assert.ok(events > JOURNAL_READ_PAGE_SIZE * 2);
	const expected = writer.getWorkflow("run");
	const checkpoints = writer.listCheckpoints("run");
	await writer.close();
	const readSource = SqlRunJournal.prototype.read;
	let consumed = 0;
	const paged = vi.spyOn(SqlRunJournal.prototype, "read").mockImplementation(async function* (
		this: SqlRunJournal,
		runId: string,
		fromSeq?: number,
	) {
		for await (const entry of readSource.call(this, runId, fromSeq)) {
			consumed++;
			yield entry;
		}
	});
	try {
		const reader = await open(path);
		assert.equal(consumed, events);
		assert.deepEqual(paged.mock.calls, [["run"]]);
		assert.deepEqual(reader.getWorkflow("run"), expected);
		assert.deepEqual(reader.listCheckpoints("run"), checkpoints);
	} finally {
		paged.mockRestore();
	}
});

test("a replay failure while opening clears the renewal timer and closes the journal", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	await writer.commitCheckpoint(checkpoint());
	await writer.close();
	const replayFailure = new StorageUnavailableError(
		{ adapter: "node-sqlite", location: path },
		new Error("replay failed"),
	);
	const failingRead = vi.spyOn(SqlRunJournal.prototype, "read").mockImplementation(async function* () {
		yield* [];
		throw replayFailure;
	});
	const created = vi.spyOn(globalThis, "setInterval");
	const cleared = vi.spyOn(globalThis, "clearInterval");
	const closedJournal = vi.spyOn(SqlRunJournal.prototype, "close");
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			await assert.rejects(
				JournalDurableBackend.open(await openSqlRunJournal(path)),
				(error: Error) => error === replayFailure,
			);
		}
		const timers = created.mock.results.map((result) => result.value);
		assert.equal(timers.length, 0);
		assert.deepEqual(
			cleared.mock.calls.map(([timer]) => timer),
			timers,
		);
		assert.equal(closedJournal.mock.calls.length, 3);
	} finally {
		failingRead.mockRestore();
		created.mockRestore();
		cleared.mockRestore();
		closedJournal.mockRestore();
	}
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

test(
	"closing a journal releases its files while the backend remains reachable",
	() => {
		const child = spawnSyncCollect(
			[bunExecutable(), resolve("test/fixtures/journal-backend-close-child.ts"), database()],
			{ timeout: FRESH_PROCESS_TIMEOUT_MS },
		);
		assert.equal(child.exitCode, 0, child.stderr.toString());
	},
	FRESH_PROCESS_TIMEOUT_MS,
);

test("checkpoint identity is first-writer-wins without adding a duplicate event", async () => {
	const backend = await open();
	await register(backend);
	await backend.commitCheckpoint(checkpoint());
	const before = await entries(backend.journal);
	await backend.commitCheckpoint(checkpoint("changed"));
	assert.equal(backend.getToolOutput("run", "hash"), "saved");
	assert.deepEqual(await entries(backend.journal), before);
});

test("two backends on one file cannot append to the same fresh lease", async () => {
	const path = database();
	const first = await open(path);
	await register(first);
	const second = await open(path);
	assert.notEqual(first.holderId, second.holderId);
	const before = await entries(first.journal);
	await assert.rejects(
		async () => await second.commitCheckpoint(checkpoint()),
		(error: Error) => {
			assert.ok(error instanceof JournalOwnershipError);
			assert.equal(error.runId, "run");
			assert.equal(error.holderId, first.holderId);
			assert.equal(classifyControlError(error), "owned_elsewhere");
			return true;
		},
	);
	assert.deepEqual(await entries(first.journal), before);
	assert.equal(second.listCheckpoints("run").length, 0);
});

test("lease expiry takeover fences the previous writer and maps lost ownership", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	const first = await open(path);
	await register(first);
	const oldEpoch = (await first.journal.leaseState("run"))!.epoch;
	expire(path);
	const second = await open(path);
	await second.commitCheckpoint(checkpoint("new holder"));
	const currentEpoch = (await second.journal.leaseState("run"))!.epoch;
	assert.equal(currentEpoch, oldEpoch + 1);
	const before = await entries(second.journal);
	await assert.rejects(
		async () => await first.commitCheckpoint(checkpoint("stale")),
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
	assert.deepEqual(await entries(second.journal), before);
	assert.equal(second.getToolOutput("run", "hash"), "new holder");
});

test("lease renewal follows the existing liveness cadence and prevents stale takeover", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	const path = database();
	const first = await open(path);
	await register(first);
	const initial = (await first.journal.leaseState("run"))!;
	const renew = vi.spyOn(first.journal, "renew");
	expire(path);
	await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	assert.equal(renew.mock.calls.length, 1);
	assert.ok((await first.journal.leaseState("run"))!.renewedAt >= initial.renewedAt);
	await vi.advanceTimersByTimeAsync(FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
	const second = await open(path);
	await assert.rejects(async () => await second.commitCheckpoint(checkpoint()), JournalOwnershipError);
	assert.equal((await first.journal.leaseState("run"))!.epoch, initial.epoch);
	await first.close();
	vi.advanceTimersByTime(FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
	await second.commitCheckpoint(checkpoint());
	assert.equal(second.getToolOutput("run", "hash"), "saved");
});

test("heartbeat records lost ownership and drops the lease when renewal and holder lookup both reject (#3682)", async () => {
	vi.useFakeTimers();
	const backend = await open();
	await register(backend);
	const state = (await backend.journal.leaseState("run"))!;
	const stale = new StaleLeaseError("run", state.epoch, state.epoch + 1);
	const renew = vi.spyOn(backend.journal, "renew").mockRejectedValue(stale);
	vi.spyOn(backend.journal, "leaseState").mockRejectedValue(
		new StorageUnavailableError({ adapter: "test", location: "journal" }, new Error("lookup failed")),
	);
	const release = vi.spyOn(backend.journal, "release");
	await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	await assert.rejects(
		async () => await backend.commitWorkflowStatus("run", "paused"),
		(error: Error) => {
			assert.ok(error instanceof JournalOwnershipError);
			assert.equal(error.holderId, null);
			assert.equal(error.cause, stale);
			return true;
		},
	);
	await vi.advanceTimersByTimeAsync(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
	assert.equal(renew.mock.calls.length, 1);
	await backend.close();
	assert.equal(release.mock.calls.length, 0, "lost local lease must not be released on close");
});

test("status claims use full snapshots, omit absent fields and clear omitted owners", async () => {
	const path = database();
	const backend = await open(path);
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running",
		releasedModelOwner: "old",
	});
	const previous = backend.getWorkflow("run")!;
	assert.equal(
		await backend.commitWorkflowStatusTransition("run", ["running"], "paused", 0, undefined, previous.updatedAt),
		true,
	);
	const latest = (await entries(backend.journal)).at(-1)!;
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
	const before = await entries(backend.journal);
	assert.equal(await backend.commitWorkflowStatusTransition("run", ["running"], "completed"), false);
	assert.equal(
		await backend.commitWorkflowStatusTransition(
			"run",
			["paused"],
			"completed",
			undefined,
			undefined,
			previous.updatedAt,
		),
		false,
	);
	assert.deepEqual(await entries(backend.journal), before);
});

test("owner release and reclaim match the in-memory backend before and after reopen", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	let journal = await open(path);
	const memory = await createMemoryTestBackend();
	const input = {
		workflowId: "run",
		name: "owned",
		inputs: {},
		createdAt: 1,
		status: "paused" as const,
		completedCheckpoints: 1,
		modelOwner: "owner",
		releasedModelOwner: "old-release",
	};
	for (const backend of [memory, journal]) await backend.commitWorkflowRegistration(input);
	const verify = async (releasedModelOwner?: string, modelOwner = "owner") => {
		const expected = JSON.parse(JSON.stringify(memory.getWorkflow("run"))) as DurableWorkflowHandle;
		assert.deepEqual(journal.getWorkflow("run"), expected);
		assert.equal(expected.modelOwner, modelOwner);
		assert.equal(expected.releasedModelOwner, releasedModelOwner);
		const snapshot = (await entries(journal.journal)).at(-1)!;
		assert.deepEqual(snapshot.event.payload, expected);
		await journal.close();
		journal = await open(path);
		assert.deepEqual(journal.getWorkflow("run"), expected);
	};
	await verify("old-release");
	for (const backend of [memory, journal]) assert.deepEqual(await releasePausedRunsOwnedBy(backend, "owner"), ["run"]);
	await verify("owner");
	for (const backend of [memory, journal]) await reclaimReleasedRunsOwnedBy(backend, "owner");
	await verify();
	for (const backend of [memory, journal])
		assert.equal(
			await backend.commitWorkflowStatusTransition(
				"run",
				["paused"],
				"paused",
				undefined,
				undefined,
				undefined,
				"new",
			),
			true,
		);
	await verify(undefined, "new");
});

test("checkpoint payloads preserve unusual text, duplicate arrays and completion ordering on reopen", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	await backend.commitCheckpoint({
		...checkpoint(),
		checkpointId: "later",
		completedAt: 10,
		output: { raw: "\u0000\ud800", list: [2, 1, 2] },
	});
	await backend.commitCheckpoint({ ...checkpoint(), checkpointId: "earlier", completedAt: 5 });
	const reader = await open(path);
	assert.deepEqual(reader.listCheckpoints("run"), backend.listCheckpoints("run"));
	assert.deepEqual(reader.getToolOutput("run", "hash"), { raw: "\u0000\ud800", list: [2, 1, 2] });
	assert.deepEqual(
		reader.listCheckpoints("run").map((entry) => entry.checkpointId),
		["earlier", "later"],
	);
});

test("journal asynchronous method return identities remain Promises and read remains AsyncIterable", async () => {
	const journal = await openSqlRunJournal(database());
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
	await register(first);
	expire(path);
	const second = await open(path);
	await second.commitCheckpoint(checkpoint());
	const before = await entries(second.journal);
	await assert.rejects(first.deleteWorkflow("run"), JournalOwnershipError);
	assert.deepEqual(await entries(second.journal), before);
});

test("a status sequence conflict returns false and refreshes the winning snapshot", async () => {
	const journal = await openSqlRunJournal(database());
	let contend = false;
	const append = journal.append.bind(journal);
	journal.append = async (lease, event, options) => {
		if (contend && options?.expectSeq !== undefined) {
			contend = false;
			await append(lease, event);
		}
		return append(lease, event, options);
	};
	const backend = await JournalDurableBackend.open(journal);
	opened.push(backend);
	await register(backend);
	contend = true;
	assert.equal(await backend.commitWorkflowStatusTransition("run", ["running"], "paused"), false);
	assert.equal(backend.getWorkflow("run")?.status, "paused");
	assert.equal((await entries(journal)).length, 2);
});

test("prompt reservation generations and releases rebuild from durable events", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const firstToken = await backend.reservePendingPrompt("run", "prompt");
	await backend.close();
	const resumed = await open(path);
	assert.deepEqual(await resumed.pendingPromptToken("run", "prompt"), firstToken);
	await resumed.releasePendingPrompt("run", "prompt", firstToken);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 0);
	const nextToken = await resumed.reservePendingPrompt("run", "prompt");
	assert.equal(nextToken.generation, firstToken.generation + 1);
	await resumed.releasePendingPrompt("run", "prompt", firstToken);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 1);
	await resumed.releasePendingPrompt("run", "prompt", nextToken);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 0);
});

test("cache replays of an answered prompt add no journal events while changing claims persist", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	const backend = await open(path);
	await register(backend);
	const answered = await backend.reservePendingPrompt("run", "answered");
	await backend.releasePendingPrompt("run", "answered", answered);
	const events = (await entries(backend.journal)).length;
	const updatedAt = backend.getWorkflow("run")!.updatedAt;
	for (let replay = 1; replay <= 3; replay++) {
		vi.setSystemTime(1_000 + replay * 1_000);
		assert.equal(await backend.pendingPromptToken("run", "answered"), undefined);
	}
	assert.equal((await entries(backend.journal)).length, events);
	assert.equal(backend.getWorkflow("run")!.updatedAt, updatedAt);
	await backend.commitPendingPromptAdjustment("run", 1);
	const claimed = await backend.pendingPromptToken("run", "pending");
	assert.ok(claimed);
	assert.equal((await entries(backend.journal)).length, events + 2);
	await backend.close();
	const resumed = await open(path);
	assert.deepEqual(await resumed.pendingPromptToken("run", "pending"), claimed);
	assert.equal((await entries(resumed.journal)).length, events + 2);
	await resumed.releasePendingPrompt("run", "pending", claimed);
	assert.equal(resumed.getWorkflow("run")!.pendingPrompts, 0);
});

test("pending messages, settlement and delivery accounting survive reopen without rewriting text or order", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const message: PendingStageMessage = {
		id: "message",
		runId: "run",
		stageKey: "stage",
		from: { id: "sender" },
		message: { id: "wire", timestamp: 1, content: { text: " raw\u0000\ud800 " } },
		queuedAt: "verbatim timestamp",
		admissionOrder: 1,
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

test("sticky delivery records append O(change) journal bytes and reopen to the same deliveries (#3920)", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const sticky = (id: string): PendingStageMessage => ({
		id,
		runId: "run",
		stageKey: "workflow:run/child-*/**",
		targetPath: "workflow:run/child-*/**",
		from: { id: "sender" },
		message: { id, timestamp: 1, content: { text: `hello from ${id}` } },
		queuedAt: "2026-10-24T20:59:42.835Z",
		admissionOrder: 1,
		status: "queued",
		sticky: true,
		deliveries: [],
		deliveryCount: 0,
	});
	let messages: PendingStageMessage[] = ["a", "b", "c", "d"].map(sticky);
	let added = 0;
	let headers = 0;
	for (let stage = 0; stage < 61; stage++) {
		messages = messages.map((entry) => {
			const deliveries = [
				...(entry.deliveries ?? []),
				{
					runId: `child-${stage}`,
					stageId: `stage-${stage}-0123456789abcdef0123456789abcdef`,
					stageName: "stage-a",
					sessionId: `session-${stage}-0123456789abcdef0123456789abcdef`,
					admission: "transport" as const,
					deliveredAt: "2026-10-24T20:59:49.769Z",
				},
			];
			// Compaction drops the deliveries of finished stages from the live entry.
			return {
				...entry,
				deliveries: stage % 10 === 9 ? deliveries.filter((_, index) => index % 2 === 0) : deliveries,
				deliveryCount: (entry.deliveryCount ?? 0) + 1,
			};
		});
		added += messages.reduce((sum, entry) => sum + JSON.stringify(entry.deliveries!.at(-1)).length, 0);
		headers += JSON.stringify(messages.map((entry) => ({ ...entry, deliveries: [] }))).length;
		assert.equal(await backend.persistPendingStageMessages("run", messages), true);
	}
	const queued = (await entries(backend.journal)).filter(
		(entry) => entry.event.type === RUN_EVENT_TYPES.messageQueued,
	);
	const written = queued.reduce((sum, entry) => sum + JSON.stringify(entry.event.payload).length, 0);
	// Each record adds one delivery per message: the journal should grow by that change, not by every live delivery.
	const bound = 2 * (added + headers);
	assert.ok(written < bound, `wrote ${written} bytes of queued snapshots; linear bound ${bound}`);
	assert.deepEqual(backend.getWorkflow("run")?.pendingStageMessages, messages);
	await backend.close();
	// The resume catalog lists a run from its latest snapshot without folding its history.
	const listed = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [] });
	opened.push(listed);
	await listed.prepareWorkflowCatalog();
	assert.deepEqual(listed.getWorkflow("run")?.pendingStageMessages, messages);
	const resumed = await open(path);
	await resumed.hydrateWorkflow("run");
	assert.deepEqual(resumed.getWorkflow("run")?.pendingStageMessages, messages);
});

test("pending pattern sends and status changes append O(change) journal bytes as the pending list grows (#3929)", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const sticky = (index: number): PendingStageMessage => ({
		id: `message-${index}`,
		runId: "run",
		stageKey: index % 20 === 0 ? "workflow:run/**" : `workflow:run/child-c${index % 160}/**`,
		targetPath: index % 20 === 0 ? "workflow:run/**" : `workflow:run/child-c${index % 160}/**`,
		notInKnownSet: true,
		from: { id: `sender-${index}`, name: `subagent-chat-${index}`, cwd: "/repo", groups: ["workflow:run"] },
		message: { id: `message-${index}`, timestamp: index, content: { text: `hello from child ${index}` } },
		queuedAt: "2026-10-24T23:26:06.916Z",
		admissionOrder: 1,
		status: "queued",
		sticky: true,
		deliveryCount: 0,
	});
	const handleBytes = () => {
		const { pendingStageMessages: _messages, ...handle } = backend.getWorkflow("run")!;
		return JSON.stringify(handle).length;
	};
	let messages: PendingStageMessage[] = [];
	let changed = 0;
	let headers = 0;
	for (let send = 0; send < 300; send++) {
		const queued = sticky(send);
		// Each send queues one message and records a delivery count on one earlier sticky entry.
		messages = [...messages, queued].map((entry, index) =>
			index === Math.floor(send / 2) ? { ...entry, deliveryCount: (entry.deliveryCount ?? 0) + 1 } : entry,
		);
		changed += JSON.stringify(queued).length + JSON.stringify(messages[Math.floor(send / 2)]).length;
		headers += handleBytes();
		assert.equal(await backend.persistPendingStageMessages("run", messages), true);
		if (send % 50 === 49) {
			headers += handleBytes();
			await backend.commitWorkflowStatus("run", send % 100 === 49 ? "paused" : "running");
		}
	}
	const snapshots = (await entries(backend.journal)).filter(
		(entry) =>
			entry.event.type === RUN_EVENT_TYPES.messageQueued || entry.event.type === RUN_EVENT_TYPES.statusChanged,
	);
	const written = snapshots.reduce((sum, entry) => sum + JSON.stringify(entry.event.payload).length, 0);
	// The journal should grow by the queued and changed entries, not by the whole pending list on every event.
	const bound = 2 * (changed + headers);
	assert.ok(written < bound, `wrote ${written} bytes of handle snapshots; linear bound ${bound}`);
	assert.deepEqual(backend.getWorkflow("run")?.pendingStageMessages, messages);
	await backend.close();
	// The resume catalog lists a run from its latest snapshot without folding its history.
	const listed = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [] });
	opened.push(listed);
	await listed.prepareWorkflowCatalog();
	assert.deepEqual(listed.getWorkflow("run")?.pendingStageMessages, messages);
	const resumed = await open(path);
	await resumed.hydrateWorkflow("run");
	assert.deepEqual(resumed.getWorkflow("run")?.pendingStageMessages, messages);
});

test("pending entries that drop optional fields write unset patches that replay to the live list (#3929)", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const entry = (index: number): PendingStageMessage => ({
		id: `message-${index}`,
		runId: "run",
		stageKey: "workflow:run/**",
		targetPath: "workflow:run/**",
		notInKnownSet: true,
		from: { id: `sender-${index}`, name: `sender-${index}`, cwd: "/repo", groups: ["workflow:run"] },
		message: { id: `message-${index}`, timestamp: index, content: { text: `a long enough message body ${index}` } },
		queuedAt: "2026-10-24T23:26:06.916Z",
		admissionOrder: index,
		status: "queued",
		sticky: true,
		deliveries: [{ runId: "run", stageId: `stage-${index}`, deliveredAt: "2026-10-24T23:26:07.000Z" }],
		deliveryCount: 1,
	});
	const initial = [entry(0), entry(1), entry(2)];
	assert.equal(await backend.persistPendingStageMessages("run", initial), true);
	const { deliveries: _deliveries, notInKnownSet: _known, ...cleared } = initial[1]!;
	const messages = [initial[0]!, { ...cleared, deliveryCount: 0 }, initial[2]!];
	assert.equal(await backend.persistPendingStageMessages("run", messages), true);
	const latest = (await entries(backend.journal)).at(-1)!;
	assert.equal(latest.event.type, RUN_EVENT_TYPES.messageQueued);
	const change = (latest.event.payload as { pendingStageMessageChange?: readonly PendingStageListChangeItem[] })
		.pendingStageMessageChange;
	assert.deepEqual(change, [
		[0, 1],
		{ patch: 1, set: { deliveryCount: 0 }, unset: ["notInKnownSet", "deliveries"] },
		[2, 1],
	]);
	assert.deepEqual(backend.getWorkflow("run")?.pendingStageMessages, messages);
	await backend.close();
	const listed = await JournalDurableBackend.open(await openSqlRunJournal(path), { runs: [] });
	opened.push(listed);
	await listed.prepareWorkflowCatalog();
	assert.deepEqual(listed.getWorkflow("run")?.pendingStageMessages, messages);
	const resumed = await open(path);
	await resumed.hydrateWorkflow("run");
	assert.deepEqual(resumed.getWorkflow("run")?.pendingStageMessages, messages);
});

test("a pending-list write that loses a sequence race to another writer still appends only its change (#3929)", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const journal = backend.journal;
	const append = journal.append.bind(journal);
	let pinnedWrites = 0;
	journal.append = async (lease, event, options) => {
		if (
			options?.expectSeq !== undefined &&
			event.type === RUN_EVENT_TYPES.messageQueued &&
			pinnedWrites++ % 2 === 0
		) {
			await append(lease, {
				type: RUN_EVENT_TYPES.messageDelivered,
				payload: { messageId: "foreign", delivery: { sessionId: "foreign", deliveredAt: 1 } },
			});
		}
		return await append(lease, event, options);
	};
	const sticky = (index: number): PendingStageMessage => ({
		id: `message-${index}`,
		runId: "run",
		stageKey: `workflow:run/child-c${index}/**`,
		targetPath: `workflow:run/child-c${index}/**`,
		notInKnownSet: true,
		from: { id: `sender-${index}`, name: `subagent-chat-${index}`, cwd: "/repo", groups: ["workflow:run"] },
		message: { id: `message-${index}`, timestamp: index, content: { text: `hello from child ${index}` } },
		queuedAt: "2026-10-24T23:26:06.916Z",
		admissionOrder: 1,
		status: "queued",
		sticky: true,
		deliveryCount: 0,
	});
	let messages: PendingStageMessage[] = [];
	for (let send = 0; send < 40; send++) {
		messages = [...messages, sticky(send)];
		assert.equal(await backend.persistPendingStageMessages("run", messages), true);
	}
	const [first, ...later] = (await entries(journal)).filter(
		(entry) => entry.event.type === RUN_EVENT_TYPES.messageQueued,
	);
	assert.ok("pendingStageMessages" in (first!.event.payload as object), "the run's first pending list has no base");
	const rewrites = later.filter((entry) => "pendingStageMessages" in (entry.event.payload as object));
	assert.equal(rewrites.length, 0, `${rewrites.length} of ${later.length} later queued events rewrote the whole list`);
	assert.deepEqual(backend.getWorkflow("run")?.pendingStageMessages, messages);
	await backend.close();
	const resumed = await open(path);
	await resumed.hydrateWorkflow("run");
	assert.deepEqual(resumed.getWorkflow("run")?.pendingStageMessages, messages);
});

test("additive checkpoints propagate typed counter violations instead of hiding them", async () => {
	const journal = await openSqlRunJournal(database());
	let fail = false;
	const append = journal.append.bind(journal);
	journal.append = async (lease, event, options) => {
		if (fail) throw new JournalCounterRangeError(lease.runId, "seq", Number.MAX_SAFE_INTEGER + 1, "overflow");
		return append(lease, event, options);
	};
	const backend = await JournalDurableBackend.open(journal);
	opened.push(backend);
	await register(backend);
	fail = true;
	await assert.rejects(backend.commitAdditiveCheckpointBestEffort(checkpoint()), (error: Error) => {
		assert.ok(error instanceof JournalCounterRangeError);
		assert.equal(error.runId, "run");
		assert.equal(error.field, "seq");
		assert.equal(error.value, Number.MAX_SAFE_INTEGER + 1);
		assert.equal(error.reason, "overflow");
		return true;
	});
	assert.equal((await entries(journal)).length, 1);
	assert.equal(backend.listCheckpoints("run").length, 0);
});

test("status snapshots preserve unchanged active prompt reservations across reopen", async () => {
	const path = database();
	const backend = await open(path);
	await register(backend);
	const token = await backend.reservePendingPrompt("run", "prompt");
	await backend.commitWorkflowStatus("run", "paused");
	await backend.close();
	const resumed = await open(path);
	await resumed.releasePendingPrompt("run", "prompt", token);
	assert.equal(resumed.getWorkflow("run")?.pendingPrompts, 0);
});

test("lease handoff refreshes the projection before writing a status snapshot", async () => {
	const path = database();
	const first = await open(path);
	await register(first);
	const second = await open(path);
	await first.commitCheckpoint(checkpoint());
	await first.persistSummary("run", "keep summary", 1);
	const token = await first.reservePendingPrompt("run", "prompt");
	await first.close();
	await second.commitWorkflowStatus("run", "paused");
	assert.equal(second.getWorkflow("run")?.completedCheckpoints, 1);
	assert.equal(second.getWorkflow("run")?.summary, "keep summary");
	assert.equal(second.getWorkflow("run")?.pendingPrompts, 1);
	await second.releasePendingPrompt("run", "prompt", token);
	assert.equal(second.getWorkflow("run")?.pendingPrompts, 0);
});

test("catalog and targeted hydration remove deleted runs and rebuild recreated run identities", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	await writer.commitCheckpoint(checkpoint("old"));
	await writer.commitWorkflowStatus("run", "completed");
	const reader = await open(path);
	assert.equal((await reader.prepareWorkflowCatalog()).completed.length, 1);
	await writer.deleteWorkflow("run");
	assert.equal((await reader.prepareWorkflowCatalog()).completed.length, 0);
	assert.equal(reader.getWorkflow("run"), undefined);
	await register(writer);
	await writer.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new" });
	await reader.hydrateWorkflow("run");
	assert.deepEqual(
		reader.listCheckpoints("run").map((entry) => entry.checkpointId),
		["new"],
	);
	assert.equal(reader.getToolOutput("run", "hash"), "new");
	await writer.deleteWorkflow("run");
	await register(writer);
	await writer.commitCheckpoint({ ...checkpoint("recreated"), checkpointId: "recreated" });
	await reader.hydrateWorkflow("run");
	assert.deepEqual(
		reader.listCheckpoints("run").map((entry) => entry.checkpointId),
		["recreated"],
	);
	assert.equal(reader.getToolOutput("run", "hash"), "recreated");
});

test("status mutation after recreation rebuilds a shorter journal without explicit hydration", async () => {
	const path = database();
	const writer = await open(path);
	await writer.commitWorkflowRegistration({
		workflowId: "run",
		name: "old",
		inputs: { identity: "old" },
		createdAt: 1,
		status: "running",
	});
	await writer.commitCheckpoint({ ...checkpoint("old"), checkpointId: "old" });
	await writer.persistSummary("run", "old summary", 1);
	await writer.commitWorkflowStatus("run", "paused");
	assert.equal((await entries(writer.journal)).length, 4);
	const observer = await open(path);
	await writer.deleteWorkflow("run");
	await writer.commitWorkflowRegistration({
		workflowId: "run",
		name: "new",
		inputs: { identity: "new" },
		createdAt: 5,
		status: "running",
	});
	await writer.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new", completedAt: 6 });
	await writer.close();
	await observer.commitWorkflowStatus("run", "paused");
	const fresh = await open(path);
	assert.deepEqual(fresh.getWorkflow("run")!.inputs, { identity: "new" });
	assert.deepEqual(observer.getWorkflow("run"), fresh.getWorkflow("run"));
	assert.deepEqual(observer.listCheckpoints("run"), fresh.listCheckpoints("run"));
	assert.deepEqual(
		observer.listCheckpoints("run").map((entry) => entry.checkpointId),
		["new"],
	);
	assert.equal(observer.getWorkflow("run")!.completedCheckpoints, 1);
	assert.equal(observer.getWorkflow("run")!.name, "new");
	assert.equal(observer.getWorkflow("run")!.createdAt, 5);
	assert.equal(observer.getWorkflow("run")!.summary, undefined);
	const latest = (await entries(observer.journal)).at(-1)!;
	assert.equal(latest.event.type, RUN_EVENT_TYPES.statusChanged);
	assert.deepEqual(latest.event.payload, JSON.parse(JSON.stringify(observer.getWorkflow("run"))));
});

for (const extra of [0, 1]) {
	test(`recreation with ${extra === 0 ? "an equal" : "a longer"} journal replaces all cached state before mutation`, async () => {
		const path = database();
		const writer = await open(path);
		const message = (identity: string): PendingStageMessage => ({
			id: identity,
			runId: "run",
			stageKey: "stage",
			from: { id: identity },
			message: { id: identity, timestamp: 1, content: { text: identity } },
			queuedAt: identity,
			admissionOrder: 1,
			status: "queued",
		});
		const delivery = {
			runId: "run",
			stageId: "stage",
			sessionId: "session",
			admission: "context" as const,
			deliveredAt: "raw",
		};
		await writer.commitWorkflowRegistration({
			workflowId: "run",
			name: "old",
			inputs: { identity: "old" },
			createdAt: 1,
			status: "running",
		});
		await writer.commitCheckpoint({ ...checkpoint("old"), checkpointId: "old" });
		await writer.commitCheckpoint({ ...checkpoint("old two"), checkpointId: "old two" });
		await writer.persistSummary("run", "old summary", 99);
		await writer.reservePendingPrompt("run", "old prompt");
		await writer.persistPendingStageMessages("run", [message("old")]);
		await writer.archivePendingStageMessage("run", message("old"));
		await writer.archivePendingStageDeliveryReceipt("run", "old", delivery, {
			messageRunId: "run",
			deliveryCount: 9,
		});
		assert.equal((await entries(writer.journal)).length, 8);
		const observer = await open(path);
		await writer.deleteWorkflow("run");
		await writer.commitWorkflowRegistration({
			workflowId: "run",
			name: "new",
			inputs: { identity: "new" },
			createdAt: 5,
			status: "running",
		});
		await writer.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new", completedAt: 6 });
		await writer.persistSummary("run", "new summary", 1);
		const token = await writer.reservePendingPrompt("run", "new prompt");
		await writer.persistPendingStageMessages("run", [message("new")]);
		await writer.archivePendingStageMessage("run", message("new"));
		await writer.archivePendingStageDeliveryReceipt("run", "new", delivery, {
			messageRunId: "run",
			deliveryCount: 2,
		});
		for (let index = 0; index <= extra; index++) await writer.commitWorkflowStatus("run", "running");
		assert.equal((await entries(writer.journal)).length, 8 + extra);
		await writer.close();
		await observer.commitWorkflowStatus("run", "paused");
		const fresh = await open(path);
		for (const backend of [observer, fresh]) {
			const handle = backend.getWorkflow("run")!;
			assert.deepEqual(handle.inputs, { identity: "new" });
			assert.equal(handle.name, "new");
			assert.equal(handle.createdAt, 5);
			assert.equal(handle.summary, "new summary");
			assert.equal(handle.summarizedThrough, 1);
			assert.equal(handle.completedCheckpoints, 1);
			assert.equal(handle.pendingPrompts, 1);
			assert.deepEqual(handle.pendingStageMessages, [message("new")]);
			assert.deepEqual(
				backend.listCheckpoints("run").map((entry) => entry.checkpointId),
				["new"],
			);
			assert.equal(await backend.readSettledPendingStageMessage("run", "old"), undefined);
			assert.deepEqual(await backend.readSettledPendingStageMessage("run", "new"), message("new"));
			assert.equal(await backend.hasPendingStageDeliveryReceipt("run", "old", delivery), false);
			assert.equal(await backend.hasPendingStageDeliveryReceipt("run", "new", delivery), true);
			assert.equal(await backend.readPendingStageMessageDeliveryCount("run", "old"), 0);
			assert.equal(await backend.readPendingStageMessageDeliveryCount("run", "new"), 2);
		}
		assert.deepEqual(observer.getWorkflow("run"), fresh.getWorkflow("run"));
		assert.deepEqual(observer.listCheckpoints("run"), fresh.listCheckpoints("run"));
		const latest = (await entries(observer.journal)).at(-1)!;
		assert.equal(latest.event.type, RUN_EVENT_TYPES.statusChanged);
		// The status change writes the recreated run's handle; its pending entries may be written as a change.
		const { pendingStageMessages: _list, ...expected } = JSON.parse(JSON.stringify(fresh.getWorkflow("run")));
		const { pendingStageMessages: _written, pendingStageMessageChange: _change, ...payload } = latest.event.payload;
		assert.deepEqual(payload, expected);
		assert.equal(await observer.pendingPromptToken("run", "old prompt"), undefined);
		await observer.releasePendingPrompt("run", "new prompt", token);
		assert.equal(observer.getWorkflow("run")!.pendingPrompts, 0);
	});
}

test("a retained stale lease stays lost after deletion and recreation even after hydration", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	const stale = await open(path);
	await register(stale);
	const oldEpoch = (await stale.journal.leaseState("run"))!.epoch;
	expire(path);
	const replacement = await open(path);
	await replacement.commitCheckpoint(checkpoint());
	await replacement.deleteWorkflow("run");
	await register(replacement);
	await replacement.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new" });
	const currentEpoch = (await replacement.journal.leaseState("run"))!.epoch;
	await replacement.close();
	const before = await entries(stale.journal);
	let lost: JournalOwnershipError | undefined;
	await assert.rejects(
		async () => await stale.commitWorkflowStatus("run", "paused"),
		(error: Error) => {
			assert.ok(error instanceof JournalOwnershipError);
			assert.equal(error.runId, "run");
			assert.equal(error.holderId, null);
			assert.ok(error.cause instanceof StaleLeaseError);
			assert.equal(error.cause.runId, "run");
			assert.equal(error.cause.heldEpoch, oldEpoch);
			assert.equal(error.cause.currentEpoch, currentEpoch);
			lost = error;
			return true;
		},
	);
	await stale.hydrateWorkflow("run");
	await assert.rejects(
		async () => await stale.commitCheckpoint(checkpoint("stale")),
		(error: Error) => error === lost,
	);
	assert.deepEqual(await entries(stale.journal), before);
	assert.equal(await stale.journal.leaseState("run"), undefined);
});

test("mutation of a deleted unrecreated run clears cached state and preserves absent-run results", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	await writer.commitCheckpoint(checkpoint());
	const observer = await open(path);
	await writer.deleteWorkflow("run");
	await observer.commitWorkflowStatus("run", "paused");
	await observer.commitCheckpoint(checkpoint("ignored"));
	assert.equal(observer.getWorkflow("run"), undefined);
	assert.deepEqual(observer.listCheckpoints("run"), []);
	assert.equal(await observer.commitWorkflowStatusTransition("run", ["running"], "paused"), false);
	assert.equal(await observer.persistSummary("run", "ignored", 1), false);
	assert.equal(await observer.persistPendingStageMessages("run", []), false);
	assert.deepEqual(await observer.deleteWorkflowIfInactive("run"), { ok: false, reason: "not_found" });
	await observer.deleteWorkflow("run");
	assert.deepEqual(await entries(observer.journal), []);
	assert.equal(await observer.journal.leaseState("run"), undefined);
	await register(observer);
	assert.equal(observer.getWorkflow("run")!.completedCheckpoints, 0);
	assert.deepEqual(observer.listCheckpoints("run"), []);
});

for (const mutation of ["status claim", "delivery receipt"] as const) {
	test(`${mutation} as the first mutation after recreation folds the replacement without hydration`, async () => {
		const path = database();
		const writer = await open(path);
		await register(writer);
		await writer.commitCheckpoint({ ...checkpoint("old"), checkpointId: "old" });
		await writer.commitWorkflowStatus("run", "paused");
		const observer = await open(path);
		await writer.deleteWorkflow("run");
		await writer.commitWorkflowRegistration({
			workflowId: "run",
			name: "new",
			inputs: { identity: "new" },
			createdAt: 5,
			status: "running",
		});
		await writer.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new", completedAt: 6 });
		await writer.close();
		if (mutation === "status claim") {
			assert.equal(
				await observer.commitWorkflowStatusTransition("run", ["running"], "completed", undefined, undefined, 6),
				true,
			);
		} else {
			await observer.archivePendingStageDeliveryReceipt(
				"run",
				"new message",
				{
					runId: "run",
					stageId: "stage",
					sessionId: "session",
					admission: "context",
					deliveredAt: "raw",
				},
				{ messageRunId: "run", deliveryCount: 2 },
			);
			assert.equal(await observer.readPendingStageMessageDeliveryCount("run", "new message"), 2);
		}
		const fresh = await open(path);
		assert.deepEqual(observer.getWorkflow("run")!.inputs, { identity: "new" });
		assert.deepEqual(observer.getWorkflow("run"), fresh.getWorkflow("run"));
		assert.deepEqual(observer.listCheckpoints("run"), fresh.listCheckpoints("run"));
		assert.deepEqual(
			observer.listCheckpoints("run").map((entry) => entry.checkpointId),
			["new"],
		);
		assert.equal(observer.getWorkflow("run")!.completedCheckpoints, 1);
	});
}

for (const change of ["late registration", "external deletion"] as const) {
	test(`direct deletion first after ${change} uses durable existence without hydration`, async () => {
		const path = database();
		const writer = await open(path);
		if (change === "external deletion") {
			await register(writer);
			await writer.commitCheckpoint(checkpoint("old"));
		}
		const observer = await open(path);
		if (change === "late registration") await register(writer);
		else await writer.deleteWorkflow("run");
		await writer.close();
		await observer.deleteWorkflow("run");
		assert.equal(observer.getWorkflow("run"), undefined);
		assert.deepEqual(observer.listCheckpoints("run"), []);
		const fresh = await open(path);
		assert.equal(fresh.getWorkflow("run"), undefined);
		assert.deepEqual(await observer.prepareWorkflowCatalog(), await fresh.prepareWorkflowCatalog());
		assert.deepEqual(await fresh.prepareWorkflowCatalog(), { resumable: [], completed: [], inspectableIds: [] });
		const db = new JournalTestDatabase(path);
		try {
			for (const table of [JOURNAL_TABLES.runs, JOURNAL_TABLES.events]) {
				assert.equal(db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count, 0);
			}
			assert.equal(
				db.get<{ holder: string | null }>(
					`SELECT ${JOURNAL_COLUMNS.holderId} AS holder FROM ${JOURNAL_TABLES.leases}`,
				)?.holder,
				null,
			);
		} finally {
			db.close();
		}
		await observer.deleteWorkflow("run");
		assert.deepEqual(await observer.deleteWorkflowIfInactive("run"), { ok: false, reason: "not_found" });
		await register(observer);
		await observer.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new" });
		const recreated = await open(path);
		assert.deepEqual(observer.getWorkflow("run"), recreated.getWorkflow("run"));
		assert.deepEqual(observer.listCheckpoints("run"), recreated.listCheckpoints("run"));
		assert.deepEqual(
			observer.listCheckpoints("run").map((entry) => entry.checkpointId),
			["new"],
		);
	});
}

test("direct deletion first after recreation removes the current run and its checkpoints", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	await writer.commitCheckpoint(checkpoint("old"));
	const observer = await open(path);
	await writer.deleteWorkflow("run");
	await register(writer);
	await writer.commitCheckpoint({ ...checkpoint("new"), checkpointId: "new" });
	const epoch = (await writer.journal.leaseState("run"))!.epoch;
	await writer.close();
	await observer.deleteWorkflow("run");
	const fresh = await open(path);
	assert.equal(observer.getWorkflow("run"), undefined);
	assert.equal(fresh.getWorkflow("run"), undefined);
	assert.deepEqual(fresh.listCheckpoints("run"), []);
	assert.deepEqual(await fresh.journal.listRuns(), []);
	assert.deepEqual(await entries(fresh.journal), []);
	await register(observer);
	assert.equal((await observer.journal.leaseState("run"))!.epoch, epoch + 2);
	await observer.deleteWorkflow("run");
	assert.deepEqual(await observer.journal.listRuns(), []);
	assert.equal(await observer.journal.leaseState("run"), undefined);
});

test("late registration deletion refuses a fresh foreign holder before deleting after release", async () => {
	const path = database();
	const observer = await open(path);
	const writer = await open(path);
	await register(writer);
	const before = await entries(writer.journal);
	const lease = await writer.journal.leaseState("run");
	await assert.rejects(observer.deleteWorkflow("run"), (error: Error) => {
		assert.ok(error instanceof JournalOwnershipError);
		assert.equal(error.runId, "run");
		assert.equal(error.holderId, writer.holderId);
		assert.equal(error.cause, undefined);
		return true;
	});
	assert.deepEqual(await entries(writer.journal), before);
	assertLeaseStateUnchanged(await writer.journal.leaseState("run"), lease);
	assert.deepEqual((await open(path)).getWorkflow("run"), writer.getWorkflow("run"));
	await writer.close();
	await observer.deleteWorkflow("run");
	assert.equal((await open(path)).getWorkflow("run"), undefined);
	assert.deepEqual(await observer.journal.listRuns(), []);
});

test("direct deletion retains stale held-lease fencing even with an empty cached projection", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const path = database();
	const stale = await open(path);
	await register(stale);
	const heldEpoch = (await stale.journal.leaseState("run"))!.epoch;
	expire(path);
	const writer = await open(path);
	await writer.commitCheckpoint(checkpoint("current"));
	await writer.deleteWorkflow("run");
	await stale.hydrateWorkflow("run");
	assert.equal(stale.getWorkflow("run"), undefined);
	await register(writer);
	const currentEpoch = (await writer.journal.leaseState("run"))!.epoch;
	const before = await entries(writer.journal);
	await assert.rejects(stale.deleteWorkflow("run"), (error: Error) => {
		assert.ok(error instanceof JournalOwnershipError);
		assert.equal(error.runId, "run");
		assert.equal(error.holderId, writer.holderId);
		assert.ok(error.cause instanceof StaleLeaseError);
		assert.equal(error.cause.runId, "run");
		assert.equal(error.cause.heldEpoch, heldEpoch);
		assert.equal(error.cause.currentEpoch, currentEpoch);
		return true;
	});
	assert.deepEqual(await entries(writer.journal), before);
	await writer.close();
	await assert.rejects(stale.deleteWorkflow("run"), JournalOwnershipError);
	assert.deepEqual(writer.getWorkflow("run"), (await open(path)).getWorkflow("run"));
});

test("status claims recheck the acquired equal-sequence incarnation", async () => {
	const path = database();
	const writer = await open(path);
	await writer.commitWorkflowRegistration({
		workflowId: "run",
		name: "old",
		inputs: {},
		createdAt: 1,
		updatedAt: 1,
		status: "paused",
	});
	await writer.close();
	const replacement = await open(path);
	const journal = await interleavedJournal(path, async (runId) => {
		await replacement.journal.deleteRun(runId);
		await replacement.commitWorkflowRegistration({
			workflowId: runId,
			name: "replacement",
			inputs: { identity: "replacement" },
			createdAt: 2,
			updatedAt: 2,
			status: "running",
		});
		await replacement.journal.release((await replacement.journal.leaseState(runId))!);
	});
	const observer = await JournalDurableBackend.open(journal);
	opened.push(observer);
	assert.equal(await observer.commitWorkflowStatusTransition("run", ["paused"], "completed"), false);
	const fresh = await open(path);
	assert.equal(fresh.getWorkflow("run")!.status, "running");
	assert.deepEqual(fresh.getWorkflow("run")!.inputs, { identity: "replacement" });
	assert.equal((await entries(fresh.journal)).length, 1);
});

test("inactive deletion rechecks the acquired equal-sequence incarnation", async () => {
	const path = database();
	const writer = await open(path);
	await writer.commitWorkflowRegistration({
		workflowId: "run",
		name: "old",
		inputs: {},
		createdAt: 1,
		status: "paused",
	});
	await writer.close();
	const replacement = await open(path);
	const journal = await interleavedJournal(path, async (runId) => {
		await replacement.journal.deleteRun(runId);
		await replacement.commitWorkflowRegistration({
			workflowId: runId,
			name: "replacement",
			inputs: {},
			createdAt: 2,
			status: "running",
		});
		await replacement.journal.release((await replacement.journal.leaseState(runId))!);
	});
	const observer = await JournalDurableBackend.open(journal);
	opened.push(observer);
	assert.deepEqual(await observer.deleteWorkflowIfInactive("run"), { ok: false, reason: "running" });
	assert.equal((await open(path)).getWorkflow("run")!.status, "running");
	assert.equal((await entries(observer.journal)).length, 1);
});

test("backend writes use standard JSON for negative zero across repeated snapshots", async () => {
	const path = database();
	const input = Object.freeze({ value: -0 });
	const expected = JSON.parse(JSON.stringify(input)) as { value: number };
	const output = JSON.parse(JSON.stringify(-0)) as number;
	const backend = await open(path);
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "zero",
		inputs: input,
		createdAt: 0,
		status: "running",
	});
	await backend.commitCheckpoint({ ...checkpoint(), output: -0 });
	const verify = (reader: JournalDurableBackend) => {
		assert.deepEqual(reader.getWorkflow("run")!.inputs, expected);
		assert.ok(Object.is(reader.getToolOutput("run", "hash"), output));
		assert.deepEqual(reader.toMetadata("run")!.inputs, expected);
		assert.ok(Object.is(reader.getToolCheckpoint("run", "hash")!.output, output));
		const stored = reader.listCheckpoints("run")[0]!;
		assert.ok(stored.kind === "tool");
		assert.ok(Object.is(stored.output, output));
	};
	verify(backend);
	for (let repeat = 0; repeat < 2; repeat++) {
		await backend.commitWorkflowStatus("run", "paused");
		const token = await backend.reservePendingPrompt("run", "prompt");
		await backend.releasePendingPrompt("run", "prompt", token);
		await backend.persistPendingStageMessages("run", []);
		await backend.persistSummary("run", "summary", repeat);
		verify(backend);
		await backend.hydrateWorkflow("run");
		verify(backend);
		verify(await open(path));
	}
	for (const entry of await entries(backend.journal)) {
		const payload = entry.event.payload as {
			inputs?: { value: number };
			handle?: { inputs: { value: number } };
			output?: number;
		};
		if (entry.event.type === RUN_EVENT_TYPES.checkpointRecorded) assert.ok(Object.is(payload.output, output));
		else assert.deepEqual((payload.handle ?? payload).inputs, expected);
	}
	const db = new JournalTestDatabase(path);
	try {
		assert.ok(db.get<{ json: string }>("SELECT header_json AS json FROM wf_runs")!.json.includes('"value":0'));
		for (const row of db.all<{ json: string }>("SELECT payload AS json FROM wf_events"))
			assert.equal(row.json.includes(":-0"), false);
	} finally {
		db.close();
	}
	await backend.close();
	verify(await open(path));
	assert.ok(Object.is(input.value, -0));
});

test("direct deletion clears all cached state when another deletion wins acquisition", async () => {
	const path = database();
	const writer = await open(path);
	await register(writer);
	await writer.commitCheckpoint(checkpoint());
	await writer.persistSummary("run", "old summary", 1);
	await writer.reservePendingPrompt("run", "old prompt");
	const message: PendingStageMessage = {
		id: "old",
		runId: "run",
		stageKey: "stage",
		from: { id: "sender" },
		message: { id: "old", timestamp: 1, content: { text: "old" } },
		queuedAt: "raw",
		admissionOrder: 1,
		status: "queued",
	};
	const delivery = {
		runId: "run",
		stageId: "stage",
		sessionId: "session",
		admission: "context" as const,
		deliveredAt: "raw",
	};
	await writer.persistPendingStageMessages("run", [message]);
	await writer.archivePendingStageMessage("run", message);
	await writer.archivePendingStageDeliveryReceipt("run", message.id, delivery, {
		messageRunId: "run",
		deliveryCount: 9,
	});
	await writer.close();
	const remover = await open(path);
	let removal: Promise<void> | undefined;
	const journal = await interleavedJournal(path, async (runId) => {
		removal = remover.deleteWorkflow(runId);
		await removal;
	});
	const observer = await JournalDurableBackend.open(journal);
	opened.push(observer);
	assert.ok(observer.getWorkflow("run"));
	assert.equal(observer.listCheckpoints("run").length, 1);
	assert.deepEqual(await observer.readSettledPendingStageMessage("run", message.id), message);
	assert.equal(await observer.hasPendingStageDeliveryReceipt("run", message.id, delivery), true);
	assert.equal(await observer.readPendingStageMessageDeliveryCount("run", message.id), 9);
	await observer.deleteWorkflow("run");
	assert.ok(removal);
	await removal;
	assert.equal(observer.getWorkflow("run"), undefined);
	assert.equal(observer.getLoadableWorkflow("run"), undefined);
	assert.equal(observer.toMetadata("run"), undefined);
	assert.deepEqual(observer.listCheckpoints("run"), []);
	assert.equal(await observer.pendingPromptToken("run", "old prompt"), undefined);
	assert.equal(await observer.readSettledPendingStageMessage("run", message.id), undefined);
	assert.equal(await observer.hasPendingStageDeliveryReceipt("run", message.id, delivery), false);
	assert.equal(await observer.readPendingStageMessageDeliveryCount("run", message.id), 0);
	assert.deepEqual(await observer.journal.listRuns(), []);
	assert.deepEqual(await entries(observer.journal), []);
	assert.equal(await observer.journal.leaseState("run"), undefined);
	assert.deepEqual(await observer.prepareWorkflowCatalog(), { resumable: [], completed: [], inspectableIds: [] });
	assert.equal((await open(path)).getWorkflow("run"), undefined);
});

for (const action of ["claim", "delete"] as const) {
	test(`${action} preserves absent-run results when deletion wins during acquisition`, async () => {
		const path = database();
		const writer = await open(path);
		await writer.commitWorkflowRegistration({
			workflowId: "run",
			name: "old",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		await writer.close();
		const remover = await open(path);
		const journal = await interleavedJournal(path, async (runId) => {
			await remover.deleteWorkflow(runId);
		});
		const observer = await JournalDurableBackend.open(journal);
		opened.push(observer);
		if (action === "claim")
			assert.equal(await observer.commitWorkflowStatusTransition("run", ["paused"], "completed"), false);
		else assert.deepEqual(await observer.deleteWorkflowIfInactive("run"), { ok: false, reason: "not_found" });
		assert.equal(observer.getWorkflow("run"), undefined);
		assert.equal((await open(path)).getWorkflow("run"), undefined);
		assert.deepEqual(await entries(observer.journal), []);
		assert.equal(await observer.journal.leaseState("run"), undefined);
	});
}

async function interleaveAcquisition(
	change: (replacement: JournalDurableBackend) => void | Promise<void>,
	oldLength = 1,
) {
	const path = database();
	const writer = await open(path);
	for (let index = 0; index < oldLength; index++) {
		await writer.commitWorkflowRegistration({
			workflowId: "run",
			name: "old",
			inputs: { identity: "old" },
			createdAt: 1,
			updatedAt: 1,
			status: "paused",
		});
	}
	await writer.close();
	const replacement = await open(path);
	let armed = true;
	const journal = await interleavedJournal(path, async () => {
		if (armed) {
			armed = false;
			await change(replacement);
		}
	});
	const observer = await JournalDurableBackend.open(journal);
	opened.push(observer);
	return { path, observer, replacement };
}

for (const [length, oldLength, newLength] of [
	["shorter", 3, 1],
	["equal", 1, 1],
	["longer", 1, 3],
] as const) {
	for (const predicate of ["matching", "status mismatch", "timestamp mismatch"] as const) {
		test(`claim uses acquired ${length} sequence and ${predicate} predicate`, async () => {
			const { path, observer } = await interleaveAcquisition(async (replacement) => {
				await replacement.journal.deleteRun("run");
				for (let index = 0; index < newLength; index++) {
					await replacement.commitWorkflowRegistration({
						workflowId: "run",
						name: "replacement",
						inputs: { identity: "new" },
						createdAt: 2,
						updatedAt: predicate === "timestamp mismatch" ? 2 : 1,
						status: predicate === "status mismatch" ? "running" : "paused",
					});
				}
				await replacement.close();
			}, oldLength);
			assert.equal(
				await observer.commitWorkflowStatusTransition(
					"run",
					["paused", "paused"],
					"completed",
					undefined,
					undefined,
					1,
				),
				predicate === "matching",
			);
			const fresh = await open(path);
			assert.equal(
				fresh.getWorkflow("run")!.status,
				predicate === "matching" ? "completed" : predicate === "status mismatch" ? "running" : "paused",
			);
			assert.deepEqual(fresh.getWorkflow("run")!.inputs, { identity: "new" });
			assert.equal((await entries(fresh.journal)).length, newLength + (predicate === "matching" ? 1 : 0));
		});
	}
	for (const status of ["running", "paused"] as const) {
		test(`inactive deletion uses acquired ${length} sequence and ${status} status`, async () => {
			const { path, observer } = await interleaveAcquisition(async (replacement) => {
				await replacement.journal.deleteRun("run");
				for (let index = 0; index < newLength; index++) {
					await replacement.commitWorkflowRegistration({
						workflowId: "run",
						name: "replacement",
						inputs: {},
						createdAt: 2,
						status,
					});
				}
				await replacement.close();
			}, oldLength);
			assert.deepEqual(
				await observer.deleteWorkflowIfInactive("run"),
				status === "paused" ? { ok: true } : { ok: false, reason: "running" },
			);
			const fresh = await open(path);
			assert.equal(fresh.getWorkflow("run")?.status, status === "paused" ? undefined : "running");
			assert.equal((await entries(fresh.journal)).length, status === "paused" ? 0 : newLength);
		});
	}
}

for (const action of ["claim", "delete"] as const) {
	test(`${action} refuses a fresh competitor acquired during the guard gap`, async () => {
		const { path, observer, replacement } = await interleaveAcquisition(async (backend) => {
			await backend.journal.deleteRun("run");
			await backend.commitWorkflowRegistration({
				workflowId: "run",
				name: "replacement",
				inputs: {},
				createdAt: 2,
				status: "paused",
			});
		});
		await assert.rejects(
			action === "claim"
				? observer.commitWorkflowStatusTransition("run", ["paused"], "completed")
				: observer.deleteWorkflowIfInactive("run"),
			(error: Error) => {
				assert.ok(error instanceof JournalOwnershipError);
				assert.equal(error.runId, "run");
				assert.equal(error.holderId, replacement.holderId);
				assert.equal(error.cause, undefined);
				return true;
			},
		);
		assert.equal((await open(path)).getWorkflow("run")!.status, "paused");
		assert.equal((await entries(observer.journal)).length, 1);
	});
	test(`${action} cannot silently reacquire a stale execution after replacement`, async () => {
		const path = database();
		const stale = await open(path);
		await stale.commitWorkflowRegistration({
			workflowId: "run",
			name: "old",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		const heldEpoch = (await stale.journal.leaseState("run"))!.epoch;
		const replacement = await open(path);
		const takeover = await replacement.journal.takeover("run", replacement.holderId, stale.holderId);
		assert.equal(takeover.status, "acquired");
		await replacement.deleteWorkflow("run");
		await replacement.commitWorkflowRegistration({
			workflowId: "run",
			name: "replacement",
			inputs: {},
			createdAt: 2,
			status: "paused",
		});
		const currentEpoch = (await replacement.journal.leaseState("run"))!.epoch;
		await replacement.close();
		const before = await entries(stale.journal);
		let failure: JournalOwnershipError | undefined;
		for (let repeat = 0; repeat < 2; repeat++) {
			await assert.rejects(
				action === "claim"
					? stale.commitWorkflowStatusTransition("run", ["paused"], "completed")
					: stale.deleteWorkflowIfInactive("run"),
				(error: Error) => {
					assert.ok(error instanceof JournalOwnershipError);
					assert.ok(error.cause instanceof StaleLeaseError);
					assert.equal(error.cause.heldEpoch, heldEpoch);
					assert.equal(error.cause.currentEpoch, currentEpoch);
					if (failure) assert.equal(error, failure);
					failure = error;
					return true;
				},
			);
			await stale.hydrateWorkflow("run");
		}
		assert.deepEqual(await entries(stale.journal), before);
		assert.equal(await stale.journal.leaseState("run"), undefined);
	});
}

for (const runtime of ["node", "bun"] as const) {
	for (const action of ["claim", "delete"] as const) {
		for (const length of ["same", "longer"] as const) {
			test(
				`${runtime} child replacement during acquisition preserves ${action} guard at ${length} sequence`,
				async () => {
					const { path, observer } = await interleaveAcquisition(() => {
						const child = spawnSyncCollect(
							[
								runtime === "bun" ? bunExecutable() : process.execPath,
								resolve("test/fixtures/journal-backend-acquisition-child.mjs"),
								path,
								length,
							],
							{ timeout: FRESH_PROCESS_TIMEOUT_MS },
						);
						assert.equal(child.exitCode, 0, child.stderr.toString());
						const snapshot = JSON.parse(child.stdout.toString()) as {
							handle: { status: string };
							entries: { seq: number; epoch: number }[];
						};
						assert.equal(snapshot.handle.status, "running");
						assert.equal(snapshot.entries.length, length === "same" ? 1 : 2);
						assert.equal(snapshot.entries[0]!.epoch, 3);
					});
					if (action === "claim")
						assert.equal(await observer.commitWorkflowStatusTransition("run", ["paused"], "completed"), false);
					else assert.deepEqual(await observer.deleteWorkflowIfInactive("run"), { ok: false, reason: "running" });
					const fresh = await open(path);
					assert.equal(fresh.getWorkflow("run")!.status, "running");
					assert.deepEqual(fresh.getWorkflow("run")!.inputs, { identity: "replacement" });
					assert.equal((await entries(fresh.journal)).length, length === "same" ? 1 : 2);
				},
				FRESH_PROCESS_TIMEOUT_MS,
			);
		}
	}
}

test("backend serialization keeps native lexemes and calls caller toJSON once per durable write", async () => {
	const path = database();
	const nativeJson = JSON as typeof JSON & { rawJSON(text: string): Readonly<{ rawJSON: string }> };
	const values = Object.freeze([
		nativeJson.rawJSON("1.2300e+02"),
		nativeJson.rawJSON("-0"),
		nativeJson.rawJSON('"\\u0061"'),
		nativeJson.rawJSON('"\ud800"'),
		nativeJson.rawJSON('"💡"'),
	]);
	const input = { values };
	let calls = 0;
	Object.defineProperty(input, "toJSON", {
		value: () => {
			calls++;
			return { values };
		},
	});
	Object.freeze(input);
	const backend = await open(path);
	await backend.commitWorkflowRegistration({
		workflowId: "run",
		name: "raw",
		inputs: input,
		createdAt: 0,
		status: "running",
	});
	assert.equal(calls, 2);
	await backend.commitCheckpoint({ ...checkpoint(), output: input });
	assert.equal(calls, 3);
	const before = await entries(backend.journal);
	await backend.commitCheckpoint({ ...checkpoint(), output: input });
	assert.equal(calls, 4, "append serializes once at invocation, including keyed replay");
	assert.deepEqual(await entries(backend.journal), before);
	const db = new JournalTestDatabase(path);
	try {
		const lexemes = '"values":[1.2300e+02,-0,"\\u0061","\\ud800","💡"]';
		assert.ok(db.get<{ json: string }>("SELECT header_json AS json FROM wf_runs")!.json.includes(lexemes));
		for (const row of db.all<{ json: string }>("SELECT payload AS json FROM wf_events"))
			assert.ok(row.json.includes(lexemes));
	} finally {
		db.close();
	}
	await backend.commitWorkflowStatus("run", "paused");
	assert.equal(calls, 4, "append serializes once at invocation, including keyed replay");
	const expected = { values: [123, -0, "a", "\ud800", "💡"] };
	assert.deepEqual(backend.getWorkflow("run")!.inputs, JSON.parse(JSON.stringify(expected)));
	assert.deepEqual((await open(path)).getToolOutput("run", "hash"), expected);
	assert.equal(input.values, values);
});
