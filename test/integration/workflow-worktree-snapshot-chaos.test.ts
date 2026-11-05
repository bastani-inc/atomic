import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase, SqlSnapshotBlobStore } from "@bastani/atomic/storage";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import { SNAPSHOT_INDEX_BACKFILL_BATCH } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	collectSnapshotGarbage,
	snapshotBlob,
	snapshotBlobHashes,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { listWorkflowSnapshotBoundaries } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { bunExecutable, spawnProcess } from "../helpers/runtime.js";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
	dropSnapshotIndex,
	fullScanRetainedHashes,
	openSharedSnapshotDatabase,
	snapshotEntry,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const REAL_PROCESS_TIMEOUT_MS = 120_000;

const CAPTURE_CHILD = `
import { openNodeSqliteDatabase } from "./packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSnapshotBlobStore } from "./packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { captureWorktreeSnapshot } from "./packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { setWorktreeSnapshotGit } from "./packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
setWorktreeSnapshotGit(async () => ({ path: "git", env: { GIT_CONFIG_GLOBAL: process.env.FIXTURE_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1" } }));
const database = await openNodeSqliteDatabase(process.env.FIXTURE_DATABASE);
const blobs = await SqlSnapshotBlobStore.open(database);
writeFileSync(join(process.env.FIXTURE_REPO, "changed.txt"), "T2\\n");
await captureWorktreeSnapshot(process.env.FIXTURE_REPO, {
  previous: JSON.parse(process.env.FIXTURE_PREVIOUS),
  blobs: {
    getBlob: blobs.getBlob.bind(blobs),
    refreshBlobs: blobs.refreshBlobs.bind(blobs),
    listBlobHashes: blobs.listBlobHashes.bind(blobs),
    async putBlobs(values) {
      await blobs.putBlobs(values);
      process.stdout.write("BLOBS_STORED\\n");
      await new Promise(() => {});
    },
  },
});
`;

test(
	"SIGKILL between blob write and checkpoint publication leaves only resumable references (#4245)",
	async () => {
		const sandbox = new GitSandbox();
		const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = sandbox.path("agent");
		let child: ReturnType<typeof spawnProcess> | undefined;
		let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
		let backend: JournalDurableBackend | undefined;
		try {
			const { clone } = await sandbox.remoteWithClone();
			const databasePath = sandbox.path("shared.sqlite");
			database = await openNodeSqliteDatabase(databasePath);
			let journal = await SqlRunJournal.open(database);
			backend = await JournalDurableBackend.open(journal, { runs: [] });
			let attempt = 0;
			let calls = 0;
			let resumedCwd = "";
			const definition = workflow({
				name: "capture-crash",
				description: "",
				inputs: {},
				outputs: { ok: Type.Boolean() },
				run: async (ctx) => {
					await ctx.tool("write", {}, async () => {
						calls++;
						sandbox.write(join(ctx.cwd!, "changed.txt"), "T1\n");
						return "done";
					});
					if (attempt++ === 0) throw new Error("interrupted");
					resumedCwd = ctx.cwd!;
					assert.equal(readFileSync(join(ctx.cwd!, "changed.txt"), "utf8"), "T1\n");
					return { ok: true };
				},
			});
			const first = await run(definition, {}, { cwd: clone, durableBackend: backend, store: createStore() });
			assert.equal(first.status, "failed");
			const before = await listWorkflowSnapshotBoundaries(journal, first.runId);
			assert.equal(before.length, 1);
			await backend.close();
			backend = undefined;
			await database.close();
			database = undefined;
			child = spawnProcess([bunExecutable(), "-e", CAPTURE_CHILD], {
				cwd: process.cwd(),
				env: {
					...process.env,
					FIXTURE_GIT_CONFIG: sandbox.globalConfig,
					FIXTURE_DATABASE: databasePath,
					FIXTURE_REPO: clone,
					FIXTURE_PREVIOUS: JSON.stringify(before[0]!.snapshot),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			assert.ok(child.stdout);
			const read = child.stdout.getReader();
			const message = await read.read();
			assert.equal(new TextDecoder().decode(message.value), "BLOBS_STORED\n");
			child.kill("SIGKILL");
			await child.exited;
			assert.equal(child.signalCode, "SIGKILL");
			child = undefined;
			database = await openNodeSqliteDatabase(databasePath);
			journal = await SqlRunJournal.open(database);
			backend = await JournalDurableBackend.open(journal, { runs: [first.runId] });
			const after = await listWorkflowSnapshotBoundaries(journal, first.runId);
			assert.equal(after.length, 1);
			assert.equal(after[0]!.checkpointId, before[0]!.checkpointId);
			for (const boundary of after) {
				for (const hash of snapshotBlobHashes(boundary.snapshot))
					assert.ok(await journal.snapshotBlobs.getBlob(hash));
			}
			const resumed = await run(
				definition,
				{},
				{ runId: first.runId, cwd: clone, durableBackend: backend, store: createStore() },
			);
			assert.equal(resumed.status, "completed");
			assert.equal(calls, 1);
			assert.notEqual(resumedCwd, clone);
			assert.equal(readFileSync(join(clone, "changed.txt"), "utf8"), "T2\n");
		} finally {
			if (child) {
				child.kill("SIGKILL");
				await child.exited;
			}
			await backend?.close();
			await database?.close();
			if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
			sandbox.dispose();
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);

test(
	"sixteen concurrent journal connections deduplicate overlapping snapshot blobs (#4245)",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "workflow-snapshot-contention-"));
		const connections = await Promise.all(
			Array.from({ length: 16 }, () => openNodeSqliteDatabase(join(directory, "shared.sqlite"))),
		);
		try {
			const stores = await Promise.all(connections.map((database) => SqlSnapshotBlobStore.open(database)));
			const blobs = Array.from({ length: 24 }, (_, index) =>
				snapshotBlob(new TextEncoder().encode(`blob-${index}`)),
			);
			await Promise.all(stores.map((store, index) => store.putBlobs(blobs.filter((_, n) => n % 2 === index % 2))));
			const hashes = await stores[0]!.listBlobHashes();
			assert.equal(hashes.length, blobs.length);
			assert.equal(new Set(hashes).size, blobs.length);
			for (const blob of blobs) assert.deepEqual(await stores[0]!.getBlob(blob.hash), blob.data);
		} finally {
			await Promise.all(connections.map((database) => database.close()));
			await rm(directory, { recursive: true, force: true });
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);

test(
	"concurrent captures and garbage collection on one SQLite file never lose a blob that a capture referenced (#4245, #4355)",
	async () => {
		const GRACE_SECONDS = 2;
		const WRITERS = 6;
		const CAPTURES_PER_WRITER = 100;
		const directory = await mkdtemp(join(tmpdir(), "workflow-snapshot-gc-race-"));
		const connections = await Promise.all(
			Array.from({ length: WRITERS + 2 }, () => openNodeSqliteDatabase(join(directory, "shared.sqlite"))),
		);
		try {
			const journals = await Promise.all(connections.map((database) => SqlRunJournal.open(database)));
			const publishedBlobs: string[] = [];
			const missing: string[] = [];
			let writing = true;

			// Each writer does what a capture does: store the blob, wait a little, then publish the checkpoint that
			// references it, in a run that stays resumable. A blob shared by two captures is stored again by the second.
			const writer = async (writerIndex: number) => {
				const journal = journals[writerIndex]!;
				const runId = `writer-${writerIndex}`;
				const lease = await startRun(journal, runId);
				await journal.append(lease, statusEvent(runId, { status: "running" }, "RunStarted"));
				for (let capture = 0; capture < CAPTURES_PER_WRITER; capture++) {
					const shared = capture % 5 === 0;
					const entry = textBlob(shared ? `shared-${capture}` : `blob-${writerIndex}-${capture}`);
					await journal.snapshotBlobs.putBlobs([entry]);
					await new Promise((resolve) => setTimeout(resolve, 20 + ((writerIndex * 7 + capture) % 30)));
					await journal.append(lease, checkpointEvent([syntheticSnapshot(entry.hash, [entry.hash])]));
					publishedBlobs.push(entry.hash);
					if ((await journal.snapshotBlobs.getBlob(entry.hash)) === undefined) missing.push(entry.hash);
				}
			};
			// Collection runs back to back while references are published. Blobs nobody references (stored, never
			// published) are the garbage it exists to remove.
			const orphan = textBlob("never referenced");
			await journals[WRITERS]!.snapshotBlobs.putBlobs([orphan]);
			const collector = async () => {
				while (writing) {
					await collectSnapshotGarbage(journals[WRITERS + 1]!.snapshotBlobs, { graceSeconds: GRACE_SECONDS });
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			};
			const collecting = collector();
			await Promise.all(Array.from({ length: WRITERS }, (_, index) => writer(index)));
			writing = false;
			await collecting;

			assert.deepEqual(missing, [], "a blob was gone right after its capture published its reference");
			for (const hash of publishedBlobs) {
				assert.notEqual(
					await journals[0]!.snapshotBlobs.getBlob(hash),
					undefined,
					`published blob ${hash} was collected`,
				);
			}
			// The orphan outlived the grace window while the writers ran, so collection removed it, and only it.
			assert.equal(
				await journals[0]!.snapshotBlobs.getBlob(orphan.hash),
				undefined,
				"the orphan was never collected",
			);
			assert.equal(new Set(await journals[0]!.snapshotBlobs.listBlobHashes()).size, new Set(publishedBlobs).size);
			await Promise.all(journals.map((journal) => journal.close()));
		} finally {
			await Promise.all(connections.map((database) => database.close()));
			await rm(directory, { recursive: true, force: true });
		}
	},
	REAL_PROCESS_TIMEOUT_MS,
);

/**
 * A collector that stops for good partway: in `mid-batch` mode inside its `FIXTURE_KILL_AT`th delete, before the
 * batch commits; in `between-batches` mode after that many batches have committed. It prints a marker and waits to be
 * killed.
 */
const COLLECTOR_CHILD = `
import { openNodeSqliteDatabase } from "./packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSnapshotBlobStore } from "./packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
const database = await openNodeSqliteDatabase(process.env.FIXTURE_DATABASE);
const killAt = Number(process.env.FIXTURE_KILL_AT);
const midBatch = process.env.FIXTURE_MODE === "mid-batch";
const hang = (marker) => {
  process.stdout.write(marker + "\\n");
  return new Promise(() => {});
};
let deletes = 0;
let transactions = 0;
const wrapped = {
  descriptor: database.descriptor,
  exec: (sql) => database.exec(sql),
  run: (sql, ...params) => database.run(sql, ...params),
  get: (sql, ...params) => database.get(sql, ...params),
  all: (sql, ...params) => database.all(sql, ...params),
  close: () => database.close(),
  async transaction(callback, options) {
    if (!midBatch && ++transactions === killAt + 1) await hang("BETWEEN_BATCHES");
    return database.transaction((tx) => callback({
      exec: (sql) => tx.exec(sql),
      run: (sql, ...params) => tx.run(sql, ...params),
      get: (sql, ...params) => tx.get(sql, ...params),
      async all(sql, ...params) {
        const rows = await tx.all(sql, ...params);
        if (midBatch && sql.startsWith("DELETE") && ++deletes === killAt) await hang("MID_BATCH");
        return rows;
      },
    }), options);
  },
};
const store = await SqlSnapshotBlobStore.open(wrapped);
await store.collectGarbage({ graceSeconds: Number(process.env.FIXTURE_GRACE) });
process.stdout.write("FINISHED\\n");
`;

describe.each([
	["mid-batch", "MID_BATCH"],
	["between-batches", "BETWEEN_BATCHES"],
] as const)("SIGKILL during collection (%s) (#4355)", (mode, marker) => {
	test(
		"never deletes a referenced blob, even one referenced while the collector was stopped, and the next collection removes the rest",
		async () => {
			const GRACE_SECONDS = 3600;
			const directory = await mkdtemp(join(tmpdir(), "snapshot-collector-kill-"));
			const databasePath = join(directory, "shared.sqlite");
			const shared = await openSharedSnapshotDatabase(databasePath);
			const writerDatabase = await openNodeSqliteDatabase(databasePath);
			const writer = await SqlRunJournal.open(writerDatabase);
			let child: ReturnType<typeof spawnProcess> | undefined;
			try {
				const blobs = Array.from({ length: 1200 }, (_, index) => textBlob(`blob-${index}`));
				await shared.journal.snapshotBlobs.putBlobs(blobs);
				const referenced = blobs.filter((_, index) => index % 4 === 0);
				const lease = await startRun(shared.journal, "kept");
				await shared.journal.append(lease, statusEvent("kept", { status: "running" }, "RunStarted"));
				for (let index = 0; index < referenced.length; index += 50)
					await shared.journal.append(
						lease,
						checkpointEvent(
							referenced.slice(index, index + 50).map((blob) => syntheticSnapshot(blob.hash, [blob.hash])),
						),
					);
				await shared.journal.append(lease, statusEvent("kept", { status: "failed" }));
				const recorded = referenced.slice(0, 50);
				await createSession(shared.sessions, "session-1", [
					snapshotEntry(
						"/repo",
						"recorded",
						syntheticSnapshot(
							"recorded",
							recorded.map((blob) => blob.hash),
						),
					),
				]);
				await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, GRACE_SECONDS + 10);
				const writerLease = await startRun(writer, "late");
				await writer.append(writerLease, statusEvent("late", { status: "running" }, "RunStarted"));

				child = spawnProcess([bunExecutable(), "-e", COLLECTOR_CHILD], {
					cwd: process.cwd(),
					env: {
						...process.env,
						FIXTURE_DATABASE: databasePath,
						FIXTURE_MODE: mode,
						FIXTURE_KILL_AT: "2",
						FIXTURE_GRACE: String(GRACE_SECONDS),
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				assert.ok(child.stdout);
				const message = await child.stdout.getReader().read();
				assert.equal(new TextDecoder().decode(message.value), `${marker}\n`);

				// While the collector is stopped, captures reuse aged unreferenced blobs: each restarts their age first,
				// storing a blob again when the collector already took it, then publishes the reference.
				const late = blobs.filter((_, index) => index % 4 === 1).slice(0, 40);
				const publishing = (async () => {
					for (const blob of late) {
						if (!(await writer.snapshotBlobs.refreshBlobs([blob.hash])))
							await writer.snapshotBlobs.putBlobs([blob]);
						await writer.append(writerLease, checkpointEvent([syntheticSnapshot(blob.hash, [blob.hash])]));
					}
				})();
				if (mode === "between-batches") await publishing;
				child.kill("SIGKILL");
				await child.exited;
				assert.equal(child.signalCode, "SIGKILL");
				child = undefined;
				await publishing;

				const expected = await fullScanRetainedHashes(shared.journal, shared.sessions);
				assert.ok(expected.size >= referenced.length + late.length);
				for (const hash of expected)
					assert.ok(await shared.journal.snapshotBlobs.getBlob(hash), `referenced blob ${hash} was deleted`);
				assert.deepEqual(await shared.database.all("PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
				const surviving = new Set(await shared.journal.snapshotBlobs.listBlobHashes());
				assert.ok(surviving.size > expected.size, "the collector was stopped before it finished");

				await collectSnapshotGarbage(shared.journal.snapshotBlobs, { graceSeconds: GRACE_SECONDS });
				assert.deepEqual(
					[...(await shared.journal.snapshotBlobs.listBlobHashes())].sort(),
					[...expected].sort(),
					"the next collection removed exactly the unreferenced aged blobs",
				);
			} finally {
				if (child) {
					child.kill("SIGKILL");
					await child.exited;
				}
				await writer.close();
				await writerDatabase.close();
				await shared.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
		REAL_PROCESS_TIMEOUT_MS,
	);
});

/**
 * A process that opens a database whose index was never built, as the new build, and backfills it, until it stops for
 * good partway: in `mid-batch` mode inside its `FIXTURE_KILL_AT`th batch, before that batch commits; in
 * `between-batches` mode right after that many batches have committed.
 */
const BACKFILL_CHILD = `
import { openNodeSqliteDatabase } from "./packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSnapshotBlobStore } from "./packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
const database = await openNodeSqliteDatabase(process.env.FIXTURE_DATABASE);
const killAt = Number(process.env.FIXTURE_KILL_AT);
const midBatch = process.env.FIXTURE_MODE === "mid-batch";
const hang = (marker) => {
  process.stdout.write(marker + "\\n");
  return new Promise(() => {});
};
let armed = false;
let batches = 0;
const advances = (sql) => sql.startsWith("UPDATE snapshot_index_sources SET backfilled_through");
const wrapped = {
  descriptor: database.descriptor,
  exec: (sql) => database.exec(sql),
  run: (sql, ...params) => database.run(sql, ...params),
  get: (sql, ...params) => database.get(sql, ...params),
  all: (sql, ...params) => database.all(sql, ...params),
  close: () => database.close(),
  async transaction(callback, options) {
    if (armed && !midBatch && batches === killAt) await hang("BETWEEN_BATCHES");
    return database.transaction((tx) => callback({
      exec: (sql) => tx.exec(sql),
      get: (sql, ...params) => tx.get(sql, ...params),
      all: (sql, ...params) => tx.all(sql, ...params),
      async run(sql, ...params) {
        const result = await tx.run(sql, ...params);
        if (armed && advances(sql) && ++batches === killAt && midBatch) await hang("MID_BATCH");
        return result;
      },
    }), options);
  },
};
const store = await SqlSnapshotBlobStore.open(wrapped);
armed = true;
await store.completeIndex({});
process.stdout.write("FINISHED\\n");
`;

describe.each([
	["mid-batch", "MID_BATCH", 1],
	["between-batches", "BETWEEN_BATCHES", 2],
] as const)("SIGKILL during an index backfill (%s) (#4355)", (mode, marker, committedBatches) => {
	test(
		"never deletes a referenced blob, and the next collection resumes the backfill and finishes it",
		async () => {
			const EVENTS = SNAPSHOT_INDEX_BACKFILL_BATCH * 3 + 100;
			const directory = await mkdtemp(join(tmpdir(), "snapshot-backfill-kill-"));
			const databasePath = join(directory, "shared.sqlite");
			const database = await openNodeSqliteDatabase(databasePath);
			let child: ReturnType<typeof spawnProcess> | undefined;
			let stores: { journal: SqlRunJournal; sessions: SqlSessionStore } | undefined;
			try {
				const written = {
					sessions: await SqlSessionStore.open(database),
					journal: await SqlRunJournal.open(database),
				};
				const lease = await startRun(written.journal, "big");
				await written.journal.append(lease, statusEvent("big", { status: "running" }, "RunStarted"));
				await database.run(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
					INSERT INTO snapshot_blobs (hash, bytes, data, created_at) SELECT 'padded-' || i, 1, x'00', 0 FROM n`,
					EVENTS,
				);
				await database.run(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
					INSERT INTO wf_events SELECT 'big', 1 + i, ?, NULL, 'CheckpointRecorded',
						json_object('kind', 'tool', 'checkpointId', 'c' || i, 'worktreeSnapshots',
							json_array(json_object('chain', json_array(json_object('patch', 'padded-' || i))))), 0 FROM n`,
					EVENTS,
					lease.epoch,
				);
				await written.journal.append(lease, statusEvent("big", { status: "failed" }));
				await written.journal.snapshotBlobs.putBlobs([textBlob("unreferenced a"), textBlob("unreferenced b")]);
				await database.run("UPDATE snapshot_blobs SET created_at = 0");
				await written.journal.close();
				await written.sessions.close();
				await dropSnapshotIndex(database);

				child = spawnProcess([bunExecutable(), "-e", BACKFILL_CHILD], {
					cwd: process.cwd(),
					env: { ...process.env, FIXTURE_DATABASE: databasePath, FIXTURE_MODE: mode, FIXTURE_KILL_AT: "2" },
					stdout: "pipe",
					stderr: "pipe",
				});
				assert.ok(child.stdout);
				const message = await child.stdout.getReader().read();
				assert.equal(new TextDecoder().decode(message.value), `${marker}\n`);
				child.kill("SIGKILL");
				await child.exited;
				assert.equal(child.signalCode, "SIGKILL");
				child = undefined;

				const [events] = await database.all<{ watermark: number; backfilled_through: number }>(
					"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'journal-events'",
				);
				assert.equal(
					events!.backfilled_through,
					SNAPSHOT_INDEX_BACKFILL_BATCH * committedBatches,
					"only the batches that committed before the kill are recorded",
				);
				assert.ok(events!.backfilled_through < events!.watermark);
				stores = { sessions: await SqlSessionStore.open(database), journal: await SqlRunJournal.open(database) };

				const { deleted } = await collectSnapshotGarbage(stores.journal.snapshotBlobs);

				assert.deepEqual(
					[...deleted].sort(),
					[textBlob("unreferenced a").hash, textBlob("unreferenced b").hash].sort(),
					"only the unreferenced blobs go",
				);
				assert.equal((await stores.journal.snapshotBlobs.listBlobHashes()).length, EVENTS);
				assert.deepEqual(await database.all("PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
				for (const progress of await database.all<{ watermark: number; backfilled_through: number }>(
					"SELECT watermark, backfilled_through FROM snapshot_index_sources",
				))
					assert.equal(progress.backfilled_through, progress.watermark);
			} finally {
				if (child) {
					child.kill("SIGKILL");
					await child.exited;
				}
				await stores?.journal.close();
				await stores?.sessions.close();
				await database.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
		REAL_PROCESS_TIMEOUT_MS,
	);
});
