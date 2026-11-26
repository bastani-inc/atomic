import assert from "node:assert/strict";
import {
	createSqliteDatabase,
	type FencedPathId,
	type SqliteDriver,
	type SqliteDriverTransactionOptions,
	type SqliteTransactionOptions,
	StorageTransientError,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { transactionFinisher } from "../../packages/coding-agent/src/core/storage/statement-sequence.js";

const AUDITED = "test-path" as FencedPathId;
const RETRIED: SqliteTransactionOptions = {
	retryTransientFailures: true,
	concurrency: { kind: "serial", domain: "sessions:s1" },
};

class Refused extends Error {}
class Lost extends Error {}

/**
 * A pipelined driver like Postgres's: a statement listed in `failing` fails once its turn comes, and a commit behind a
 * failed statement comes back as a rollback. `gate` holds every answer until `release()`.
 */
function pipelinedDriver(failing: Map<string, () => Error> = new Map()) {
	const events: string[] = [];
	const begun: SqliteDriverTransactionOptions[] = [];
	let gate: Promise<void> = Promise.resolve();
	let open: () => void = () => {};
	const result = { columns: [], rows: [], changes: 1 };
	const driver: SqliteDriver = {
		descriptor: { adapter: "pipelined", location: "pipelined://database" },
		concurrentTransactions: true,
		pipelinedTransactions: true,
		transientFailure: (failure) =>
			failure instanceof Refused
				? { code: "lock-conflict", outcome: "not-applied" }
				: failure instanceof Lost
					? { code: "connection-lost", outcome: "unknown" }
					: undefined,
		execute: () => result,
		executeMultiple: () => {},
		beginTransaction(options) {
			if (options !== undefined) begun.push(options);
			events.push("begin");
			let aborted: Error | undefined;
			return {
				execute: async (sql) => {
					events.push(`tx ${sql}`);
					await gate;
					const failure = failing.get(sql);
					if (failure !== undefined) {
						failing.delete(sql);
						aborted = failure();
						throw aborted;
					}
					if (aborted !== undefined) throw new Error("current transaction is aborted");
					return result;
				},
				executeMultiple: () => {},
				commit: async () => {
					events.push("commit");
					await gate;
					if (aborted instanceof Lost) throw new Lost("connection lost");
					if (aborted !== undefined)
						throw new Error("The transaction was rolled back because a statement in it failed");
				},
				rollback: () => void events.push("rollback"),
			};
		},
		close: () => {},
	};
	return {
		driver,
		events,
		begun,
		hold() {
			gate = new Promise((resolve) => {
				open = resolve;
			});
		},
		release: () => open(),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a transaction's last writes go out with its commit, before any answer (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	pipelined.hold();
	const done = database.transaction(async (tx) => {
		const finish = transactionFinisher(tx);
		assert.ok(finish);
		assert.equal(
			finish([
				{ sql: "insert entry", params: [1] },
				{ sql: "update head", params: [1] },
			]),
			true,
		);
		return "appended";
	}, RETRIED);
	await settle();
	assert.deepEqual(pipelined.events, ["begin", "tx insert entry", "tx update head", "commit"]);
	pipelined.release();
	assert.equal(await done, "appended");
	await database.close();
});

test("a transaction takes no call after its last writes (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	await assert.rejects(
		database.transaction(async (tx) => {
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
			await tx.run("late");
		}),
		(error: Error) => error.name === "StorageTransactionClosedError",
	);
	assert.deepEqual(pipelined.events, ["begin", "tx insert entry", "rollback"]);
	await database.close();
});

test("last writes holding NUL are not sent that way, and the caller writes them as before (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	await database.transaction(async (tx) => {
		assert.equal(
			transactionFinisher(tx)?.([
				{ sql: "insert entry", params: [] },
				{ sql: "bad", params: ["a\0b"] },
			]),
			false,
		);
	});
	assert.deepEqual(pipelined.events, ["begin", "commit"]);
	await database.close();
});

test("a non-pipelined transaction offers no way to send its last writes with its commit (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase({ ...pipelined.driver, pipelinedTransactions: false });
	await database.transaction(async (tx) => assert.equal(transactionFinisher(tx), undefined));
	await database.close();
});

test("a last write the server refused fails the transaction with its own error, and it runs again (#6560)", async () => {
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const pipelined = pipelinedDriver(new Map([["insert entry", () => new Refused("deadlock detected")]]));
		const database = createSqliteDatabase(pipelined.driver);
		let runs = 0;
		const done = await database.transaction(async (tx) => {
			runs++;
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
			return runs;
		}, RETRIED);
		assert.equal(done, 2);
		assert.deepEqual(pipelined.events, [
			"begin",
			"tx insert entry",
			"commit",
			"rollback",
			"begin",
			"tx insert entry",
			"commit",
		]);
		await database.close();
	} finally {
		warn.mockRestore();
	}
});

test("a last write whose connection broke after the commit went out is not run again: it may have committed (#6560)", async () => {
	const pipelined = pipelinedDriver(new Map([["insert entry", () => new Lost("connection lost")]]));
	const database = createSqliteDatabase(pipelined.driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
		}, RETRIED),
		(error: Error & { outcome?: string }) => error.name === "StorageTransientError" && error.outcome === "unknown",
	);
	assert.equal(runs, 1);
	await database.close();
});

test("an unawaited statement the server refused before the commit went out still lets the transaction run again (#6560)", async () => {
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const pipelined = pipelinedDriver(new Map([["update", () => new Refused("could not serialize access")]]));
		const database = createSqliteDatabase(pipelined.driver);
		let runs = 0;
		const done = await database.transaction(async (tx) => {
			runs++;
			void tx.run("update").catch(() => {});
			// Its failure arrives before the callback returns and the commit is sent.
			await tx.get("read").catch(() => undefined);
			return runs;
		}, RETRIED);
		assert.equal(done, 2);
		await database.close();
	} finally {
		warn.mockRestore();
	}
});

test("a commit that came back as a rollback fails with the statement that failed, not a reasonless rollback (#6560)", async () => {
	const pipelined = pipelinedDriver(new Map([["insert entry", () => new Error("duplicate key value")]]));
	const database = createSqliteDatabase(pipelined.driver);
	await assert.rejects(
		database.transaction(async (tx) => {
			transactionFinisher(tx)?.([{ sql: "insert entry", params: [] }]);
		}),
		(error: Error) => (error.cause as Error | undefined)?.message === "duplicate key value",
	);
	await database.close();
});

test("a pipelined driver is told a transaction's leading reads, snapshotted and up to one holding NUL (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	const bytes = new Uint8Array([1, 2]);
	const leading = [
		{ sql: "SELECT schema_version FROM meta", params: [] },
		{ sql: "SELECT last_seq FROM sessions WHERE id = ?", params: ["s1", bytes] },
		{ sql: "bad", params: ["a\0b"] },
		{ sql: "after", params: [] },
	];
	await database.transaction(async () => {}, { ...RETRIED, leading });
	bytes[0] = 9;
	assert.deepEqual(
		pipelined.begun.map((begin) => begin.leading),
		[
			[
				{ sql: "SELECT schema_version FROM meta", params: [] },
				{ sql: "SELECT last_seq FROM sessions WHERE id = ?", params: ["s1", new Uint8Array([1, 2])] },
			],
		],
	);
	const serial = pipelinedDriver();
	const unpipelined = createSqliteDatabase({ ...serial.driver, pipelinedTransactions: false });
	await unpipelined.transaction(async () => {}, { concurrency: { kind: "fenced", audit: AUDITED }, leading });
	assert.equal(serial.begun[0]?.leading, undefined);
	await Promise.all([database.close(), unpipelined.close()]);
});

test("a read-only transaction answers once its reads are answered, before its commit is, and closing waits for it (#6560)", async () => {
	const pipelined = pipelinedDriver();
	const database = createSqliteDatabase(pipelined.driver);
	let committed = false;
	const commitGate = Promise.withResolvers<void>();
	const begin = pipelined.driver.beginTransaction.bind(pipelined.driver);
	pipelined.driver.beginTransaction = async (options) => {
		const transaction = await begin(options);
		return {
			...transaction,
			commit: async () => {
				await commitGate.promise;
				committed = true;
			},
		};
	};
	const rows = await database.transaction(async (tx) => tx.all("SELECT entries"), { readOnly: true });
	assert.deepEqual(rows, []);
	assert.equal(committed, false);
	const closed = database.close();
	await settle();
	assert.equal(committed, false);
	commitGate.resolve();
	await closed;
	assert.equal(committed, true);
});

test("a read-only transaction waits for its commit where transactions share the connection (#6560)", async () => {
	const pipelined = pipelinedDriver();
	let committed = false;
	const database = createSqliteDatabase({
		...pipelined.driver,
		concurrentTransactions: false,
		pipelinedTransactions: false,
		async beginTransaction(options) {
			const transaction = await pipelined.driver.beginTransaction(options);
			return {
				...transaction,
				commit: async () => {
					await settle();
					committed = true;
				},
			};
		},
	});
	await database.transaction(async (tx) => tx.all("SELECT entries"), { readOnly: true });
	assert.equal(committed, true);
	await database.close();
});

test("a savepoint-recovered transient failure never replaces an ambiguous or unrecognized commit failure (#6711)", async () => {
	const makeDriver = (commitFailure: () => Error) => {
		const driver: SqliteDriver = {
			descriptor: { adapter: "pipelined", location: "pipelined://database" },
			concurrentTransactions: true,
			pipelinedTransactions: true,
			transientFailure: (failure) =>
				failure instanceof Refused
					? { code: "lock-conflict", outcome: "not-applied" }
					: failure instanceof Lost
						? { code: "connection-lost", outcome: "unknown" }
						: undefined,
			execute: () => ({ columns: [], rows: [], changes: 1 }),
			executeMultiple: () => {},
			beginTransaction() {
				let failed = false;
				return {
					execute: async (sql) => {
						if (sql === "forget search") {
							failed = true;
							throw new Refused("lock timeout");
						}
						if (failed) throw new Error("current transaction is aborted");
						return { columns: [], rows: [], changes: 1 };
					},
					executeMultiple: async (sql) => {
						if (/ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO/i.test(sql)) {
							failed = false;
							return;
						}
						if (failed) throw new Error("current transaction is aborted");
					},
					commit: async () => {
						throw commitFailure();
					},
					rollback: () => {},
				};
			},
			close: () => {},
		};
		return driver;
	};

	let runs = 0;
	const droppedDb = createSqliteDatabase(makeDriver(() => new Lost("connection dropped after COMMIT")));
	await assert.rejects(
		droppedDb.transaction(async (tx) => {
			runs++;
			await tx.exec("/* setup */ SAVEPOINT sp_forget");
			await tx.run("forget search").catch(() => undefined);
			await tx.exec("ROLLBACK TRANSACTION TO SAVEPOINT sp_forget; RELEASE SAVEPOINT sp_forget");
			await tx.run("delete session");
		}, RETRIED),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome], ["connection-lost", "unknown"]);
			return true;
		},
	);
	assert.equal(runs, 1);

	let unrecognizedRuns = 0;
	const timeoutError = Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" });
	const unrecognizedDb = createSqliteDatabase(makeDriver(() => timeoutError));
	await assert.rejects(
		unrecognizedDb.transaction(async (tx) => {
			unrecognizedRuns++;
			await tx.exec('SAVEPOINT "Sp_1"');
			await tx.run("forget search").catch(() => undefined);
			await tx.exec('ROLLBACK TO "Sp_1"');
			await tx.exec('RELEASE "Sp_1"');
		}, RETRIED),
		(error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error instanceof StorageTransientError, false);
			assert.equal(error.cause, timeoutError);
			return true;
		},
	);
	assert.equal(unrecognizedRuns, 1);
	await Promise.all([droppedDb.close(), unrecognizedDb.close()]);
});

test("multi-statement SAVEPOINT failure and nested aborted SAVEPOINT recover cleanly without hiding real errors or faking recovery from string literals (#6711)", async () => {
	let runs = 0;
	const driver: SqliteDriver = {
		descriptor: { adapter: "pipelined", location: "pipelined://database" },
		concurrentTransactions: true,
		pipelinedTransactions: true,
		transientFailure: (failure) =>
			failure instanceof Refused ? { code: "lock-conflict", outcome: "not-applied" } : undefined,
		execute: () => ({ columns: [], rows: [], changes: 1 }),
		executeMultiple: () => {},
		beginTransaction() {
			let aborted: Error | undefined;
			return {
				execute: async (sql) => {
					if (sql === "insert literal") return { columns: [], rows: [], changes: 1 };
					if (sql === "dup key") {
						aborted = new Error("duplicate key value");
						throw aborted;
					}
					if (aborted !== undefined) throw new Error("current transaction is aborted");
					return { columns: [], rows: [], changes: 1 };
				},
				executeMultiple: async (sql) => {
					if (sql === "SAVEPOINT sp; SET LOCAL lock_timeout = 100") {
						aborted = new Refused("lock timeout on setup");
						throw aborted;
					}
					if (sql === "ROLLBACK TO SAVEPOINT sp") {
						aborted = undefined;
						return;
					}
					if (aborted !== undefined) throw new Error("current transaction is aborted");
				},
				commit: async () => {
					if (aborted !== undefined)
						throw new Error("The transaction was rolled back because a statement in it failed");
				},
				rollback: () => {},
			};
		},
		close: () => {},
	};
	const database = createSqliteDatabase(driver);
	// Multi-statement SAVEPOINT fails, nested SAVEPOINT fails with aborted, ROLLBACK TO recovers both,
	// then a later finish write hits duplicate key -> must report duplicate key and not retry.
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			await tx.exec("SAVEPOINT sp; SET LOCAL lock_timeout = 100").catch(() => undefined);
			await tx.exec("SAVEPOINT sp").catch(() => undefined);
			await tx.exec("ROLLBACK TO SAVEPOINT sp");
			await tx.exec("RELEASE SAVEPOINT sp");
			transactionFinisher(tx)?.([{ sql: "dup key", params: [] }]);
		}, RETRIED),
		(error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error instanceof StorageTransientError, false);
			assert.equal((error.cause as Error).message, "duplicate key value");
			return true;
		},
	);
	assert.equal(runs, 1);

	// A string literal containing `ROLLBACK TO SAVEPOINT sp` must NOT count as recovering an earlier failure.
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const literalDriver = pipelinedDriver(new Map([["first", () => new Refused("deadlock")]]));
		const literalDb = createSqliteDatabase(literalDriver.driver);
		let literalRuns = 0;
		const finishedRun = await literalDb.transaction(async (tx) => {
			literalRuns++;
			await tx.exec("SAVEPOINT sp");
			void tx.run("first").catch(() => {});
			void tx.run("SELECT 'ROLLBACK TO SAVEPOINT sp'").catch(() => {});
			return literalRuns;
		}, RETRIED);
		assert.equal(finishedRun, 2);
		await literalDb.close();
	} finally {
		warn.mockRestore();
	}
	await database.close();
});

test("a finish statement failing with not-applied cannot override a commit failing with unknown (#6711)", async () => {
	const driver: SqliteDriver = {
		descriptor: { adapter: "pipelined", location: "pipelined://database" },
		concurrentTransactions: true,
		pipelinedTransactions: true,
		transientFailure: (failure) =>
			failure instanceof Refused
				? { code: "lock-conflict", outcome: "not-applied" }
				: failure instanceof Lost
					? { code: "connection-lost", outcome: "unknown" }
					: undefined,
		execute: () => ({ columns: [], rows: [], changes: 1 }),
		executeMultiple: () => {},
		beginTransaction() {
			return {
				execute: async () => {
					throw new Refused("deadlock");
				},
				executeMultiple: () => {},
				commit: async () => {
					// Settle after the finish statement's Refused rejection already ran.
					await settle();
					throw new Lost("connection lost on commit");
				},
				rollback: () => {},
			};
		},
		close: () => {},
	};
	const database = createSqliteDatabase(driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			transactionFinisher(tx)?.([{ sql: "write", params: [] }]);
		}, RETRIED),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome], ["connection-lost", "unknown"]);
			return true;
		},
	);
	assert.equal(runs, 1);
	await database.close();
});

test("a savepoint-recovered transient failure does not trigger retries when the callback later fails permanently (#6711)", async () => {
	const driver: SqliteDriver = {
		descriptor: { adapter: "pipelined", location: "pipelined://database" },
		concurrentTransactions: true,
		pipelinedTransactions: true,
		transientFailure: (failure) =>
			failure instanceof Refused ? { code: "lock-conflict", outcome: "not-applied" } : undefined,
		execute: () => ({ columns: [], rows: [], changes: 1 }),
		executeMultiple: () => {},
		beginTransaction() {
			return {
				execute: async (sql) => {
					if (sql === "forget") throw new Refused("lock timeout");
					if (sql === "write") throw new Error("foreign key violation");
					return { columns: [], rows: [], changes: 1 };
				},
				executeMultiple: () => {},
				commit: () => {},
				rollback: () => {},
			};
		},
		close: () => {},
	};
	const database = createSqliteDatabase(driver);
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			await tx.exec("SAVEPOINT sp");
			await tx.run("forget").catch(() => undefined);
			await tx.exec("ROLLBACK TO SAVEPOINT sp");
			await tx.exec("RELEASE SAVEPOINT sp");
			await tx.run("write");
		}, RETRIED),
		(error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error instanceof StorageTransientError, false);
			assert.equal((error.cause as Error).message, "foreign key violation");
			return true;
		},
	);
	assert.equal(runs, 1);
	await database.close();
});

test("leadingOnly calls onCommit before writing COMMIT so drops after it report unknown while pre-commit failures still retry (#6711)", async () => {
	const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const statement = { sql: "INSERT INTO claims VALUES (?)", params: ["c1"] } as const;

		// 1) Drop inside beginTransaction AFTER onCommit() -> unknown, never retried.
		let beginAttempts = 0;
		const dropAfterOnCommit = createSqliteDatabase({
			descriptor: { adapter: "pipelined", location: "pipelined://database" },
			concurrentTransactions: true,
			pipelinedTransactions: true,
			transientFailure: (failure) =>
				failure instanceof Lost ? { code: "connection-lost", outcome: "unknown" } : undefined,
			execute: () => ({ columns: [], rows: [], changes: 1 }),
			executeMultiple: () => {},
			beginTransaction(options) {
				beginAttempts++;
				options?.onCommit?.();
				throw new Lost("dropped after COMMIT written");
			},
			close: () => {},
		});
		await assert.rejects(
			dropAfterOnCommit.transaction(async (tx) => tx.run(statement.sql, ...statement.params), {
				...RETRIED,
				leading: [statement],
				leadingOnly: true,
			}),
			(error: unknown) => {
				assert.ok(error instanceof StorageTransientError);
				assert.deepEqual([error.code, error.outcome], ["connection-lost", "unknown"]);
				return true;
			},
		);
		assert.equal(beginAttempts, 1);

		// 2) Drop inside beginTransaction BEFORE onCommit() (e.g. connect failure) -> not-applied, retries!
		let connectAttempts = 0;
		const dropBeforeOnCommit = createSqliteDatabase({
			descriptor: { adapter: "pipelined", location: "pipelined://database" },
			concurrentTransactions: true,
			pipelinedTransactions: true,
			transientFailure: (failure) =>
				failure instanceof Lost ? { code: "connection-lost", outcome: "unknown" } : undefined,
			execute: () => ({ columns: [], rows: [], changes: 1 }),
			executeMultiple: () => {},
			beginTransaction(options) {
				connectAttempts++;
				if (connectAttempts === 1) throw new Lost("dropped during connect before COMMIT");
				options?.onCommit?.();
				return {
					execute: () => ({ columns: [], rows: [], changes: 1 }),
					executeMultiple: () => {},
					commit: () => {},
					rollback: () => {},
				};
			},
			close: () => {},
		});
		await dropBeforeOnCommit.transaction(async (tx) => tx.run(statement.sql, ...statement.params), {
			...RETRIED,
			leading: [statement],
			leadingOnly: true,
		});
		assert.equal(connectAttempts, 2);

		// 3) Server Refused (not-applied) on leading statement AFTER onCommit() -> still retries!
		let refusedAttempts = 0;
		const refusedAfterOnCommit = createSqliteDatabase({
			descriptor: { adapter: "pipelined", location: "pipelined://database" },
			concurrentTransactions: true,
			pipelinedTransactions: true,
			transientFailure: (failure) =>
				failure instanceof Refused ? { code: "lock-conflict", outcome: "not-applied" } : undefined,
			execute: () => ({ columns: [], rows: [], changes: 1 }),
			executeMultiple: () => {},
			beginTransaction(options) {
				refusedAttempts++;
				options?.onCommit?.();
				const failThisRun = refusedAttempts === 1;
				return {
					execute: () => {
						if (failThisRun) throw new Refused("lock timeout");
						return { columns: [], rows: [], changes: 1 };
					},
					executeMultiple: () => {},
					commit: () => {},
					rollback: () => {},
				};
			},
			close: () => {},
		});
		await refusedAfterOnCommit.transaction(async (tx) => tx.run(statement.sql, ...statement.params), {
			...RETRIED,
			leading: [statement],
			leadingOnly: true,
		});
		assert.equal(refusedAttempts, 2);

		await Promise.all([dropAfterOnCommit.close(), dropBeforeOnCommit.close(), refusedAfterOnCommit.close()]);
	} finally {
		warn.mockRestore();
	}
});
