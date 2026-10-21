import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { JournalEntry } from "../../packages/workflows/src/durable/journal/types.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	prepareTargetedDurableResumable,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import type { DurableWorkflowStatus, ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestDatabase } from "../helpers/journal-database.js";
import { testRunId } from "../helpers/run-id.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, sleep, spawnSyncCollect } from "../helpers/runtime.js";

/** A real Bun child process that opens the journal, writes once and exits. */
const WRITER_PROCESS_TIMEOUT_MS = 60_000;
const WRITER = resolve("test/fixtures/resume-list-cache-writer.ts");
/**
 * Time left on the crashed owner's lease when the test starts. The checks made while the lease is still live
 * run well inside it; the test then waits, without writing, until the store clock says the lease expired.
 */
const LEASE_EXPIRY_HEADROOM_MS = 5_000;
const LEASE_POLL_MS = 100;
const WORKFLOW_NAME = "cached-catalog";

/** Counts journal events a backend reads, through the journal's public read API. */
function observeEventReads(journal: SqlRunJournal) {
	const read = journal.read.bind(journal);
	const observed = { events: 0 };
	journal.read = async function* (runId: string, fromSeq?: number): AsyncIterable<JournalEntry> {
		for await (const entry of read(runId, fromSeq)) {
			observed.events++;
			yield entry;
		}
	};
	return observed;
}

async function register(backend: JournalDurableBackend, workflowId: string, status: DurableWorkflowStatus) {
	await backend.commitWorkflowRegistration({
		workflowId,
		name: WORKFLOW_NAME,
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: "tool",
		name: "tool",
		argsHash: "tool",
		output: "done",
		completedAt: 2,
	});
	await backend.commitWorkflowStatus(workflowId, status);
	await backend.releaseWorkflow(workflowId);
}

function statuses(entries: readonly ResumableWorkflowEntry[]): Record<string, string> {
	return Object.fromEntries(entries.map((entry) => [entry.workflowId, entry.status]));
}

describe("/workflow resume catalog cache", () => {
	let dir: string;
	let path: string;
	let reader: JournalDurableBackend<SqlRunJournal>;
	let events: { events: number };
	const opened: { close(): Promise<void> }[] = [];

	async function otherConnection(): Promise<JournalDurableBackend> {
		const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
		opened.push(backend);
		return backend;
	}

	function writerProcess(...args: string[]): void {
		const child = spawnSyncCollect([bunExecutable(), WRITER, path, ...args], { timeout: WRITER_PROCESS_TIMEOUT_MS });
		assert.equal(child.exitCode, 0, child.stderr.toString());
	}

	beforeEach(async () => {
		dir = makeTempDirectory("workflow-catalog-cache-");
		path = join(dir, "journal.sqlite");
		const seed = await JournalDurableBackend.open(await openSqlRunJournal(path));
		await register(seed, testRunId("paused-run"), "paused");
		await register(seed, testRunId("failed-run"), "failed");
		await register(seed, testRunId("completed-run"), "completed");
		await seed.close();
		reader = await JournalDurableBackend.open(await openSqlRunJournal(path));
		events = observeEventReads(reader.journal);
	});

	afterEach(async () => {
		for (const handle of opened.splice(0).reverse()) await handle.close();
		await reader.close();
		removeTempDirectory(dir);
	});

	test("an unchanged reopen returns the same catalog without reading any events", async () => {
		const first = await reader.prepareWorkflowCatalog();
		events.events = 0;
		assert.deepEqual(await reader.prepareWorkflowCatalog(), first);
		assert.equal(events.events, 0);
		assert.deepEqual(statuses(first.resumable), {
			[testRunId("paused-run")]: "paused",
			[testRunId("failed-run")]: "failed",
		});
		assert.deepEqual(statuses(first.completed), { [testRunId("completed-run")]: "completed" });
	});

	test("another connection's create, status change and delete are reflected, reading only the changed runs", async () => {
		const other = await otherConnection();
		await reader.prepareWorkflowCatalog();
		events.events = 0;
		await other.commitWorkflowStatus(testRunId("paused-run"), "failed");
		const changed = await reader.prepareWorkflowCatalog();
		assert.equal(statuses(changed.resumable)[testRunId("paused-run")], "failed");
		// The status change appended one event; the cached run is extended from its last folded event.
		assert.equal(events.events, 2);
		await other.commitWorkflowStatus(testRunId("failed-run"), "completed");
		await register(other, testRunId("created-run"), "paused");
		await other.deleteWorkflow(testRunId("paused-run"));
		const reopened = await reader.prepareWorkflowCatalog();
		assert.deepEqual(statuses(reopened.resumable), { [testRunId("created-run")]: "paused" });
		assert.deepEqual(statuses(reopened.completed), {
			[testRunId("completed-run")]: "completed",
			[testRunId("failed-run")]: "completed",
		});
		assert.equal(reader.getWorkflow(testRunId("paused-run")), undefined);
	});

	test("own-process changes are reflected, including through another journal on the same connection", async () => {
		const database: SqliteDatabase = await openNodeSqliteDatabase(path);
		const shared = await JournalDurableBackend.open(await SqlRunJournal.open(database), { ownsJournal: false });
		const sibling = await JournalDurableBackend.open(await SqlRunJournal.open(database), { ownsJournal: false });
		try {
			await shared.prepareWorkflowCatalog();
			await register(sibling, testRunId("sibling-run"), "paused");
			assert.equal(statuses((await shared.prepareWorkflowCatalog()).resumable)[testRunId("sibling-run")], "paused");
			await sibling.commitWorkflowStatus(testRunId("sibling-run"), "completed");
			assert.equal(
				statuses((await shared.prepareWorkflowCatalog()).completed)[testRunId("sibling-run")],
				"completed",
			);
			await sibling.deleteWorkflow(testRunId("failed-run"));
			assert.equal(statuses((await shared.prepareWorkflowCatalog()).resumable)[testRunId("failed-run")], undefined);
			await shared.commitWorkflowStatus(testRunId("paused-run"), "failed");
			assert.equal(statuses((await shared.prepareWorkflowCatalog()).resumable)[testRunId("paused-run")], "failed");
		} finally {
			await sibling.close();
			await shared.close();
			await database.close();
		}
	});

	test(
		"another process's create, status change and delete are reflected",
		async () => {
			await reader.prepareWorkflowCatalog();
			writerProcess("run-create", testRunId("process-run"), "paused");
			assert.equal(statuses((await reader.prepareWorkflowCatalog()).resumable)[testRunId("process-run")], "paused");
			writerProcess("run-status", testRunId("process-run"), "completed");
			const completed = await reader.prepareWorkflowCatalog();
			assert.equal(statuses(completed.resumable)[testRunId("process-run")], undefined);
			assert.equal(statuses(completed.completed)[testRunId("process-run")], "completed");
			writerProcess("run-delete", testRunId("failed-run"));
			assert.equal(statuses((await reader.prepareWorkflowCatalog()).resumable)[testRunId("failed-run")], undefined);
		},
		WRITER_PROCESS_TIMEOUT_MS * 3,
	);

	test("a crashed owner's lease expiring with no store write makes its run resumable on reopen", async () => {
		const workflowId = testRunId("crashed-run");
		const other = await otherConnection();
		await other.commitWorkflowRegistration({
			workflowId,
			name: WORKFLOW_NAME,
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await other.commitCheckpoint({
			kind: "tool",
			workflowId,
			checkpointId: "tool",
			name: "tool",
			argsHash: "tool",
			output: "done",
			completedAt: 2,
		});
		await other.releaseWorkflow(workflowId);
		const crashed = await other.journal.acquire(workflowId, "crashed-owner");
		assert.equal(crashed.status, "acquired");
		const raw = new JournalTestDatabase(path);
		try {
			raw.run(
				"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
				FOREIGN_LIVE_WORKFLOW_WINDOW_MS - LEASE_EXPIRY_HEADROOM_MS,
				workflowId,
			);
		} finally {
			raw.close();
		}

		const live = await reader.prepareWorkflowCatalog();
		assert.equal(statuses(live.resumable)[workflowId], "running");
		assert.equal(await reader.workflowOwnership(workflowId), "foreign");
		assert.deepEqual(await prepareTargetedDurableResumable(reader, [workflowId]), []);
		const selected = await resumeDurableWorkflow(workflowId, resumeDeps(reader), live.resumable);
		assert.ok(!selected.ok);
		assert.equal(selected.reason, "owned_elsewhere");

		while (((await reader.journal.leaseState(workflowId))?.ageMs ?? 0) <= FOREIGN_LIVE_WORKFLOW_WINDOW_MS)
			await sleep(LEASE_POLL_MS);
		events.events = 0;
		const expired = await reader.prepareWorkflowCatalog();
		assert.equal(events.events, 0, "lease expiry wrote nothing, so the catalog itself is unchanged");
		assert.equal(statuses(expired.resumable)[workflowId], "running");
		assert.equal(await reader.workflowOwnership(workflowId), "available");
		assert.deepEqual(
			(await prepareTargetedDurableResumable(reader, [workflowId])).map((entry) => entry.workflowId),
			[workflowId],
		);
	});

	test("selecting a listed run that another connection deleted does not resume it", async () => {
		const other = await otherConnection();
		const listed = await reader.prepareWorkflowCatalog();
		await other.deleteWorkflow(testRunId("paused-run"));
		const selected = await resumeDurableWorkflow(testRunId("paused-run"), resumeDeps(reader), listed.resumable);
		assert.ok(!selected.ok);
		assert.equal(selected.reason, "stale");
		assert.equal(await reader.journal.getRun(testRunId("paused-run")), undefined);
	});
});

function definition(): WorkflowDefinition {
	return workflow({
		name: WORKFLOW_NAME,
		description: "",
		inputs: { topic: Type.Optional(Type.String()) },
		outputs: { done: Type.Optional(Type.Boolean()) },
		run: async () => ({ done: true }),
	}) as unknown as WorkflowDefinition;
}

function registry(def: WorkflowDefinition): WorkflowRegistry {
	return {
		register: () => registry(def),
		merge: () => registry(def),
		get: (name: string) => (name === def.name || name === def.normalizedName ? def : undefined),
		has: (name: string) => name === def.name || name === def.normalizedName,
		remove: () => registry(def),
		names: () => [def.normalizedName],
		all: () => [def],
	};
}

function resumeDeps(backend: JournalDurableBackend) {
	return {
		registry: registry(definition()),
		baseRunOpts: { store: createStore(), cancellation: createCancellationRegistry(), jobs: createJobTracker() },
		durableBackend: backend,
	};
}
