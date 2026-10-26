import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const LOCK_CONTENTION_TEST_TIMEOUT_MS = 60_000;

/** Another process takes the journal's write lock, reports `locked`, and commits after `holdMs` (never when negative). */
const LOCK_HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const [path, holdMs] = process.argv.slice(1);
const database = new DatabaseSync(path);
database.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS lock_holder(x); INSERT INTO lock_holder VALUES (1)");
process.stdout.write("locked\\n");
if (Number(holdMs) >= 0) setTimeout(() => { database.exec("COMMIT"); database.close(); }, Number(holdMs));
else setInterval(() => {}, 1_000);
`;

async function holdWriteLock(path: string, holdMs: number): Promise<SpawnedProcess> {
	const holder = spawnProcess([process.execPath, "-e", LOCK_HOLDER, path, String(holdMs)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.ok(holder.stdout);
	const reader = holder.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(await readStreamText(holder.stderr));
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	assert.equal(text, "locked\n");
	return holder;
}

/**
 * A starting pooled stage's Intercom extension writes its pending-stage delivery and prelude message through journal
 * transactions. In the 480-child soak another process held the journal's write lock past the 5 s busy timeout, and
 * the stage failed `Extension startup failed: …intercom…: Storage unavailable: node-sqlite at …journal5.sqlite`.
 */
test(
	"a journal write waits out another process's write lock held past the busy timeout",
	async () => {
		const directory = makeTempDirectory("journal-lock-contention-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		let holder: SpawnedProcess | undefined;
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "coordinator");
			if (acquired.status !== "acquired") assert.fail("lease not acquired");
			const pool = await openSqlPoolQueue(journal);
			await pool.initialize(acquired.lease, 600_000);
			const { work, boundary } = poolWorkFixture();
			await pool.enqueue(acquired.lease, work, boundary);
			const claimed = await pool.claim(
				acquired.lease,
				"worker",
				[{ definition: work.definition, digest: work.digest }],
				600_000,
			);
			assert.ok(claimed);
			holder = await holdWriteLock(path, 6_500);
			await pool.assertCurrent(acquired.lease, claimed);
			assert.equal(await holder.exited, 0, await readStreamText(holder.stderr));
		} finally {
			holder?.kill("SIGKILL");
			await holder?.exited;
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCK_CONTENTION_TEST_TIMEOUT_MS,
);

test(
	"a write lock that is never released fails within the bound and names the SQLite cause",
	async () => {
		const directory = makeTempDirectory("journal-lock-unavailable-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 100, lockWaitMs: 500 });
		let holder: SpawnedProcess | undefined;
		try {
			await database.exec("CREATE TABLE probe(x)");
			holder = await holdWriteLock(path, -1);
			const started = Date.now();
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageUnavailableError);
			assert.match(error.message, /^Storage unavailable: node-sqlite at .*journal\.sqlite: database is locked/);
			assert.match((error.cause as Error).message, /database is locked/);
			assert.ok(Date.now() - started < 5_000, `gave up after ${Date.now() - started} ms`);
			assert.deepEqual(await database.get("PRAGMA busy_timeout"), { timeout: 100 });
		} finally {
			holder?.kill("SIGKILL");
			await holder?.exited;
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCK_CONTENTION_TEST_TIMEOUT_MS,
);

test(
	"a transaction waiting for another process's write lock leaves the event loop running",
	async () => {
		const directory = makeTempDirectory("journal-lock-event-loop-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		let holder: SpawnedProcess | undefined;
		let ticker: ReturnType<typeof setInterval> | undefined;
		try {
			await database.exec("CREATE TABLE probe(x)");
			holder = await holdWriteLock(path, 2_500);
			let last = performance.now();
			let maxGapMs = 0;
			ticker = setInterval(() => {
				const now = performance.now();
				maxGapMs = Math.max(maxGapMs, now - last);
				last = now;
			}, 20);
			const started = performance.now();
			await database.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"));
			const finished = performance.now();
			const waitedMs = finished - started;
			clearInterval(ticker);
			// The gap still open at commit counts: a wait that blocks synchronously lets no tick fire at all.
			maxGapMs = Math.max(maxGapMs, finished - last);
			assert.ok(waitedMs >= 1_000, `committed after ${waitedMs} ms while the lock was held`);
			assert.ok(maxGapMs < 500, `event loop stalled for ${Math.round(maxGapMs)} ms while waiting for the lock`);
			assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM probe"), { count: 1 });
			assert.deepEqual(await database.get("PRAGMA busy_timeout"), { timeout: 5_000 });
			assert.equal(await holder.exited, 0, await readStreamText(holder.stderr));
		} finally {
			clearInterval(ticker);
			holder?.kill("SIGKILL");
			await holder?.exited;
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCK_CONTENTION_TEST_TIMEOUT_MS,
);

const HOG_FIXTURE = fileURLToPath(new URL("../fixtures/sqlite-write-hog.mjs", import.meta.url));
const HOGS = 3;
const HOG_HOLD_MS = 20;
const VICTIM_TRANSACTIONS = 10;
/** Short enough that a writer starved by the other processes fails quickly on a stall-blind deadline. */
const VICTIM_LOCK_WAIT_MS = 5_000;
/** The writers that may commit while one waits: each other process's turn, plus the one already holding the lock. */
const MAX_COMMITS_AHEAD = 2 * HOGS;
const FAIRNESS_TEST_TIMEOUT_MS = 120_000;

async function startHog(path: string, stopPath: string): Promise<SpawnedProcess> {
	const hog = spawnProcess([process.execPath, HOG_FIXTURE, path, String(HOG_HOLD_MS), stopPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.ok(hog.stdout);
	const reader = hog.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(await readStreamText(hog.stderr));
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return hog;
}

test(
	"writers in several processes take the write lock in turn, so a writer is not starved by one that retakes it (#3978)",
	async () => {
		const directory = makeTempDirectory("journal-lock-fairness-");
		const path = join(directory, "journal.sqlite");
		const stopPath = join(directory, "stop");
		const database = await openNodeSqliteDatabase(path, { lockWaitMs: VICTIM_LOCK_WAIT_MS });
		const hogs: SpawnedProcess[] = [];
		try {
			await database.exec("CREATE TABLE hog(pid INTEGER); CREATE TABLE victim(n INTEGER)");
			for (let index = 0; index < HOGS; index++) hogs.push(await startHog(path, stopPath));
			const overtaken: number[] = [];
			for (let index = 0; index < VICTIM_TRANSACTIONS; index++) {
				const before = (await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM hog"))!.count;
				await database.transaction(async (tx) => {
					const after = (await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM hog"))!.count;
					overtaken.push(after - before);
					await tx.run("INSERT INTO victim VALUES (?)", index);
				});
			}
			assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM victim"), { count: VICTIM_TRANSACTIONS });
			assert.ok(
				Math.max(...overtaken) <= MAX_COMMITS_AHEAD,
				`other writers committed ${JSON.stringify(overtaken)} times while each of this writer's transactions waited`,
			);
			await writeFileEnsuringDir(stopPath, "");
			for (const hog of hogs) assert.equal(await hog.exited, 0, await readStreamText(hog.stderr));
			const perHog = await database.all<{ pid: number; count: number }>(
				"SELECT pid, COUNT(*) AS count FROM hog GROUP BY pid",
			);
			assert.equal(perHog.length, HOGS, "every writer process committed");
		} finally {
			await writeFileEnsuringDir(stopPath, "");
			for (const hog of hogs) {
				hog.kill("SIGKILL");
				await hog.exited;
			}
			await database.close();
			removeTempDirectory(directory);
		}
	},
	FAIRNESS_TEST_TIMEOUT_MS,
);

test(
	"a write lock other writers keep committing through does not fail a waiting writer at the lock wait (#3978)",
	async () => {
		const directory = makeTempDirectory("journal-lock-progress-");
		const path = join(directory, "journal.sqlite");
		const stopPath = join(directory, "stop");
		// The wait is shorter than the time the other writers keep the lock busy in total.
		const database = await openNodeSqliteDatabase(path, { lockWaitMs: 4 * HOG_HOLD_MS });
		const hogs: SpawnedProcess[] = [];
		try {
			await database.exec("CREATE TABLE hog(pid INTEGER); CREATE TABLE victim(n INTEGER)");
			for (let index = 0; index < HOGS; index++) hogs.push(await startHog(path, stopPath));
			for (let index = 0; index < VICTIM_TRANSACTIONS; index++)
				await database.transaction((tx) => tx.run("INSERT INTO victim VALUES (?)", index));
			assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM victim"), { count: VICTIM_TRANSACTIONS });
		} finally {
			await writeFileEnsuringDir(stopPath, "");
			for (const hog of hogs) {
				hog.kill("SIGKILL");
				await hog.exited;
			}
			await database.close();
			removeTempDirectory(directory);
		}
	},
	FAIRNESS_TEST_TIMEOUT_MS,
);
