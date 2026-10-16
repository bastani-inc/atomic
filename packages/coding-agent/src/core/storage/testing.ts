import assert from "node:assert/strict";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.js";
import {
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";

export interface StorageConformanceRunner {
	describe(name: string, body: () => void): void;
	it(name: string, body: () => Promise<void>): void;
}

export interface SqliteDatabaseConformanceSubject {
	readonly database: SqliteDatabase;
	reopen(): Promise<SqliteDatabase>;
	withRollbackFailure(cause: Error, body: () => Promise<void>): Promise<void>;
}

export type WithSqliteDatabaseSubject = (
	body: (subject: SqliteDatabaseConformanceSubject) => Promise<void>,
) => Promise<void>;

export function registerSqliteDatabaseConformance(
	runner: StorageConformanceRunner,
	name: string,
	withSubject: WithSqliteDatabaseSubject,
): void {
	for (const reopen of [false, true]) {
		runner.describe(`${name}${reopen ? " (reopen)" : ""}`, () => {
			const check = (name: string, body: (subject: SqliteDatabaseConformanceSubject) => Promise<void>) =>
				runner.it(name, () => withSubject(body));
			const checkpoint = (subject: SqliteDatabaseConformanceSubject) =>
				reopen ? subject.reopen() : Promise.resolve(subject.database);
			const create = (database: SqliteDatabase) =>
				database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value)");

			check("binds parameters and reuses statements", async (subject) => {
				await create(subject.database);
				const values = ["'); DROP TABLE items; --", "", "same", "same"];
				for (const value of values) await subject.database.run("INSERT INTO items(value) VALUES (?)", value);
				const database = await checkpoint(subject);
				assert.deepEqual(
					await database.all("SELECT value FROM items ORDER BY id"),
					values.map((value) => ({ value })),
				);
				assert.equal(await database.get("SELECT value FROM items WHERE id = ?", 99), undefined);
				assert.deepEqual(await database.all("SELECT value FROM items WHERE id = ?", 99), []);
			});

			check("reports affected rows", async (subject) => {
				await create(subject.database);
				assert.deepEqual(await subject.database.run("INSERT INTO items(value) VALUES (?), (?)", "a", "b"), {
					changes: 2,
				});
				const database = await checkpoint(subject);
				assert.deepEqual(await database.run("UPDATE items SET value = ?", "c"), { changes: 2 });
				assert.deepEqual(await database.run("DELETE FROM items WHERE id = ?", 99), { changes: 0 });
			});

			check("round-trips values with exact signed integers", async (subject) => {
				await create(subject.database);
				const values: SqliteValue[] = [
					null,
					0,
					Number.MAX_SAFE_INTEGER,
					-Number.MAX_SAFE_INTEGER,
					9007199254740992n,
					-9007199254740992n,
					9223372036854775807n,
					-9223372036854775808n,
					1.25,
					"text",
					JSON.stringify({ text: "A\0B" }),
					new Uint8Array([0, 1, 255]),
					new Uint8Array([0]),
					new Uint8Array(),
				];
				for (const value of values) await subject.database.run("INSERT INTO items(value) VALUES (?)", value);
				const database = await checkpoint(subject);
				assert.deepEqual(
					await database.all("SELECT value FROM items ORDER BY id"),
					values.map((value) => ({ value })),
				);
				assert.deepEqual(await database.get("SELECT ? AS value", 42n), { value: 42 });
			});

			check("binds binary parameters when called, not when queued work executes", async (subject) => {
				await create(subject.database);
				const database = await checkpoint(subject);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const holding = database.transaction(async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
				const bytes = new Uint8Array([1, 2, 3]);
				const write = database.run("INSERT INTO items(value) VALUES (?)", bytes);
				const read = database.get("SELECT ? AS value", bytes);
				const rows = database.all("SELECT ? AS value", bytes);
				bytes.fill(0);
				release.resolve();
				await Promise.all([holding, write]);
				const expected = { value: new Uint8Array([1, 2, 3]) };
				assert.deepEqual(await read, expected);
				assert.deepEqual(await rows, [expected]);
				assert.deepEqual(await (await checkpoint(subject)).all("SELECT value FROM items"), [expected]);
			});

			check("binds binary parameters at call time inside a transaction", async (subject) => {
				await create(subject.database);
				const database = await checkpoint(subject);
				const expected = { value: new Uint8Array([1, 2, 3]) };
				await database.transaction(async (tx) => {
					const bytes = new Uint8Array([1, 2, 3]);
					const write = tx.run("INSERT INTO items(value) VALUES (?)", bytes);
					const read = tx.get("SELECT ? AS value", bytes);
					const rows = tx.all("SELECT ? AS value", bytes);
					bytes.fill(0);
					await write;
					assert.deepEqual(await read, expected);
					assert.deepEqual(await rows, [expected]);
				});
				assert.deepEqual(await (await checkpoint(subject)).all("SELECT value FROM items"), [expected]);
			});

			check("rejects NUL string bindings before executing SQL", async (subject) => {
				await create(subject.database);
				const database = await checkpoint(subject);
				const rejectInvalid = async (executor: SqliteExecutor) => {
					for (const method of ["run", "get", "all"] as const) {
						for (const parameterIndex of [0, 1]) {
							const params: SqliteValue[] = [1, "text"];
							params[parameterIndex] = "A\0B";
							await assert.rejects(
								executor[method]("INSERT INTO items(id, value) VALUES (?, ?) RETURNING value", ...params),
								(error: Error) => {
									assert.ok(error instanceof StorageInvalidTextError);
									assert.equal(error.parameterIndex, parameterIndex);
									assert.equal(error.reason, "nul-character");
									return true;
								},
							);
						}
					}
				};
				await rejectInvalid(database);
				await database.transaction(rejectInvalid);
				assert.deepEqual(await database.all("SELECT * FROM items"), []);
				await assert.rejects(database.get("INVALID SQL", "\0"), StorageInvalidTextError);
			});

			check("commits the transaction and returns its result", async (subject) => {
				await create(subject.database);
				const result = { committed: true };
				assert.equal(
					await subject.database.transaction(async (tx) => {
						await tx.exec("INSERT INTO items(value) VALUES ('first')");
						assert.deepEqual(await tx.run("INSERT INTO items(value) VALUES (?)", "second"), { changes: 1 });
						assert.deepEqual(await tx.get("SELECT count(*) AS count FROM items"), { count: 2 });
						assert.equal((await tx.all("SELECT * FROM items")).length, 2);
						return result;
					}),
					result,
				);
				assert.deepEqual(await (await checkpoint(subject)).get("SELECT count(*) AS count FROM items"), {
					count: 2,
				});
			});

			check("rolls back and rethrows the identical callback rejection", async (subject) => {
				await create(subject.database);
				const failure = new StorageTransactionClosedError();
				await assert.rejects(
					subject.database.transaction(async (tx) => {
						await tx.run("INSERT INTO items(value) VALUES (?)", "discard");
						throw failure;
					}),
					(error: Error) => error === failure,
				);
				assert.deepEqual(await (await checkpoint(subject)).all("SELECT * FROM items"), []);
			});

			check("rolls back earlier writes when the final statement fails", async (subject) => {
				await create(subject.database);
				await assert.rejects(
					subject.database.transaction(async (tx) => {
						await tx.run("INSERT INTO items(id, value) VALUES (?, ?)", 1, "discard");
						await tx.run("INSERT INTO items(id, value) VALUES (?, ?)", 1, "duplicate");
					}),
					StorageUnavailableError,
				);
				assert.deepEqual(await (await checkpoint(subject)).all("SELECT * FROM items"), []);
			});

			check("rejects a failed commit with a typed error and leaves nothing visible", async (subject) => {
				await subject.database.exec(
					"CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)",
				);
				const database = await checkpoint(subject);
				// A deferred foreign-key violation passes every statement and fails only at COMMIT.
				await database.exec("PRAGMA foreign_keys = ON");
				let callbackSettled = false;
				await assert.rejects(
					database.transaction(async (tx) => {
						await tx.run("INSERT INTO children(id, parent) VALUES (?, ?)", 1, 1);
						callbackSettled = true;
						return "committed";
					}),
					(error: Error) => {
						assert.ok(error instanceof StorageUnavailableError);
						assert.equal(error.adapter, database.descriptor.adapter);
						assert.equal(error.location, database.descriptor.location);
						assert.ok(error.cause instanceof Error);
						return true;
					},
				);
				assert.equal(callbackSettled, true);
				assert.deepEqual(await database.all("SELECT id FROM children"), []);
				await database.transaction(async (tx) => {
					await tx.run("INSERT INTO parents(id) VALUES (?)", 1);
					await tx.run("INSERT INTO children(id, parent) VALUES (?, ?)", 1, 1);
				});
				assert.deepEqual(await (await checkpoint(subject)).all("SELECT id, parent FROM children"), [
					{ id: 1, parent: 1 },
				]);
			});

			check("retains both failures when rollback fails", async (subject) => {
				const original = new StorageTransactionClosedError();
				const rollback = new StorageTransactionClosedError();
				await subject.withRollbackFailure(rollback, async () => {
					await assert.rejects(
						subject.database.transaction(async () => {
							throw original;
						}),
						(error: Error) => {
							assert.ok(error instanceof StorageRollbackError);
							assert.equal(error.cause, original);
							assert.ok(error.rollbackCause instanceof StorageUnavailableError);
							assert.equal(error.rollbackCause.cause, rollback);
							return true;
						},
					);
				});
			});

			for (const reject of [false, true]) {
				check(
					`expires all handle methods after callback ${reject ? "rejection" : "resolution"}`,
					async (subject) => {
						let handle: SqliteExecutor | undefined;
						const failure = new StorageTransactionClosedError();
						const operation = subject.database.transaction(async (tx) => {
							handle = tx;
							if (reject) throw failure;
						});
						if (reject) await assert.rejects(operation, (error: Error) => error === failure);
						else await operation;
						await checkpoint(subject);
						assert.ok(handle);
						await assert.rejects(handle.exec("SELECT 1"), StorageTransactionClosedError);
						await assert.rejects(handle.run("SELECT 1"), StorageTransactionClosedError);
						await assert.rejects(handle.get("SELECT 1"), StorageTransactionClosedError);
						await assert.rejects(handle.all("SELECT 1"), StorageTransactionClosedError);
					},
				);
			}

			check("queues unrelated operations and transactions in call order", async (subject) => {
				await create(subject.database);
				const database = await checkpoint(subject);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const order: string[] = [];
				const first = database.transaction(async (tx) => {
					entered.resolve();
					await release.promise;
					await tx.run("INSERT INTO items(value) VALUES (?)", "transaction");
					order.push("transaction");
				});
				await entered.promise;
				const write = database.run("INSERT INTO items(value) VALUES (?)", "queued").then(() => order.push("write"));
				const read = database.all("SELECT value FROM items ORDER BY id").then((rows) => {
					assert.deepEqual(rows, [{ value: "transaction" }, { value: "queued" }]);
					order.push("read");
				});
				const last = database.transaction(async () => {
					order.push("last");
				});
				await Promise.resolve();
				assert.deepEqual(order, []);
				release.resolve();
				await Promise.all([first, write, read, last]);
				assert.deepEqual(order, ["transaction", "write", "read", "last"]);
			});

			check("close drains accepted work, is idempotent, and rejects new calls", async (subject) => {
				await create(subject.database);
				const database = await checkpoint(subject);
				const write = database.run("INSERT INTO items(value) VALUES (?)", "durable");
				const read = database.all("SELECT value FROM items");
				const close = database.close();
				await assert.rejects(database.exec("SELECT 1"), StoreClosedError);
				await write;
				assert.deepEqual(await read, [{ value: "durable" }]);
				await close;
				await database.close();
				for (const operation of [
					() => database.exec("SELECT 1"),
					() => database.run("SELECT 1"),
					() => database.get("SELECT 1"),
					() => database.all("SELECT 1"),
					() => database.transaction(async () => {}),
				]) {
					await assert.rejects(operation(), (error: Error) => {
						assert.ok(error instanceof StoreClosedError);
						assert.equal(error.adapter, database.descriptor.adapter);
						assert.equal(error.location, database.descriptor.location);
						return true;
					});
				}
				assert.deepEqual(await (await subject.reopen()).all("SELECT value FROM items"), [{ value: "durable" }]);
			});

			check("wraps driver failures with descriptor and cause", async (subject) => {
				const database = await checkpoint(subject);
				for (const operation of [
					() => database.exec("INVALID SQL"),
					() => database.run("INVALID SQL"),
					() => database.get("INVALID SQL"),
					() => database.all("INVALID SQL"),
				]) {
					await assert.rejects(operation(), (error: Error) => {
						assert.ok(error instanceof StorageUnavailableError);
						assert.equal(error.adapter, database.descriptor.adapter);
						assert.equal(error.location, database.descriptor.location);
						assert.ok(error.cause instanceof Error);
						return true;
					});
				}
			});
		});
	}
}

/** Exercises independent connections to the same database, including an async yield while holding its write lock. */
export function registerSqliteConnectionConformance(
	runner: StorageConformanceRunner,
	name: string,
	withConnections: (body: (first: SqliteDatabase, second: SqliteDatabase) => Promise<void>) => Promise<void>,
): void {
	runner.describe(name, () => {
		runner.it("queues concurrent transactions across connections without blocking the event loop (#3682)", () =>
			withConnections(async (first, second) => {
				await first.exec("CREATE TABLE concurrent_items (value INTEGER)");
				const entered = Promise.withResolvers<void>();
				let timerDelay = 0;
				const started = performance.now();
				const holding = first.transaction(async (tx) => {
					entered.resolve();
					await new Promise<void>((resolve) => setTimeout(resolve, 25));
					timerDelay = performance.now() - started;
					await tx.run("INSERT INTO concurrent_items VALUES (?)", 1);
				});
				await entered.promise;
				const queued = second.transaction(async (tx) => {
					await tx.run("INSERT INTO concurrent_items VALUES (?)", 2);
				});
				const outcomes = await Promise.allSettled([holding, queued]);
				const EVENT_LOOP_STALL_BOUND_MS = 2000;
				assert.ok(timerDelay < EVENT_LOOP_STALL_BOUND_MS, `timer delayed ${timerDelay}ms`);
				assert.deepEqual(
					outcomes.map((outcome) => outcome.status),
					["fulfilled", "fulfilled"],
				);
				assert.deepEqual(await second.all("SELECT value FROM concurrent_items ORDER BY value"), [
					{ value: 1 },
					{ value: 2 },
				]);
			}),
		);
	});
}
