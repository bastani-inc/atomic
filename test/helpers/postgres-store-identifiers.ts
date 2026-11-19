import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import {
	postgresDialect,
	type StorageDialect,
	type StorageTrigger,
} from "../../packages/coding-agent/src/core/storage/dialect.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import { openSqlHeldSendStore } from "../../packages/intercom/broker/sql-held-send-store.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { openSqlOutboxStore } from "../../packages/intercom/broker/sql-outbox-store.js";
import { openSqlPendingAskStore } from "../../packages/intercom/broker/sql-pending-ask-store.js";
import { openSqlReleasedAskStore } from "../../packages/intercom/broker/sql-released-ask-store.js";
import { openSqlRestoringReservationStore } from "../../packages/intercom/broker/sql-restoring-reservation-store.js";
import { openSqlSentMessageAuthority } from "../../packages/intercom/broker/sql-sent-message-authority.js";
import { physicalIdentifiers } from "../../packages/storage-postgres/postgres.js";
import { seedLegacyWorkflowTables } from "./legacy-store-0990.js";
import { storageBackends } from "./storage-backends.js";

/**
 * Every store on PostgreSQL under long prefixes (#4793): the longest one PostgreSQL accepts, and a longer one the
 * prefix check would refuse, which these tests pass to the stores directly. Every name a store gives the server
 * reaches it as `postgresDialect.identifier` of it, in creation, use and catalog probes alike, so each store opens
 * again cleanly, and no two names become one identifier. The database holds an earlier release's workflow tables, as an
 * upgraded one does: the snapshot index's triggers on them are the names past 63 bytes under the longest prefix.
 */

const postgres = storageBackends.find((backend) => backend.name === "Postgres")!;
/** The longest prefix PostgreSQL accepts (#5067). */
const LONG_PREFIX = `${"p".repeat(23)}_`;
/** Longer than any prefix PostgreSQL accepts: its names would be truncated if any reached the server whole. */
const OVERLONG_PREFIX = `${"q".repeat(35)}_`;

/** `database`, whose dialect records every name the stores hand it to create, render, probe or drop. */
function recordingNames(database: SqliteDatabase, asked: Set<string>, made = new Set<string>()): SqliteDatabase {
	const record = (...names: readonly string[]) => {
		for (const name of names) asked.add(name);
	};
	/** A name the stores created, which must exist afterwards; a probed one may be absent. */
	const create = (...names: readonly string[]) => {
		record(...names);
		for (const name of names) made.add(name);
	};
	const dialect: StorageDialect = Object.freeze({
		...postgresDialect,
		renderTrigger: (trigger: StorageTrigger) => {
			create(trigger.name, `${trigger.name}_fn`);
			return postgresDialect.renderTrigger(trigger);
		},
		dropTrigger: (name: string, table: string) => {
			record(name);
			return postgresDialect.dropTrigger(name, table);
		},
		schemaObjects: (names: readonly string[]) => {
			record(...names);
			return postgresDialect.schemaObjects(names);
		},
		tableExists: (table: string) => {
			record(table);
			return postgresDialect.tableExists(table);
		},
		columnExists: (table: string, column: string) => {
			record(table);
			return postgresDialect.columnExists(table, column);
		},
	});
	const created = (sql: string) => {
		for (const match of sql.matchAll(/CREATE (?:UNIQUE INDEX|INDEX|TABLE)(?: IF NOT EXISTS)? ([A-Za-z0-9_]+)/g))
			create(match[1]!);
	};
	return new Proxy(database, {
		get(target, key) {
			if (key === "dialect") return dialect;
			if (key === "exec")
				return (sql: string) => {
					created(sql);
					return target.exec(sql);
				};
			if (key === "transaction")
				return (body: Parameters<SqliteDatabase["transaction"]>[0], options?: object) =>
					target.transaction(
						(tx) =>
							body(
								new Proxy(tx, {
									get: (inner, name) =>
										name === "exec"
											? (sql: string) => {
													created(sql);
													return inner.exec(sql);
												}
											: Reflect.get(inner, name, inner),
								}),
							),
						options,
					);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Opens every store Atomic keeps on a database under `prefix`: sessions and Intercom. */
async function openEveryStore(
	database: SqliteDatabase,
	prefix: string,
	/** Another connection, which the Intercom wake-up bus owns and closes. */
	connect: () => Promise<SqliteDatabase>,
): Promise<void> {
	const sessions = await SqlSessionStore.open(database, { prefix });
	await sessions.close();
	const options = { database, prefix };
	await openSqlBrokerLeaseStore(options);
	await openSqlOutboxStore(options);
	await openSqlHeldSendStore(options);
	await openSqlRestoringReservationStore(options);
	await openSqlPendingAskStore(options);
	await openSqlReleasedAskStore(options);
	await openSqlSentMessageAuthority(options);
	await openSqlKnownSessionStore(options);
	await (await openDatabaseWakeUpBus({ openDatabase: connect, prefix })).close();
}

test("every unquoted identifier past 63 bytes, in DDL, DML and function bodies, becomes the dialect's name for it (#4793)", () => {
	const long = `${"t".repeat(60)}_events`;
	const short = postgresDialect.identifier(long);
	assert.notEqual(short, long);
	assert.equal(
		physicalIdentifiers(`CREATE TABLE ${long}(id TEXT); INSERT INTO ${long} VALUES ('${long}') -- ${long}`),
		`CREATE TABLE ${short}(id TEXT); INSERT INTO ${short} VALUES ('${long}') -- ${long}`,
	);
	assert.equal(
		physicalIdentifiers(`SELECT "${long}" FROM ${long} t /* ${long} */`),
		`SELECT "${long}" FROM ${short} t /* ${long} */`,
	);
	assert.equal(
		physicalIdentifiers(
			`CREATE FUNCTION f() RETURNS trigger AS $trigger$ BEGIN DELETE FROM ${long} WHERE k = '${long}'; END $trigger$`,
		),
		`CREATE FUNCTION f() RETURNS trigger AS $trigger$ BEGIN DELETE FROM ${short} WHERE k = '${long}'; END $trigger$`,
	);
	assert.equal(physicalIdentifiers(`SELECT ${"x".repeat(63)} FROM t`), `SELECT ${"x".repeat(63)} FROM t`);
	assert.equal(physicalIdentifiers(`SELECT $1, ${short}`), `SELECT $1, ${short}`, "a mapped name maps to itself");
});

test("a long word in a nested block comment or in a dollar-quoted value is left as written (#4793)", () => {
	const long = `t_${"a".repeat(62)}_tbl`;
	const short = postgresDialect.identifier(long);
	// Postgres nests block comments: the quote inside is commented out, so the name after the comment is SQL.
	assert.equal(
		physicalIdentifiers(`SELECT /* a /* b */ c ' */ 1 FROM ${long}`),
		`SELECT /* a /* b */ c ' */ 1 FROM ${short}`,
	);
	assert.equal(
		physicalIdentifiers(`SELECT /* a /* b */ ${long} */ '${long}' FROM ${long}`),
		`SELECT /* a /* b */ ${long} */ '${long}' FROM ${short}`,
	);
	// A dollar-quoted string that is not a routine's body is a value.
	for (const value of [`$$${long}$$`, `$q$${long}$q$`])
		assert.equal(
			physicalIdentifiers(`INSERT INTO ${long} (v) VALUES (${value})`),
			`INSERT INTO ${short} (v) VALUES (${value})`,
		);
	assert.equal(
		physicalIdentifiers(`SELECT 1 FROM ${long}; SELECT $$${long}$$ AS v`),
		`SELECT 1 FROM ${short}; SELECT $$${long}$$ AS v`,
		"a body ends with its statement",
	);
	// A routine's body is SQL: its names are mapped, its literals kept, after any comment in its header.
	assert.equal(
		physicalIdentifiers(`DO $$ BEGIN DELETE FROM ${long} WHERE k = '${long}'; END $$`),
		`DO $$ BEGIN DELETE FROM ${short} WHERE k = '${long}'; END $$`,
	);
	assert.equal(
		physicalIdentifiers(
			`CREATE PROCEDURE p() /* a /* b */ c */ LANGUAGE plpgsql AS $b$ BEGIN DELETE FROM ${long}; END $b$`,
		),
		`CREATE PROCEDURE p() /* a /* b */ c */ LANGUAGE plpgsql AS $b$ BEGIN DELETE FROM ${short}; END $b$`,
	);
});

describe.skipIf(postgres.skipReason !== undefined)("a dollar-quoted value reaches the server unchanged (#4793)", () => {
	test("a value whose text is a long name is stored as written, after a nested comment", async () => {
		const scope = await postgres.openScope();
		try {
			const database = await scope.connect();
			const long = `t_${"a".repeat(62)}_tbl`;
			await database.exec(`CREATE TABLE ${long} (v TEXT)`);
			await database.run(`INSERT INTO ${long} (v) SELECT $$${long}$$ /* a /* b */ c ' */`);
			assert.deepEqual(await database.all(`SELECT v FROM ${long}`), [{ v: long }]);
		} finally {
			await scope.close();
		}
	});
});

describe.skipIf(postgres.skipReason !== undefined)(
	"every store's Postgres identifiers under long prefixes (#4793)",
	() => {
		for (const prefix of [LONG_PREFIX, OVERLONG_PREFIX])
			test(`every store opens twice under a ${prefix.length}-character prefix, and finds each object it asks for`, async () => {
				const scope = await postgres.openScope();
				try {
					const asked = new Set<string>();
					const made = new Set<string>();
					const connect = async () => recordingNames(await scope.connect(), asked, made);
					await seedLegacyWorkflowTables(await scope.connect(), { prefix });
					await openEveryStore(await connect(), prefix, connect);
					// A second host opening the same stores finds every object and changes nothing.
					await openEveryStore(await connect(), prefix, connect);
					const sessions = await SqlSessionStore.open(await scope.connect(), { prefix });
					try {
						const header = {
							id: "s",
							version: 4 as const,
							createdAt: "2026-01-01T00:00:00Z",
							cwd: "/",
						};
						await sessions.create(header, []);
						assert.equal((await sessions.load("s")).header.id, "s");
					} finally {
						await sessions.close();
					}
					const ours = [...made].filter((name) => name.startsWith(prefix));
					assert.ok(
						ours.some((name) => name.length > 63),
						"names past 63 bytes were created",
					);
					const probe = postgresDialect.schemaObjects(ours);
					const reader = await scope.connect();
					const found = new Set(
						(await reader.all<{ name: string }>(probe.sql, ...probe.params)).map((row) => row.name),
					);
					// Trigger functions are not tables, indexes or triggers: the catalog probe does not list them.
					assert.deepEqual(
						ours.filter((name) => !found.has(name) && !name.endsWith("_fn")),
						[],
						"every object a store created exists under the dialect's name for it",
					);
				} finally {
					await scope.close();
				}
			});

		test("no two names any store asks for map to one Postgres identifier, under any prefix", async () => {
			const names = new Set<string>();
			for (const prefix of ["", LONG_PREFIX, OVERLONG_PREFIX]) {
				const scope = await postgres.openScope();
				try {
					const connect = async () => recordingNames(await scope.connect(), names);
					await seedLegacyWorkflowTables(await scope.connect(), { prefix });
					await openEveryStore(await connect(), prefix, connect);
				} finally {
					await scope.close();
				}
			}
			assert.ok(
				[...names].some((name) => name.length > 63),
				"some names were long enough to be hashed",
			);
			const byIdentifier = new Map<string, string>();
			for (const name of names) {
				const identifier = postgresDialect.identifier(name);
				assert.ok(identifier.length <= 63, identifier);
				const earlier = byIdentifier.get(identifier);
				assert.equal(earlier, undefined, `${name} and ${earlier} both become ${identifier}`);
				byIdentifier.set(identifier, name);
			}
		});
	},
);
