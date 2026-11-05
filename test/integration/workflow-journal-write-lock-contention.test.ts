import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	isStorageWriteLockTimeoutError,
	rehydrateStorageError,
	type SerializedStorageError,
	StorageUnavailableError,
	StorageWriteLockTimeoutError,
	StorageWriterQueueUnusableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { isSqliteBusy } from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
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
			await pool.extend(acquired.lease, claimed, 600_000);
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
			const started = performance.now();
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageWriteLockTimeoutError, String(error));
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.code, "write-lock-timeout");
			assert.equal(error.timeoutMs, 500);
			assert.ok(error.elapsedMs >= 500);
			assert.equal(error.phase, "acquiring");
			assert.equal(error.location, path);
			assert.ok(isSqliteBusy(error.cause), "names the SQLite cause");
			const elapsedMs = performance.now() - started;
			assert.ok(elapsedMs < 5_000, `gave up after ${Math.round(elapsedMs)} ms`);
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

/** How long another process holds the lock while this one waits for it. */
const EVENT_LOOP_HOLD_MS = 5_000;
/**
 * A wait that blocks synchronously stalls the event loop for about the whole hold; half of it stays clear of a loaded
 * runner starving the process. With 50 copies of this file at once on a 32-core Windows runner, other tests' child
 * processes kept the waiting process off the CPU for up to 0.8 s.
 */
const MAX_EVENT_LOOP_STALL_MS = EVENT_LOOP_HOLD_MS / 2;

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
			holder = await holdWriteLock(path, EVENT_LOOP_HOLD_MS);
			let last = performance.now();
			let maxGapMs = 0;
			let acquiredAt = Number.NaN;
			ticker = setInterval(() => {
				if (!Number.isNaN(acquiredAt)) return;
				const now = performance.now();
				maxGapMs = Math.max(maxGapMs, now - last);
				last = now;
			}, 20);
			const started = performance.now();
			await database.transaction((tx) => {
				acquiredAt = performance.now();
				return tx.run("INSERT INTO probe VALUES (1)");
			});
			clearInterval(ticker);
			// Only the wait for the lock counts, not the commit after it, which syncs the file to disk.
			const waitedMs = acquiredAt - started;
			// The gap still open when the lock was taken counts: a wait that blocks synchronously lets no tick fire at all.
			maxGapMs = Math.max(maxGapMs, acquiredAt - last);
			assert.ok(waitedMs >= EVENT_LOOP_HOLD_MS / 2, `took the lock after ${waitedMs} ms while it was held`);
			assert.ok(
				maxGapMs < MAX_EVENT_LOOP_STALL_MS,
				`event loop stalled for ${Math.round(maxGapMs)} ms while waiting for the lock`,
			);
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
const PROGRESS_LOCK_WAIT_MS = 2_000;
/** How often the test counts the other writers' commits while one of its transactions waits for the lock. */
const OVERTAKE_CHECK_MS = 50;

async function startHog(path: string, stopPath: string, clockOffsetMs = 0): Promise<SpawnedProcess> {
	const hog = spawnProcess(
		[process.execPath, HOG_FIXTURE, path, String(HOG_HOLD_MS), stopPath, String(clockOffsetMs)],
		{ stdout: "pipe", stderr: "pipe" },
	);
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

/**
 * Runs `VICTIM_TRANSACTIONS` transactions in this process while one writer per entry of `hogClockOffsetsMs` retakes
 * the lock from another, each with its own clock that far off the system clock, and checks that no transaction here
 * waited through more than `MAX_COMMITS_AHEAD` of theirs. A transaction the others keep overtaking fails the test as
 * soon as they pass the bound, instead of waiting out a starvation that may not end.
 */
async function assertWritersTakeTurns(hogClockOffsetsMs: readonly number[]): Promise<void> {
	const directory = makeTempDirectory("journal-lock-fairness-");
	const path = join(directory, "journal.sqlite");
	const stopPath = join(directory, "stop");
	const database = await openNodeSqliteDatabase(path, { lockWaitMs: VICTIM_LOCK_WAIT_MS });
	const hogs: SpawnedProcess[] = [];
	let observer: DatabaseSync | undefined;
	try {
		await database.exec("CREATE TABLE hog(pid INTEGER); CREATE TABLE victim(n INTEGER)");
		for (const clockOffsetMs of hogClockOffsetsMs) hogs.push(await startHog(path, stopPath, clockOffsetMs));
		const reader = new DatabaseSync(path, { readOnly: true });
		observer = reader;
		const hogCommits = () => Number(reader.prepare("SELECT COUNT(*) AS count FROM hog").get()!.count);
		const overtaken: number[] = [];
		for (let index = 0; index < VICTIM_TRANSACTIONS; index++) {
			const before = (await database.get<{ count: number }>("SELECT COUNT(*) AS count FROM hog"))!.count;
			let began = false;
			const committed = database.transaction(async (tx) => {
				began = true;
				const after = (await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM hog"))!.count;
				overtaken.push(after - before);
				await tx.run("INSERT INTO victim VALUES (?)", index);
			});
			const finished = committed.then(
				() => true,
				() => true,
			);
			for (let done = false; !done; ) {
				const ahead = hogCommits() - before;
				if (!began && ahead > MAX_COMMITS_AHEAD)
					assert.fail(
						`other writers committed ${JSON.stringify([...overtaken, ahead])} times while each of this writer's transactions waited`,
					);
				done = await Promise.race([finished, sleep(OVERTAKE_CHECK_MS).then(() => false)]);
			}
			await committed;
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
		observer?.close();
		await database.close();
		removeTempDirectory(directory);
	}
}

test(
	"writers in several processes take the write lock in turn, so a writer is not starved by one that retakes it (#3978)",
	() => assertWritersTakeTurns(Array.from({ length: HOGS }, () => 0)),
	FAIRNESS_TEST_TIMEOUT_MS,
);

/**
 * Processes started on either side of a system clock step, and one well within the staleness window: on Windows each
 * running process's `Date` stays off the system clock by the step until V8 renews its reading, up to a minute later.
 */
const HOG_CLOCK_OFFSETS_MS = [-30_000, 30_000, 5_000];

test(
	"writers in several processes whose own clocks are seconds apart still take the write lock in turn (#4387)",
	() => assertWritersTakeTurns(HOG_CLOCK_OFFSETS_MS),
	FAIRNESS_TEST_TIMEOUT_MS,
);

test(
	"a write lock other writers keep committing through does not fail a waiting writer at the lock wait (#3978)",
	async () => {
		const directory = makeTempDirectory("journal-lock-progress-");
		const path = join(directory, "journal.sqlite");
		const stopPath = join(directory, "stop");
		// Far longer than any one commit holds the lock, even on a loaded machine, and far shorter than the time the
		// other writers keep the lock busy in total, which is what a deadline blind to their commits measured.
		const database = await openNodeSqliteDatabase(path, { lockWaitMs: PROGRESS_LOCK_WAIT_MS });
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

const STALLED_WRITER_FIXTURE = fileURLToPath(new URL("../fixtures/sqlite-stalled-writer.mjs", import.meta.url));
const STALLED_WRITERS = 10;
const STALLED_LOCK_WAIT_MS = 500;
/**
 * A queued writer measures the same stall: with nobody committing, each gives up about one lock wait after the last
 * commit. Before #3978's follow-up, every older ticket counted as progress, so the tenth writer waited roughly once
 * per writer ahead of it (4.7 s here); this bound sits well between the two.
 */
const STALLED_WAIT_BOUND_MS = (STALLED_WRITERS / 2) * STALLED_LOCK_WAIT_MS;

async function readLine(child: SpawnedProcess): Promise<string> {
	assert.ok(child.stdout);
	const reader = child.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(await readStreamText(child.stderr));
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return text.trim();
}

test(
	"writers queued behind an idle lock still give up one lock wait after the last commit, not one per writer ahead (#3978)",
	async () => {
		const directory = makeTempDirectory("journal-lock-queued-stall-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const writers: SpawnedProcess[] = [];
		let holder: SpawnedProcess | undefined;
		try {
			await database.exec("CREATE TABLE probe(x)");
			for (let index = 0; index < STALLED_WRITERS; index++) {
				const writer = spawnProcess(
					[process.execPath, STALLED_WRITER_FIXTURE, path, String(STALLED_LOCK_WAIT_MS)],
					{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
				);
				writers.push(writer);
				assert.equal(await readLine(writer), "ready");
			}
			// Held and never committed: nobody makes progress through the lock.
			holder = await holdWriteLock(path, -1);
			for (const writer of writers) writer.stdin?.end("go\n");
			const outcomes = await Promise.all(
				writers.map(
					async (writer) =>
						JSON.parse(await readLine(writer)) as {
							waitedMs: number;
							error: SerializedStorageError | null;
						},
				),
			);
			for (const outcome of outcomes) {
				assert.ok(outcome.error, JSON.stringify(outcome));
				// Serialized in the writer's process, rehydrated here as the same class with the same facts (#4316).
				const error = rehydrateStorageError(outcome.error);
				assert.ok(error instanceof StorageWriteLockTimeoutError, JSON.stringify(outcome));
				assert.ok(isStorageWriteLockTimeoutError(error));
				assert.equal(error.timeoutMs, STALLED_LOCK_WAIT_MS);
				assert.ok(error.elapsedMs >= STALLED_LOCK_WAIT_MS);
				assert.ok(error.phase === "queued" || error.phase === "acquiring", error.phase);
				assert.equal(error.location, path);
			}
			const longest = Math.max(...outcomes.map((outcome) => outcome.waitedMs));
			assert.ok(
				longest < STALLED_WAIT_BOUND_MS,
				`a writer waited ${Math.round(longest)} ms with no commit; each should give up after about ${STALLED_LOCK_WAIT_MS} ms`,
			);
		} finally {
			holder?.kill("SIGKILL");
			await holder?.exited;
			for (const writer of writers) {
				writer.kill("SIGKILL");
				await writer.exited;
			}
			await database.close();
			removeTempDirectory(directory);
		}
	},
	FAIRNESS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"a writers' queue that cannot be created fails the transaction as storage unavailable, naming the database (#3978)",
	async () => {
		const directory = makeTempDirectory("journal-lock-queue-unwritable-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0, lockWaitMs: 2_000 });
		let holder: SpawnedProcess | undefined;
		// The queue directory exists but cannot take a ticket.
		const queue = `${path}-writers`;
		mkdirSync(queue);
		chmodSync(queue, 0o500);
		try {
			await database.exec("CREATE TABLE probe(x)");
			holder = await holdWriteLock(path, -1);
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageWriterQueueUnusableError, String(error));
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.code, "writer-queue-unusable");
			assert.equal(error.location, path);
			assert.ok(/^(EACCES|EPERM)$/.test(error.errno ?? ""), error.errno);
			assert.equal((error.cause as NodeJS.ErrnoException).code, error.errno);
		} finally {
			chmodSync(queue, 0o700);
			holder?.kill("SIGKILL");
			await holder?.exited;
			await database.close();
			removeTempDirectory(directory);
		}
	},
	FAIRNESS_TEST_TIMEOUT_MS,
);
