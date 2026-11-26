import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
} from "../../packages/coding-agent/src/core/storage/database.js";
import {
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest, LeadAnswer } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import {
	sequenceRunner,
	transactionFinisher,
} from "../../packages/coding-agent/src/core/storage/statement-sequence.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

const REPRO_ROW2_SQL = "SELECT json_extract(v,'$') AS x FROM (SELECT column1 AS v FROM (VALUES('1'),('{')))";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openFile(options?: Parameters<typeof openNodeSqliteDatabase>[1]): Promise<{
	readonly path: string;
	readonly database: SqliteDatabase;
}> {
	const directory = makeTempDirectory("atomic-pipelined-tx-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "pipelined.sqlite");
	const database = await openNodeSqliteDatabase(path, options);
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)");
	return { path, database };
}

function recordRequests(): ConnectionRequest[] {
	const sent: ConnectionRequest[] = [];
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		return send(request);
	});
	cleanups.push(() => interception.restore());
	return sent;
}

async function itemValues(database: SqliteDatabase): Promise<string[]> {
	const rows = await database.all<SqliteRow & { value: string }>("SELECT value FROM items ORDER BY id");
	return rows.map((row) => row.value);
}

test("leading .get() succeeds when row 2 errors under .all() (malformed JSON repro), while .all() still throws (#6706)", async () => {
	const { database } = await openFile();
	const leading: readonly SqliteStatement[] = [{ sql: REPRO_ROW2_SQL, params: [] }];

	// Regular write transaction with leading: `.all()` inside `lead()` fails on row 2,
	// so `.get()` is re-sent on its own and succeeds.
	const sentGet = recordRequests();
	const got = await database.transaction(
		async (tx) => {
			const row = await tx.get<SqliteRow & { x: number }>(REPRO_ROW2_SQL);
			await tx.run("INSERT INTO items (value) VALUES (?)", `x=${row?.x}`);
			return row?.x;
		},
		{ leading },
	);
	assert.equal(got, 1);
	assert.equal(
		sentGet.some((request) => request.kind === "get" && request.sql === REPRO_ROW2_SQL),
		true,
		"the failed leading statement was re-sent on its own as a get request",
	);

	// Same query with leadingOnly: COMMIT was not run because the leading `.all()` failed;
	// `.get()` re-runs on its own and commits normally.
	const gotLeadingOnly = await database.transaction((tx) => tx.get<SqliteRow & { x: number }>(REPRO_ROW2_SQL), {
		leading,
		leadingOnly: true,
	});
	assert.equal(gotLeadingOnly?.x, 1);

	// Calling `.all()` on the same leading statement still throws malformed JSON, matching unbatched execution.
	await assert.rejects(
		database.transaction((tx) => tx.all(REPRO_ROW2_SQL), { leading }),
		/malformed JSON/,
	);
	assert.deepEqual(await itemValues(database), ["x=1"]);
});

test("a failing leading statement is re-sent on its own and fails with the same error as unbatched execution (#6706)", async () => {
	const { database } = await openFile();
	const missing: SqliteStatement = { sql: "SELECT * FROM no_such_table WHERE id = ?", params: [7] };

	const unbatched = await database
		.transaction((tx) => tx.get(missing.sql, ...missing.params))
		.then(
			() => assert.fail("unbatched succeeded"),
			(error: unknown) => error,
		);

	const sent = recordRequests();
	const batched = await database
		.transaction(
			async (tx) => {
				const first = await tx.get<SqliteRow & { n: number }>("SELECT 1 AS n");
				assert.equal(first?.n, 1);
				return tx.get(missing.sql, ...missing.params);
			},
			{ leading: [{ sql: "SELECT 1 AS n", params: [] }, missing] },
		)
		.then(
			() => assert.fail("batched succeeded"),
			(error: unknown) => error,
		);

	assert.equal(
		sent.some((request) => request.kind === "get" && request.sql === missing.sql),
		true,
		"the failing leading statement was re-sent on its own",
	);
	assert.ok(batched instanceof StorageUnavailableError && unbatched instanceof StorageUnavailableError);
	assert.equal(batched.message, unbatched.message);
	assert.equal(
		(batched.cause as { errcode?: number } | undefined)?.errcode,
		(unbatched.cause as { errcode?: number } | undefined)?.errcode,
	);
	// Connection remains usable after rollback.
	await database.transaction((tx) => tx.run("INSERT INTO items (value) VALUES ('after-fail')"));
	assert.deepEqual(await itemValues(database), ["after-fail"]);
});

test("a leading failure that aborts the transaction (RAISE(ROLLBACK)) blocks every later call from running outside a transaction (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE guarded (value TEXT NOT NULL)");
	await database.exec(
		"CREATE TRIGGER abort_tx BEFORE INSERT ON guarded BEGIN SELECT RAISE(ROLLBACK, 'abort whole tx'); END",
	);
	const readFirst: SqliteStatement = { sql: "SELECT 42 AS n", params: [] };
	const aborting: SqliteStatement = { sql: "INSERT INTO guarded (value) VALUES (?)", params: ["boom"] };

	const sent = recordRequests();
	const caughtErrors: unknown[] = [];
	const outcome = await database
		.transaction(
			async (tx) => {
				// First leading statement succeeded before the second aborted the transaction.
				assert.equal((await tx.get<SqliteRow & { n: number }>(readFirst.sql))?.n, 42);
				// Every subsequent call must fail with the aborting error without touching the connection thread.
				for (const call of [
					() => tx.run(aborting.sql, ...aborting.params),
					() => tx.run("INSERT INTO items (value) VALUES ('escaped-run')"),
					() => tx.get("SELECT 1 AS x"),
					() => tx.all("SELECT 1 AS x"),
					() => tx.exec("INSERT INTO items (value) VALUES ('escaped-exec')"),
					() =>
						sequenceRunner(tx)!({
							statements: [{ sql: "INSERT INTO items (value) VALUES ('escaped-seq')", params: [] }],
						}),
				]) {
					try {
						await call();
						assert.fail("call after transaction-aborting leading failure succeeded");
					} catch (error) {
						caughtErrors.push(error);
					}
				}
				assert.equal(
					transactionFinisher(tx)?.([{ sql: "INSERT INTO items (value) VALUES ('escaped-finish')", params: [] }]),
					false,
				);
				// Even if the callback swallows all errors and returns normally, the transaction must still reject.
				return "swallowed";
			},
			{ leading: [readFirst, aborting] },
		)
		.then(
			() => assert.fail("transaction resolved after leading abort"),
			(error: unknown) => error,
		);

	assert.equal(caughtErrors.length, 6);
	for (const error of [outcome, ...caughtErrors]) {
		assert.ok(error instanceof StorageUnavailableError, String(error));
		assert.equal(error instanceof StorageRollbackError, false);
		assert.match(error.message, /abort whole tx/);
	}
	// Only the initial `begin` request hit the connection thread; no statement ran outside a transaction and no ROLLBACK was sent.
	assert.deepEqual(
		sent.map((request) => request.kind),
		["begin"],
	);
	assert.deepEqual(await itemValues(database), []);
	// Next transaction succeeds cleanly.
	await database.transaction((tx) => tx.run("INSERT INTO items (value) VALUES ('recovered')"));
	assert.deepEqual(await itemValues(database), ["recovered"]);
});

test("a leading failure that aborts the transaction via SQLITE_FULL runs nothing outside a transaction (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE blobs (data BLOB NOT NULL)");
	const pageCount = (await database.get<SqliteRow & { page_count: number }>("PRAGMA page_count"))!.page_count;
	await database.exec(`PRAGMA max_page_count = ${pageCount}`);

	const bigInsert: SqliteStatement = {
		sql: "INSERT INTO blobs (data) VALUES (?)",
		params: [new Uint8Array(256 * 1024)],
	};
	const sent = recordRequests();
	const error = await database
		.transaction(
			async (tx) => {
				try {
					await tx.run(bigInsert.sql, ...bigInsert.params);
				} catch {
					// Attempt to write after SQLITE_FULL rolled back the transaction.
					await tx.run("INSERT INTO items (value) VALUES ('must-not-autocommit')");
				}
			},
			{ leading: [bigInsert] },
		)
		.then(
			() => assert.fail("SQLITE_FULL transaction succeeded"),
			(failure: unknown) => failure,
		);

	assert.ok(error instanceof StorageUnavailableError, String(error));
	assert.equal((error.cause as { errcode?: number } | undefined)?.errcode, 13);
	assert.deepEqual(
		sent.map((request) => request.kind),
		["begin"],
		"nothing ran after the SQLITE_FULL leading abort",
	);
	assert.deepEqual(await itemValues(database), []);
});

test("leadingOnly commits in one request with an ordinary COMMIT statement and rejects extra calls (#6706)", async () => {
	const { database } = await openFile();
	const insert: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?) RETURNING id, value", params: ["one"] };
	const read: SqliteStatement = { sql: "SELECT count(*) AS n FROM items", params: [] };
	const sent = recordRequests();

	const result = await database.transaction(
		async (tx) => {
			const inserted = await tx.get<SqliteRow & { id: number; value: string }>(insert.sql, ...insert.params);
			const counted = await tx.get<SqliteRow & { n: number }>(read.sql);
			return { inserted, count: counted?.n };
		},
		{ leading: [insert, read], leadingOnly: true },
	);

	assert.deepEqual(result, { inserted: { id: 1, value: "one" }, count: 1 });
	assert.equal(sent.length, 1, "entire leadingOnly transaction took exactly one connection-thread request");
	assert.equal(sent[0]?.kind, "begin");
	if (sent[0]?.kind === "begin") {
		const commit = sent[0].statements?.at(-1);
		assert.deepEqual(
			commit,
			{ sql: "COMMIT", params: [] },
			"COMMIT is an ordinary prepared statement (no script flag)",
		);
	}

	// Extra statement after leadingOnly fails with StorageTransactionClosedError without sending anything to the thread.
	sent.length = 0;
	const insertTwo: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["two"] };
	await assert.rejects(
		database.transaction(
			async (tx) => {
				await tx.run(insertTwo.sql, ...insertTwo.params);
				await tx.run("INSERT INTO items (value) VALUES (?)", "unexpected");
			},
			{ leading: [insertTwo], leadingOnly: true },
		),
		StorageTransactionClosedError,
	);
	assert.equal(sent.length, 1, "the unexpected extra call was rejected locally without contacting the thread");
	assert.deepEqual(await itemValues(database), ["one", "two"]);
});

test("leadingOnly COMMIT failure that leaves the transaction open (deferred foreign key) rolls back cleanly (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
	await database.exec("CREATE TABLE children (pid INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)");

	const badChild: SqliteStatement = { sql: "INSERT INTO children (pid) VALUES (?)", params: [999] };
	const sent = recordRequests();
	const error = await database
		.transaction((tx) => tx.run(badChild.sql, ...badChild.params), { leading: [badChild], leadingOnly: true })
		.then(
			() => assert.fail("deferred FK violation committed"),
			(failure: unknown) => failure,
		);

	assert.ok(error instanceof StorageUnavailableError, String(error));
	assert.equal(error instanceof StorageRollbackError, false);
	assert.match(error.message, /FOREIGN KEY constraint failed/);
	assert.equal(
		sent.some((request) => request.kind === "exec" && request.sql === "ROLLBACK"),
		true,
		"ROLLBACK ran because SQLite kept the transaction open after deferred FK failure on COMMIT",
	);
	// Next transaction succeeds cleanly (transaction was not left open).
	await database.transaction((tx) => tx.run("INSERT INTO items (value) VALUES ('clean-after-fk')"));
	assert.deepEqual(await itemValues(database), ["clean-after-fk"]);
});

test("leadingOnly COMMIT failure that already closed the transaction does not fail with StorageRollbackError (#6706)", async () => {
	const { database } = await openFile();
	const insert: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["v"] };
	const interception = interceptConnectionRequests(async (request, send) => {
		if (request.kind === "begin" && request.statements !== undefined) {
			await send({ ...request, statements: [insert] });
			await send({ kind: "exec", sql: "ROLLBACK" });
			const answer: LeadAnswer = {
				answers: [{ rows: [], changes: 1 }],
				failure: Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 }),
				open: false,
			};
			return answer;
		}
		return send(request);
	});
	cleanups.push(() => interception.restore());
	const error = await database
		.transaction(
			async (tx) => {
				await tx.run(insert.sql, ...insert.params);
			},
			{ leading: [insert], leadingOnly: true },
		)
		.then(
			() => assert.fail("transaction committed"),
			(failure: unknown) => failure,
		);
	assert.ok(error instanceof StorageUnavailableError, String(error));
	assert.equal(error instanceof StorageRollbackError, false);
	assert.match(error.message, /disk I\/O error/);
	assert.deepEqual(await itemValues(database), []);
});

test("leadingOnly with NUL text in a leading statement does not bundle COMMIT and fails with StorageInvalidTextError (#6706)", async () => {
	const { database } = await openFile();
	const okStmt: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["before-nul"] };
	const badStmt: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["has\0nul"] };
	await assert.rejects(
		database.transaction(
			async (tx) => {
				await tx.run(okStmt.sql, ...okStmt.params);
				await tx.run(badStmt.sql, ...badStmt.params);
			},
			{ leading: [okStmt, badStmt], leadingOnly: true },
		),
		StorageInvalidTextError,
	);
	assert.deepEqual(await itemValues(database), [], "transaction rolled back cleanly");
});

test("finisher whose callback throws sends none of the finisher statements and rolls back earlier writes (#6706)", async () => {
	const { database } = await openFile();
	const sent = recordRequests();
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items (value) VALUES (?)", "pre-finisher");
			assert.equal(
				transactionFinisher(tx)?.([{ sql: "INSERT INTO items (value) VALUES (?)", params: ["finisher-write"] }]),
				true,
			);
			throw new Error("callback aborted");
		}),
		/callback aborted/,
	);
	assert.equal(
		sent.some((request) => request.kind === "sequence"),
		false,
		"finisher sequence was never sent when callback threw",
	);
	assert.deepEqual(await itemValues(database), [], "pre-finisher write was rolled back too");
});

test("finisher statement failure rolls back earlier writes and commits nothing (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE uniq (value TEXT NOT NULL UNIQUE)");
	await database.run("INSERT INTO uniq (value) VALUES ('dup')");
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items (value) VALUES (?)", "pre");
			assert.equal(
				transactionFinisher(tx)?.([
					{ sql: "INSERT INTO items (value) VALUES (?)", params: ["in-finisher-1"] },
					{ sql: "INSERT INTO uniq (value) VALUES (?)", params: ["dup"] },
				]),
				true,
			);
		}),
		StorageUnavailableError,
	);
	assert.deepEqual(await itemValues(database), []);
});

test("transactionFinisher does not re-execute leading writes that already ran with BEGIN (#6706)", async () => {
	const { database } = await openFile();
	const insert: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["once"] };
	await database.transaction(
		async (tx) => {
			if (transactionFinisher(tx)?.([insert]) === true) return;
			await tx.run(insert.sql, ...insert.params);
		},
		{ leading: [insert] },
	);
	assert.deepEqual(await itemValues(database), ["once"]);
});

test("transactionFinisher strips an already-executed leading prefix when a later leading statement failed (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE uniq (value TEXT NOT NULL UNIQUE)");
	await database.run("INSERT INTO uniq (value) VALUES ('taken')");
	const first: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["first"] };
	const failing: SqliteStatement = { sql: "INSERT INTO uniq (value) VALUES (?)", params: ["taken"] };
	const sent = recordRequests();
	await assert.rejects(
		database.transaction(
			async (tx) => {
				if (transactionFinisher(tx)?.([first, failing]) === true) return;
				await tx.run(first.sql, ...first.params);
				await tx.run(failing.sql, ...failing.params);
			},
			{ leading: [first, failing], leadingOnly: true },
		),
		StorageUnavailableError,
	);
	const sequence = sent.find((request) => request.kind === "sequence");
	assert.ok(sequence?.kind === "sequence");
	assert.deepEqual(
		sequence.statements.map((statement) => statement.sql),
		[failing.sql, "COMMIT"],
	);
	assert.deepEqual(await itemValues(database), []);
});

test("post-finish calls fail with StorageTransactionClosedError without reaching the connection (#6706)", async () => {
	const { database } = await openFile();
	const sent = recordRequests();
	await assert.rejects(
		database.transaction(async (tx) => {
			assert.equal(
				transactionFinisher(tx)?.([{ sql: "INSERT INTO items (value) VALUES (?)", params: ["x"] }]),
				true,
			);
			await tx.run("INSERT INTO items (value) VALUES (?)", "late");
		}),
		StorageTransactionClosedError,
	);
	assert.equal(
		sent.some((request) => request.kind === "run" || request.kind === "sequence"),
		false,
		"neither the finisher nor the late call was sent when the callback failed",
	);
	assert.deepEqual(await itemValues(database), []);
});

test("led first group-commit member failing (with savepoint bundled in BEGIN) rolls back only its savepoint while later members commit in the same transaction (#6706)", async () => {
	const { database } = await openFile();
	const gate = Promise.withResolvers<void>();
	let held = false;
	const sent: ConnectionRequest[] = [];
	const interception = interceptConnectionRequests(async (request, send) => {
		sent.push(request);
		if (!held && request.kind === "get") {
			held = true;
			await gate.promise;
		}
		return send(request);
	});
	cleanups.push(() => {
		gate.resolve();
		interception.restore();
	});

	const blocker = database.get("SELECT 1 AS blocker");
	const m1Write: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["m1-rolled-back"] };
	const m1 = database.transaction(
		async (tx) => {
			await tx.run(m1Write.sql, ...m1Write.params);
			throw new Error("m1 failed");
		},
		{ leading: [m1Write] },
	);
	const m2 = database.transaction(
		async (tx) => {
			const row = await tx.get<SqliteRow & { x: number }>(REPRO_ROW2_SQL);
			assert.equal(row?.x, 1);
			await tx.run("INSERT INTO items (value) VALUES (?)", "m2-ok");
			return "m2";
		},
		{ leading: [{ sql: REPRO_ROW2_SQL, params: [] }] },
	);
	const m3 = database.transaction(async (tx) => {
		assert.equal(
			transactionFinisher(tx)?.([{ sql: "INSERT INTO items (value) VALUES (?)", params: ["m3-threw"] }]),
			true,
		);
		throw new Error("m3 finisher callback threw");
	});
	const m4 = database.transaction(async (tx) => {
		await tx.run("INSERT INTO items (value) VALUES (?)", "m4-ok");
		return "m4";
	});
	gate.resolve();
	await blocker;

	const outcomes = await Promise.allSettled([m1, m2, m3, m4]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["rejected", "fulfilled", "rejected", "fulfilled"],
	);
	assert.equal(
		sent.filter((request) => request.kind === "begin").length,
		1,
		"all four members shared a single BEGIN IMMEDIATE despite member 1 failing",
	);
	assert.deepEqual(await itemValues(database), ["m2-ok", "m4-ok"]);
});

test("led first group-commit member failing when member 2 was absorbed after BEGIN (no savepoint) rolls back cleanly and member 2 commits in a fresh transaction (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE guarded (value TEXT NOT NULL)");
	await database.exec(
		"CREATE TRIGGER abort_tx BEFORE INSERT ON guarded BEGIN SELECT RAISE(ROLLBACK, 'led abort'); END",
	);

	// Subcase A: callback throws after leading write; Subcase B: leading statement aborts whole transaction.
	for (const kind of ["throw", "leading-abort"] as const) {
		const beginStarted = Promise.withResolvers<void>();
		const allowBegin = Promise.withResolvers<void>();
		let intercepted = false;
		const interception = interceptConnectionRequests(async (request, send) => {
			if (!intercepted && request.kind === "begin") {
				intercepted = true;
				beginStarted.resolve();
				await allowBegin.promise;
			}
			return send(request);
		});

		try {
			const leadStmt: SqliteStatement =
				kind === "throw"
					? { sql: "INSERT INTO items (value) VALUES (?)", params: [`first-${kind}`] }
					: { sql: "INSERT INTO guarded (value) VALUES (?)", params: ["boom"] };
			const first = database.transaction(
				async (tx) => {
					await tx.run(leadStmt.sql, ...leadStmt.params);
					throw new Error("first failed");
				},
				{ leading: [leadStmt] },
			);
			await beginStarted.promise;
			const second = database.transaction(async (tx) => {
				await tx.run("INSERT INTO items (value) VALUES (?)", `second-${kind}`);
				return kind;
			});
			allowBegin.resolve();

			const [r1, r2] = await Promise.allSettled([first, second]);
			assert.equal(r1.status, "rejected");
			assert.equal(r2.status, "fulfilled");
			assert.equal((r2 as PromiseFulfilledResult<string>).value, kind);
		} finally {
			allowBegin.resolve();
			interception.restore();
		}
	}
	assert.deepEqual(await itemValues(database), ["second-throw", "second-leading-abort"]);
});

test("a led first group-commit member that swallows a transaction-aborting error never lets the next member run outside a transaction (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE uniq (value TEXT NOT NULL UNIQUE)");
	await database.run("INSERT INTO uniq (value) VALUES ('taken')");
	const beginStarted = Promise.withResolvers<void>();
	const allowBegin = Promise.withResolvers<void>();
	let intercepted = false;
	const interception = interceptConnectionRequests(async (request, send) => {
		if (!intercepted && request.kind === "begin") {
			intercepted = true;
			beginStarted.resolve();
			await allowBegin.promise;
		}
		return send(request);
	});
	cleanups.push(() => {
		allowBegin.resolve();
		interception.restore();
	});

	const first = database.transaction(
		async (tx) => {
			await tx.get("SELECT 1 AS ok");
			await tx.run("INSERT INTO items (value) VALUES ('from-first')");
			try {
				await tx.run("INSERT OR ROLLBACK INTO uniq (value) VALUES ('taken')");
			} catch {
				// Swallow the error and return normally.
			}
			return "swallowed";
		},
		{ leading: [{ sql: "SELECT 1 AS ok", params: [] }] },
	);
	await beginStarted.promise;
	const second = database.transaction(async (tx) => {
		await tx.run("INSERT INTO items (value) VALUES ('from-second')");
		return "second-ok";
	});
	allowBegin.resolve();

	const [r1, r2] = await Promise.allSettled([first, second]);
	assert.equal(r1.status, "rejected", "the member whose transaction aborted must not resolve");
	assert.equal(r2.status, "fulfilled", "the following member must run in a fresh transaction and commit");
	assert.equal((r2 as PromiseFulfilledResult<string>).value, "second-ok");
	assert.deepEqual(await itemValues(database), ["from-second"]);
});

test("group-commit members bundle their SAVEPOINT with their leading statements in one request (#6706)", async () => {
	const { database } = await openFile();
	const gate = Promise.withResolvers<void>();
	let held = false;
	const sent: ConnectionRequest[] = [];
	const interception = interceptConnectionRequests(async (request, send) => {
		sent.push(request);
		if (!held && request.kind === "get") {
			held = true;
			await gate.promise;
		}
		return send(request);
	});
	cleanups.push(() => {
		gate.resolve();
		interception.restore();
	});

	const blocker = database.get("SELECT 1 AS blocker");
	const read1: SqliteStatement = { sql: "SELECT count(*) AS n FROM items WHERE value = ?", params: ["a"] };
	const read2: SqliteStatement = { sql: "SELECT count(*) AS n FROM items WHERE value = ?", params: ["b"] };
	const tx1 = database.transaction(
		async (tx) => {
			const row = await tx.get<{ n: number }>(read1.sql, ...read1.params);
			const write: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["a"] };
			if (transactionFinisher(tx)?.([write]) !== true) await tx.run(write.sql, ...write.params);
			return row?.n;
		},
		{ leading: [read1] },
	);
	const tx2 = database.transaction(
		async (tx) => {
			const row = await tx.get<{ n: number }>(read2.sql, ...read2.params);
			const write: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["b"] };
			if (transactionFinisher(tx)?.([write]) !== true) await tx.run(write.sql, ...write.params);
			return row?.n;
		},
		{ leading: [read2] },
	);
	gate.resolve();
	await blocker;
	assert.deepEqual(await Promise.all([tx1, tx2]), [0, 0]);
	const afterBlocker = sent.slice(1);
	assert.deepEqual(
		afterBlocker.map((request) => request.kind),
		["begin", "sequence", "lead", "sequence", "exec"],
	);
	assert.equal(
		afterBlocker[0]?.kind === "begin" ? afterBlocker[0].statements?.[0]?.sql : undefined,
		"SAVEPOINT atomic_group_0",
	);
	assert.equal(
		afterBlocker[2]?.kind === "lead" ? afterBlocker[2].statements[0]?.sql : undefined,
		"SAVEPOINT atomic_group_1",
	);
	assert.equal(afterBlocker[4]?.kind === "exec" ? afterBlocker[4].sql : undefined, "COMMIT");
	assert.deepEqual(await itemValues(database), ["a", "b"]);
});

test("group-commit member 2 leading abort abandons earlier members cleanly and commits later members in order (#6706)", async () => {
	const { database } = await openFile();
	await database.exec("CREATE TABLE guarded (value TEXT NOT NULL)");
	await database.exec(
		"CREATE TRIGGER abort_m2 BEFORE INSERT ON guarded BEGIN SELECT RAISE(ROLLBACK, 'm2 led abort'); END",
	);
	const gate = Promise.withResolvers<void>();
	let held = false;
	const interception = interceptConnectionRequests(async (request, send) => {
		if (!held && request.kind === "get") {
			held = true;
			await gate.promise;
		}
		return send(request);
	});
	cleanups.push(() => {
		gate.resolve();
		interception.restore();
	});

	const blocker = database.get("SELECT 1 AS blocker");
	const m1 = database.transaction((tx) => tx.run("INSERT INTO items (value) VALUES ('m1')"));
	const m2 = database.transaction((tx) => tx.run("INSERT INTO guarded (value) VALUES (?)", "boom"), {
		leading: [{ sql: "INSERT INTO guarded (value) VALUES (?)", params: ["boom"] }],
	});
	const m3 = database.transaction((tx) => tx.run("INSERT INTO items (value) VALUES ('m3')"));
	gate.resolve();
	await blocker;

	const outcomes = await Promise.allSettled([m1, m2, m3]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["rejected", "rejected", "fulfilled"],
	);
	assert.deepEqual(await itemValues(database), ["m3"]);
});

test("older connection thread compatibility: begin ignoring statements and no tx field falls back cleanly (#6706)", async () => {
	const { database } = await openFile();
	const sent: ConnectionRequest[] = [];
	// Simulate an older connection thread: `begin` ignores `request.statements` and returns `undefined`,
	// and `inTransaction` is `undefined` (thread never sent `tx`).
	const interception = interceptConnectionRequests((request, send, connection) => {
		sent.push(request);
		Object.defineProperty(connection, "inTransaction", { value: undefined, configurable: true });
		if (request.kind === "begin") {
			const { statements: _ignored, ...legacyBegin } = request;
			return send(legacyBegin);
		}
		return send(request);
	});
	cleanups.push(() => interception.restore());

	const insertOne: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["legacy-lead-only"] };
	await database.transaction((tx) => tx.run(insertOne.sql, ...insertOne.params), {
		leading: [insertOne],
		leadingOnly: true,
	});

	const read: SqliteStatement = { sql: "SELECT count(*) AS n FROM items", params: [] };
	await Promise.all([
		database.transaction(
			async (tx) => {
				await tx.get(read.sql);
				const write: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["legacy-g1"] };
				if (transactionFinisher(tx)?.([write]) !== true) await tx.run(write.sql, ...write.params);
			},
			{ leading: [read] },
		),
		database.transaction(
			async (tx) => {
				await tx.get(read.sql);
				const write: SqliteStatement = { sql: "INSERT INTO items (value) VALUES (?)", params: ["legacy-g2"] };
				if (transactionFinisher(tx)?.([write]) !== true) await tx.run(write.sql, ...write.params);
			},
			{ leading: [read] },
		),
	]);

	assert.equal(
		sent.some((request) => request.kind === "lead"),
		false,
		"older connection threads are never sent `{ kind: 'lead' }`",
	);
	const scriptCommits = sent.flatMap((request) =>
		request.kind === "sequence"
			? request.statements.filter((statement) => statement.script === true && statement.sql === "COMMIT")
			: [],
	);
	assert.deepEqual(scriptCommits, [], "COMMIT in sequence never uses script: true");
	assert.deepEqual(await itemValues(database), ["legacy-lead-only", "legacy-g1", "legacy-g2"]);
});

/** Deterministic LCG so differential equivalence runs are reproducible. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

interface WorkloadStep {
	readonly kind:
		| "lead-read-finisher-write"
		| "leading-only-write"
		| "leading-diverged"
		| "leading-row2-get"
		| "leading-row2-all"
		| "leading-stmt-fail"
		| "finisher-throw"
		| "finisher-constraint-fail"
		| "binary-roundtrip"
		| "nul-param";
	readonly key: string;
	readonly payload: string;
}

async function runWorkload(database: SqliteDatabase, batched: boolean, steps: readonly WorkloadStep[]) {
	await database.exec(`
		CREATE TABLE kv (
			k TEXT PRIMARY KEY,
			v TEXT NOT NULL,
			b BLOB
		);
		CREATE TABLE audit (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			k TEXT NOT NULL,
			note TEXT NOT NULL
		);
	`);
	const normalizeOutcome = (outcome: PromiseSettledResult<unknown>) =>
		outcome.status === "fulfilled"
			? { status: "ok", value: outcome.value }
			: {
					status: "err",
					name: outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason,
					errcode:
						outcome.reason instanceof StorageUnavailableError
							? (outcome.reason.cause as { errcode?: number } | undefined)?.errcode
							: undefined,
				};

	const runOne = (step: WorkloadStep): Promise<unknown> => {
		const opts = (options: SqliteTransactionOptions): SqliteTransactionOptions | undefined =>
			batched ? options : undefined;
		const finishOrRun = async (tx: SqliteExecutor, statements: readonly SqliteStatement[]) => {
			if (batched && transactionFinisher(tx)?.(statements) === true) return;
			for (const statement of statements) await tx.run(statement.sql, ...statement.params);
		};
		switch (step.kind) {
			case "lead-read-finisher-write": {
				const read: SqliteStatement = { sql: "SELECT v FROM kv WHERE k = ?", params: [step.key] };
				return database.transaction(
					async (tx) => {
						const existing = await tx.get<SqliteRow & { v: string }>(read.sql, ...read.params);
						const next = existing === undefined ? step.payload : `${existing.v}+${step.payload}`;
						await finishOrRun(tx, [
							{ sql: "INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", params: [step.key, next] },
							{ sql: "INSERT INTO audit (k, note) VALUES (?, ?)", params: [step.key, next] },
						]);
						return next;
					},
					opts({ leading: [read] }),
				);
			}
			case "leading-only-write": {
				const write: SqliteStatement = {
					sql: "INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?) RETURNING k, v",
					params: [step.key, step.payload],
				};
				return database.transaction(
					(tx) => tx.get(write.sql, ...write.params),
					opts({ leading: [write], leadingOnly: true }),
				);
			}
			case "leading-diverged": {
				const read1: SqliteStatement = { sql: "SELECT count(*) AS n FROM kv", params: [] };
				const read2: SqliteStatement = { sql: "SELECT v FROM kv WHERE k = ?", params: ["other"] };
				return database.transaction(
					async (tx) => {
						const count = await tx.get<SqliteRow & { n: number }>(read1.sql);
						// Diverges from read2 on purpose.
						const row = await tx.get<SqliteRow & { v: string }>("SELECT v FROM kv WHERE k = ?", step.key);
						await finishOrRun(tx, [
							{
								sql: "INSERT INTO audit (k, note) VALUES (?, ?)",
								params: [step.key, `${count?.n}:${row?.v ?? "none"}`],
							},
						]);
						return { count: count?.n, prev: row?.v ?? null };
					},
					opts({ leading: [read1, read2] }),
				);
			}
			case "leading-row2-get": {
				const read: SqliteStatement = { sql: REPRO_ROW2_SQL, params: [] };
				return database.transaction(
					async (tx) => {
						const row = await tx.get<SqliteRow & { x: number }>(read.sql);
						await finishOrRun(tx, [
							{ sql: "INSERT INTO audit (k, note) VALUES (?, ?)", params: [step.key, `row2:${row?.x}`] },
						]);
						return row?.x;
					},
					opts({ leading: [read] }),
				);
			}
			case "leading-row2-all": {
				const read: SqliteStatement = { sql: REPRO_ROW2_SQL, params: [] };
				return database.transaction((tx) => tx.all(read.sql), opts({ leading: [read] }));
			}
			case "leading-stmt-fail": {
				const bad: SqliteStatement = { sql: "SELECT * FROM absent_table WHERE k = ?", params: [step.key] };
				return database.transaction((tx) => tx.get(bad.sql, ...bad.params), opts({ leading: [bad] }));
			}
			case "finisher-throw": {
				return database.transaction(async (tx) => {
					await tx.run("INSERT INTO audit (k, note) VALUES (?, ?)", step.key, "should-rollback");
					if (batched) {
						transactionFinisher(tx)?.([
							{ sql: "INSERT INTO kv (k, v) VALUES (?, ?)", params: [step.key, "never"] },
						]);
					}
					throw new Error("caller-threw");
				});
			}
			case "finisher-constraint-fail": {
				const read: SqliteStatement = { sql: "SELECT count(*) AS n FROM kv", params: [] };
				return database.transaction(
					async (tx) => {
						await tx.get(read.sql);
						await finishOrRun(tx, [
							{ sql: "INSERT INTO audit (k, note) VALUES (?, ?)", params: [step.key, "rolled-back"] },
							{ sql: "INSERT INTO kv (k, v) VALUES (?, NULL)", params: [step.key] },
						]);
					},
					opts({ leading: [read] }),
				);
			}
			case "binary-roundtrip": {
				const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
				const slice = backing.subarray(1, 5);
				const expected = new Uint8Array([1, 2, 3, 4]);
				const write: SqliteStatement = {
					sql: "INSERT OR REPLACE INTO kv (k, v, b) VALUES (?, ?, ?)",
					params: [step.key, step.payload, slice],
				};
				const promise = database.transaction(
					async (tx) => {
						const res = await tx.run(write.sql, step.key, step.payload, expected);
						const row = await tx.get<SqliteRow & { b: Uint8Array }>("SELECT b FROM kv WHERE k = ?", step.key);
						return { changes: res.changes, bytes: [...(row?.b ?? [])] };
					},
					opts({ leading: [write] }),
				);
				// Mutate the original slice right after queueing: `writeLead` snapshotted its bytes, so `tx.run` matches.
				backing.fill(0);
				return promise;
			}
			case "nul-param": {
				const bad: SqliteStatement = { sql: "INSERT INTO kv (k, v) VALUES (?, ?)", params: [step.key, "a\0b"] };
				return database.transaction(
					(tx) => tx.run(bad.sql, ...bad.params),
					opts({ leading: [bad], leadingOnly: true }),
				);
			}
		}
	};

	const outcomes = [];
	// Run both sequential single transactions AND concurrent group-commit batches of 4.
	for (let index = 0; index < steps.length; ) {
		if (index % 5 === 0 && index + 4 <= steps.length) {
			const batch = await Promise.allSettled(steps.slice(index, index + 4).map(runOne));
			outcomes.push(...batch.map(normalizeOutcome));
			index += 4;
		} else {
			const [single] = await Promise.allSettled([runOne(steps[index]!)]);
			outcomes.push(normalizeOutcome(single!));
			index += 1;
		}
	}
	const kv = await database.all<SqliteRow & { k: string; v: string; b: Uint8Array | null }>(
		"SELECT k, v, b FROM kv ORDER BY k",
	);
	const audit = await database.all<SqliteRow & { k: string; note: string }>("SELECT k, note FROM audit ORDER BY seq");
	return {
		outcomes,
		kv: kv.map((row) => ({ k: row.k, v: row.v, b: row.b === null ? null : [...row.b] })),
		audit,
	};
}

test("differential equivalence: pipelined leading and finisher transactions behave identically to individual unbatched calls (#6706)", async () => {
	const rng = makeRng(6706);
	const kinds: readonly WorkloadStep["kind"][] = [
		"lead-read-finisher-write",
		"leading-only-write",
		"leading-diverged",
		"leading-row2-get",
		"leading-row2-all",
		"leading-stmt-fail",
		"finisher-throw",
		"finisher-constraint-fail",
		"binary-roundtrip",
		"nul-param",
	];
	const steps: WorkloadStep[] = [];
	// Include every kind explicitly first, then 50 seeded randomized operations.
	for (let index = 0; index < kinds.length; index++) {
		steps.push({ kind: kinds[index]!, key: `k${index % 4}`, payload: `p${index}` });
	}
	for (let index = 0; index < 50; index++) {
		const kind = kinds[Math.floor(rng() * kinds.length)]!;
		steps.push({ kind, key: `k${Math.floor(rng() * 6)}`, payload: `r${index}` });
	}

	const dir = makeTempDirectory("atomic-diff-equiv-");
	cleanups.push(() => removeTempDirectory(dir));
	const pipelinedDb = await openNodeSqliteDatabase(join(dir, "pipelined.sqlite"));
	const unbatchedDb = await openNodeSqliteDatabase(join(dir, "unbatched.sqlite"));
	const rawWrapped = new DatabaseSync(join(dir, "wrapped.sqlite"));
	const wrappedDb = wrapNodeSqliteDatabase(rawWrapped);
	cleanups.push(async () => {
		await pipelinedDb.close();
		await unbatchedDb.close();
		await wrappedDb.close();
		rawWrapped.close();
	});

	const pipelined = await runWorkload(pipelinedDb, true, steps);
	const unbatched = await runWorkload(unbatchedDb, false, steps);
	const wrapped = await runWorkload(wrappedDb, false, steps);

	assert.deepEqual(pipelined, unbatched, "pipelined thread connection matches unbatched thread connection");
	assert.deepEqual(pipelined, wrapped, "pipelined thread connection matches unbatched calling-thread connection");
});

test("connection thread writes holder records and checks the writers-queue directory without overtaking live tickets (#6706)", async () => {
	const { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } = await import("node:fs");
	const { path, database } = await openFile();
	const holders = `${path}-holders`;
	const writers = `${path}-writers`;
	const wakes = `${path}-wakes`;
	const readHolderState = () => {
		const [name] = readdirSync(holders).filter((entry) => entry.startsWith(`${process.pid}-`));
		return readFileSync(join(holders, name!), "utf8").slice(0, 4);
	};

	// Uncontended write: worker thread writes "held" before callback runs and "free" before commit settles.
	let duringTx = "";
	const sent = recordRequests();
	await database.transaction(async (tx) => {
		duringTx = readHolderState();
		await tx.run("INSERT INTO items (value) VALUES (?)", "uncontended");
	});
	assert.equal(duringTx, "held", "holder record already says held on the connection thread before callback runs");
	assert.equal(readHolderState(), "free", "holder record already says free when transaction settles");
	assert.equal(
		sent.filter((request) => request.kind === "begin").length,
		1,
		"uncontended fast path took the lock in a single begin request",
	);

	// Empty post-contention writers directory: still takes the lock in one begin request without returning contended.
	mkdirSync(writers, { recursive: true });
	mkdirSync(wakes, { recursive: true });
	sent.length = 0;
	await database.transaction((tx) => tx.run("INSERT INTO items (value) VALUES (?)", "empty-dir"));
	assert.equal(
		sent.filter((request) => request.kind === "begin").length,
		1,
		"empty post-contention writers directory still completes in one begin request",
	);

	// Mid-transaction waiter added while this connection holds the lock: settleLock notices writers dir and wakes it!
	const ticketName = `${String(Date.now()).padStart(15, "0")}-999999991-1`;
	const noticePath = join(wakes, ticketName);
	const untouchedMs = Date.UTC(2000, 0, 1);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items (value) VALUES (?)", "wakes-waiter");
		writeFileSync(join(writers, ticketName), "");
		writeFileSync(noticePath, "");
		const untouched = new Date(untouchedMs);
		utimesSync(noticePath, untouched, untouched);
	});
	const { statSync } = await import("node:fs");
	assert.ok(statSync(noticePath).mtimeMs > untouchedMs, "releasing the lock woke the ticket queued mid-transaction");
	assert.equal(existsSync(join(writers, ticketName)), true);
	assert.deepEqual(await itemValues(database), ["uncontended", "empty-dir", "wakes-waiter"]);
});
