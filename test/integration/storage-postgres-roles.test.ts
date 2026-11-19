import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { SqliteDatabase, SqliteExecutor } from "@bastani/atomic/storage";
import pg from "pg";
import { describe, test } from "vitest";
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
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { listenPoolReady, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { readFleetRateUsage, SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { JournalSchemaVersionError, type Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import * as workerHost from "../../packages/workflows/src/workers/worker-host.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	openPostgresAdmin,
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * PostgreSQL with two roles (#5218): an owner role that sets up and migrates Atomic's schema, and a runtime role with
 * only the privileges docs/storage.md ("PostgreSQL roles") grants it, which must run worker hosts and roots without DDL.
 */

const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
const postgresAdapter = fileURLToPath(new URL("../../packages/storage-postgres/postgres.js", import.meta.url));
const postgresPackage = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");
/** The Intercom broker state as main shipped it before #5218, vendored: an earlier release's broker. */
const earlierBroker = resolve(moduleDir(import.meta.url), "../fixtures/intercom-pre-5218/broker/open-broker-state.ts");
const PREFIX = "r5218_";
const CHILDREN = 3;
/** Root A's pool and worker host B: two pools cold-start. */
const ROLES_BUDGET = poolTestBudgetMs(2);
/**
 * How long a running host's fenced pool write, and another host's open of the pool, may take while a stalled transaction
 * holds a pool table: far below the 30 s statement timeout a DDL lock wait used to run into.
 */
const STALLED_WRITE_BOUND_MS = 5_000;
/** Hosts that start together on a new database in the concurrent setup test. */
const CONCURRENT_HOSTS = 16;
/** Each host opens every store; they set the schema up one after another under its lock, then open it as it is. */
const CONCURRENT_HOSTS_TIMEOUT_MS = 120_000;
/** How long a committed pool write's wake-up may take to reach a listening runtime-role connection. */
const WAKE_BOUND_MS = 5_000;

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
	const journal = await SqlRunJournal.open(database, { prefix });
	try {
		const queue = await openSqlPoolQueue(journal);
		await openSqlPoolUsage(journal);
		await SqlSharedPool.open(journal, queue);
		await SqlFleetStore.open(journal);
		await SqlRateBuckets.open(journal);
		await SqlResourceAdmission.open(journal, { root: "root", holder: "holder" });
		await (await openPoolSessions(sqlPoolStorage(journal)!)).close();
	} finally {
		await journal.close();
	}
	await (await SqlRunJournal.open(database, { prefix })).close();
	const intercom = await openIntercomBrokerState({ prefix, openDatabase: open });
	await intercom.bus.close();
	await intercom.state.close();
}

/**
 * The runtime role's grants as docs/storage.md gives them, run as the owner on the schema the owner's tables are in:
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

/** The statements of `sql` that define or change the schema. */
const ddl = (sql: string): string[] =>
	sql
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => /^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|DO)\b/i.test(statement));

async function until(
	what: string,
	deadline: number,
	check: () => boolean | Promise<boolean>,
	watched: readonly BudgetedProcess[],
): Promise<void> {
	while (!(await check())) {
		for (const process of watched)
			if (process.process.exitCode !== null)
				assert.fail(`a process ended while waiting for ${what}:\n${await expectExitedCleanly(process)}`);
		if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL owner and runtime roles (#5218)", () => {
	test.skipIf(process.platform === "win32")(
		"a runtime role with only the documented runtime grants starts a worker host, claims and completes pooled work, and runs LISTEN/NOTIFY (#5218)",
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
				const directory = makeTempDirectory("storage-postgres-roles-");
				const deadline = Date.now() + ROLES_BUDGET.waitMs;
				const passwordFile = join(directory, "runtime-password");
				writeFileSync(passwordFile, roles.passwords.runtime, { mode: 0o600 });
				const env = (name: string) => ({
					...process.env,
					SHARED_POOL_HOST: name,
					SHARED_POOL_AGENT_DIR: join(directory, name, "agent"),
					SHARED_POOL_ADAPTER: postgresAdapter,
					SHARED_POOL_URL: roles.urls.runtime,
					SHARED_POOL_PREFIX: PREFIX,
					SHARED_POOL_ROOT: randomUUID(),
					SHARED_POOL_WORK_MS: "50",
					SHARED_POOL_TOKEN_FILE: passwordFile,
					SHARED_POOL_TOKEN_SECRET: "password",
				});
				let host: BudgetedProcess | undefined;
				try {
					host = spawnWithinBudget(
						[process.execPath, hostFixture, directory, "2"],
						{ cwd: directory, stdout: "ignore", env: env("B") },
						deadline,
					);
					const started = host;
					await until(
						"the runtime role's worker host",
						deadline,
						() => existsSync(join(directory, "host-ready-B")),
						[started],
					);
					// Its listening connection is the runtime role's own.
					await until(
						"the runtime role's listening connection",
						deadline,
						async () =>
							(await scope.admin.get(
								"SELECT 1 AS listening FROM pg_stat_activity WHERE datname = ? AND usename = ? AND application_name = 'atomic-listen' AND query LIKE 'LISTEN%pool_ready%'",
								scope.name,
								roles.runtime,
							)) !== undefined,
						[started],
					);
					const root = spawnWithinBudget(
						[process.execPath, rootFixture, "start", directory, String(CHILDREN), "1", "sequential"],
						{ cwd: directory, stdout: "ignore", env: env("A") },
						deadline,
					);
					await expectExitedCleanly(root);
					const outcome = await readJson<{ status: string; children: { status: string }[] }>(
						join(directory, "outcome-start.json"),
					);
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
					assert.equal(outcome.children.length, CHILDREN);
					const reader = await roles.open("owner");
					const work = await reader.all(`SELECT state FROM ${schema}.${PREFIX}wf_runs_work`);
					assert.deepEqual(
						work.map((row) => row.state),
						Array(CHILDREN).fill("completed"),
					);
					started.process.kill("SIGTERM");
					await expectExitedCleanly(started);
					host = undefined;
					for (const decoy of decoys.tables)
						assert.equal(
							Number((await decoys.database.get(`SELECT count(*) AS n FROM public.${decoy}`))?.n),
							0,
							decoy,
						);
				} finally {
					host?.process.kill("SIGKILL");
					removeTempDirectory(directory);
				}

				// A pool write by the runtime role wakes another runtime-role connection that listens.
				const writer = await roles.open("runtime");
				const listener = await SqlRunJournal.open(await roles.open("runtime"), { prefix: PREFIX });
				const woken: (string | undefined)[] = [];
				const subscription = listenPoolReady(listener, (root) => woken.push(root));
				assert.ok(subscription, "a journal on PostgreSQL delivers pool wake-ups");
				try {
					const wakeDeadline = Date.now() + WAKE_BOUND_MS;
					await until(
						"the runtime role's second listening connection",
						wakeDeadline,
						async () =>
							Number(
								(
									await scope.admin.get(
										"SELECT count(*) AS listening FROM pg_stat_activity WHERE datname = ? AND usename = ? AND application_name = 'atomic-listen' AND query LIKE 'LISTEN%pool_ready%'",
										scope.name,
										roles.runtime,
									)
								)?.listening,
							) > 0,
						[],
					);
					const notify = writer.notifications!.notify(`${PREFIX}pool_ready`, "probe");
					await writer.run(notify.sql, ...notify.params);
					await until("the wake-up", wakeDeadline, () => woken.includes("probe"), []);
				} finally {
					subscription.close();
					await listener.close();
				}
			});
		},
		ROLES_BUDGET.timeoutMs,
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
			await broker.bus.close();
			await broker.state.close();
			assert.deepEqual(statements.flatMap(ddl), []);
			// Again, as after an upgrade with nothing new: still nothing to change.
			const again = await migrateAs(roles, "owner");
			assert.equal(again.code, 0, again.err);
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

	test("atomic storage migrate moves earlier tables and fleet waiting counters from public, and refuses earlier writers (#5218, #4768)", async () => {
		await withRoles(async (scope, roles) => {
			// An earlier release's layout: every table in public, as the adapter keeps them for an explicit schema public.
			// On a managed server public is not the owner role's (Azure's belongs to azure_pg_admin): it is granted CREATE
			// there, as an earlier release's setup needed.
			await (await scope.open()).exec(`GRANT CREATE ON SCHEMA public TO ${roles.owner}`);
			const earlier = () => scope.open({ url: roles.urls.owner, password: roles.passwords.owner, schema: "public" });
			await openEveryStore(earlier, PREFIX);
			const running = await SqlRunJournal.open(await earlier(), { prefix: PREFIX });
			await running.createRun({ runId: "before", name: "w", cwd: "/", createdAt: 1, status: "running" });
			const earlierRates = await SqlRateBuckets.open(running);
			await earlierRates.acquire("p", 1, { intervalMs: 1_000, burst: 1 });
			const waitingEpoch = await earlierRates.registerWaiting("p", "h");
			await earlierRates.reportWaiting([{ reporter: "h", scope: "p", waitingMs: 750, epoch: waitingEpoch }]);
			// A default open of that database finds the earlier tables where they are.
			const found = await roles.open("owner");
			assert.equal((await found.get("SELECT current_schema() AS schema"))?.schema, "public");

			const migrated = await migrateAs(roles, "owner");
			assert.equal(migrated.code, 0, migrated.err);
			assert.match(migrated.out, /from schema public to schema atomic/);

			// The earlier process's next write is refused, as is its next open, rather than writing to public.
			await assert.rejects(
				running.createRun({ runId: "after", name: "w", cwd: "/", createdAt: 2, status: "running" }),
				JournalSchemaVersionError,
			);
			await assert.rejects(SqlRunJournal.open(await earlier(), { prefix: PREFIX }), JournalSchemaVersionError);
			// A new open uses the atomic schema, with the run written before the move.
			const current = await roles.open("owner");
			assert.equal((await current.get("SELECT current_schema() AS schema"))?.schema, "atomic");
			assert.ok(await current.get(`SELECT run_id FROM ${PREFIX}wf_runs WHERE run_id = 'before'`));
			assert.equal(
				(await scope.admin.get(`SELECT to_regclass('public.${PREFIX}wf_runs')::text AS name`))?.name,
				null,
			);
			// The runtime role then runs on the moved schema without DDL.
			await grantRuntime(current, roles);
			const migratedJournal = await SqlRunJournal.open(current, { prefix: PREFIX });
			const migratedRates = await SqlRateBuckets.open(migratedJournal);
			await migratedRates.reportWaiting([{ reporter: "h", scope: "p", waitingMs: 1_000, epoch: waitingEpoch }]);
			assert.equal((await readFleetRateUsage(migratedJournal))[0]?.waitingMs, 1_000);
			const statements: string[] = [];
			await openEveryStore(async () => recording(await roles.open("runtime"), statements), PREFIX);
			assert.deepEqual(statements.flatMap(ddl), []);
		});
	});

	test("a host opening the pool while a stalled transaction holds a pool table never delays a running host's fenced writes (#5218)", async () => {
		await withPostgresDatabase(async (scope) => {
			const { work, boundary } = poolWorkFixture();
			const journal = await SqlRunJournal.open(await scope.open(), { prefix: PREFIX });
			const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
			await backend.commitWorkflowRegistration({
				workflowId: "root",
				name: "root",
				inputs: {},
				createdAt: 0,
				status: "running",
			});
			const acquired = await journal.acquire("root", backend.holderId);
			const lease = (acquired as { lease: Lease }).lease;
			const pool = await openSqlPoolQueue(journal);
			await pool.initialize(lease, 60_000);
			await SqlSharedPool.open(journal, pool);
			await SqlResourceAdmission.open(journal, { root: "root", holder: "holder" });
			// The snapshot index covers the pool's tables from the next journal open on: the schema is now current.
			await (await SqlRunJournal.open(await scope.open(), { prefix: PREFIX })).close();
			await pool.enqueue(lease, work, boundary);
			// A host that vanished mid-transaction: its row lock on the work table stays until the server ends it.
			const schema = String((await (await scope.open()).get("SELECT current_schema() AS schema"))?.schema);
			const url = new URL(scope.url);
			const stalled = new pg.Client({
				host: url.hostname,
				port: Number(url.port || 5432),
				database: scope.name,
				user: decodeURIComponent(url.username),
				...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
				...(url.searchParams.get("sslmode") === "disable" || /^(127\.|localhost$)/.test(url.hostname)
					? {}
					: { ssl: { servername: url.hostname } }),
			});
			await stalled.connect();
			try {
				await stalled.query("BEGIN");
				await stalled.query(`UPDATE ${schema}.${PREFIX}wf_runs_work SET renewed_at = renewed_at WHERE id = 'none'`);
				const started = performance.now();
				const opening = (async () => {
					const other = await SqlRunJournal.open(await scope.open(), { prefix: PREFIX });
					try {
						await SqlSharedPool.open(other, await openSqlPoolQueue(other));
						await SqlResourceAdmission.open(other, { root: "root", holder: "other" });
					} finally {
						await other.close();
					}
					return performance.now() - started;
				})();
				const claimed = await pool.claim(
					lease,
					"worker",
					[{ definition: work.definition, digest: work.digest }],
					60_000,
				);
				const claimMs = performance.now() - started;
				assert.ok(claimed, "the running host claimed the queued child");
				assert.ok(claimMs < STALLED_WRITE_BOUND_MS, `the running host's claim took ${Math.round(claimMs)} ms`);
				const openMs = await opening;
				assert.ok(openMs < STALLED_WRITE_BOUND_MS, `the other host's open took ${Math.round(openMs)} ms`);
			} finally {
				await stalled.query("ROLLBACK").catch(() => {});
				await stalled.end();
				await backend.close();
				await journal.close();
			}
		});
	}, 60_000);

	test("a monitoring role with SELECT only reads the fleet's status without creating anything (#5218)", async () => {
		await withRoles(async (_scope, roles) => {
			await openEveryStore(() => roles.open("owner"), PREFIX);
			const owner = await roles.open("owner");
			const schema = String((await owner.get("SELECT current_schema() AS schema"))?.schema);
			await owner.exec(`GRANT USAGE ON SCHEMA ${schema} TO ${roles.runtime}`);
			await owner.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${roles.runtime}`);
			const directory = makeTempDirectory("storage-postgres-monitor-");
			try {
				const passwordFile = join(directory, "password");
				writeFileSync(passwordFile, roles.passwords.runtime, { mode: 0o600 });
				const fleet = await workerHost.readWorkflowWorkerFleet({
					journal: {
						adapter: postgresAdapter,
						options: { url: roles.urls.runtime },
						secrets: { password: { file: passwordFile } },
						prefix: PREFIX,
					},
					agentDir: join(directory, "agent"),
					probeWrites: false,
				});
				assert.equal(fleet.fleet.store.state, "ok", JSON.stringify(fleet.fleet.store));
			} finally {
				removeTempDirectory(directory);
			}
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
