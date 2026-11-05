import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
			// What a wait that blocks synchronously adds is time the event loop spends running, not waiting for events;
			// a loaded runner keeping an idle process off the CPU adds none of it.
			let last = performance.eventLoopUtilization();
			let maxBusyMs = 0;
			ticker = setInterval(() => {
				const now = performance.eventLoopUtilization();
				maxBusyMs = Math.max(maxBusyMs, performance.eventLoopUtilization(now, last).active);
				last = now;
			}, 20);
			const started = performance.now();
			let acquired = 0;
			await database.transaction((tx) => {
				// The wait ends with the lock taken. The commit that follows syncs the log to disk on the event loop, as
				// every commit does whether or not it waited, and is not part of the wait.
				acquired = performance.now();
				clearInterval(ticker);
				// The interval still open when the lock is taken counts: a wait that blocks synchronously lets no tick fire.
				maxBusyMs = Math.max(
					maxBusyMs,
					performance.eventLoopUtilization(performance.eventLoopUtilization(), last).active,
				);
				return tx.run("INSERT INTO probe VALUES (1)");
			});
			const waitedMs = acquired - started;
			assert.ok(waitedMs >= 1_000, `took the lock after ${waitedMs} ms while it was held`);
			assert.ok(maxBusyMs < 500, `event loop blocked for ${Math.round(maxBusyMs)} ms while waiting for the lock`);
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
		const countHogCommits = reader.prepare("SELECT COUNT(*) AS count FROM hog");
		const hogCommits = () => Number(countHogCommits.get()!.count);
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
			// Polled once begin() has run, so the count starts with this transaction asking for the lock.
			await new Promise<void>((resolve) => setImmediate(resolve));
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
/** Writers queued ahead of the one under test, which wait far longer than the test runs. */
const PATIENT_WRITERS = 9;
const PATIENT_LOCK_WAIT_MS = 60_000;
const STALLED_LOCK_WAIT_MS = 500;

interface StalledWriterOutcome {
	readonly waitedMs: number;
	readonly error: SerializedStorageError | null;
}

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

/** The queue's tickets once there are `count`, oldest first. */
async function queuedTickets(queue: string, count: number): Promise<string[]> {
	for (;;) {
		const names = existsSync(queue) ? readdirSync(queue).sort() : [];
		if (names.length >= count) return names;
		await sleep(20);
	}
}

/**
 * Before #3978's follow-up, a writer behind older tickets counted them as progress and gave up only once they had
 * gone: the tenth of ten writers queued at an idle lock waited once per writer ahead of it. Here the writers ahead
 * wait far longer than the test runs, so a writer that waited for them would outlast the test, however loaded the
 * machine.
 */
test(
	"a writer queued behind others at an idle lock gives up one lock wait after the last commit, while the writers ahead still wait (#3978)",
	async () => {
		const directory = makeTempDirectory("journal-lock-queued-stall-");
		const path = join(directory, "journal.sqlite");
		const queue = `${path}-writers`;
		const database = await openNodeSqliteDatabase(path);
		const writers: SpawnedProcess[] = [];
		let holder: SpawnedProcess | undefined;
		const startWriter = async (lockWaitMs: number): Promise<SpawnedProcess> => {
			const writer = spawnProcess([process.execPath, STALLED_WRITER_FIXTURE, path, String(lockWaitMs)], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			writers.push(writer);
			assert.equal(await readLine(writer), "ready");
			return writer;
		};
		try {
			await database.exec("CREATE TABLE probe(x)");
			const patient: SpawnedProcess[] = [];
			for (let index = 0; index < PATIENT_WRITERS; index++) patient.push(await startWriter(PATIENT_LOCK_WAIT_MS));
			const last = await startWriter(STALLED_LOCK_WAIT_MS);
			// Held and never committed: nobody makes progress through the lock.
			holder = await holdWriteLock(path, -1);
			for (const writer of patient) writer.stdin?.end("go\n");
			const ahead = await queuedTickets(queue, PATIENT_WRITERS);
			last.stdin?.end("go\n");
			const outcome = JSON.parse(await readLine(last)) as StalledWriterOutcome;
			assert.deepEqual(
				readdirSync(queue).filter((name) => ahead.includes(name)),
				ahead,
				`it gave up after ${Math.round(outcome.waitedMs)} ms only once writers ahead of it had gone`,
			);
			assert.ok(outcome.error, JSON.stringify(outcome));
			// Serialized in the writer's process, rehydrated here as the same class with the same facts (#4316).
			const error = rehydrateStorageError(outcome.error);
			assert.ok(error instanceof StorageWriteLockTimeoutError, JSON.stringify(outcome));
			assert.ok(isStorageWriteLockTimeoutError(error));
			assert.equal(error.timeoutMs, STALLED_LOCK_WAIT_MS);
			assert.ok(error.elapsedMs >= STALLED_LOCK_WAIT_MS);
			assert.ok(error.phase === "queued" || error.phase === "acquiring", error.phase);
			assert.equal(error.location, path);
			// The holder goes; the writers that waited all along take the lock in turn.
			holder.kill("SIGKILL");
			await holder.exited;
			for (const writer of patient) {
				const committed = JSON.parse(await readLine(writer)) as StalledWriterOutcome;
				assert.equal(committed.error, null, JSON.stringify(committed));
			}
			assert.deepEqual(await database.get("SELECT COUNT(*) AS count FROM probe"), { count: PATIENT_WRITERS });
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
