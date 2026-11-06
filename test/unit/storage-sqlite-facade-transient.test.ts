import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	isRetryableStorageError,
	type SqliteDriver,
	type SqliteDriverTransientFailure,
	STORAGE_TRANSIENT_RETRY_ATTEMPTS,
	StorageConfigError,
	StorageRollbackError,
	StorageTransientError,
	type StorageTransientErrorCode,
	type StorageTransientOutcome,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";

type Step = "execute" | "exec" | "batch" | "begin" | "tx" | "commit" | "rollback" | "tx close" | "close";

/** A driver failure that the driver itself recognizes as transient, with the outcome it reports for the request. */
function transient(code: StorageTransientErrorCode, outcome: StorageTransientOutcome, message = "driver call failed") {
	return Object.assign(new Error(message), { transient: { code, outcome } satisfies SqliteDriverTransientFailure });
}

/** A driver that records each call and throws the failures planned for its next calls of a kind. */
function plannedDriver(redact?: (text: string) => string) {
	const calls: string[] = [];
	const classified: string[] = [];
	const planned = new Map<Step, Error[]>();
	const step = (kind: Step, label: string = kind) => {
		calls.push(label);
		const failure = planned.get(kind)?.shift();
		if (failure) throw failure;
	};
	const result = (sql: string) => ({ columns: ["sql"], rows: [[sql]], changes: 1 });
	const driver: SqliteDriver = {
		descriptor: { adapter: "planned", location: "planned://database" },
		execute(sql) {
			step("execute", `execute ${sql}`);
			return result(sql);
		},
		executeMultiple: (sql) => step("exec", `exec ${sql}`),
		batch(statements) {
			step("batch", `batch ${statements.map(({ sql }) => sql).join("; ")}`);
			return statements.map(({ sql }) => result(sql));
		},
		beginTransaction() {
			step("begin");
			return {
				execute(sql) {
					step("tx", `tx ${sql}`);
					return result(sql);
				},
				executeMultiple: (sql) => step("tx", `tx ${sql}`),
				commit: () => step("commit"),
				rollback: () => step("rollback"),
				close: () => step("tx close"),
			};
		},
		close: () => step("close"),
		...(redact === undefined ? {} : { redact }),
		transientFailure(failure) {
			classified.push(failure instanceof Error ? failure.message : String(failure));
			return (failure as { transient?: SqliteDriverTransientFailure } | undefined)?.transient;
		},
	};
	return {
		driver,
		calls,
		classified,
		fail(kind: Step, ...failures: Error[]) {
			planned.set(kind, [...(planned.get(kind) ?? []), ...failures]);
		},
	};
}

/** Settles queued promise callbacks without moving the fake clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const warnings: Error[] = [];
const onWarning = (warning: Error) => warnings.push(warning);

beforeEach(() => {
	vi.useFakeTimers();
	warnings.length = 0;
	process.on("warning", onWarning);
});

afterEach(() => {
	process.off("warning", onWarning);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test("a statement a transient failure ended before it reached the database runs again after the backoff (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	fail("execute", transient("connection-refused", "not-applied"));
	const database = createSqliteDatabase(driver);
	const row = database.get<{ sql: string }>("SELECT 1");
	await settle();
	assert.deepEqual(calls, ["execute SELECT 1"]);
	await vi.advanceTimersByTimeAsync(249);
	assert.deepEqual(calls, ["execute SELECT 1"], "the second run waits the whole first backoff");
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(await row, { sql: "SELECT 1" });
	assert.deepEqual(calls, ["execute SELECT 1", "execute SELECT 1"]);
	assert.equal(warnings.length, 1, "the recovered failure is observable once");
	assert.ok(warnings[0] instanceof StorageTransientError);
	assert.deepEqual(
		[(warnings[0] as StorageTransientError).code, (warnings[0] as StorageTransientError).attempts],
		["connection-refused", 1],
	);
});

test("a call that keeps failing transiently gives up typed after every run, with the backoff doubling (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0);
	const { driver, calls, fail } = plannedDriver();
	const failures = Array.from({ length: STORAGE_TRANSIENT_RETRY_ATTEMPTS }, (_, index) =>
		transient("stream-expired", "not-applied", `expired ${index + 1}`),
	);
	fail("exec", ...failures);
	const database = createSqliteDatabase(driver);
	const outcome = database.exec("PRAGMA foreign_keys = ON").then(
		() => assert.fail("the call should fail"),
		(error: unknown) => error,
	);
	await settle();
	// Math.random() = 0 gives the shortest waits: four fifths of 250, 500, 1000 and 2000 ms.
	for (const delay of [200, 400, 800, 1600]) {
		const before = calls.length;
		await vi.advanceTimersByTimeAsync(delay - 1);
		assert.equal(calls.length, before, `no run before ${delay} ms`);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(calls.length, before + 1, `the next run after ${delay} ms`);
	}
	const error = await outcome;
	assert.ok(error instanceof StorageTransientError);
	assert.equal(STORAGE_TRANSIENT_RETRY_ATTEMPTS, 5);
	assert.deepEqual(
		[error.code, error.outcome, error.attempts, error.adapter, error.location],
		["stream-expired", "not-applied", 5, "planned", "planned://database"],
	);
	assert.equal(error.cause, failures[4]);
	assert.equal(calls.length, 5);
	assert.equal(vi.getTimerCount(), 0);
	assert.equal(warnings.length, 1);
});

test("the backoff varies by up to a fifth either way (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.75);
	const { driver, calls, fail } = plannedDriver();
	fail("execute", transient("connection-refused", "not-applied"), transient("connection-refused", "not-applied"));
	const database = createSqliteDatabase(driver);
	const run = database.run("INSERT");
	await settle();
	// Math.random() = 0.75 lengthens each wait by a tenth: 275 ms, then 550 ms.
	await vi.advanceTimersByTimeAsync(274);
	assert.equal(calls.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(calls.length, 2);
	await vi.advanceTimersByTimeAsync(549);
	assert.equal(calls.length, 2);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(await run, { changes: 1 });
	assert.equal(calls.length, 3);
});

test("a statement whose outcome is unknown fails typed at once and never runs again (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("execute", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	await assert.rejects(database.run("INSERT INTO events VALUES (1)"), (error: unknown) => {
		assert.ok(error instanceof StorageTransientError);
		assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "unknown", 1]);
		return true;
	});
	assert.deepEqual(calls, ["execute INSERT INTO events VALUES (1)"]);
	assert.equal(vi.getTimerCount(), 0);
	assert.equal(warnings.length, 0);
});

test("a failure the driver does not recognize stays a plain StorageUnavailableError and never runs again (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	const failure = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
	fail("execute", failure);
	const database = createSqliteDatabase(driver);
	await assert.rejects(database.run("INSERT"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error instanceof StorageTransientError, false);
		assert.equal(error.cause, failure);
		assert.equal(isRetryableStorageError(error), false);
		return true;
	});
	assert.deepEqual(calls, ["execute INSERT"]);
});

test("a driver without a classifier fails as before, without retries (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("execute", transient("connection-refused", "not-applied"));
	const plain: SqliteDriver = { ...driver, transientFailure: undefined };
	await assert.rejects(createSqliteDatabase(plain).run("INSERT"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error instanceof StorageTransientError, false);
		return true;
	});
	assert.equal(calls.length, 1);
});

test("the classifier reads the driver's own failure, while the error keeps only a redacted cause (#4383)", async () => {
	const { driver, classified, fail } = plannedDriver((text) => text.replaceAll("s3cret", "[redacted]"));
	fail("execute", transient("connection-lost", "unknown", "fetch https://user:s3cret@db failed"));
	const database = createSqliteDatabase(driver);
	await assert.rejects(database.get("SELECT 1"), (error: unknown) => {
		assert.ok(error instanceof StorageTransientError);
		assert.equal((error.cause as Error).message, "fetch https://user:[redacted]@db failed");
		return true;
	});
	assert.deepEqual(classified, ["fetch https://user:s3cret@db failed"]);
});

test("a failure inside an open transaction applied nothing; only a commit keeps the request's outcome (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("tx", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO events VALUES (1)")),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "not-applied", 1]);
			return true;
		},
	);
	fail("begin", transient("connection-lost", "unknown"));
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO events VALUES (2)")),
		(error: unknown) => error instanceof StorageTransientError && error.outcome === "not-applied",
	);
	fail("commit", transient("connection-lost", "unknown"));
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO events VALUES (3)")),
		(error: unknown) => error instanceof StorageTransientError && error.outcome === "unknown",
	);
	assert.deepEqual(calls, [
		"begin",
		"tx INSERT INTO events VALUES (1)",
		"rollback",
		"tx close",
		"begin",
		"begin",
		"tx INSERT INTO events VALUES (3)",
		"commit",
		"rollback",
		"tx close",
	]);
});

test("a transaction runs again only when its options allow it (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("tx", transient("stream-expired", "not-applied"));
	const database = createSqliteDatabase(driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			await tx.run("INSERT INTO events VALUES (1)");
		}),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["stream-expired", "not-applied", 1]);
			return true;
		},
	);
	assert.equal(runs, 1);
	assert.deepEqual(calls, ["begin", "tx INSERT INTO events VALUES (1)", "rollback", "tx close"]);

	fail("tx", transient("stream-expired", "not-applied"));
	await assert.rejects(
		database.transaction(
			async (tx) => {
				await tx.run("INSERT INTO events VALUES (2)");
			},
			{ retryTransientFailures: false },
		),
		StorageTransientError,
	);
	assert.equal(calls.filter((call) => call === "begin").length, 2);
	assert.equal(vi.getTimerCount(), 0);
});

test("an allowed transaction that a transient failure ended before its commit runs again and commits once (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	// A statement inside an open transaction commits nothing, whatever the driver says of its request.
	fail("tx", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	let runs = 0;
	const seen: unknown[] = [];
	const committed = database.transaction(
		async (tx) => {
			runs++;
			try {
				return await tx.get<{ sql: string }>("INSERT INTO events VALUES (1) RETURNING seq");
			} catch (error) {
				seen.push(error);
				throw error;
			}
		},
		{ retryTransientFailures: true },
	);
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	assert.deepEqual(await committed, { sql: "INSERT INTO events VALUES (1) RETURNING seq" });
	assert.equal(runs, 2);
	assert.ok(seen[0] instanceof StorageTransientError);
	assert.deepEqual([seen[0].outcome, seen[0].attempts], ["not-applied", 1]);
	assert.deepEqual(calls, [
		"begin",
		"tx INSERT INTO events VALUES (1) RETURNING seq",
		"rollback",
		"tx close",
		"begin",
		"tx INSERT INTO events VALUES (1) RETURNING seq",
		"commit",
		"tx close",
	]);
});

test("an allowed transaction whose begin or commit applied nothing runs again (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	fail("begin", transient("connection-lost", "unknown"));
	fail("commit", transient("transaction-timeout", "not-applied"));
	const database = createSqliteDatabase(driver);
	const committed = database.transaction((tx) => tx.run("UPDATE runs SET status = 'done'"), {
		retryTransientFailures: true,
	});
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	await vi.advanceTimersByTimeAsync(500);
	assert.deepEqual(await committed, { changes: 1 });
	assert.deepEqual(calls, [
		"begin",
		"begin",
		"tx UPDATE runs SET status = 'done'",
		"commit",
		"rollback",
		"tx close",
		"begin",
		"tx UPDATE runs SET status = 'done'",
		"commit",
		"tx close",
	]);
});

test("a commit whose outcome is unknown is never run again (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("commit", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO events VALUES (1)"), { retryTransientFailures: true }),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "unknown", 1]);
			return true;
		},
	);
	assert.deepEqual(calls, ["begin", "tx INSERT INTO events VALUES (1)", "commit", "rollback", "tx close"]);
	assert.equal(vi.getTimerCount(), 0);
});

test("a commit whose outcome is unknown is never run again, even after the callback swallowed a transient failure (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("tx", transient("stream-expired", "not-applied"));
	fail("commit", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(
			async (tx) => {
				runs++;
				await tx.run("SAVEPOINT append").catch(() => undefined);
				await tx.run("INSERT INTO events VALUES (1)");
			},
			{ retryTransientFailures: true },
		),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "unknown", 1]);
			return true;
		},
	);
	assert.equal(runs, 1);
	assert.deepEqual(calls, [
		"begin",
		"tx SAVEPOINT append",
		"tx INSERT INTO events VALUES (1)",
		"commit",
		"rollback",
		"tx close",
	]);
	assert.equal(vi.getTimerCount(), 0);
	assert.equal(warnings.length, 0);
});

test("a commit that fails for a reason the driver does not recognize is never run again, even after a swallowed transient failure (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	const failure = Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" });
	fail("tx", transient("stream-expired", "not-applied"));
	fail("commit", failure);
	const database = createSqliteDatabase(driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(
			async (tx) => {
				runs++;
				await tx.run("SAVEPOINT append").catch(() => undefined);
				await tx.run("INSERT INTO events VALUES (1)");
			},
			{ retryTransientFailures: true },
		),
		(error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error instanceof StorageTransientError, false);
			assert.equal(error.cause, failure);
			assert.equal(isRetryableStorageError(error), false);
			return true;
		},
	);
	assert.equal(runs, 1);
	assert.equal(calls.filter((call) => call === "commit").length, 1);
	assert.equal(vi.getTimerCount(), 0);
});

test("a commit that applied nothing still runs the transaction again after a swallowed transient failure (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	fail("tx", transient("stream-expired", "not-applied"));
	fail("commit", transient("transaction-timeout", "not-applied"));
	const database = createSqliteDatabase(driver);
	let runs = 0;
	const committed = database.transaction(
		async (tx) => {
			runs++;
			await tx.run("SAVEPOINT append").catch(() => undefined);
			await tx.run("INSERT INTO events VALUES (1)");
			return runs;
		},
		{ retryTransientFailures: true },
	);
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	assert.equal(await committed, 2);
	assert.equal(calls.filter((call) => call === "commit").length, 2);
	assert.deepEqual(
		warnings.map((warning) => (warning as StorageTransientError).code),
		["transaction-timeout"],
		"the commit's own failure decides, and is the one reported",
	);
});

test("a transaction whose callback swallowed a transient failure still runs again (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	fail("tx", transient("stream-expired", "not-applied"), transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	let runs = 0;
	const committed = database.transaction(
		async (tx) => {
			runs++;
			await tx.run("SAVEPOINT append").catch(() => undefined);
			await tx.run("ROLLBACK TO append").catch(() => undefined);
			await tx.run("INSERT INTO events VALUES (1)");
			if (runs === 1) throw new Error("the transaction is closed");
			return runs;
		},
		{ retryTransientFailures: true },
	);
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	assert.equal(await committed, 2);
	assert.equal(calls.filter((call) => call === "commit").length, 1);
	assert.deepEqual(
		warnings.map((warning) => (warning as StorageTransientError).code),
		["stream-expired"],
		"the first transient failure of the run is the one recorded",
	);
});

test("a committed transaction never runs again, even when a later cleanup fails (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("tx", transient("stream-expired", "not-applied"));
	const closeFailure = new Error("release failed");
	fail("tx close", closeFailure);
	const database = createSqliteDatabase(driver);
	await assert.rejects(
		database.transaction(
			async (tx) => {
				await tx.run("SAVEPOINT append").catch(() => undefined);
				await tx.run("INSERT INTO events VALUES (1)");
			},
			{ retryTransientFailures: true },
		),
		(error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error instanceof StorageTransientError, false);
			assert.equal(error.cause, closeFailure);
			return true;
		},
	);
	assert.deepEqual(calls, ["begin", "tx SAVEPOINT append", "tx INSERT INTO events VALUES (1)", "commit", "tx close"]);
	assert.equal(vi.getTimerCount(), 0);
});

test("a failed rollback after a lasting failure is reported, not taken as a reason to run again (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("rollback", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	const failure = new Error("payload rejected");
	await assert.rejects(
		database.transaction(
			async () => {
				throw failure;
			},
			{ retryTransientFailures: true },
		),
		(error: unknown) => {
			assert.ok(error instanceof StorageRollbackError);
			assert.equal(error.cause, failure);
			assert.ok(error.rollbackCause instanceof StorageUnavailableError);
			assert.equal(error.rollbackCause instanceof StorageTransientError, false);
			return true;
		},
	);
	assert.deepEqual(calls, ["begin", "rollback", "tx close"]);
	assert.equal(vi.getTimerCount(), 0);
});

test("a transaction option that is not a boolean is rejected before anything runs (#4383)", async () => {
	const { driver, calls } = plannedDriver();
	const database = createSqliteDatabase(driver);
	await assert.rejects(
		database.transaction(async () => {}, { retryTransientFailures: "yes" as unknown as boolean }),
		(error: unknown) => {
			assert.ok(error instanceof StorageConfigError);
			assert.deepEqual(
				[error.source, error.field, error.reason, error.hint],
				["sdk", "retryTransientFailures", "boolean-required", "Pass true or false, or omit it"],
			);
			return true;
		},
	);
	assert.deepEqual(calls, []);
});

test("a batch runs again when it applied nothing, and not when its outcome is unknown (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	fail("batch", transient("connection-refused", "not-applied"));
	const database = createSqliteDatabase(driver);
	const statements = [{ sql: "INSERT INTO events VALUES (?)", params: [1] }];
	const retried = database.batch!(statements);
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	assert.deepEqual(await retried, [[{ sql: "INSERT INTO events VALUES (?)" }]]);
	assert.equal(calls.length, 2);

	fail("batch", transient("connection-lost", "unknown"));
	await assert.rejects(database.batch!(statements), (error: unknown) => {
		assert.ok(error instanceof StorageTransientError);
		assert.equal(error.outcome, "unknown");
		return true;
	});
	assert.equal(calls.length, 3);
});

test("calls queued behind a call that runs again keep their order (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const { driver, calls, fail } = plannedDriver();
	fail("execute", transient("connection-refused", "not-applied"));
	const database = createSqliteDatabase(driver);
	const first = database.run("INSERT 1");
	const second = database.run("INSERT 2");
	await settle();
	assert.deepEqual(calls, ["execute INSERT 1"]);
	await vi.advanceTimersByTimeAsync(250);
	await Promise.all([first, second]);
	assert.deepEqual(calls, ["execute INSERT 1", "execute INSERT 1", "execute INSERT 2"]);
});

test("closing the database ends a backoff at once and rejects with the transient failure (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("execute", transient("connection-refused", "not-applied"));
	const database = createSqliteDatabase(driver);
	const pending = database.get("SELECT 1").then(
		() => assert.fail("the call should fail"),
		(error: unknown) => error,
	);
	await settle();
	assert.equal(vi.getTimerCount(), 1);
	const closed = database.close();
	const error = await pending;
	await closed;
	assert.ok(error instanceof StorageTransientError);
	assert.equal(error.attempts, 1);
	assert.deepEqual(calls, ["execute SELECT 1", "close"]);
	assert.equal(vi.getTimerCount(), 0);
	await assert.rejects(database.get("SELECT 1"), StoreClosedError);
});

test("a call that fails while closing begins does not wait for another run (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const database = createSqliteDatabase({
		...driver,
		async execute(sql, params) {
			await held;
			return driver.execute(sql, params);
		},
	});
	fail("execute", transient("connection-refused", "not-applied"));
	const pending = database.get("SELECT 1").then(
		() => assert.fail("the call should fail"),
		(error: unknown) => error,
	);
	await settle();
	const closed = database.close();
	release();
	const error = await pending;
	await closed;
	assert.ok(error instanceof StorageTransientError);
	assert.equal(error.attempts, 1);
	assert.deepEqual(calls, ["execute SELECT 1", "close"]);
	assert.equal(warnings.length, 0);
});

test("each database reports the first failure it recovers from once (#4383)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const first = plannedDriver();
	first.fail("execute", transient("connection-refused", "not-applied"));
	const database = createSqliteDatabase(first.driver);
	const one = database.run("INSERT 1");
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	await one;
	first.fail("execute", transient("stream-expired", "not-applied"));
	const two = database.run("INSERT 2");
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	await two;
	assert.equal(warnings.length, 1);

	const second = plannedDriver();
	second.fail("execute", transient("transaction-timeout", "not-applied"));
	const other = createSqliteDatabase(second.driver);
	const three = other.run("INSERT 3");
	await settle();
	await vi.advanceTimersByTimeAsync(250);
	await three;
	await settle();
	assert.deepEqual(
		warnings.map((warning) => (warning as StorageTransientError).code),
		["connection-refused", "transaction-timeout"],
	);
});
