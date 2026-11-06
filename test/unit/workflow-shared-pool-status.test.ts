import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	readSharedPoolStats,
	type SharedPoolStats,
	SqlSharedPool,
} from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { sharedPoolStatus } from "../../packages/workflows/src/workers/shared-pool-status.js";
import { sharedPoolStatusLines } from "../../packages/workflows/src/workers/shared-pool-status-lines.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";

test("a shared pool's status reads as lines of queue depth, hosts and leases (#4310)", () => {
	const lines = sharedPoolStatusLines({
		sharedPool: {
			root: "root",
			ready: 2,
			leased: 1,
			completed: 3,
			failed: 0,
			pendingStageInputs: 1,
			hosts: [
				{
					host: "host-b",
					labels: {},
					git: "system",
					restore: true,
					workers: 2,
					maxWorkers: 4,
					roots: ["root"],
					heartbeatAgoMs: 300,
					leased: 1,
				},
				{
					host: "host-c",
					labels: {},
					git: "unavailable",
					restore: false,
					workers: 1,
					maxWorkers: 1,
					roots: ["root"],
					heartbeatAgoMs: 1_250,
					leased: 0,
				},
			],
			leases: [
				{
					work: "w1",
					childRunId: "child-1",
					worker: "host-b/1",
					host: "host-b",
					generation: 1,
					renewedAgoMs: 400,
					expiresInMs: 29_600,
				},
				{
					work: "w2",
					childRunId: "child-2",
					worker: "root",
					host: "",
					generation: 2,
					renewedAgoMs: -5,
					expiresInMs: 1_000,
				},
			],
		},
	});
	assert.deepEqual(lines, [
		"2 ready · 1 leased · 3 completed · 0 failed · 1 stage input waiting",
		"host host-b: 2 of 4 workers, 1 lease, git system, restores, seen 0.3s ago",
		"host host-c: 1 of 1 workers, 0 leases, git unavailable, seen 1.3s ago",
		"child child-1 on host host-b: renewed 0.4s ago, expires in 29.6s",
		"child child-2 on the root's host: renewed 0.0s ago, expires in 1.0s",
	]);
	assert.deepEqual(sharedPoolStatusLines({ sharedPoolUnavailable: { name: "StorageError", message: "gone" } }), [
		"Shared pool stats unavailable: gone",
	]);
	const plural = sharedPoolStatusLines({
		sharedPool: {
			root: "r",
			ready: 0,
			leased: 0,
			completed: 0,
			failed: 0,
			pendingStageInputs: 2,
			hosts: [],
			leases: [],
		},
	});
	assert.deepEqual(plural, ["0 ready · 0 leased · 0 completed · 0 failed · 2 stage inputs waiting"]);
});

test("workflow status reads a shared root's pool, and nothing for any other run (#4310)", async () => {
	const directory = makeLibsqlDirectory();
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "shared.db")).href });
	const journal = await SqlRunJournal.open(database, { prefix: "acme_" });
	try {
		assert.equal(await sharedPoolStatus(undefined, "root"), undefined);
		const memory = await JournalDurableBackend.open(new MemoryRunJournal());
		assert.equal(await sharedPoolStatus(memory, "root"), undefined);
		await memory.close();
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "owner");
		if (acquired.status !== "acquired") assert.fail("no lease");
		const lease: Lease = acquired.lease;
		assert.equal(await readSharedPoolStats(journal, "root"), undefined, "a journal that never ran a shared pool");
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(lease, 60_000);
		await SqlSharedPool.open(journal, queue);
		const { work, boundary } = poolWorkFixture();
		await queue.enqueue(lease, work, boundary);
		const backend = await JournalDurableBackend.open(journal);
		assert.equal(await sharedPoolStatus(backend, "root"), undefined, "a root that did not opt in shows no pool");
		await journal.append(lease, {
			type: RUN_EVENT_TYPES.runStarted,
			payload: {
				workflowId: "root",
				name: "root",
				inputs: {},
				createdAt: 0,
				status: "running",
				resources: { workers: { placement: "shared" } },
			},
		});
		await backend.hydrateWorkflow("root");
		const status = await sharedPoolStatus(backend, "root");
		assert.ok(status !== undefined && "sharedPool" in status, JSON.stringify(status));
		assert.deepEqual([status.sharedPool.ready, status.sharedPool.leased], [1, 0]);
		await database.close();
		const unavailable = await sharedPoolStatus(backend, "root");
		assert.ok(unavailable !== undefined && "sharedPoolUnavailable" in unavailable);
		const { name, message } = unavailable.sharedPoolUnavailable;
		assert.match(name, /Error$/);
		assert.ok(message.length > 0, "the status says why the pool could not be read");
	} finally {
		await journal.close().catch(() => {});
		await database.close().catch(() => {});
		await removeLibsqlDirectory(directory);
	}
});

test("workflow status shows a shared root's pool under its run detail, and nothing more for any other run (#4310)", () => {
	const store = createStore();
	store.recordRunStart({
		id: "root",
		name: "fan-out",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1_000,
	});
	const inspected = inspectRun("root", { store });
	assert.ok(inspected.ok, JSON.stringify(inspected));
	const detail = inspected.detail;
	const pool: SharedPoolStats = {
		root: "root",
		ready: 4,
		leased: 0,
		completed: 1,
		failed: 2,
		pendingStageInputs: 0,
		hosts: [],
		leases: [
			{
				work: "w1",
				childRunId: "c1",
				worker: "host-b/worker-1",
				host: "host-b",
				generation: 1,
				renewedAgoMs: 1_000,
				expiresInMs: 2_000,
			},
		],
	};
	const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const plain = strip(renderResult({ action: "statusDetail", runId: "root", detail }, { width: 100 }));
	assert.ok(!plain.includes("SHARED POOL"), plain);
	const shown = strip(
		renderResult({ action: "statusDetail", runId: "root", detail, sharedPool: pool }, { width: 100 }),
	);
	assert.ok(shown.startsWith(plain), "the pool follows the run detail unchanged");
	const notice = shown.slice(plain.length);
	assert.match(notice, /^\n.*SHARED POOL/);
	assert.ok(notice.includes("4 ready · 0 leased · 1 completed · 2 failed · 0 stage inputs waiting"), notice);
	const lines = notice.split("\n");
	assert.notEqual(
		lines.findIndex((line) => line.includes("stage inputs waiting")),
		lines.findIndex((line) => line.includes("child c1 on host host-b")),
		"each status line is a line of its own",
	);
	const unavailable = strip(
		renderResult(
			{
				action: "statusDetail",
				runId: "root",
				detail,
				sharedPoolUnavailable: { name: "StorageError", message: "the journal is unreachable" },
			},
			{ width: 100 },
		),
	);
	assert.ok(unavailable.startsWith(plain));
	assert.match(
		unavailable.slice(plain.length),
		/SHARED POOL[\s\S]*Shared pool stats unavailable: the journal is unreachable/,
	);
});

test("workflow status reads nothing for a run without shared placement or without a pool to read (#4310)", async () => {
	const backend = await JournalDurableBackend.open(new MemoryRunJournal());
	try {
		for (const [runId, resources] of [
			["opted-in", { workers: { placement: "shared" } }],
			["admission-only", { admission: { limits: { session: 1 } } }],
			["no-resources", undefined],
		] as const) {
			await backend.journal.createRun({ runId, name: runId, cwd: "", createdAt: 0, status: "running" });
			const acquired = await backend.journal.acquire(runId, "owner");
			if (acquired.status !== "acquired") assert.fail("no lease");
			await backend.journal.append(acquired.lease, {
				type: RUN_EVENT_TYPES.runStarted,
				payload: {
					workflowId: runId,
					name: runId,
					inputs: {},
					createdAt: 0,
					status: "running",
					...(resources === undefined ? {} : { resources }),
				},
			});
			await backend.hydrateWorkflow(runId);
			assert.equal(await sharedPoolStatus(backend, runId), undefined, runId);
		}
	} finally {
		await backend.close();
	}
});
