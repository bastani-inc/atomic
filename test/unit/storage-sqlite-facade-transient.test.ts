import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	isRetryableStorageError,
	type SqliteDriver,
	type SqliteDriverTransientFailure,
	StorageRollbackError,
	StorageTransientError,
	type StorageTransientErrorCode,
	type StorageTransientOutcome,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test } from "vitest";

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

test("a failed rollback after a lasting failure is reported, not taken as a reason to run again (#4383)", async () => {
	const { driver, calls, fail } = plannedDriver();
	fail("rollback", transient("connection-lost", "unknown"));
	const database = createSqliteDatabase(driver);
	const failure = new Error("payload rejected");
	await assert.rejects(
		database.transaction(async () => {
			throw failure;
		}),
		(error: unknown) => {
			assert.ok(error instanceof StorageRollbackError);
			assert.equal(error.cause, failure);
			assert.ok(error.rollbackCause instanceof StorageUnavailableError);
			assert.equal(error.rollbackCause instanceof StorageTransientError, false);
			return true;
		},
	);
	assert.deepEqual(calls, ["begin", "rollback", "tx close"]);
});
