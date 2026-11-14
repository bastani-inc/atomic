import assert from "node:assert/strict";
import { join } from "node:path";
import { inspect } from "node:util";
import {
	postgresDialect,
	StorageConfigError,
	StorageTransientError,
	type StorageTransientErrorCode,
	type StorageTransientOutcome,
	StorageUnavailableError,
} from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import adapter, { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	openPostgresAdmin,
	postgresSkipReason,
	postgresTestPassword,
	postgresUrlFor,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/** A statement the facade gives up on only after its five runs and their backoff, about four seconds. */
const TRANSIENT_RETRIES_TIMEOUT_MS = 20_000;

function assertTransient(
	error: unknown,
	code: StorageTransientErrorCode,
	outcome: StorageTransientOutcome,
): asserts error is StorageTransientError {
	assert.ok(error instanceof StorageTransientError, inspect(error));
	assert.equal(error.code, code);
	assert.equal(error.outcome, outcome);
}

describe.skipIf(postgresSkipReason !== undefined)("Postgres storage adapter (#4793)", () => {
	test("binds ? parameters in order and leaves ? in literals, identifiers and comments alone (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const row = await database.get(
				`SELECT ?::text AS first, '?' AS quoted, E'\\'?' AS escaped, E'can''t \\' ?' AS doubled, "?column"."?" AS identifier,
					$$?$$ AS dollar, $tag$ ? $tag$ AS tagged, /* ? /* nested ? */ ? */ ?::bigint AS second -- ?
				FROM (SELECT 'x' AS "?") AS "?column"`,
				"one",
				2,
			);
			assert.deepEqual(row, {
				first: "one",
				quoted: "?",
				escaped: "'?",
				doubled: "can't ' ?",
				identifier: "x",
				dollar: "?",
				tagged: " ? ",
				second: 2,
			});
		});
	});

	test("returns SQLite values: exact integers, numbers, bytes, booleans and text (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const row = await database.get(
				`SELECT 9223372036854775807::bigint AS big, -9007199254740992::bigint AS edge, 42::bigint AS small,
					7::int AS int4, 3::smallint AS int2, 1.25::float8 AS real, 0.5::numeric AS fraction,
					9007199254740993.0::numeric(20, 1) AS wholeNumeric,
					(SELECT SUM(x) FROM (VALUES (9223372036854775807::bigint), (1::bigint)) AS t(x)) AS sum,
					true AS yes, false AS no, '\\x00ff'::bytea AS bytes, '{"a": 1}'::jsonb AS json,
					'2026-01-02 03:04:05+00'::timestamptz AS at, NULL AS nothing, ?::bytea AS bound`,
				new Uint8Array([1, 2, 3]),
			);
			assert.deepEqual(row, {
				big: 9223372036854775807n,
				edge: -9007199254740992n,
				small: 42,
				int4: 7,
				int2: 3,
				real: 1.25,
				fraction: 0.5,
				wholenumeric: 9007199254740993n,
				sum: 9223372036854775808n,
				yes: 1,
				no: 0,
				bytes: new Uint8Array([0, 255]),
				json: '{"a": 1}',
				at: "2026-01-02 03:04:05+00",
				nothing: null,
				bound: new Uint8Array([1, 2, 3]),
			});
		});
	});

	test("reports changed rows, round-trips bound integers and runs several statements in one exec (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			await database.exec("CREATE TABLE items (id BIGINT PRIMARY KEY, value TEXT); CREATE TABLE other (id BIGINT)");
			await database.exec("PRAGMA foreign_keys = ON");
			assert.deepEqual(
				await database.run("INSERT INTO items(id, value) VALUES (?, ?), (?, ?)", 9223372036854775807n, "a", 1, "b"),
				{ changes: 2 },
			);
			assert.deepEqual(await database.run("UPDATE items SET value = ?", "c"), { changes: 2 });
			assert.deepEqual(await database.run("DELETE FROM items WHERE id = ?", 99), { changes: 0 });
			assert.deepEqual(await database.all("SELECT id, value FROM items ORDER BY id"), [
				{ id: 1, value: "c" },
				{ id: 9223372036854775807n, value: "c" },
			]);
			assert.equal(await database.get("SELECT id FROM items WHERE id = ?", 99), undefined);
		});
	});

	test("carries the Postgres dialect (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			assert.equal(database.dialect, postgresDialect);
			assert.equal(database.descriptor.adapter, "postgres");
		});
	});

	test("commits and rolls back transactions, and never commits one a failed statement aborted (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			await database.exec("CREATE TABLE items (id BIGINT PRIMARY KEY)");
			await database.transaction(async (tx) => {
				await tx.run("INSERT INTO items(id) VALUES (?)", 1);
			});
			await assert.rejects(
				database.transaction(async (tx) => {
					await tx.run("INSERT INTO items(id) VALUES (?)", 2);
					throw new Error("abandon");
				}),
				/abandon/,
			);
			await assert.rejects(
				database.transaction(async (tx) => {
					await tx.run("INSERT INTO items(id) VALUES (?)", 3);
					await tx.run("INSERT INTO items(id) VALUES (?)", 1).catch(() => {});
				}),
				StorageUnavailableError,
			);
			assert.deepEqual(await database.all("SELECT id FROM items ORDER BY id"), [{ id: 1 }]);
			// The connection that held the aborted transaction is usable again.
			for (let index = 0; index < 10; index++) await database.get("SELECT 1 AS one");
		});
	});

	test("a serial transaction excludes another of its domain until it commits (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const first = await open();
			const second = await open();
			await first.exec("CREATE TABLE events (seq BIGINT PRIMARY KEY)");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holder = first.transaction(
				async (tx) => {
					await tx.run("INSERT INTO events(seq) VALUES (?)", 1);
					entered.resolve();
					await release.promise;
				},
				{ concurrency: { kind: "serial", domain: "team_events" } },
			);
			await entered.promise;
			// Another domain does not wait.
			await second.transaction(async (tx) => tx.get("SELECT 1 AS one"), {
				concurrency: { kind: "serial", domain: "team_other" },
			});
			const waiter = second.transaction(
				async (tx) => tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM events"),
				{ concurrency: { kind: "serial", domain: "team_events" } },
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			release.resolve();
			await holder;
			// It waited for the holder's commit, so it sees its row.
			assert.deepEqual(await waiter, { count: 1 });
		});
	});

	test("a whole-database serial transaction and a domain's exclude each other (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const first = await open();
			const second = await open();
			const whole = { kind: "serial" } as const;
			const domain = (name: string) => ({ kind: "serial", domain: name }) as const;
			const conflicts = async (
				held: { kind: "serial"; domain?: string },
				wanted: { kind: "serial"; domain?: string },
			): Promise<boolean> => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const holder = first.transaction(
					async () => {
						entered.resolve();
						await release.promise;
					},
					{ concurrency: held },
				);
				await entered.promise;
				try {
					const error = await second
						.transaction(async () => {}, { concurrency: wanted, lockWaitMs: 100 })
						.catch((caught) => caught);
					if (error === undefined) return false;
					assertTransient(error, "lock-conflict", "not-applied");
					return true;
				} finally {
					release.resolve();
					await holder;
				}
			};
			assert.equal(await conflicts(whole, domain("team_a")), true);
			assert.equal(await conflicts(domain("team_a"), whole), true);
			assert.equal(await conflicts(domain("team_a"), domain("team_a")), true);
			assert.equal(await conflicts(domain("team_a"), domain("team_b")), false);
			assert.equal(await conflicts(whole, whole), true);
		});
	});

	test("a serial transaction that waits out lockWaitMs fails as a lock conflict (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const first = await open();
			const second = await open();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holder = first.transaction(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			try {
				const error = await second.transaction(async () => {}, { lockWaitMs: 100 }).catch((caught) => caught);
				assertTransient(error, "lock-conflict", "not-applied");
				assert.equal(error.attempts, 1);
			} finally {
				release.resolve();
				await holder;
			}
		});
	});

	test(
		"maps SQLSTATEs to transient and fatal failures (#4793)",
		async () => {
			await withPostgresDatabase(async ({ open }) => {
				const database = await open();
				const raise = (sqlstate: string) =>
					database.transaction(
						(tx) => tx.exec(`DO $$ BEGIN RAISE EXCEPTION 'fixture' USING ERRCODE = '${sqlstate}'; END $$`),
						{},
					);
				const transient: [string, StorageTransientErrorCode, StorageTransientOutcome][] = [
					["40001", "lock-conflict", "not-applied"],
					["40P01", "lock-conflict", "not-applied"],
					["55P03", "lock-conflict", "not-applied"],
					["57014", "transaction-timeout", "not-applied"],
					["53300", "connection-refused", "not-applied"],
					["57P03", "connection-refused", "not-applied"],
					["08001", "connection-refused", "not-applied"],
					["08004", "connection-refused", "not-applied"],
				];
				for (const [sqlstate, code] of transient) {
					// Inside a transaction nothing applied, whatever the failure says of the request.
					assertTransient(await raise(sqlstate).catch((error) => error), code, "not-applied");
				}
				for (const [sqlstate, code, outcome] of transient)
					assertTransient(
						await database
							.exec(`DO $$ BEGIN RAISE EXCEPTION 'fixture' USING ERRCODE = '${sqlstate}'; END $$`)
							.catch((error) => error),
						code,
						outcome,
					);
				for (const sqlstate of ["42501", "23505", "08P01", "53100", "28P01", "3D000"]) {
					const error = await raise(sqlstate).catch((caught) => caught);
					assert.ok(error instanceof StorageUnavailableError, inspect(error));
					assert.equal(error instanceof StorageTransientError, false, sqlstate);
				}
			});
		},
		TRANSIENT_RETRIES_TIMEOUT_MS * 2,
	);

	test("an exec outside a transaction that may have applied reports an unknown outcome (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			for (const sqlstate of ["57P01", "57P02", "08000", "08003", "08006"])
				assertTransient(
					await database
						.exec(`DO $$ BEGIN RAISE EXCEPTION 'fixture' USING ERRCODE = '${sqlstate}'; END $$`)
						.catch((error) => error),
					"connection-lost",
					"unknown",
				);
		});
	});

	test("cancels a statement in a transaction at statementTimeoutMs (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ statementTimeoutMs: 100 });
			const started = performance.now();
			const error = await database.transaction((tx) => tx.get("SELECT pg_sleep(5)")).catch((caught) => caught);
			assertTransient(error, "transaction-timeout", "not-applied");
			assert.ok(performance.now() - started < 4000);
		});
	});

	test("gives up on a statement outside a transaction that outlives its timeout, outcome unknown (#4793)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open({ statementTimeoutMs: 100 });
			const error = await database.get("SELECT pg_sleep(30)").catch((caught) => caught);
			assertTransient(error, "connection-lost", "unknown");
			assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
		});
	});

	test("a connection the server ends during a transaction is lost, then replaced (#4793)", async () => {
		await withPostgresDatabase(async ({ open, admin, name }) => {
			const database = await open();
			const error = await database
				.transaction(async (tx) => {
					const killer = (async () => {
						await new Promise((resolve) => setTimeout(resolve, 200));
						await admin.run(
							"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND query LIKE 'SELECT pg_sleep%'",
							name,
						);
					})();
					try {
						await tx.get("SELECT pg_sleep(10)");
					} finally {
						await killer;
					}
				})
				.catch((caught) => caught);
			assertTransient(error, "connection-lost", "not-applied");
			for (let index = 0; index < 10; index++) assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
		});
	});

	test(
		"a server that refuses connections fails as connection-refused, nothing applied (#4793)",
		async () => {
			const error = await openPostgresDatabase({ url: "postgres://atomic@127.0.0.1:1/atomic" }).catch(
				(caught) => caught,
			);
			assertTransient(error, "connection-refused", "not-applied");
			assert.equal(error.attempts, 5);
		},
		TRANSIENT_RETRIES_TIMEOUT_MS,
	);

	test("refused credentials and a missing database fail at once, without the password (#4793)", async () => {
		const wrong = await openPostgresAdmin({ password: "fixture-wrong-password" }).catch((caught) => caught);
		assert.ok(wrong instanceof StorageUnavailableError, inspect(wrong));
		assert.equal(wrong instanceof StorageTransientError, false);
		assert.equal(inspect(wrong, { depth: null }).includes("fixture-wrong-password"), false);
		const missing = await openPostgresDatabase({
			url: postgresUrlFor("atomic_p2_missing_database"),
			...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
		}).catch((caught) => caught);
		assert.ok(missing instanceof StorageUnavailableError, inspect(missing));
		assert.equal(missing instanceof StorageTransientError, false);
	});

	test("an empty password from the password source is refused, not retried (#4793)", async () => {
		const error = await openPostgresAdmin({ password: async () => "" }).catch((caught) => caught);
		assert.ok(error instanceof StorageUnavailableError, inspect(error));
		assert.equal(error instanceof StorageTransientError, false);
		let cause: unknown = error.cause;
		while (cause instanceof Error && !(cause instanceof StorageConfigError)) cause = cause.cause;
		assert.ok(cause instanceof StorageConfigError, inspect(error));
	});

	test("reads a rotated password file for the next new connection (#4793)", async () => {
		await withPostgresDatabase(async ({ admin, url, name }) => {
			const role = `${name}_role`;
			const directory = makeTempDirectory("storage-postgres-secret-");
			const file = join(directory, "password");
			try {
				await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-first-password'`);
				await admin.exec(`GRANT ALL ON DATABASE ${name} TO ${role}`);
				writeTextSync(file, "fixture-first-password\n");
				const { readFile } = await import("node:fs/promises");
				const roleUrl = new URL(url);
				roleUrl.username = role;
				const database = await adapter.openDatabase(
					{ url: roleUrl.href },
					{
						agentDir: directory,
						domain: "journal",
						secret: async (secret) => {
							assert.equal(secret, "password");
							return (await readFile(file, "utf8")).trimEnd();
						},
					},
				);
				try {
					assert.deepEqual(await database.get("SELECT current_user AS who"), { who: role });
					// Rotate: the old password stops working, and the connections that used it end.
					writeTextSync(file, "fixture-second-password\n");
					await admin.exec(`ALTER ROLE ${role} PASSWORD 'fixture-second-password'`);
					await admin.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?", role);
					// The pool drops an idle connection once the server's notice that it ended arrives.
					await new Promise((resolve) => setTimeout(resolve, 200));
					assert.deepEqual(await database.get("SELECT current_user AS who"), { who: role });
				} finally {
					await database.close();
				}
			} finally {
				await admin.exec(`REVOKE ALL ON DATABASE ${name} FROM ${role}`).catch(() => {});
				await admin.exec(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
				removeTempDirectory(directory);
			}
		});
	});
});
