import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	StorageUnavailableError,
	StorageWriteLockTimeoutError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";

import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

/** Short, so a waiter that treats the stall as an idle lock fails within the test. */
const LOCK_WAIT_MS = 500;
/** How long the holder stays stalled mid-transaction: many lock waits. */
const STALL_MS = 3_000;
const TEST_TIMEOUT_MS = 90_000;
const HOLDER = fileURLToPath(new URL("../fixtures/sqlite-stalling-holder.mjs", import.meta.url));

type Stall = "stopped" | "event loop blocked";

async function readLine(child: SpawnedProcess): Promise<string> {
	assert.ok(child.stdout);
	const reader = child.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(`holder exited: ${await readStreamText(child.stderr)}`);
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return text.trim();
}

/**
 * Another Atomic process takes the write lock mid-transaction and stalls holding it: stopped by a signal, or with its
 * own event loop blocked. Resolves once the lock is held; `release` lets the holder commit and waits for it to exit.
 */
async function stallingHolder(path: string, stall: Stall, record: string[] = []) {
	const holder = spawnProcess(
		[process.execPath, HOLDER, path, stall === "stopped" ? "stdin" : `spin:${STALL_MS}`, ...record],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	assert.equal(await readLine(holder), "locked");
	if (stall === "stopped") holder.kill("SIGSTOP");
	return {
		pid: holder.pid,
		async release() {
			if (stall === "stopped") {
				holder.kill("SIGCONT");
				holder.stdin?.end("commit\n");
			}
			assert.equal(await readLine(holder), "committed");
			assert.equal(await holder.exited, 0, await readStreamText(holder.stderr));
		},
		async kill() {
			holder.kill("SIGKILL");
			await holder.exited;
		},
	};
}

/** Largest gap between ticks of a 20 ms timer until stopped, including the one still open. */

for (const stall of ["stopped", "event loop blocked"] as const)
	test.skipIf(process.platform === "win32")(
		"a writer that gives up on a write lock held by a stopped process names that process",
		async () => {
			const directory = makeTempDirectory("journal-stalled-holder-named-");
			const path = join(directory, "journal.sqlite");
			const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0, lockWaitMs: LOCK_WAIT_MS });
			let holder: Awaited<ReturnType<typeof stallingHolder>> | undefined;
			try {
				await database.exec("CREATE TABLE probe(x)");
				holder = await stallingHolder(path, "stopped");
				const error = await database
					.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
					.then(
						() => assert.fail("write succeeded under a held lock"),
						(cause: unknown) => cause,
					);
				assert.ok(error instanceof StorageWriteLockTimeoutError, String(error));
				assert.ok(error instanceof StorageUnavailableError);
				assert.equal(error.code, "write-lock-timeout");
				assert.equal(error.holderPid, holder.pid);
				assert.ok((error.holderHeldMs ?? -1) >= 0);
				assert.equal(error.timeoutMs, LOCK_WAIT_MS);
				await holder.release();
			} finally {
				await holder?.kill();
				await database.close();
				removeTempDirectory(directory);
			}
		},
		TEST_TIMEOUT_MS,
	);

/** Long enough that the holder's record of taking the lock cannot land before the waiting writer gives up. */
const SLOW_RECORD_MS = 4 * LOCK_WAIT_MS;

test.skipIf(process.platform === "win32")(
	"a writer that gives up on a write lock lists, without naming it, a process that took the lock and stopped before it recorded so",
	async () => {
		const directory = makeTempDirectory("journal-stalled-holder-unrecorded-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0, lockWaitMs: LOCK_WAIT_MS });
		let holder: Awaited<ReturnType<typeof stallingHolder>> | undefined;
		try {
			await database.exec("CREATE TABLE probe(x)");
			holder = await stallingHolder(path, "stopped", [`slow-record:${SLOW_RECORD_MS}`]);
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageWriteLockTimeoutError, String(error));
			assert.equal(error.holderPid, undefined);
			assert.equal(error.holderCandidates, String(holder.pid));
			assert.match(error.message, new RegExp(`processes trying for it: ${holder.pid}\\)`));
			await holder.release();
		} finally {
			await holder?.kill();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);

const QUEUE_WRITER = fileURLToPath(new URL("../fixtures/sqlite-queue-writer.mjs", import.meta.url));

test.skipIf(process.platform === "win32")(
	"a writer that gives up never names a waiter stopped in the queue when a later writer took the lock past it without recording so",
	async () => {
		const directory = makeTempDirectory("journal-stalled-holder-stopped-waiter-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0, lockWaitMs: LOCK_WAIT_MS });
		const children: SpawnedProcess[] = [];
		let first: Awaited<ReturnType<typeof stallingHolder>> | undefined;
		let later: Awaited<ReturnType<typeof stallingHolder>> | undefined;
		try {
			await database.exec("CREATE TABLE probe(x); CREATE TABLE writes(writer TEXT, seq INTEGER, payload BLOB)");
			first = await stallingHolder(path, "stopped");
			const waiter = spawnProcess(
				[process.execPath, QUEUE_WRITER, path, JSON.stringify({ label: "waiter", lockWaitMs: 60_000 })],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			children.push(waiter);
			assert.equal(await readLine(waiter), "ready");
			waiter.stdin?.end("go\n");
			const queued = () => readdirSync(`${path}-writers`).some((name) => name.split("-")[1] === String(waiter.pid));
			while (!existsSync(`${path}-writers`) || !queued()) await sleep(5);
			waiter.kill("SIGSTOP");
			await first.kill();
			first = undefined;
			// Takes the lock past the stopped waiter's ticket once that goes stale, and stops before it records so.
			later = await stallingHolder(path, "stopped", [`slow-record:${SLOW_RECORD_MS}`]);
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageWriteLockTimeoutError, String(error));
			assert.equal(
				error.holderPid,
				undefined,
				`named process ${error.holderPid}; the waiter is ${waiter.pid}, the holder ${later.pid}`,
			);
			assert.deepEqual(error.holderCandidates?.split(", ").map(Number).sort(), [waiter.pid, later.pid].sort());
		} finally {
			await first?.kill();
			await later?.kill();
			for (const child of children) {
				child.kill("SIGCONT");
				child.kill("SIGKILL");
				await child.exited;
			}
			await database.close();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);

const STALLED_WRITER = fileURLToPath(new URL("../fixtures/sqlite-stalled-writer.mjs", import.meta.url));
const SLOW_MEMBERS = 40;
const SLOW_MEMBER_MS = 25;

test.skipIf(process.platform === "win32")(
	"a long group commit lets another process's writer in instead of holding the write lock for the whole batch",
	async () => {
		const directory = makeTempDirectory("journal-group-commit-hold-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		let writer: SpawnedProcess | undefined;
		try {
			// The other writer's row records how many of this connection's rows had committed when it got the lock.
			await database.exec(`
				CREATE TABLE slow(n INTEGER);
				CREATE TABLE probe(x INTEGER);
				CREATE TRIGGER probe_counts AFTER INSERT ON probe BEGIN
					UPDATE probe SET x = (SELECT COUNT(*) FROM slow) WHERE rowid = NEW.rowid;
				END;
			`);
			writer = spawnProcess([process.execPath, STALLED_WRITER, path, "60000"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			assert.equal(await readLine(writer), "ready");
			const entered = Promise.withResolvers<void>();
			// Queued together, so they share one group commit; each is CPU work while the lock is held.
			const members = Array.from({ length: SLOW_MEMBERS }, (_, index) =>
				database.transaction(async (tx) => {
					entered.resolve();
					const until = performance.now() + SLOW_MEMBER_MS;
					while (performance.now() < until) {
						// Busy, as a process starved of CPU is.
					}
					await tx.run("INSERT INTO slow VALUES (?)", index);
				}),
			);
			await entered.promise;
			writer.stdin?.end("go\n");
			await Promise.all(members);
			const outcome = JSON.parse(await readLine(writer)) as { error: { message: string } | null };
			assert.equal(outcome.error, null, JSON.stringify(outcome));
			const seen = (await database.get<{ x: number }>("SELECT x FROM probe"))!.x;
			assert.ok(
				seen < SLOW_MEMBERS * 0.75,
				`the other writer waited until ${seen} of ${SLOW_MEMBERS} transactions (${SLOW_MEMBERS * SLOW_MEMBER_MS} ms of work) had committed`,
			);
		} finally {
			writer?.kill("SIGKILL");
			await writer?.exited;
			await database.close();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);

test("a connection's write-lock record goes away when it closes, and records of exited processes are removed", async () => {
	const directory = makeTempDirectory("journal-holder-records-");
	const path = join(directory, "journal.sqlite");
	const holders = `${path}-holders`;
	// A process that was killed while it held the lock left its record behind; pids this large are never live.
	mkdirSync(holders, { recursive: true });
	writeFileSync(join(holders, "999999999-1"), `held ${String(Date.now()).padStart(15, "0")}\n`);
	const database = await openNodeSqliteDatabase(path);
	try {
		await database.transaction((tx) => tx.exec("CREATE TABLE probe(x)"));
		assert.deepEqual(
			readdirSync(holders).map((name) => name.split("-")[0]),
			[String(process.pid)],
		);
		await database.close();
		assert.deepEqual(readdirSync(holders), []);
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
