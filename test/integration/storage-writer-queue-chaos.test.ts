import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import {
	rehydrateStorageError,
	type SerializedStorageError,
	StorageRollbackError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import type { WriterQueueStats } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { isSqliteBusy } from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

/**
 * Chaos for the cross-process writers' queue (#4316): processes killed or stopped while they hold the write lock or
 * wait for it, many writers at once, a write that runs out of space, and clock steps. Every case checks the same
 * invariants: each committed transaction is there exactly once, nothing of a failed or killed one is, every live
 * writer makes progress, and the database passes `PRAGMA integrity_check`.
 */

const WRITER = fileURLToPath(new URL("../fixtures/sqlite-queue-writer.mjs", import.meta.url));
const HOLDER = fileURLToPath(new URL("../fixtures/sqlite-stalling-holder.mjs", import.meta.url));
/** Child processes, jiti-loaded adapters, and waits of a few ticket lifetimes (2 s each). */
const CHAOS_TEST_TIMEOUT_MS = 120_000;

interface WriterOptions {
	readonly label: string;
	readonly transactions?: number;
	readonly concurrency?: number;
	readonly busyMs?: number;
	readonly lockWaitMs?: number;
	readonly clockSkewMs?: number;
	readonly blobBytes?: number;
	readonly fillDatabase?: boolean;
}

interface WriterReport {
	readonly pid: number;
	readonly label: string;
	readonly committed: number;
	readonly errors: SerializedStorageError[];
	readonly stats: WriterQueueStats;
}

/** Reads a child's stdout line by line, keeping what arrives after a line for the next read. */
class Lines {
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private buffered = "";
	private readonly child: SpawnedProcess;

	constructor(child: SpawnedProcess) {
		assert.ok(child.stdout);
		this.child = child;
		this.reader = child.stdout.getReader();
	}

	async next(): Promise<string> {
		while (!this.buffered.includes("\n")) {
			const chunk = await this.reader.read();
			if (chunk.done) assert.fail(`child exited: ${await readStreamText(this.child.stderr)}`);
			this.buffered += new TextDecoder().decode(chunk.value);
		}
		const end = this.buffered.indexOf("\n");
		const line = this.buffered.slice(0, end);
		this.buffered = this.buffered.slice(end + 1);
		return line;
	}
}

const children: SpawnedProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
	try {
		for (const child of children.splice(0)) {
			if (process.platform !== "win32") child.kill("SIGCONT");
			child.kill("SIGKILL");
			await child.exited;
		}
	} finally {
		for (const directory of directories.splice(0)) removeTempDirectory(directory);
	}
});

function database(prefix: string): { readonly path: string; readonly writers: string } {
	const directory = makeTempDirectory(prefix);
	directories.push(directory);
	const path = join(directory, "journal.sqlite");
	const setup = new DatabaseSync(path);
	setup.exec(
		"PRAGMA journal_mode = WAL; CREATE TABLE writes(writer TEXT NOT NULL, seq INTEGER NOT NULL, payload BLOB)",
	);
	setup.close();
	return { path, writers: `${path}-writers` };
}

async function startWriter(path: string, options: WriterOptions) {
	const child = spawnProcess([process.execPath, WRITER, path, JSON.stringify(options)], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const lines = new Lines(child);
	assert.equal(await lines.next(), "ready");
	return {
		child,
		pid: child.pid!,
		go: () => child.stdin?.end("go\n"),
		report: async () => JSON.parse(await lines.next()) as WriterReport,
	};
}

/** An Atomic process holding the write lock mid-transaction, with one uncommitted row; `commit` lets it finish. */
async function startHolder(path: string) {
	const child = spawnProcess([process.execPath, HOLDER, path, "stdin"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const lines = new Lines(child);
	assert.equal(await lines.next(), "locked");
	return {
		child,
		pid: child.pid!,
		async commit() {
			child.stdin?.end("commit\n");
			assert.equal(await lines.next(), "committed");
			assert.equal(await child.exited, 0, await readStreamText(child.stderr));
		},
	};
}

function ticketsOf(writers: string, pid: number): string[] {
	return existsSync(writers) ? readdirSync(writers).filter((name) => name.split("-")[1] === String(pid)) : [];
}

/** Waits until the process has a ticket in the writers' queue: it is waiting for the lock. */
async function untilQueued(writers: string, pid: number): Promise<string> {
	for (;;) {
		const [ticket] = ticketsOf(writers, pid);
		if (ticket !== undefined) return ticket;
		await sleep(5);
	}
}

/** A reader that waits out a writer process still closing (its last checkpoint locks the file briefly). */
function readerOf(path: string): DatabaseSync {
	return new DatabaseSync(path, { readOnly: true, timeout: 10_000 });
}

function rows(path: string): { writer: string; seq: number }[] {
	const reader = readerOf(path);
	try {
		return reader.prepare("SELECT writer, seq FROM writes ORDER BY rowid").all() as { writer: string; seq: number }[];
	} finally {
		reader.close();
	}
}

function assertIntact(path: string): void {
	const reader = readerOf(path);
	try {
		assert.deepEqual(
			reader
				.prepare("PRAGMA integrity_check")
				.all()
				.map((row) => row.integrity_check),
			["ok"],
		);
	} finally {
		reader.close();
	}
}

function holderRowExists(path: string): boolean {
	const reader = readerOf(path);
	try {
		const table = reader.prepare("SELECT name FROM sqlite_master WHERE name = 'stalled_holder'").get();
		return table !== undefined && reader.prepare("SELECT COUNT(*) AS count FROM stalled_holder").get()?.count !== 0;
	} finally {
		reader.close();
	}
}

function describeTickets(writers: string): string {
	const now = Date.now();
	return JSON.stringify(
		existsSync(writers)
			? readdirSync(writers)
					.sort()
					.map((name) => `${name} age=${Math.round(now - statSync(join(writers, name)).mtimeMs)}ms`)
			: [],
	);
}

/** Re-dates every ticket in the queue, as a clock step after their writers last refreshed them leaves them. */
function shiftTickets(writers: string, offsetMs: number): void {
	for (const name of readdirSync(writers)) {
		const time = new Date(Date.now() + offsetMs);
		utimesSync(join(writers, name), time, time);
	}
}

test(
	"writers in different processes take a held lock in the order they queued for it (#4316)",
	async () => {
		const { path, writers } = database("queue-chaos-fifo-");
		const holder = await startHolder(path);
		const queued = [];
		for (const label of ["first", "second", "third", "fourth", "fifth"]) {
			const writer = await startWriter(path, { label });
			writer.go();
			await untilQueued(writers, writer.pid);
			queued.push(writer);
		}
		const queuedTickets = describeTickets(writers);
		await holder.commit();
		const reports = await Promise.all(queued.map((writer) => writer.report()));
		assert.deepEqual(
			reports.map((report) => [report.committed, report.errors.length]),
			queued.map(() => [1, 0]),
		);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["first", "second", "third", "fourth", "fifth"],
			`tickets when the holder committed: ${queuedTickets}`,
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"a writer killed while it waits in the queue does not hold up the writers behind it (#4316)",
	async () => {
		const { path, writers } = database("queue-chaos-killed-waiter-");
		const holder = await startHolder(path);
		const killed = await startWriter(path, { label: "killed" });
		killed.go();
		const abandoned = await untilQueued(writers, killed.pid);
		const behind = await startWriter(path, { label: "behind" });
		behind.go();
		await untilQueued(writers, behind.pid);
		const queuedTickets = describeTickets(writers);
		killed.child.kill("SIGKILL");
		await killed.child.exited;
		const timeAtDeath = statSync(join(writers, abandoned)).mtimeMs;
		await holder.commit();
		const report = await behind.report();
		assert.equal(report.committed, 1, JSON.stringify(report));
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["behind"],
		);
		assert.ok(existsSync(join(writers, abandoned)), "the abandoned ticket was passed over, not needed gone");
		const timeAfterRelease = statSync(join(writers, abandoned)).mtimeMs;
		assert.equal(
			timeAfterRelease,
			timeAtDeath,
			`no other writer kept the dead writer's ticket live after it died; tickets before the kill: ${queuedTickets}; now: ${describeTickets(writers)}`,
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"a writer killed holding the lock mid-transaction leaves no partial write, and the queued writers carry on (#4316)",
	async () => {
		const { path, writers } = database("queue-chaos-killed-holder-");
		const holder = await startHolder(path);
		const waiting = [];
		for (const label of ["one", "two", "three"]) {
			const writer = await startWriter(path, { label });
			writer.go();
			await untilQueued(writers, writer.pid);
			waiting.push(writer);
		}
		holder.child.kill("SIGKILL");
		await holder.child.exited;
		const reports = await Promise.all(waiting.map((writer) => writer.report()));
		assert.deepEqual(
			reports.map((report) => report.committed),
			[1, 1, 1],
		);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["one", "two", "three"],
		);
		assert.equal(holderRowExists(path), false, "the killed holder's uncommitted row is gone");
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a writer stopped while it waits is passed over once its ticket goes stale and takes its turn after it continues (#4316)",
	async () => {
		const { path, writers } = database("queue-chaos-stopped-waiter-");
		const holder = await startHolder(path);
		const stopped = await startWriter(path, { label: "stopped" });
		stopped.go();
		await untilQueued(writers, stopped.pid);
		const behind = await startWriter(path, { label: "behind" });
		behind.go();
		await untilQueued(writers, behind.pid);
		stopped.child.kill("SIGSTOP");
		await holder.commit();
		assert.equal((await behind.report()).committed, 1);
		stopped.child.kill("SIGCONT");
		assert.equal((await stopped.report()).committed, 1);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["behind", "stopped"],
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"writers queued behind a holder stopped mid-transaction wait it out and none fails (#4316)",
	async () => {
		const { path, writers } = database("queue-chaos-stopped-holder-");
		const holder = await startHolder(path);
		holder.child.kill("SIGSTOP");
		const waiting = [];
		for (const label of ["a", "b", "c"]) {
			const writer = await startWriter(path, { label, lockWaitMs: 10_000 });
			writer.go();
			await untilQueued(writers, writer.pid);
			waiting.push(writer);
		}
		await sleep(3_000);
		holder.child.kill("SIGCONT");
		await holder.commit();
		const reports = await Promise.all(waiting.map((writer) => writer.report()));
		assert.deepEqual(
			reports.map((report) => [report.committed, report.errors]),
			[
				[1, []],
				[1, []],
				[1, []],
			],
		);
		assert.ok(holderRowExists(path));
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

const MANY_WRITERS = 12;
const TRANSACTIONS_EACH = 40;

test(
	"many writers in many processes commit every transaction exactly once, each process in its own order (#4316)",
	async () => {
		const { path } = database("queue-chaos-many-");
		const started = await Promise.all(
			Array.from({ length: MANY_WRITERS }, (_, index) =>
				startWriter(path, { label: `w${index}`, transactions: TRANSACTIONS_EACH, concurrency: 4, busyMs: 1 }),
			),
		);
		for (const writer of started) writer.go();
		const reports = await Promise.all(started.map((writer) => writer.report()));
		for (const report of reports) assert.deepEqual([report.committed, report.errors], [TRANSACTIONS_EACH, []]);
		const written = rows(path);
		assert.equal(written.length, MANY_WRITERS * TRANSACTIONS_EACH);
		for (let index = 0; index < MANY_WRITERS; index++)
			assert.deepEqual(
				written.filter((row) => row.writer === `w${index}`).map((row) => row.seq),
				Array.from({ length: TRANSACTIONS_EACH }, (_, seq) => seq),
				`w${index} committed each transaction once, in order`,
			);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test(
	"a writer whose write runs out of space fails alone and hands the lock to the writer behind it (#4316)",
	async () => {
		const { path, writers } = database("queue-chaos-full-");
		const holder = await startHolder(path);
		const full = await startWriter(path, { label: "full", blobBytes: 1 << 20, fillDatabase: true });
		full.go();
		await untilQueued(writers, full.pid);
		const behind = await startWriter(path, { label: "behind" });
		behind.go();
		await untilQueued(writers, behind.pid);
		await holder.commit();
		const failed = await full.report();
		assert.equal(failed.committed, 0);
		const [error] = failed.errors.map((serialized) => rehydrateStorageError(serialized));
		// SQLite rolls a transaction back itself on SQLITE_FULL, so the explicit rollback after it fails too.
		assert.ok(error instanceof StorageRollbackError, String(error));
		const codes: unknown[] = [];
		for (const start of [error.cause, error.rollbackCause])
			for (let cause: unknown = start; cause instanceof Error; cause = cause.cause)
				codes.push((cause as { errcode?: number }).errcode);
		assert.ok(
			codes.includes(13),
			`SQLITE_FULL (database or disk is full) in the cause chain: ${JSON.stringify(codes)}`,
		);
		assert.equal((await behind.report()).committed, 1);
		assert.deepEqual(
			rows(path).map((row) => row.writer),
			["behind"],
		);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

for (const [direction, offsetMs] of [
	["back", 3_600_000],
	["forward", -3_600_000],
] as const)
	test(
		`queued writers keep making progress when the clock steps ${direction} under them, past an abandoned ticket (#4316)`,
		async () => {
			const { path, writers } = database(`queue-chaos-clock-${direction}-`);
			const holder = await startHolder(path);
			const waiting = [];
			for (const label of ["one", "two", "three"]) {
				const writer = await startWriter(path, { label });
				writer.go();
				await untilQueued(writers, writer.pid);
				waiting.push(writer);
			}
			// A writer that died before the step, first in line.
			writeFileSync(join(writers, `${"0".repeat(15)}-999999999-1`), "");
			shiftTickets(writers, offsetMs);
			await holder.commit();
			const reports = await Promise.all(waiting.map((writer) => writer.report()));
			assert.deepEqual(
				reports.map((report) => [report.committed, report.errors]),
				[
					[1, []],
					[1, []],
					[1, []],
				],
			);
			assert.deepEqual(
				rows(path)
					.map((row) => row.writer)
					.sort(),
				["one", "three", "two"],
			);
			assertIntact(path);
		},
		CHAOS_TEST_TIMEOUT_MS,
	);

test(
	"a writer whose own clock is an hour off still commits every transaction once beside writers with the right time (#4316)",
	async () => {
		const { path } = database("queue-chaos-skewed-process-");
		const started = await Promise.all([
			startWriter(path, { label: "ahead", transactions: 20, clockSkewMs: 3_600_000 }),
			startWriter(path, { label: "behind", transactions: 20, clockSkewMs: -3_600_000 }),
			...["a", "b", "c"].map((label) => startWriter(path, { label, transactions: 20, busyMs: 2 })),
		]);
		for (const writer of started) writer.go();
		const reports = await Promise.all(started.map((writer) => writer.report()));
		for (const report of reports)
			assert.deepEqual([report.label, report.committed, report.errors], [report.label, 20, []]);
		const written = rows(path);
		for (const label of ["ahead", "behind", "a", "b", "c"])
			assert.deepEqual(
				written.filter((row) => row.writer === label).map((row) => row.seq),
				Array.from({ length: 20 }, (_, seq) => seq),
			);
		assertIntact(path);
	},
	CHAOS_TEST_TIMEOUT_MS,
);

test("a busy failure keeps its SQLite code across the process boundary", () => {
	const serialized: SerializedStorageError = {
		name: "StorageWriteLockTimeoutError",
		code: "write-lock-timeout",
		message: "",
		fields: { adapter: "node-sqlite", location: "/x", timeoutMs: 1, elapsedMs: 1, phase: "queued" },
		cause: { name: "Error", code: "ERR_SQLITE_ERROR", message: "database is locked", fields: { errcode: 5 } },
	};
	assert.ok(isSqliteBusy(rehydrateStorageError(serialized).cause));
});
