import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";

/**
 * Hosts that ship their checkpoints keep their children's stage sessions, and the checkpoints that bill usage, in
 * their local journals too, and ship them in the background (#4768). On each shared store (a libSQL file, a libSQL
 * server, PostgreSQL), three hosts run a fan-out whose children hold in their stages' model calls, with nothing
 * shipped yet: then one host is killed, its children replay elsewhere from what it shipped, another host drains, the
 * killed host starts again from its local journal, and the root finishes. No session write, checkpoint or usage is
 * lost or doubled, and the journal holds each stage's transcript as the attempt that ended it wrote it.
 */

const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
const libsqlAdapter = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const postgresAdapter = fileURLToPath(new URL("../../packages/storage-postgres/postgres.js", import.meta.url));
const CHILDREN = 4;
/** A short work lease, so a replay starts within the test once the killed host's leases lapse. */
const LEASE_MS = 4_000;
/** Nothing ships on its own while the children hold: only a stage's end, a flush or the host's stop ships. */
const SHIPPING = { intervalMs: 60_000, maxBatch: 64, maxLagMs: 600_000 };
/** The root's pool and three worker hosts, one of them started twice. */
const BUDGET = poolTestBudgetMs(5);

type Row = Record<string, unknown>;

interface Store {
	readonly env: Record<string, string>;
	readonly prefix: string;
	/** Where the pool's stage sessions are: `<runs>_pool_`, or, on PostgreSQL, whose names are short, `<prefix>wf_ps_`. */
	readonly sessions: string;
	query(sql: string, ...args: (string | number)[]): Promise<Row[]>;
}

interface Backend {
	readonly name: string;
	readonly skip: string | undefined;
	with(directory: string, body: (store: Store) => Promise<void>): Promise<void>;
}

async function queryOn(open: () => Promise<SqliteDatabase>, sql: string, args: (string | number)[]): Promise<Row[]> {
	const database = await open();
	try {
		return await database.all(sql, ...args);
	} finally {
		await database.close();
	}
}

const sqldUrl = process.env.ATOMIC_TEST_LIBSQL_URL || undefined;
const backends: readonly Backend[] = [
	{
		name: "a libSQL file",
		skip: undefined,
		async with(directory, body) {
			const url = pathToFileURL(join(directory, "shared.db")).href;
			await body({
				prefix: "acme_",
				sessions: "acme_wf_runs_pool_",
				env: { SHARED_POOL_ADAPTER: libsqlAdapter, SHARED_POOL_URL: url, SHARED_POOL_PREFIX: "acme_" },
				query: (sql, ...args) => queryOn(() => openLibsqlDatabase({ url }), sql, args),
			});
		},
	},
	{
		name: "a libSQL server",
		skip: sqldUrl === undefined ? "ATOMIC_TEST_LIBSQL_URL is not set" : undefined,
		async with(_directory, body) {
			const url = sqldUrl!;
			const prefix = `g${randomBytes(3).toString("hex")}_`;
			try {
				await body({
					prefix,
					sessions: `${prefix}wf_runs_pool_`,
					env: { SHARED_POOL_ADAPTER: libsqlAdapter, SHARED_POOL_URL: url, SHARED_POOL_PREFIX: prefix },
					query: (sql, ...args) => queryOn(() => openLibsqlDatabase({ url }), sql, args),
				});
			} finally {
				const database = await openLibsqlDatabase({ url });
				try {
					await dropLibsqlScope(database, prefix);
				} finally {
					await database.close();
				}
			}
		},
	},
	{
		name: "PostgreSQL",
		skip: postgresSkipReason,
		async with(directory, body) {
			await withPostgresDatabase(async (database) => {
				const passwordFile = join(directory, "password");
				writeFileSync(passwordFile, postgresTestPassword ?? "", { mode: 0o600 });
				await body({
					prefix: "acme_",
					sessions: "acme_wf_ps_",
					env: {
						SHARED_POOL_ADAPTER: postgresAdapter,
						SHARED_POOL_URL: database.url,
						SHARED_POOL_PREFIX: "acme_",
						...(postgresTestPassword === undefined
							? {}
							: { SHARED_POOL_TOKEN_FILE: passwordFile, SHARED_POOL_TOKEN_SECRET: "password" }),
					},
					query: (sql, ...args) => queryOn(() => database.open(), sql, args),
				});
			});
		},
	},
];

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

const markers = (directory: string, prefix: string) => readdirSync(directory).filter((name) => name.startsWith(prefix));

for (const backend of backends)
	test.skipIf(backend.skip !== undefined || process.platform === "win32")(
		`on ${backend.name}, stage sessions and billed usage stay on their hosts and ship through a host's death, a drain and a restart, none lost or doubled (#4768)`,
		async () => {
			const directory = makeTempDirectory("shipped-sessions-");
			const root = randomUUID();
			const deadline = Date.now() + BUDGET.waitMs;
			const processes: BudgetedProcess[] = [];
			try {
				await backend.with(directory, async (store) => {
					const table = (name: string) => `${store.prefix}${name}`;
					const env = (name: string, extra: Record<string, string> = {}) => ({
						...process.env,
						...store.env,
						SHARED_POOL_HOST: name,
						SHARED_POOL_AGENT_DIR: join(directory, name, "agent"),
						SHARED_POOL_ROOT: root,
						SHARED_POOL_CHECKPOINT_SHIPPING: JSON.stringify(SHIPPING),
						SHARED_POOL_LEASE_MS: String(LEASE_MS),
						...extra,
					});
					const startHost = (name: string, workers: number, extra: Record<string, string> = {}) => {
						const host = spawnWithinBudget(
							[process.execPath, hostFixture, directory, String(workers)],
							{ cwd: directory, stdout: "ignore", env: env(name, extra), detached: true },
							deadline,
						);
						processes.push(host);
						return host;
					};
					const hostB = startHost("B", 2);
					await until("host B", deadline, () => existsSync(join(directory, "host-ready-B")), [hostB]);
					const rootA = spawnWithinBudget(
						[process.execPath, rootFixture, "start", directory, String(CHILDREN), "1", "sessions"],
						{ cwd: directory, stdout: "ignore", env: env("A"), detached: true },
						deadline,
					);
					processes.push(rootA);
					await until(
						"host B's children to hold in their stages",
						deadline,
						() => markers(directory, "holding-B-").length >= 2,
						[hostB, rootA],
					);
					// Host C drains on SIGTERM, as `atomic worker start` does.
					const hostC = startHost("C", 2, { SHARED_POOL_DRAIN_ON_TERM: "1" });
					await until(
						"every child to hold in its stage",
						deadline,
						() => markers(directory, "holding-").length >= CHILDREN,
						[hostB, hostC, rootA],
					);

					// Every child is in its stage's model call: its first step and its session's prompt went to its host's local
					// journal, none of it to the shared one directly. What reached the shared journal already, as a host ships
					// at least every minute, came in batches.
					assert.deepEqual(
						await store.query(
							`SELECT work FROM ${table("wf_runs_pool_operations")} WHERE operation NOT IN ('pool-confirmed', 'pool-handoff')`,
						),
						[],
						"no write was committed to the shared journal directly",
					);
					for (const { work } of await store.query(`SELECT work FROM ${store.sessions}session_owners`))
						assert.ok(
							(
								await store.query(
									`SELECT 1 AS shipped FROM ${table("wf_runs_ship_batches")} WHERE work = ?`,
									String(work),
								)
							).length > 0,
							`the session of ${work} came in a shipped batch`,
						);

					// Host B dies with its children's sessions unshipped; the stages go on everywhere else.
					process.kill(-hostB.process.pid!, "SIGKILL");
					await hostB.process.exited;
					writeFileSync(join(directory, "release"), "");
					// Host C drains: it takes nothing more, and finishes and ships the children it runs before it stops.
					hostC.process.kill("SIGTERM");
					await expectExitedCleanly(hostC);
					// Host B starts again from its local journal: what it kept for attempts another host took over is refused and
					// dropped, and it serves the root again.
					const restartedB = startHost("B", 2);
					await expectExitedCleanly(rootA);
					restartedB.process.kill("SIGTERM");
					await expectExitedCleanly(restartedB);

					const outcome = await readJson<{
						status: string;
						children: { status: string; firstHost?: string; finalHost?: string; reply?: string }[];
					}>(join(directory, "outcome-start.json"));
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
					assert.equal(outcome.children.length, CHILDREN);
					for (const child of outcome.children) assert.equal(child.status, "completed", JSON.stringify(child));
					const killed = markers(directory, "holding-B-").map((name) => Number(name.split("-")[2]));
					assert.ok(killed.length >= 2, "the killed host ran children");

					// Every checkpoint was recorded once, in a dense sequence.
					const events = await store.query(
						`SELECT seq, key FROM ${table("wf_events")} WHERE run_id = ? ORDER BY seq`,
						root,
					);
					assert.deepEqual(
						events.map((event) => Number(event.seq)),
						events.map((_, index) => index + 1),
					);
					const keys = events.flatMap((event) => (event.key === null ? [] : [String(event.key)]));
					assert.equal(new Set(keys).size, keys.length, "no checkpoint was recorded twice");

					// Each stage's transcript is in the shared journal as the attempt that ended the stage wrote it: its prompt,
					// then the reply the child returned, each once, every entry's parent in the same session.
					const entries = await store.query(
						`SELECT session_id, seq, entry_id, entry_json FROM ${store.sessions}session_entries ORDER BY session_id, seq`,
					);
					const sessions = new Map<string, { id: string; parentId: string | null; text: string }[]>();
					for (const row of entries) {
						const entry = JSON.parse(String(row.entry_json)) as { id: string; parentId: string | null };
						const list = sessions.get(String(row.session_id)) ?? [];
						list.push({ id: entry.id, parentId: entry.parentId, text: String(row.entry_json) });
						sessions.set(String(row.session_id), list);
					}
					for (const [session, list] of sessions) {
						const ids = list.map((entry) => entry.id);
						assert.equal(new Set(ids).size, ids.length, `session ${session} holds each entry once`);
						for (const entry of list)
							assert.ok(entry.parentId === null || ids.includes(entry.parentId), `session ${session} is whole`);
					}
					for (const [index, child] of outcome.children.entries()) {
						const prompted = [...sessions.values()].filter((list) =>
							list.some((entry) => entry.text.includes(`Prompt of child ${index}"`)),
						);
						assert.equal(
							prompted.length,
							1,
							`one session holds child ${index}'s prompt, whichever attempt wrote it`,
						);
						assert.equal(
							prompted[0]!.filter((entry) => entry.text.includes(String(child.reply))).length,
							1,
							`and, once, the reply ${child.reply} the child returned`,
						);
					}
					// Every session in the shared journal is bound to its stage by a recorded checkpoint.
					const owners = await store.query(`SELECT session FROM ${store.sessions}session_owners`);
					for (const { session } of owners)
						assert.ok(
							keys.length > 0 &&
								(
									await store.query(
										`SELECT 1 AS bound FROM ${table("wf_events")} WHERE run_id = ? AND payload LIKE ?`,
										root,
										`%"sessionId":"${String(session)}"%`,
									)
								).length > 0,
							`session ${session} is bound by a recorded checkpoint`,
						);

					// Usage is billed once per attempt and stage: one model call each, never summed twice, and every stage that
					// ended billed it.
					const usage = await store.query(
						`SELECT work, generation, key, input FROM ${table("wf_runs_pool_usage")}`,
					);
					for (const row of usage)
						assert.ok(Number(row.input) <= 1, `usage ${JSON.stringify(row)} is billed once`);
					assert.equal(
						new Set(usage.filter((row) => Number(row.input) === 1).map((row) => String(row.key))).size,
						CHILDREN,
						"every child's stage billed its model call",
					);
					assert.deepEqual(
						await store.query(
							`SELECT work FROM ${table("wf_runs_pool_operations")} WHERE operation NOT IN ('pool-confirmed', 'pool-handoff')`,
						),
						[],
						"every write went through a host's local journal",
					);
				});
			} finally {
				for (const process_ of processes)
					if (process_.process.exitCode === null) {
						try {
							process.kill(-process_.process.pid!, "SIGKILL");
						} catch {
							process_.process.kill("SIGKILL");
						}
					}
				removeTempDirectory(directory);
			}
		},
		BUDGET.timeoutMs,
	);
