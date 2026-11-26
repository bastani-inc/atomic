import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import type { SqliteDatabase, SqliteExecutor } from "@bastani/atomic/storage";
import { describe, test, vi } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { copySessionBlobs } from "../../packages/coding-agent/src/core/session-tool-output.js";
import { strayPostgresStorageTables } from "../../packages/coding-agent/src/core/storage/postgres-schema.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openDatabaseWakeUpBus } from "../../packages/intercom/broker/database-wake-up-bus.js";
import type { BrokerLeaseStore } from "../../packages/intercom/broker/multinode-state-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { dumpLegacyWorkflowTables, LEGACY_STORE, seedLegacyStore } from "../helpers/legacy-store-0990.js";
import {
	openPostgresAdmin,
	type PostgresScope,
	postgresSkipReason,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { countRoundTrips } from "../helpers/postgres-round-trips.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * PostgreSQL with two roles (#5218): an owner role that sets up and migrates Atomic's schema, and a runtime role with
 * only the privileges docs/storage/postgres.md ("Set up the database") grants it, which must open sessions and Intercom without DDL.
 */

const postgresPackage = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");
/** The Intercom broker state as main shipped it before #5218, vendored: an earlier release's broker. */
const earlierBroker = resolve(moduleDir(import.meta.url), "../fixtures/intercom-pre-5218/broker/open-broker-state.ts");
const PREFIX = "r5218_";
/** Long enough for a local server to answer a read-only transaction's commit, which an open does not wait for. */
const COMMIT_SETTLE_MS = 200;
/** How long a wake-up hint may take to reach its broker, by notification or by the poll. */
const HINT_ARRIVAL_BOUND_MS = 5_000;
/** Hosts that start together on a new database in the concurrent setup test. */
const CONCURRENT_HOSTS = 16;
/** Each host opens every store; they set the schema up one after another under its lock, then open it as it is. */
const CONCURRENT_HOSTS_TIMEOUT_MS = 120_000;

interface Roles {
	readonly owner: string;
	readonly runtime: string;
	readonly passwords: Readonly<Record<"owner" | "runtime", string>>;
	/** The isolated database's URL with each role as its user. */
	readonly urls: Readonly<Record<"owner" | "runtime", string>>;
	open(role: "owner" | "runtime"): Promise<SqliteDatabase>;
}

/**
 * Runs `body` with an owner role that owns the scope's database, and a runtime role with CONNECT on it and nothing else
 * yet. Both are dropped afterwards, after the database.
 */
async function withRoles<T>(body: (scope: PostgresScope, roles: Roles) => Promise<T>): Promise<T> {
	const tag = randomBytes(4).toString("hex");
	const owner = `atomic_owner_${tag}`;
	const runtime = `atomic_runtime_${tag}`;
	const passwords = { owner: `pw-${randomUUID()}`, runtime: `pw-${randomUUID()}` };
	try {
		return await withPostgresDatabase(async (scope) => {
			await scope.admin.exec(`CREATE ROLE ${owner} LOGIN PASSWORD '${passwords.owner}'`);
			await scope.admin.exec(`CREATE ROLE ${runtime} LOGIN PASSWORD '${passwords.runtime}'`);
			// A managed server's administrator is no superuser: it changes a database's owner as a member of the new one.
			await scope.admin.exec(`GRANT ${owner} TO CURRENT_USER`);
			await scope.admin.exec(`ALTER DATABASE ${scope.name} OWNER TO ${owner}`);
			await scope.admin.exec(`GRANT CONNECT ON DATABASE ${scope.name} TO ${runtime}`);
			const urlOf = (role: string) => {
				const url = new URL(scope.url);
				url.username = role;
				return url.href;
			};
			const urls = { owner: urlOf(owner), runtime: urlOf(runtime) };
			return body(scope, {
				owner,
				runtime,
				passwords,
				urls,
				open: (role) => scope.open({ url: urls[role], password: passwords[role] }),
			});
		});
	} finally {
		const admin = await openPostgresAdmin();
		try {
			for (const role of [runtime, owner]) await admin.exec(`DROP ROLE IF EXISTS ${role}`);
		} finally {
			await admin.close();
		}
	}
}

/** Opens every store Atomic keeps on PostgreSQL under `prefix` on databases `open` returns, then closes them. */
async function openEveryStore(open: () => Promise<SqliteDatabase>, prefix: string): Promise<void> {
	const database = await open();
	await (await SqlSessionStore.open(database, { prefix })).close();
	const intercom = await openIntercomBrokerState({ prefix, openDatabase: open });
	await intercom.bus.close();
	await intercom.state.close();
}

/**
 * The runtime role's grants as docs/storage/postgres.md gives them, run as the owner on the schema the owner's tables are in:
 * schema USAGE, DML on every table, the sequences and EXECUTE on the trigger functions, and the same by default on those
 * created later.
 */
async function grantRuntime(ownerDatabase: SqliteDatabase, roles: Roles): Promise<string> {
	const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
	const schema = String(row?.schema);
	for (const statement of [
		// A hardened server takes EXECUTE on functions from PUBLIC; the runtime role's own grant still covers the triggers.
		`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`,
		`GRANT USAGE ON SCHEMA ${schema} TO ${roles.runtime}`,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${roles.runtime}`,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${roles.runtime}`,
		`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${roles.runtime}`,
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.runtime}`,
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${roles.runtime}`,
		`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${roles.runtime}`,
	])
		await ownerDatabase.exec(statement);
	return schema;
}

/**
 * Creates in `public`, as the administrator, an empty copy of every table in `schema`, on which no other role has any
 * privilege; returns their names.
 */
async function addDecoys(
	scope: PostgresScope,
	schema: string,
): Promise<{ readonly database: SqliteDatabase; readonly tables: string[] }> {
	const database = await scope.open();
	const tables = (
		await database.all<{ name: string }>(
			"SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ? AND c.relkind = 'r' ORDER BY 1",
			schema,
		)
	).map((row) => String(row.name));
	for (const table of tables) {
		await database.exec(`CREATE TABLE public.${table} (LIKE ${schema}.${table})`);
		await database.exec(`REVOKE ALL ON public.${table} FROM PUBLIC`);
	}
	return { database, tables };
}

/** A database whose every statement is recorded, in transactions too, so a test sees the DDL a store runs. */
function recording(database: SqliteDatabase, statements: string[]): SqliteDatabase {
	const executor = <E extends SqliteExecutor>(target: E): E =>
		new Proxy(target, {
			get(object, key, receiver) {
				const value = Reflect.get(object, key, receiver);
				if (key === "exec" || key === "run" || key === "get" || key === "all")
					return (sql: string, ...params: unknown[]) => {
						statements.push(sql);
						return (value as (...args: unknown[]) => unknown).call(object, sql, ...params);
					};
				if (key === "transaction")
					return (body: (tx: SqliteExecutor) => Promise<unknown>, ...rest: unknown[]) =>
						(value as (...args: unknown[]) => unknown).call(
							object,
							(tx: SqliteExecutor) => body(executor(tx)),
							...rest,
						);
				if (key === "batch" && typeof value === "function")
					return (batch: readonly { sql: string }[], ...rest: unknown[]) => {
						statements.push(...batch.map((statement) => statement.sql));
						return (value as (...args: unknown[]) => unknown).call(object, batch, ...rest);
					};
				return typeof value === "function" ? value.bind(object) : value;
			},
		});
	return executor(database);
}

/** Runs `atomic storage migrate --db <url> --password-file <file> --prefix <prefix>` as `role`. */
async function migrateAs(roles: Roles, role: "owner" | "runtime", prefix = PREFIX) {
	const root = makeTempDirectory("storage-postgres-migrate-");
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [postgresPackage] }));
		const passwordFile = join(root, "password");
		writeFileSync(passwordFile, roles.passwords[role], { mode: 0o600 });
		const out: string[] = [];
		const err: string[] = [];
		const code = await runStorageCommand(
			["migrate", "--db", roles.urls[role], "--password-file", passwordFile, "--prefix", prefix],
			{
				cwd: root,
				agentDir,
				log: (line) => out.push(line),
				error: (line) => err.push(line),
				loadBrokerState: () => import("../../packages/intercom/broker/open-broker-state.js"),
			},
		);
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		removeTempDirectory(root);
	}
}

/** A presence lease's subject for the session `targetIdentity`. */
const presenceSubject = (targetIdentity: string) =>
	({
		kind: "presence",
		targetIdentity,
		session: {
			id: targetIdentity,
			name: targetIdentity,
			cwd: "/",
			model: "m",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
		},
	}) as const;

/** `count` lease keys named `<phase>-<n>`. */
const keys = (phase: string, count: number) => Array.from({ length: count }, (_, index) => `${phase}-${index}`);

/** The order each presence lease under {@link PREFIX} was first acquired in, by key. */
async function presenceOrders(database: SqliteDatabase, schema: string): Promise<Map<string, number>> {
	const rows = await database.all<{ key: string; first_acquired_order: number | bigint }>(
		`SELECT key, first_acquired_order FROM ${schema}.${PREFIX}intercom_leases WHERE kind = 'presence'`,
	);
	return new Map(rows.map((row) => [row.key, Number(row.first_acquired_order)]));
}

/** The orders of the keys {@link keys} named for `phase`. */
const phase = (orders: ReadonlyMap<string, number>, name: string) =>
	[...orders].filter(([key]) => key.startsWith(`${name}-`)).map(([, order]) => order);

/** The statements of `sql` that define or change the schema. */
const ddl = (sql: string): string[] =>
	sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|DO)\b/i.test(statement));

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL owner and runtime roles (#5218)", () => {
	test.skipIf(process.platform === "win32")(
		"a runtime role with only the documented grants reads sessions and receives Intercom notifications without using the public tables (#5218)",
		async () => {
			await withRoles(async (scope, roles) => {
				// The owner sets the schema up, as `atomic storage migrate` or the first host joined as the owner does.
				await openEveryStore(() => roles.open("owner"), PREFIX);
				const schema = await grantRuntime(await roles.open("owner"), roles);
				assert.equal(schema, "atomic");
				// A decoy of every table in public, which neither role may touch: a statement that ran outside the schema
				// would fail, or write there.
				const decoys = await addDecoys(scope, schema);
				assert.ok(decoys.tables.length > 20, decoys.tables.join(", "));
				const runtime = () => roles.open("runtime");
				const sessions = await SqlSessionStore.open(await runtime(), { prefix: PREFIX });
				const listener = await openDatabaseWakeUpBus({
					prefix: PREFIX,
					openDatabase: runtime,
					pollIntervalMs: 60000,
				});
				const sender = await openDatabaseWakeUpBus({
					prefix: PREFIX,
					openDatabase: runtime,
					pollIntervalMs: 60000,
				});
				try {
					const header = {
						id: "runtime-session",
						version: 4 as const,
						createdAt: new Date(0).toISOString(),
						cwd: "/repo",
					};
					await sessions.create(header, []);
					assert.equal((await sessions.readHeader(header.id))?.id, header.id);
					const hints: string[] = [];
					await listener.subscribe("runtime-listener", (event) => {
						if (event.kind === "hint") hints.push(event.hint.reason);
					});
					await vi.waitFor(
						async () =>
							assert.ok(
								Number(
									(
										await scope.admin.get(
											"SELECT count(*) AS n FROM pg_stat_activity WHERE datname=? AND usename=? AND query LIKE 'LISTEN %'",
											scope.name,
											roles.runtime,
										)
									)?.n,
								) > 0,
							),
						{ timeout: 10000 },
					);
					await sender.publish({ brokerId: "runtime-listener", version: 1, reason: "outbox" });
					await vi.waitFor(() => assert.deepEqual(hints, ["outbox"]), { timeout: 5000 });
					for (const name of decoys.tables)
						assert.equal(
							Number((await decoys.database.get(`SELECT COUNT(*) AS n FROM public.${name}`))?.n),
							0,
							name,
						);
				} finally {
					await sender.close();
					await listener.close();
					await sessions.close();
				}
			});
		},
		60000,
	);

	test("atomic storage migrate sets sessions and Intercom up for the runtime role without granting it DDL (#5218)", async () => {
		await withRoles(async (_scope, roles) => {
			// The runtime role cannot set the schema up, and is told who can.
			const refused = await migrateAs(roles, "runtime");
			assert.equal(refused.code, 1);
			assert.match(refused.err, /missing-privilege/);
			assert.match(refused.err, /atomic storage migrate/);
			assert.doesNotMatch(refused.err, /^Error: .*\(42501\)$/m);

			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			assert.match(migrated.out, /set up for this version/);
			await grantRuntime(await roles.open("owner"), roles);
			const statements: string[] = [];
			const open = async () => recording(await roles.open("runtime"), statements);
			await (await SqlSessionStore.open(await open(), { prefix: PREFIX })).close();
			const broker = await openIntercomBrokerState({ prefix: PREFIX, openDatabase: open });
			// #6560: the ended-child queue, which a broker opens only when a subagent ends, finds its tables too.
			const queue = await broker.state.openEndedChildQueue!({ home: "runtime-home", holder: "runtime-broker" });
			await queue.close();
			await broker.bus.close();
			await broker.state.close();
			assert.deepEqual(statements.flatMap(ddl), []);
			// Again, as after an upgrade with nothing new: still nothing to change.
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
		});
	});

	test("a runtime role appends in one round trip once the owner's storage migrate creates the append function and grants it EXECUTE, in two before (#6599)", async () => {
		await withRoles(async (_scope, roles) => {
			// The tables as an earlier build set them up, without the function.
			await openEveryStore(() => roles.open("owner"), PREFIX);
			const owner = await roles.open("owner");
			const schema = String((await owner.get<{ schema: string }>("SELECT current_schema() AS schema"))?.schema);
			// Table privileges alone, on a server that grants new functions to no one: the runtime role may run the function
			// only by the grant storage migrate makes.
			for (const statement of [
				`ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
				`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`,
				`GRANT USAGE ON SCHEMA ${schema} TO ${roles.runtime}`,
				`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${roles.runtime}`,
				`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${roles.runtime}`,
				`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${roles.runtime}`,
			])
				await owner.exec(statement);
			/**
			 * The round trips of each of three appends to a new session, through a store the runtime role opens anew; the
			 * calls of the open's own reads and housekeeping are over before the first.
			 */
			const appendTrips = async (id: string) => {
				const sessions = await SqlSessionStore.open(await roles.open("runtime"), { prefix: PREFIX });
				try {
					const created = await sessions.create(
						{ id, version: 4, createdAt: new Date(0).toISOString(), cwd: "/repo" },
						[],
					);
					await sessions.load(id);
					const counted: number[] = [];
					let lastSeq = created.lastSeq;
					let parentId: string | null = null;
					for (const index of [1, 2, 3]) {
						const trips = countRoundTrips();
						try {
							const entry = {
								type: "message",
								id: `${id}-m${index}`,
								parentId,
								timestamp: new Date(0).toISOString(),
								message: { role: "user", content: `hello ${index}`, timestamp: 0 },
							} as SessionEntry;
							({ lastSeq } = await sessions.append(id, [entry], { expectSeq: lastSeq, epoch: created.epoch }));
							parentId = entry.id;
							counted.push(trips.take());
						} finally {
							trips.restore();
						}
					}
					return counted;
				} finally {
					await sessions.close();
				}
			};
			assert.deepEqual(await appendTrips("before"), [2, 2, 2]);
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			assert.deepEqual(await appendTrips("after"), [1, 1, 1]);
			const runtime = await roles.open("runtime");
			assert.equal(
				(await runtime.get<{ id: string }>(`SELECT id FROM ${PREFIX}session_sessions WHERE id = 'after'`))?.id,
				"after",
			);
			// Again, as after an upgrade with nothing new.
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.deepEqual(await appendTrips("again"), [1, 1, 1]);
		});
	});

	test("atomic storage migrate creates the chat records' table, which a runtime role then writes and reads without DDL (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const owner = await roles.open("owner");
			await grantRuntime(owner, roles);
			for (const name of ["r5218_session_chat_v1", "r5218_session_chat_v1_anchor"])
				assert.notEqual(
					(await owner.get<{ found: string | null }>("SELECT to_regclass(?) AS found", `atomic.${name}`))?.found,
					null,
					name,
				);
			const statements: string[] = [];
			const open = async () => recording(await roles.open("runtime"), statements);
			const write = async (id: string) => {
				const sessions = await SqlSessionStore.open(await open(), { prefix: PREFIX });
				try {
					const { epoch } = await sessions.create(
						{ id, version: 4, createdAt: new Date(0).toISOString(), cwd: "/repo" },
						[],
					);
					assert.ok(epoch);
					const chat = sessions.chatRecords!;
					await chat.append({ id, epoch }, "", { kind: "line", level: "error", text: "saved" });
					assert.deepEqual(await chat.read({ id, epoch }, [""]), [
						{ anchor: "", record: { kind: "line", level: "error", text: "saved" } },
					]);
				} finally {
					await sessions.close();
				}
			};
			await write("after-migrate");
			// As on a database where an earlier build created the table at a first chat record and recorded nothing.
			await owner.run("DELETE FROM r5218_atomic_migrations WHERE domain = 'schema:session-chat'");
			await write("unrecorded");
			assert.deepEqual(statements.flatMap(ddl), []);
		});
	});

	test("a runtime role clones whole sessions as main did until storage migrate creates the fork staging table, then a page at a time without DDL (#5594)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const owner = await roles.open("owner");
			const staging = `${PREFIX}session_fork_staging`;
			const stagingExists = async () =>
				(await owner.get("SELECT to_regclass(?) AS present", staging))?.present !== null;
			assert.ok(await stagingExists(), "storage migrate creates the staging table as the owner");
			// The database as an earlier release's migrate left it: no staging table.
			await owner.exec(`DROP TABLE ${staging}`);
			await grantRuntime(owner, roles);

			const source = await SqlSessionStore.open(await roles.open("runtime"), { prefix: PREFIX });
			const header = (id: string): SessionRecordHeader => ({
				id,
				version: SESSION_FORMAT_VERSION,
				createdAt: "2026-11-19T00:00:00.000Z",
				cwd: "/project",
			});
			const message = (id: string, parentId: string | null, text: string): SessionEntry =>
				({
					type: "message",
					id,
					parentId,
					timestamp: "2026-11-19T00:00:00.000Z",
					message: { role: "user", content: text, timestamp: 0 },
				}) as SessionEntry;
			await source.create(header("src"), [message("e1", null, "hello")]);
			const blob = await source.putBlob("src", new Uint8Array(3 * 1024 * 1024 + 5).fill(3));
			await source.append(
				"src",
				[
					message("e2", "e1", `big ${"x".repeat(1_500_000)}`),
					{
						type: "custom",
						id: "e3",
						parentId: "e2",
						timestamp: "2026-11-19T00:00:00.000Z",
						customType: "atomic.tool-output",
						data: { toolCallId: "call", hash: blob.hash, bytes: blob.bytes },
					} as SessionEntry,
				],
				{ expectSeq: 1 },
			);
			const clone = async (child: string, statements: string[]) => {
				const dest = await SqlSessionStore.open(recording(await roles.open("runtime"), statements), {
					prefix: PREFIX,
				});
				const head = await source.readEntrySizes("src", 1, 0);
				const created = await dest.createStagedFork(
					{ ...header(child), parentSessionId: "src" },
					completeSessionForkStream("src", head.epoch, head.lastSeq),
					{ store: source, sessionId: "src", epoch: head.epoch, hashes: [], receipts: new Map() },
				);
				if (created.remainingBlobs.length > 0)
					await copySessionBlobs(source, "src", dest, child, created.remainingBlobs);
				assert.deepEqual((await dest.load(child)).entries, (await source.load("src")).entries);
				assert.deepEqual(await dest.getBlob(child, blob.hash), await source.getBlob("src", blob.hash));
				return created;
			};

			// Before the migrate: the role may not create the table, so the clone is main's, with one hint.
			const warnings: string[] = [];
			const warned = (warning: Error) => warnings.push(warning.message);
			process.on("warning", warned);
			try {
				const before: string[] = [];
				const created = await clone("before", before);
				assert.deepEqual(created.remainingBlobs, [blob.hash], "main copies the blobs after the child");
				assert.ok(!(await stagingExists()));
				assert.ok(before.every((sql) => !sql.includes(`INSERT INTO ${staging}`)));
				await clone("before-again", []);
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(warnings.filter((text) => text.includes("atomic storage migrate")).length, 1);
			} finally {
				process.off("warning", warned);
			}

			// After the owner's migrate: the runtime role stages a page at a time and runs no DDL.
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.ok(await stagingExists());
			const after: string[] = [];
			const created = await clone("after", after);
			assert.deepEqual(created.remainingBlobs, []);
			assert.deepEqual(after.flatMap(ddl), []);
			assert.ok(
				after.some((sql) => sql.startsWith(`INSERT INTO ${staging}`)),
				"the clone was staged",
			);
			assert.equal(Number((await owner.get(`SELECT count(*) AS n FROM ${staging}`))!.n), 0);
		});
	});

	test("atomic storage migrate says when the owner role cannot install pg_trgm for session search, and is quiet once it can", async () => {
		await withRoles(async (scope, roles) => {
			// As on a managed server whose allow list leaves pg_trgm out: the owner role owns the schema, so it may create
			// Atomic's tables, but not the extension, which a role creates only with CREATE on the database.
			const admin = await scope.open();
			await admin.exec("CREATE SCHEMA IF NOT EXISTS atomic");
			await admin.exec(`ALTER SCHEMA atomic OWNER TO ${roles.owner}`);
			await scope.admin.exec(`ALTER DATABASE ${scope.name} OWNER TO CURRENT_USER`);
			const withoutExtension = await migrateAs(roles, "owner");
			assert.equal(withoutExtension.code, 0, withoutExtension.err);
			assert.match(withoutExtension.out, /set up for this version/);
			assert.match(withoutExtension.out, /pg_trgm/);
			assert.match(withoutExtension.out, /azure\.extensions/);
			assert.match(withoutExtension.out, /atomic storage migrate/);

			await scope.admin.exec(`GRANT CREATE ON DATABASE ${scope.name} TO ${roles.owner}`);
			const withExtension = await migrateAs(roles, "owner");
			assert.equal(withExtension.code, 0, withExtension.err);
			assert.doesNotMatch(withExtension.out, /pg_trgm/);
			assert.ok(await admin.get("SELECT 1 AS present FROM pg_catalog.pg_extension WHERE extname = 'pg_trgm'"));
		});
	});

	test("atomic storage migrate moves earlier tables and their contents from public without rewriting them (#5218, #4768)", async () => {
		await withRoles(async (scope, roles) => {
			// An earlier release's layout: every table in public, as the adapter keeps them for an explicit schema public.
			// On a managed server public is not the owner role's (Azure's belongs to azure_pg_admin): it is granted CREATE
			// there, as an earlier release's setup needed.
			await (await scope.open()).exec(`GRANT CREATE ON SCHEMA public TO ${roles.owner}`);
			const earlier = () => scope.open({ url: roles.urls.owner, password: roles.passwords.owner, schema: "public" });
			const old = await earlier();
			await seedLegacyStore(old, { prefix: PREFIX });
			const original = await dumpLegacyWorkflowTables(old, { prefix: PREFIX });

			// A default open of that database finds the earlier tables where they are.
			const found = await roles.open("owner");
			assert.equal((await found.get("SELECT current_schema() AS schema"))?.schema, "public");

			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			assert.match(migrated.out, /from schema public to schema atomic/);

			// A new open uses the atomic schema, with the run written before the move.
			const current = await roles.open("owner");
			assert.equal((await current.get("SELECT current_schema() AS schema"))?.schema, "atomic");
			assert.ok(await current.get(`SELECT run_id FROM ${PREFIX}wf_runs WHERE run_id = ?`, LEGACY_STORE.runId));
			assert.equal(await dumpLegacyWorkflowTables(current, { prefix: PREFIX }), original);
			assert.equal(
				(await scope.admin.get(`SELECT to_regclass('public.${PREFIX}wf_runs')::text AS name`))?.name,
				null,
			);
			// The runtime role then runs on the moved schema without DDL.
			await grantRuntime(current, roles);
			const statements: string[] = [];
			await openEveryStore(async () => recording(await roles.open("runtime"), statements), PREFIX);
			assert.deepEqual(statements.flatMap(ddl), []);
		});
	});

	test(
		"16 hosts that start at once on a new database set its schema up once, without a DDL race (#5218)",
		async () => {
			await withPostgresDatabase(async (scope) => {
				await Promise.all(
					Array.from({ length: CONCURRENT_HOSTS }, () =>
						openEveryStore(() => scope.open({ maxConnections: 2 }), PREFIX),
					),
				);
				const database = await scope.open();
				assert.equal((await database.get("SELECT current_schema() AS schema"))?.schema, "atomic");
				const recorded = await database.all(
					`SELECT domain, count(*) AS n FROM ${PREFIX}atomic_migrations WHERE domain LIKE 'schema:%' GROUP BY domain`,
				);
				assert.ok(recorded.length > 10, JSON.stringify(recorded));
				for (const row of recorded) assert.equal(Number(row.n), 1, JSON.stringify(row));
			});
		},
		CONCURRENT_HOSTS_TIMEOUT_MS,
	);

	test("an earlier release's Intercom broker reopening after the move is refused at its first write and creates nothing in public (#5218)", async () => {
		await withRoles(async (scope, roles) => {
			await (await scope.open()).exec(`GRANT CREATE ON SCHEMA public TO ${roles.owner}`);
			const earlier = () => scope.open({ url: roles.urls.owner, password: roles.passwords.owner, schema: "public" });
			await openEveryStore(earlier, PREFIX);
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const { openIntercomBrokerState: openEarlierBroker } = (await import(earlierBroker)) as {
				openIntercomBrokerState: typeof openIntercomBrokerState;
			};
			const refused = await openEarlierBroker({ prefix: PREFIX, openDatabase: earlier }).then(
				async (broker) => {
					// A broker that opened then writes: its first write is refused.
					await broker.state.close().catch(() => {});
					await broker.bus.close().catch(() => {});
					return undefined;
				},
				(error: Error) => error,
			);
			assert.ok(refused !== undefined, "the earlier broker opened public as if nothing had moved");
			assert.match(inspect(refused, { depth: null }), /moved its tables to schema atomic/);
			const current = await roles.open("owner");
			assert.deepEqual(await strayPostgresStorageTables(current), []);
			// Re-running migrate finds nothing astray.
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
		});
	});

	test("a process that opened public before the move refuses to create anything there afterwards, and migrate reports a stray table (#5218)", async () => {
		await withRoles(async (scope, roles) => {
			await (await scope.open()).exec(`GRANT CREATE ON SCHEMA public TO ${roles.owner}`);
			const earlier = () => scope.open({ url: roles.urls.owner, password: roles.passwords.owner, schema: "public" });
			await openEveryStore(earlier, PREFIX);
			// Opened during the rollout: it finds the earlier tables in public.
			const stale = await roles.open("owner");
			assert.equal((await stale.get("SELECT current_schema() AS schema"))?.schema, "public");
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const refused = await openIntercomBrokerState({ prefix: PREFIX, openDatabase: async () => stale }).then(
				() => undefined,
				(error: Error) => error,
			);
			assert.ok(refused !== undefined, "the stale process set Intercom up in public again");
			assert.match(inspect(refused, { depth: null }), /upgraded since this process started/);
			assert.deepEqual(await strayPostgresStorageTables(await roles.open("owner")), []);
			// A table an earlier process did create in public after the move is reported, and fails the migration.
			const admin = await scope.open();
			await admin.exec(`DROP TABLE public.${PREFIX}intercom_held_sends`);
			await admin.exec(`CREATE TABLE public.${PREFIX}intercom_held_sends (message_id TEXT)`);
			const reported = await migrateAs(roles, "owner");
			assert.equal(reported.code, 1);
			assert.match(
				reported.out,
				new RegExp(`in schema public that a process created after the move.*${PREFIX}intercom_held_sends`),
			);
		});
	});

	test("a database whose atomic schema was dropped after the move starts afresh instead of reading the fences left in public (#5218)", async () => {
		await withRoles(async (scope, roles) => {
			await (await scope.open()).exec(`GRANT CREATE ON SCHEMA public TO ${roles.owner}`);
			await openEveryStore(
				() => scope.open({ url: roles.urls.owner, password: roles.passwords.owner, schema: "public" }),
				PREFIX,
			);
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			// The operator starts over: the moved tables go, the fences stay in public.
			await (await roles.open("owner")).exec("DROP SCHEMA atomic CASCADE");
			await openEveryStore(() => roles.open("owner"), PREFIX);
			const reopened = await roles.open("owner");
			assert.equal((await reopened.get("SELECT current_schema() AS schema"))?.schema, "atomic");
			assert.deepEqual(await strayPostgresStorageTables(reopened), []);
		});
	});

	test("three concurrent migrations of an earlier release's database move it once, and the others say so (#5218)", async () => {
		await withRoles(async (scope, roles) => {
			await (await scope.open()).exec(`GRANT CREATE ON SCHEMA public TO ${roles.owner}`);
			await openEveryStore(
				() => scope.open({ url: roles.urls.owner, password: roles.passwords.owner, schema: "public" }),
				PREFIX,
			);
			const runs = await Promise.all([1, 2, 3].map(() => migrateAs(roles, "owner")));
			for (const run of runs) assert.equal(run.code, 0, run.err);
			assert.equal(
				runs.filter((run) => /Moved \d+ tables/.test(run.out)).length,
				1,
				runs.map((run) => run.out).join("\n"),
			);
			assert.equal(runs.filter((run) => /moved the tables to schema atomic first/.test(run.out)).length, 2);
		});
	});

	test("a runtime role missing its table grants, or USAGE on the schema, is told the exact grant before any DDL runs (#5218)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const owner = await roles.open("owner");
			const refusal = async () => {
				const error = await SqlSessionStore.open(await roles.open("runtime"), { prefix: PREFIX }).then(
					async (store) => {
						await store.close();
						return undefined;
					},
					(caught: Error) => caught,
				);
				assert.ok(error !== undefined, "the runtime role opened the session store");
				return inspect(error, { depth: null });
			};
			// No USAGE on the schema.
			const noUsage = await refusal();
			assert.match(noUsage, /missing-privilege/);
			assert.match(noUsage, new RegExp(`GRANT USAGE ON SCHEMA atomic TO "${roles.runtime}"`));
			// USAGE, but no table grants: the tables exist, and the fix is the table grant, not a migration.
			await owner.exec(`GRANT USAGE ON SCHEMA atomic TO ${roles.runtime}`);
			const noTables = await refusal();
			assert.match(noTables, /missing-privilege/);
			assert.match(
				noTables,
				new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO "${roles.runtime}"`),
			);
			assert.doesNotMatch(noTables, /storage migrate/);
		});
	});

	test("a runtime role binds Intercom ids as before on a schema from before id owners, and owns them once migrate adds the columns, without DDL (#5607)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
			// As an earlier release left the table: without the owner columns.
			await ownerDatabase.exec(
				`ALTER TABLE ${row?.schema}.${PREFIX}intercom_session_bindings
				 DROP COLUMN owner_token, DROP COLUMN owner_broker, DROP COLUMN owner_renewed_at`,
			);
			await grantRuntime(ownerDatabase, roles);
			const owner = (token: string) => ({ token, brokerId: `broker-${token}`, staleAfterMs: 60_000 });
			const before = await openSqlKnownSessionStore({ database: await roles.open("runtime"), prefix: PREFIX });
			assert.equal(before.owners, undefined, "without the columns the store keeps no owners");
			assert.deepEqual(await before.bind("owned-id", "address", 60_000, undefined, owner("first")), {
				status: "bound",
			});
			assert.deepEqual(
				await before.bind("owned-id", "address", 60_000, undefined, owner("second")),
				{ status: "bound" },
				"bound by return address alone, as before",
			);

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			const statements: string[] = [];
			const after = await openSqlKnownSessionStore({
				database: recording(await roles.open("runtime"), statements),
				prefix: PREFIX,
			});
			assert.ok(after.owners !== undefined, "the store keeps owners once the columns are there");
			assert.deepEqual(await after.bind("owned-id", "address", 60_000, undefined, owner("third")), {
				status: "bound",
			});
			assert.deepEqual(await after.bind("owned-id", "address", 60_000, undefined, owner("fourth")), {
				status: "held",
				ownerBroker: "broker-third",
			});
			assert.deepEqual(statements.flatMap(ddl), [], "the runtime role ran no DDL");
		});
	});

	test("a runtime role acquires leases in a unique order on a schema without the order sequence, and takes the sequence once migrate creates it, without DDL (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
			const schema = String(row?.schema);
			// As an earlier release left the schema: no order sequence, and no ledger record of it.
			await ownerDatabase.exec(`DROP SEQUENCE ${schema}.${PREFIX}intercom_leases_order`);
			await ownerDatabase.run(
				`DELETE FROM ${schema}.${PREFIX}atomic_migrations WHERE domain = ?`,
				"schema:intercom-lease-order",
			);
			await grantRuntime(ownerDatabase, roles);
			const presence = (targetIdentity: string) =>
				({
					kind: "presence",
					targetIdentity,
					session: {
						id: targetIdentity,
						name: targetIdentity,
						cwd: "/",
						model: "m",
						pid: 1,
						startedAt: 1,
						lastActivity: 1,
					},
				}) as const;
			const acquireAll = async (targets: readonly string[]) => {
				const stores = await Promise.all(
					[0, 1, 2].map(async () =>
						openSqlBrokerLeaseStore({ database: await roles.open("runtime"), prefix: PREFIX }),
					),
				);
				const acquired = await Promise.all(
					targets.map((target, index) =>
						stores[index % stores.length]!.acquire(presence(target), "broker-a", 60_000),
					),
				);
				assert.deepEqual(new Set(acquired.map((result) => result.status)), new Set(["acquired"]));
			};
			await acquireAll(Array.from({ length: 12 }, (_, index) => `before-${index}`));

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			const statements: string[] = [];
			const after = await openSqlBrokerLeaseStore({
				database: recording(await roles.open("runtime"), statements),
				prefix: PREFIX,
			});
			assert.equal((await after.acquire(presence("after-first"), "broker-a", 60_000)).status, "acquired");
			await acquireAll(Array.from({ length: 12 }, (_, index) => `after-${index}`));
			assert.deepEqual(statements.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.ok(
				statements.some((statement) =>
					statement.includes(`nextval(to_regclass('${PREFIX}intercom_leases_order'))`),
				),
				"the acquisition took its order from the sequence",
			);
			const orders = await ownerDatabase.all<{ first_acquired_order: number | bigint }>(
				`SELECT first_acquired_order FROM ${schema}.${PREFIX}intercom_leases WHERE kind = 'presence'`,
			);
			assert.equal(orders.length, 25);
			assert.equal(new Set(orders.map((order) => Number(order.first_acquired_order))).size, 25);
		});
	});

	test("a runtime store opened before migrate creates the order sequence takes its order from it afterwards, as one opened after does, so no two leases share an order (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const schema = String(
				(await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema"))?.schema,
			);
			// As an earlier release left the schema: no order sequence, and no ledger record of it.
			await ownerDatabase.exec(`DROP SEQUENCE ${schema}.${PREFIX}intercom_leases_order`);
			await ownerDatabase.run(
				`DELETE FROM ${schema}.${PREFIX}atomic_migrations WHERE domain = ?`,
				"schema:intercom-lease-order",
			);
			await grantRuntime(ownerDatabase, roles);
			const early = await Promise.all(
				[0, 1, 2].map(async () =>
					openSqlBrokerLeaseStore({ database: await roles.open("runtime"), prefix: PREFIX }),
				),
			);
			const acquire = async (stores: readonly BrokerLeaseStore[], targets: readonly string[]) => {
				const acquired = await Promise.all(
					targets.map((target, index) =>
						stores[index % stores.length]!.acquire(presenceSubject(target), "broker-a", 60_000),
					),
				);
				assert.deepEqual(new Set(acquired.map((result) => result.status)), new Set(["acquired"]));
			};
			await acquire(early, keys("before", 9));

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			const late = await openSqlBrokerLeaseStore({ database: await roles.open("runtime"), prefix: PREFIX });
			await acquire([...early, late], keys("after", 16));

			const orders = await presenceOrders(ownerDatabase, schema);
			assert.equal(orders.size, 25);
			assert.equal(new Set(orders.values()).size, 25, "no two leases share an order");
			assert.ok(
				Math.max(...phase(orders, "before")) < Math.min(...phase(orders, "after")),
				"every lease acquired after migrate comes after every lease acquired before it",
			);
		});
	});

	test("a dropped order sequence makes acquisitions take their order from the counter instead of failing, and migrate creates it again past every order taken (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const schema = String(
				(await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema"))?.schema,
			);
			await grantRuntime(ownerDatabase, roles);
			const opened = await openSqlBrokerLeaseStore({ database: await roles.open("runtime"), prefix: PREFIX });
			const acquire = async (store: BrokerLeaseStore, targets: readonly string[]) => {
				const acquired = await Promise.all(
					targets.map((target) => store.acquire(presenceSubject(target), "broker-a", 60_000)),
				);
				assert.deepEqual(new Set(acquired.map((result) => result.status)), new Set(["acquired"]));
			};
			await acquire(opened, keys("sequenced", 5));

			// Dropped by hand; the ledger still records the step.
			await ownerDatabase.exec(`DROP SEQUENCE ${schema}.${PREFIX}intercom_leases_order`);
			await acquire(opened, keys("dropped-open", 4));
			const reopened = await openSqlBrokerLeaseStore({ database: await roles.open("runtime"), prefix: PREFIX });
			await acquire(reopened, keys("dropped-reopened", 4));

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.ok(
				await ownerDatabase.get(
					"SELECT 1 AS found FROM pg_class WHERE relname = ?",
					`${PREFIX}intercom_leases_order`,
				),
				"migrate created the sequence again",
			);
			await acquire(opened, keys("recreated", 4));

			const orders = await presenceOrders(ownerDatabase, schema);
			assert.equal(orders.size, 17);
			assert.equal(new Set(orders.values()).size, 17, "no two leases share an order");
			const dropped = [...phase(orders, "dropped-open"), ...phase(orders, "dropped-reopened")];
			assert.ok(Math.max(...phase(orders, "sequenced")) < Math.min(...dropped));
			assert.ok(Math.max(...dropped) < Math.min(...phase(orders, "recreated")));
		});
	});

	test("migrate sets the fillfactor of the sessions and lease tables, which a runtime role leaves alone without DDL, and a warm open does not check again (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
			const schema = String(row?.schema);
			const tables = [`${PREFIX}session_sessions`, `${PREFIX}intercom_leases`];
			const steps = ["schema:session-fillfactor", "schema:intercom-lease-fillfactor"];
			const fillfactors = async () =>
				Object.fromEntries(
					(
						await ownerDatabase.all<{ name: string; options: string | null }>(
							`SELECT c.relname AS name, array_to_string(c.reloptions, ',') AS options FROM pg_class c
							JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ? AND c.relname IN (?, ?)`,
							schema,
							...tables,
						)
					).map((table) => [
						table.name,
						// Only the fillfactor: migrate sets autovacuum settings on these tables too.
						(table.options ?? "").split(",").find((option) => option.startsWith("fillfactor=")) ?? null,
					]),
				);
			const recorded = async () =>
				(
					await ownerDatabase.all<{ domain: string }>(
						`SELECT domain FROM ${schema}.${PREFIX}atomic_migrations WHERE domain IN (?, ?) ORDER BY domain`,
						...steps,
					)
				).map((step) => step.domain);
			const tuned = Object.fromEntries(tables.map((table) => [table, "fillfactor=80"]));
			assert.deepEqual(await fillfactors(), tuned);
			assert.deepEqual(await recorded(), [...steps].sort());

			// As an earlier release left the schema: the default fillfactor, and no ledger record of the steps.
			for (const table of tables) await ownerDatabase.exec(`ALTER TABLE ${schema}.${table} RESET (fillfactor)`);
			await ownerDatabase.run(`DELETE FROM ${schema}.${PREFIX}atomic_migrations WHERE domain IN (?, ?)`, ...steps);
			await grantRuntime(ownerDatabase, roles);
			const openAsRuntime = async (statements: string[]) => {
				const sessions = await SqlSessionStore.open(recording(await roles.open("runtime"), statements), {
					prefix: PREFIX,
				});
				const header = (id: string): SessionRecordHeader => ({
					id,
					version: SESSION_FORMAT_VERSION,
					cwd: "/work",
					createdAt: "2026-11-25T00:00:00.000Z",
				});
				const id = `s-${statements.length}-${randomUUID()}`;
				const created = await sessions.create(header(id), []);
				const entry = {
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-11-25T00:00:01.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				} as SessionEntry;
				await sessions.append(id, [entry], { expectSeq: created.lastSeq, epoch: created.epoch });
				await sessions.close();
				const broker = await openIntercomBrokerState({
					prefix: PREFIX,
					openDatabase: async () => recording(await roles.open("runtime"), statements),
				});
				await broker.bus.close();
				await broker.state.close();
			};
			const before: string[] = [];
			await openAsRuntime(before);
			assert.deepEqual(before.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.deepEqual(await fillfactors(), { [tables[0]!]: null, [tables[1]!]: null });

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.deepEqual(await fillfactors(), tuned);
			assert.deepEqual(await recorded(), [...steps].sort());
			const warm: string[] = [];
			await openAsRuntime(warm);
			assert.deepEqual(warm.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.deepEqual(
				warm.filter((statement) => statement.includes("reloptions")),
				[],
				"a warm open finds the steps in the catalog it read",
			);
		});
	});

	test("migrate makes the wake-up hint log unlogged, which a runtime role leaves logged without DDL, and a warm open does not check again (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
			const schema = String(row?.schema);
			const table = `${PREFIX}intercom_wakeups`;
			const step = "schema:intercom-wakeups-unlogged";
			const persistence = async () =>
				(
					await ownerDatabase.get<{ persistence: string }>(
						`SELECT c.relpersistence AS persistence FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
						WHERE n.nspname = ? AND c.relname = ?`,
						schema,
						table,
					)
				)?.persistence;
			const recorded = async () =>
				(await ownerDatabase.get(
					`SELECT 1 AS found FROM ${schema}.${PREFIX}atomic_migrations WHERE domain = ?`,
					step,
				)) !== undefined;
			assert.equal(await persistence(), "u", "a new hint log is unlogged");
			assert.equal(await recorded(), true);

			// As an earlier release left the schema: a logged hint log, and no ledger record of the step.
			await ownerDatabase.exec(`ALTER TABLE ${schema}.${table} SET LOGGED`);
			await ownerDatabase.run(`DELETE FROM ${schema}.${PREFIX}atomic_migrations WHERE domain = ?`, step);
			await grantRuntime(ownerDatabase, roles);
			const wakeUpAsRuntime = async (statements: string[]) => {
				const open = async () => recording(await roles.open("runtime"), statements);
				const bus = await openDatabaseWakeUpBus({ openDatabase: open, prefix: PREFIX });
				try {
					const hints: number[] = [];
					const subscribed = await bus.subscribe("broker-a", (event) => {
						if (event.kind === "hint") hints.push(event.hint.version);
					});
					assert.equal(subscribed.status, "subscribed");
					assert.equal(
						(await bus.publish({ brokerId: "broker-a", reason: "outbox", version: 7 })).status,
						"published",
					);
					const deadline = Date.now() + HINT_ARRIVAL_BOUND_MS;
					while (hints.length === 0 && Date.now() < deadline)
						await new Promise((resolve) => setTimeout(resolve, 10));
					assert.deepEqual(hints, [7], "the hint reached its broker");
				} finally {
					await bus.close();
				}
			};
			const before: string[] = [];
			await wakeUpAsRuntime(before);
			assert.deepEqual(before.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.equal(await persistence(), "p", "a runtime role leaves the hint log logged");

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.equal(await persistence(), "u");
			assert.equal(await recorded(), true);
			const warm: string[] = [];
			await wakeUpAsRuntime(warm);
			assert.deepEqual(warm.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.deepEqual(
				warm.filter((statement) => statement.includes("relpersistence")),
				[],
				"a warm open finds the step in the catalog it read",
			);
		});
	});

	test("before migrate records the fillfactor, a runtime role's process checks each table once, and its later opens take the round trips of a current schema (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const schema = String(
				(await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema"))?.schema,
			);
			// As an earlier release left the schema: the default fillfactor, and no ledger record of the steps.
			for (const table of [`${PREFIX}session_sessions`, `${PREFIX}intercom_leases`])
				await ownerDatabase.exec(`ALTER TABLE ${schema}.${table} RESET (fillfactor)`);
			await ownerDatabase.run(
				`DELETE FROM ${schema}.${PREFIX}atomic_migrations WHERE domain IN (?, ?)`,
				"schema:session-fillfactor",
				"schema:intercom-lease-fillfactor",
			);
			await grantRuntime(ownerDatabase, roles);
			/** A process's open of its session store, then of its broker, each on handles of its own, as an agent's. */
			const openAsRuntime = async () => {
				const statements: string[] = [];
				const open = async () => recording(await roles.open("runtime"), statements);
				const trips = countRoundTrips();
				try {
					const sessions = await SqlSessionStore.open(await open(), { prefix: PREFIX });
					// Each read-only transaction's commit is answered after the open returned: counted before the next open.
					await sleep(COMMIT_SETTLE_MS);
					const session = trips.take();
					const broker = await openIntercomBrokerState(
						{ prefix: PREFIX, openDatabase: open },
						{ pollIntervalMs: 60_000 },
					);
					await sleep(COMMIT_SETTLE_MS);
					const intercom = trips.take();
					await broker.bus.close();
					await broker.state.close();
					await sessions.close();
					return {
						session,
						intercom,
						fillfactorChecks: statements.filter((statement) => statement.includes("reloptions")).length,
					};
				} finally {
					trips.restore();
				}
			};
			// The first open checks the sessions and lease tables. The session store's check takes a round trip of its own;
			// the lease table's is sent behind the commit of the broker's catalog read, so it costs a statement but no
			// round trip.
			const first = await openAsRuntime();
			assert.equal(first.fillfactorChecks, 2);
			assert.equal(first.session, 5);
			// Every later open of the process checks neither, and takes the round trips of an open after migrate. Before,
			// each made both checks again, and the session store's open took 5 round trips.
			const current = { session: 4, intercom: 3, fillfactorChecks: 0 };
			assert.deepEqual(await openAsRuntime(), current);
			assert.deepEqual(await openAsRuntime(), current);
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.deepEqual(await openAsRuntime(), current);
		});
	});

	test("migrate sets autovacuum on the busy tables and lz4 on the large columns, keeps a value the administrator chose, and changes nothing once they are set (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
			const schema = String(row?.schema);
			const lz4 =
				(await ownerDatabase.get(
					"SELECT 1 AS found FROM pg_settings WHERE name = 'default_toast_compression' AND 'lz4' = ANY(enumvals)",
				)) !== undefined;
			const options = async (table: string) =>
				(
					(
						await ownerDatabase.get<{ options: string | null }>(
							`SELECT array_to_string(c.reloptions, ',') AS options FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
						WHERE n.nspname = ? AND c.relname = ?`,
							schema,
							`${PREFIX}${table}`,
						)
					)?.options ?? ""
				)
					.split(",")
					.filter((option) => option !== "")
					.sort();
			const compression = async (table: string, column: string) =>
				(
					await ownerDatabase.get<{ method: string }>(
						`SELECT a.attcompression AS method FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
						JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ? AND c.relname = ? AND a.attname = ?`,
						schema,
						`${PREFIX}${table}`,
						column,
					)
				)?.method;
			const busy = (threshold: number, analyze = threshold) =>
				[
					"autovacuum_analyze_scale_factor=0",
					`autovacuum_analyze_threshold=${analyze}`,
					"autovacuum_vacuum_scale_factor=0",
					`autovacuum_vacuum_threshold=${threshold}`,
				].sort();
			assert.deepEqual(await options("session_sessions"), [...busy(500), "fillfactor=80"].sort());
			assert.deepEqual(await options("intercom_leases"), [...busy(500), "fillfactor=80"].sort());
			assert.deepEqual(await options("snapshot_session_links"), busy(1000));
			assert.deepEqual(await options("session_entries"), [], "an insert-only table keeps the server's settings");
			for (const [table, column] of [
				["session_entries", "entry_json"],
				["session_entry_chunks", "data"],
				["session_blob_chunks", "data"],
				["snapshot_blobs", "data"],
				["intercom_outbox", "frame_json"],
			] as const)
				assert.equal(await compression(table, column), lz4 ? "l" : "", `${table}.${column}`);

			// An administrator's own threshold stays; a setting removed since is set again.
			await ownerDatabase.exec(
				`ALTER TABLE ${schema}.${PREFIX}session_sessions RESET (autovacuum_analyze_threshold), SET (autovacuum_vacuum_threshold = 2000)`,
			);
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.match(again.out, new RegExp(`on 1 table: ${PREFIX}session_sessions\\.`));
			assert.deepEqual(await options("session_sessions"), [...busy(2000, 500), "fillfactor=80"].sort());
			const settled = await migrateAs(roles, "owner");
			assert.equal(settled.code, 0, settled.err);
			assert.doesNotMatch(settled.out, /Tuned/, "a tuned database changes nothing");
		});
	});

	test("migrate takes the leaf condition out of the session links' indexes, which a runtime role leaves alone without DDL, and a warm open does not check again (#6560)", async () => {
		await withRoles(async (_scope, roles) => {
			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			const ownerDatabase = await roles.open("owner");
			const row = await ownerDatabase.get<{ schema: string }>("SELECT current_schema() AS schema");
			const schema = String(row?.schema);
			const links = `${PREFIX}snapshot_session_links`;
			const step = "schema:snapshot-links-hot";
			const indexes = async () =>
				(
					await ownerDatabase.all<{ name: string; definition: string }>(
						"SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = ? AND tablename = ? ORDER BY indexname",
						schema,
						links,
					)
				).map((index) => `${index.name}: ${index.definition.replace(/^.* USING btree /, "")}`);
			const recorded = async () =>
				(
					await ownerDatabase.all<{ domain: string }>(
						`SELECT domain FROM ${schema}.${PREFIX}atomic_migrations WHERE domain = ?`,
						step,
					)
				).map((ledger) => ledger.domain);
			const hot = [
				`${links}_anchored: (session_id, anchor_seq) WHERE (anchor_seq IS NOT NULL)`,
				`${links}_broken: (session_id) WHERE (broken = 1)`,
				`${links}_entry: (session_id, entry_id)`,
				`${links}_pkey: (session_id, seq)`,
			];
			assert.deepEqual(await indexes(), hot);
			assert.deepEqual(await recorded(), [step]);

			// As an earlier release left the schema: the index of leaves, and no ledger record of the step.
			await ownerDatabase.exec(`DROP INDEX ${schema}.${links}_anchored`);
			await ownerDatabase.exec(
				`CREATE INDEX ${links}_leaves ON ${schema}.${links} (session_id, anchor_seq) WHERE children = 0 AND anchor_seq IS NOT NULL`,
			);
			await ownerDatabase.run(`DELETE FROM ${schema}.${PREFIX}atomic_migrations WHERE domain = ?`, step);
			const earlier = await indexes();
			assert.deepEqual(earlier, [
				`${links}_broken: (session_id) WHERE (broken = 1)`,
				`${links}_entry: (session_id, entry_id)`,
				`${links}_leaves: (session_id, anchor_seq) WHERE ((children = 0) AND (anchor_seq IS NOT NULL))`,
				`${links}_pkey: (session_id, seq)`,
			]);
			await grantRuntime(ownerDatabase, roles);
			const openAsRuntime = async (statements: string[]) => {
				const sessions = await SqlSessionStore.open(recording(await roles.open("runtime"), statements), {
					prefix: PREFIX,
				});
				const id = `s-${statements.length}-${randomUUID()}`;
				const created = await sessions.create(
					{ id, version: SESSION_FORMAT_VERSION, cwd: "/work", createdAt: "2026-11-26T00:00:00.000Z" },
					[],
				);
				const entry = {
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-11-26T00:00:01.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				} as SessionEntry;
				await sessions.append(id, [entry], { expectSeq: created.lastSeq, epoch: created.epoch });
				await sessions.close();
			};
			const before: string[] = [];
			await openAsRuntime(before);
			assert.deepEqual(before.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.deepEqual(await indexes(), earlier);

			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
			assert.deepEqual(await indexes(), hot);
			assert.deepEqual(await recorded(), [step]);
			const warm: string[] = [];
			await openAsRuntime(warm);
			assert.deepEqual(warm.flatMap(ddl), [], "the runtime role ran no DDL");
			assert.deepEqual(
				warm.filter((statement) => statement.includes("relowner")),
				[],
				"a warm open finds the step in the catalog it read",
			);
		});
	});

	test("a second open of every store on a current schema runs no DDL (#5218)", async () => {
		await withRoles(async (_scope, roles) => {
			await openEveryStore(() => roles.open("owner"), PREFIX);
			const statements: string[] = [];
			await openEveryStore(async () => recording(await roles.open("owner"), statements), PREFIX);
			assert.ok(statements.length > 0, "the stores' statements were recorded");
			assert.deepEqual(statements.flatMap(ddl), []);
		});
	});
});
