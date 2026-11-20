import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { tryAdvisoryLock } from "@bastani/atomic-natives";
import { afterEach, test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	sqliteOpenLockPath,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	switchToWriteAheadLog,
	switchToWriteAheadLogSync,
} from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";
import {
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
	spawnSyncCollect,
} from "../helpers/runtime.js";
import { interceptConnectionRequests, type RequestInterception } from "../helpers/sqlite-connection-requests.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

const directories: string[] = [];
const interceptions: RequestInterception[] = [];

afterEach(() => {
	for (const interception of interceptions.splice(0)) interception.restore();
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

/** A path for a new database file; another process creates it in the rollback journal and holds its write lock. */
function databasePath(): string {
	const directory = makeTempDirectory("atomic-wal-switch-");
	directories.push(directory);
	return join(directory, "store.sqlite");
}

test("opening a store another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const path = databasePath();
	const holder = await holdSqliteWriteLock(path);
	const opening = openNodeSqliteDatabase(path);
	let early: unknown;
	try {
		early = await Promise.race([
			opening.then(
				() => "opened",
				(error: unknown) => error,
			),
			sleep(500).then(() => "waiting"),
		]);
	} finally {
		await holder.release();
	}
	// The open must still be waiting for the other process's lock, not have failed with SQLITE_BUSY.
	assert.equal(early, "waiting");
	const database = await opening;
	try {
		assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
		// It switched the file after the other process committed, not instead of it.
		assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM held"))?.count), 1);
	} finally {
		await database.close();
	}
});

test("an open refused for longer than its busy timeout fails with SQLITE_BUSY once the timeout has passed (#4270)", async () => {
	const path = databasePath();
	const holder = await holdSqliteWriteLock(path);
	try {
		const started = performance.now();
		await assert.rejects(openNodeSqliteDatabase(path, { busyTimeoutMs: 300 }), (error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal((error.cause as { errcode?: unknown }).errcode, 5);
			return true;
		});
		const waited = performance.now() - started;
		assert.ok(waited >= 300, `the open gave up after ${waited} ms, before its 300 ms busy timeout`);
	} finally {
		await holder.release();
	}
});

test("wrapping a connection to a file another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const path = databasePath();
	// The holder commits on its own: wrapping is synchronous and waits on this thread, as node:sqlite's busy timeout does.
	const holder = await holdSqliteWriteLock(path, 750);
	const connection = new DatabaseSync(path);
	try {
		const database = wrapNodeSqliteDatabase(connection);
		try {
			assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
			// It switched the file after the other process committed, not instead of it.
			assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM held"))?.count), 1);
		} finally {
			await database.close();
		}
	} finally {
		connection.close();
		await holder.release();
	}
});

const SQLITE_IOERR = 10;
const SQLITE_IOERR_TRUNCATE = 1546;
const SQLITE_BUSY = 5;
const TRUNCATE_CAP_MS = 5_000;

function sqliteFailure(fields: Record<string, unknown>): Error {
	return Object.assign(new Error("disk I/O error"), fields);
}

/**
 * Fails the first `failures` switches to the write-ahead log, of a connection on the calling thread (wrapped) and of
 * one on a thread of its own (opened) alike.
 */
function failWalSwitches(failures: number, errcode = SQLITE_IOERR_TRUNCATE): () => number {
	let attempts = 0;
	const failed = (sql: string) => {
		if (!sql.startsWith("PRAGMA journal_mode")) return false;
		attempts += 1;
		return attempts <= failures;
	};
	const failure = () => sqliteFailure({ code: "ERR_SQLITE_ERROR", errcode, errstr: "disk I/O error" });
	const exec = DatabaseSync.prototype.exec;
	vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
		if (failed(sql)) throw failure();
		return exec.call(this, sql);
	});
	interceptions.push(
		interceptConnectionRequests((request, send) =>
			request.kind === "exec" && failed(request.sql) ? Promise.reject(failure()) : send(request),
		),
	);
	return () => attempts;
}

interface GaveUp {
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly error: unknown;
}

/** The switch's retry deadline is on the monotonic clock (#5058): fake it along with the timers and the wall clock. */
const FAKED = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] as const;

async function giveUp(failure: unknown, busyTimeoutMs: number): Promise<GaveUp> {
	vi.useFakeTimers({ toFake: [...FAKED] });
	const started = Date.now();
	let attempts = 0;
	let outcome: { readonly error: unknown } | undefined;
	void switchToWriteAheadLog(() => {
		attempts += 1;
		throw failure;
	}, busyTimeoutMs).then(
		() => assert.fail("the switch cannot succeed"),
		(error: unknown) => {
			outcome = { error };
		},
	);
	for (let turn = 0; outcome === undefined && turn < 2_000; turn++) await vi.runOnlyPendingTimersAsync();
	assert.ok(outcome !== undefined, "the switch gave up");
	const result = { attempts, elapsedMs: Date.now() - started, error: outcome.error };
	vi.useRealTimers();
	return result;
}

function giveUpSync(failure: unknown, busyTimeoutMs: number): GaveUp {
	vi.useFakeTimers({ toFake: [...FAKED] });
	vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
		vi.advanceTimersByTime(Number(timeout));
		return "timed-out";
	});
	const started = Date.now();
	let attempts = 0;
	try {
		switchToWriteAheadLogSync(() => {
			attempts += 1;
			throw failure;
		}, busyTimeoutMs);
	} catch (error) {
		const result = { attempts, elapsedMs: Date.now() - started, error };
		vi.useRealTimers();
		return result;
	}
	return assert.fail("the switch cannot succeed");
}

const GIVE_UP = [
	giveUp,
	async (failure: unknown, busyTimeoutMs: number) => giveUpSync(failure, busyTimeoutMs),
] as const;

test("opening a store whose wal-index a killed process still maps waits out the release (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(3);
	const database = await openNodeSqliteDatabase(path);
	try {
		assert.equal(attempts(), 4);
		assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
	} finally {
		await database.close();
	}
});

test("wrapping a connection whose wal-index a killed process still maps waits out the release (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(3);
	const connection = new DatabaseSync(path);
	try {
		const database = wrapNodeSqliteDatabase(connection);
		try {
			assert.equal(attempts(), 4);
			assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
		} finally {
			await database.close();
		}
	} finally {
		connection.close();
	}
});

test("an open with no busy timeout fails at once with its SQLITE_IOERR_TRUNCATE cause (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(Number.POSITIVE_INFINITY);
	await assert.rejects(openNodeSqliteDatabase(path, { busyTimeoutMs: 0 }), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal((error.cause as { errcode?: unknown }).errcode, SQLITE_IOERR_TRUNCATE);
		return true;
	});
	assert.equal(attempts(), 1);
});

test("any other I/O failure while switching to the write-ahead log fails at once (#4610)", async () => {
	const path = databasePath();
	const attempts = failWalSwitches(Number.POSITIVE_INFINITY, SQLITE_IOERR);
	await assert.rejects(openNodeSqliteDatabase(path), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal((error.cause as { errcode?: unknown }).errcode, SQLITE_IOERR);
		return true;
	});
	assert.equal(attempts(), 1);
});

for (const [name, run] of [
	["switchToWriteAheadLog", GIVE_UP[0]],
	["switchToWriteAheadLogSync", GIVE_UP[1]],
] as const) {
	test.each([
		[300, 300],
		[TRUNCATE_CAP_MS, TRUNCATE_CAP_MS],
		[10_000, TRUNCATE_CAP_MS],
		[600_000, TRUNCATE_CAP_MS],
	])(
		`${name} retries a refused truncation under a busy timeout of %d ms for %d ms (#4610)`,
		async (busyTimeoutMs, expectedMs) => {
			const failure = sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE });
			const gaveUp = await run(failure, busyTimeoutMs);
			assert.equal(gaveUp.elapsedMs, expectedMs);
			assert.ok(gaveUp.attempts > 2, `${gaveUp.attempts} attempts`);
			assert.equal(gaveUp.error, failure);
		},
	);

	test.each([[300], [TRUNCATE_CAP_MS], [10_000]])(
		`${name} retries SQLITE_BUSY for the whole busy timeout of %d ms, past the truncation cap (#4610)`,
		async (busyTimeoutMs) => {
			const failure = sqliteFailure({ errcode: SQLITE_BUSY });
			const gaveUp = await run(failure, busyTimeoutMs);
			assert.equal(gaveUp.elapsedMs, busyTimeoutMs);
			assert.ok(gaveUp.attempts > 2, `${gaveUp.attempts} attempts`);
			assert.equal(gaveUp.error, failure);
		},
	);

	test.each([
		["no code", () => new Error("boom")],
		["SQLITE_IOERR", () => sqliteFailure({ errcode: SQLITE_IOERR })],
		["SQLITE_IOERR in rawCode", () => sqliteFailure({ rawCode: SQLITE_IOERR })],
		["SQLITE_ERROR", () => sqliteFailure({ errcode: 1 })],
		["SQLITE_IOERR_SHMSIZE", () => sqliteFailure({ errcode: 4874 })],
		["a non-numeric code", () => sqliteFailure({ errcode: String(SQLITE_IOERR_TRUNCATE) })],
		["a thrown string", () => "disk I/O error"],
		["a thrown null", () => null],
		[
			"a numeric code that is not first",
			() => sqliteFailure({ errcode: SQLITE_IOERR, cause: sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }) }),
		],
		["errcode before rawCode", () => sqliteFailure({ errcode: SQLITE_IOERR, rawCode: SQLITE_IOERR_TRUNCATE })],
	])(`${name} throws %s at once, whatever the busy timeout (#4610)`, async (_label, make) => {
		for (const busyTimeoutMs of [0, 300, 600_000]) {
			const failure = make();
			const gaveUp = await run(failure, busyTimeoutMs);
			assert.equal(gaveUp.attempts, 1, `busy timeout ${busyTimeoutMs}`);
			assert.equal(gaveUp.elapsedMs, 0);
			assert.equal(gaveUp.error, failure);
		}
	});

	test.each([
		["SQLITE_BUSY", SQLITE_BUSY],
		["SQLITE_IOERR_TRUNCATE", SQLITE_IOERR_TRUNCATE],
	])(`${name} throws %s at once under a busy timeout of 0 (#4610)`, async (_label, errcode) => {
		const failure = sqliteFailure({ errcode });
		const gaveUp = await run(failure, 0);
		assert.equal(gaveUp.attempts, 1);
		assert.equal(gaveUp.elapsedMs, 0);
		assert.equal(gaveUp.error, failure);
	});

	test.each([
		["errcode", () => sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE })],
		["libSQL's rawCode", () => sqliteFailure({ rawCode: SQLITE_IOERR_TRUNCATE })],
		["errcode over rawCode", () => sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE, rawCode: SQLITE_IOERR })],
		[
			"a non-numeric code in front of its cause",
			() => sqliteFailure({ errcode: "ERR", cause: sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }) }),
		],
		[
			"the cause of a wrapper",
			() =>
				new StorageUnavailableError(
					{ adapter: "node-sqlite", location: "x" },
					sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }),
				),
		],
		[
			"a cause three levels down",
			() =>
				new Error("a", {
					cause: new Error("b", {
						cause: new Error("c", { cause: sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE }) }),
					}),
				}),
		],
	])(`${name} recognizes SQLITE_IOERR_TRUNCATE as %s (#4610)`, async (_label, make) => {
		const gaveUp = await run(make(), 600_000);
		assert.equal(gaveUp.elapsedMs, TRUNCATE_CAP_MS);
	});

	test(`${name} stops at once on a chain of causes that leads back to itself without a code (#4610)`, async () => {
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		first.cause = second;
		const alone = new Error("alone");
		alone.cause = alone;
		for (const failure of [first, alone]) {
			const gaveUp = await run(failure, 600_000);
			assert.equal(gaveUp.attempts, 1);
			assert.equal(gaveUp.elapsedMs, 0);
		}
	});

	test(`${name} finds SQLITE_IOERR_TRUNCATE in a chain of causes that leads back to itself (#4610)`, async () => {
		const first = new Error("first");
		const second = sqliteFailure({ errcode: SQLITE_IOERR_TRUNCATE, cause: first });
		first.cause = second;
		const gaveUp = await run(first, 600_000);
		assert.equal(gaveUp.elapsedMs, TRUNCATE_CAP_MS);
	});
}

test("wrapping a read-only connection still reads when its open-lock file is not writable (#5317)", async () => {
	const path = databasePath();
	const setup = new DatabaseSync(path);
	setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(v INTEGER); INSERT INTO items VALUES (42)");
	setup.close();
	const lockPath = sqliteOpenLockPath(path);
	writeFileSync(lockPath, "");
	chmodSync(lockPath, 0o444);
	const connection = new DatabaseSync(path, { readOnly: true });
	try {
		const database = wrapNodeSqliteDatabase(connection);
		try {
			assert.deepEqual(await database.all("SELECT v FROM items"), [{ v: 42 }]);
		} finally {
			await database.close();
		}
	} finally {
		connection.close();
		if (existsSync(lockPath)) chmodSync(lockPath, 0o600);
	}
});

test.skipIf(process.platform !== "win32" && process.getuid?.() === 0).each(["open", "wrap"] as const)(
	"read-only %s connection still reads beside an existing lock marker when the directory refuses new files (#5317)",
	async (mode) => {
		const directory = makeTempDirectory("atomic-open-lock-denied-dir-");
		directories.push(directory);
		const roDir = join(directory, "create-denied");
		mkdirSync(roDir, { recursive: true });
		const roDbPath = join(roDir, "x.sqlite");
		const setup = new DatabaseSync(roDbPath);
		setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(v INTEGER); INSERT INTO items(v) VALUES (42);");
		writeFileSync(`${roDbPath}.lock`, "");
		if (process.platform === "win32") {
			const denied = spawnSyncCollect(["icacls", roDir, "/deny", "*S-1-1-0:(WD,AD)"]);
			assert.equal(denied.exitCode, 0, denied.stderr.toString());
		} else {
			chmodSync(roDir, 0o555);
		}
		try {
			assert.equal(existsSync(sqliteOpenLockPath(roDbPath)), false);
			if (mode === "open") {
				const opened = await openNodeSqliteDatabase(roDbPath, { readOnly: true, busyTimeoutMs: 200 });
				try {
					assert.deepEqual(await opened.all("SELECT v FROM items"), [{ v: 42 }]);
				} finally {
					await opened.close();
				}
			} else {
				const rawReadOnly = new DatabaseSync(roDbPath, { readOnly: true });
				try {
					const wrapped = wrapNodeSqliteDatabase(rawReadOnly);
					try {
						assert.deepEqual(await wrapped.all("SELECT v FROM items"), [{ v: 42 }]);
					} finally {
						await wrapped.close();
					}
				} finally {
					rawReadOnly.close();
				}
			}
			assert.equal(existsSync(sqliteOpenLockPath(roDbPath)), false);
		} finally {
			if (process.platform === "win32") {
				spawnSyncCollect(["icacls", roDir, "/remove:d", "*S-1-1-0"]);
			} else {
				chmodSync(roDir, 0o755);
			}
			setup.close();
		}
	},
);

const REFUSAL_CLEARS_AFTER_MS = 200;
const REFUSING_BUSY_TIMEOUT_MS = 300;
const PERMANENT_DENIAL_BUSY_TIMEOUT_MS = 10_000;
const PROMPT_FAILURE_MS = 2_000;

function refuseNewFiles(directory: string): () => void {
	const denied = spawnSyncCollect(["icacls", directory, "/deny", "*S-1-1-0:(WD,AD)"]);
	assert.equal(denied.exitCode, 0, denied.stderr.toString());
	return () => {
		spawnSyncCollect(["icacls", directory, "/remove:d", "*S-1-1-0"]);
	};
}

test.skipIf(process.platform !== "win32")(
	"a writable open waits out a refusal to create its open lock that clears, as while another process removes the lock (#5317)",
	async () => {
		const directory = makeTempDirectory("atomic-open-lock-refused-");
		directories.push(directory);
		const path = join(directory, "store.sqlite");
		const allow = refuseNewFiles(directory);
		const cleared = sleep(REFUSAL_CLEARS_AFTER_MS).then(allow);
		try {
			const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 5_000 });
			try {
				await database.exec("CREATE TABLE items(v INTEGER); INSERT INTO items VALUES (7)");
				assert.deepEqual(await database.all("SELECT v FROM items"), [{ v: 7 }]);
			} finally {
				await database.close();
			}
		} finally {
			await cleared;
		}
	},
);

test.skipIf(process.platform !== "win32")(
	"a writable open whose open lock stays refused reports the refusal once its busy timeout has passed (#5317)",
	async () => {
		const directory = makeTempDirectory("atomic-open-lock-refused-");
		directories.push(directory);
		const allow = refuseNewFiles(directory);
		try {
			const started = performance.now();
			const failure = await openNodeSqliteDatabase(join(directory, "store.sqlite"), {
				busyTimeoutMs: REFUSING_BUSY_TIMEOUT_MS,
			}).then(
				async (database) => {
					await database.close();
					assert.fail("the open succeeded in a directory that refuses new files");
				},
				(error: unknown) => error,
			);
			assert.ok(failure instanceof StorageUnavailableError, String(failure));
			assert.match(String(failure.cause), /Access is denied/);
			assert.ok(performance.now() - started >= REFUSING_BUSY_TIMEOUT_MS, "the open waited its busy timeout");
		} finally {
			allow();
		}
	},
);

test.skipIf(process.platform !== "win32")(
	"a writable open whose existing open lock refuses it fails at once instead of waiting its busy timeout (#5317)",
	async () => {
		const directory = makeTempDirectory("atomic-open-lock-refused-");
		directories.push(directory);
		const path = join(directory, "store.sqlite");
		const lockPath = sqliteOpenLockPath(path);
		writeFileSync(lockPath, "");
		const denied = spawnSyncCollect(["icacls", lockPath, "/deny", "*S-1-1-0:(R,W)"]);
		assert.equal(denied.exitCode, 0, denied.stderr.toString());
		try {
			const started = performance.now();
			const failure = await openNodeSqliteDatabase(path, { busyTimeoutMs: PERMANENT_DENIAL_BUSY_TIMEOUT_MS }).then(
				async (database) => {
					await database.close();
					assert.fail("the open succeeded although its open lock refuses it");
				},
				(error: unknown) => error,
			);
			const elapsed = performance.now() - started;
			assert.ok(failure instanceof StorageUnavailableError, String(failure));
			assert.match(String(failure.cause), /Access is denied/);
			assert.ok(elapsed < PROMPT_FAILURE_MS, `the open failed after ${Math.round(elapsed)} ms`);
		} finally {
			spawnSyncCollect(["icacls", lockPath, "/remove:d", "*S-1-1-0"]);
		}
	},
);

test("connections hold a shared open lock while open, release it on close or kill, and create none for untouched read-only files (#5317)", async () => {
	const directory = makeTempDirectory("atomic-open-lock-");
	directories.push(directory);
	const untouchedPath = join(directory, "untouched.sqlite");
	const raw = new DatabaseSync(untouchedPath);
	raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(v INTEGER); INSERT INTO items(v) VALUES (42);");
	raw.close();
	const untouchedReader = await openNodeSqliteDatabase(untouchedPath, { readOnly: true });
	assert.deepEqual(await untouchedReader.all("SELECT v FROM items"), [{ v: 42 }]);
	assert.equal(existsSync(sqliteOpenLockPath(untouchedPath)), false);
	assert.equal(existsSync(`${untouchedPath}-holders`), false);
	await untouchedReader.close();

	const rawUntouchedWrapped = new DatabaseSync(untouchedPath, { readOnly: true });
	try {
		const untouchedWrapped = wrapNodeSqliteDatabase(rawUntouchedWrapped);
		try {
			assert.equal(existsSync(sqliteOpenLockPath(untouchedPath)), true);
			assert.equal(tryAdvisoryLock(sqliteOpenLockPath(untouchedPath), 0), null);
			assert.deepEqual(await untouchedWrapped.all("SELECT v FROM items"), [{ v: 42 }]);
		} finally {
			await untouchedWrapped.close();
		}
	} finally {
		rawUntouchedWrapped.close();
	}
	assert.equal(existsSync(sqliteOpenLockPath(untouchedPath)), false);

	const path = join(directory, "managed.sqlite");
	const first = await openNodeSqliteDatabase(path);
	const lockPath = sqliteOpenLockPath(path);
	assert.equal(existsSync(lockPath), true);
	assert.equal(tryAdvisoryLock(lockPath, 0), null, "held shared while first connection is open");
	const second = await openNodeSqliteDatabase(path, { readOnly: true });
	const rawWrapped = new DatabaseSync(path);
	const wrapped = wrapNodeSqliteDatabase(rawWrapped);
	await first.close();
	assert.equal(tryAdvisoryLock(lockPath, 0), null, "still held while second and wrapped connections remain open");
	await second.close();
	assert.equal(tryAdvisoryLock(lockPath, 0), null, "still held while wrapped facade remains open");
	await wrapped.close();
	rawWrapped.close();
	assert.equal(existsSync(lockPath), false, "no -open.lock is left after the last connection closes");

	const uriConn = await openNodeSqliteDatabase(pathToFileURL(path).href, { readOnly: true });
	assert.equal(tryAdvisoryLock(lockPath, 0), null, "file: URI connection holds the shared open lock");
	await uriConn.close();
	assert.equal(existsSync(lockPath), false);

	const corruptPath = join(directory, "corrupt.sqlite");
	writeFileSync(corruptPath, "not a sqlite database");
	await assert.rejects(openNodeSqliteDatabase(corruptPath));
	assert.equal(existsSync(sqliteOpenLockPath(corruptPath)), false, "failed open releases and removes its open lock");

	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const roDir = join(directory, "readonly-dir");
		const roDbPath = join(roDir, "ro.sqlite");
		const roSetup = await openNodeSqliteDatabase(roDbPath);
		await roSetup.exec("CREATE TABLE items(v INTEGER); INSERT INTO items(v) VALUES (42);");
		await roSetup.exec("PRAGMA journal_mode=DELETE");
		await roSetup.close();
		chmodSync(roDbPath, 0o444);
		chmodSync(roDir, 0o555);
		try {
			const roReader = await openNodeSqliteDatabase(roDbPath, { readOnly: true });
			try {
				assert.deepEqual(await roReader.all("SELECT v FROM items"), [{ v: 42 }]);
			} finally {
				await roReader.close();
			}
		} finally {
			chmodSync(roDir, 0o755);
			chmodSync(roDbPath, 0o644);
		}
	}

	const child = spawnProcess(
		[
			process.execPath,
			"-e",
			`const { trySharedAdvisoryLock } = require(${JSON.stringify(join(process.cwd(), "packages/natives/native/index.js"))});
			const lock = trySharedAdvisoryLock(process.argv[1], 0);
			if (!lock) process.exit(1);
			process.stdout.write("locked\\n");
			setInterval(() => {}, 60_000);`,
			lockPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = readStreamText(child.stderr);
	const reader = decodeStream(child.stdout!).getReader();
	let output = "";
	while (!output.includes("\n")) {
		const chunk = await reader.read();
		if (chunk.done) assert.fail(`child exited before locking: ${await stderr}`);
		output += chunk.value;
	}
	reader.releaseLock();
	assert.equal(tryAdvisoryLock(lockPath, 0), null, "child process holds the shared open lock");
	child.kill("SIGKILL");
	await child.exited;
	const recovered = tryAdvisoryLock(lockPath, 5_000);
	assert.ok(recovered !== null, "kernel releases the shared open lock when the holder is killed");
	recovered.release();
});
