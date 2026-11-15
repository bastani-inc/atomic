import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * A shared pool whose root and worker hosts meet only in a PostgreSQL database (#4793): workers of two hosts share the
 * root's admission, one host dies mid-run, and the root resumes on the other from the children's checkpoints. The
 * libSQL twin is the first test of workflow-shared-pool-hosts.test.ts.
 */

const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
const postgresAdapter = fileURLToPath(new URL("../../packages/storage-postgres/postgres.js", import.meta.url));
const PREFIX = "acme_";
const CHILDREN = 4;
/** Fewer session permits than the three workers of the two hosts that want one at once. */
const SESSIONS = 2;
/** Root A's pool, worker host B, and the root resumed on B: three pools cold-start. */
const FANOUT_BUDGET = poolTestBudgetMs(3);

type Row = Record<string, unknown>;

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

function markers(directory: string, prefix: string): string[] {
	return readdirSync(directory).filter((name) => name.startsWith(prefix));
}

test.skipIf(postgresSkipReason !== undefined || process.platform === "win32")(
	"two hosts on one PostgreSQL journal run a fan-out; killing one host mid-run and resuming the root on the other finishes it from its checkpoints (#4793)",
	async () => {
		await withPostgresDatabase(async (database) => {
			const directory = makeTempDirectory("shared-pool-postgres-");
			const root = randomUUID();
			const deadline = Date.now() + FANOUT_BUDGET.waitMs;
			const passwordFile = join(directory, "password");
			writeFileSync(passwordFile, postgresTestPassword ?? "", { mode: 0o600 });
			const reader = await database.open();
			const query = (sql: string, ...args: (string | number)[]): Promise<Row[]> => reader.all(sql, ...args);
			const env = (name: string, extra: Record<string, string> = {}) => ({
				...process.env,
				SHARED_POOL_HOST: name,
				SHARED_POOL_AGENT_DIR: join(directory, name, "agent"),
				SHARED_POOL_ADAPTER: postgresAdapter,
				SHARED_POOL_URL: database.url,
				SHARED_POOL_PREFIX: PREFIX,
				SHARED_POOL_ROOT: root,
				...(postgresTestPassword === undefined
					? {}
					: { SHARED_POOL_TOKEN_FILE: passwordFile, SHARED_POOL_TOKEN_SECRET: "password" }),
				...extra,
			});
			let hostB: BudgetedProcess | undefined;
			let rootA: BudgetedProcess | undefined;
			try {
				hostB = spawnWithinBudget(
					[process.execPath, hostFixture, directory, "2"],
					{ cwd: directory, stdout: "ignore", env: env("B") },
					deadline,
				);
				await until("host B", deadline, () => existsSync(join(directory, "host-ready-B")), [hostB]);
				// Host A runs the root, in a process group of its own with its coordinator and its worker.
				rootA = spawnWithinBudget(
					[process.execPath, rootFixture, "start", directory, String(CHILDREN), "1"],
					{
						cwd: directory,
						stdout: "ignore",
						env: env("A", { SHARED_POOL_SESSIONS: String(SESSIONS) }),
						detached: true,
					},
					deadline,
				);
				let mostGranted = 0;
				let fullWithWaiters = false;
				let holdersOfBothHosts = false;
				await until(
					"both hosts' children to hold their sessions",
					deadline,
					async () => {
						const permits = await query(
							`SELECT holder, state FROM ${PREFIX}wf_runs_resource_permits WHERE kind = 'session' AND state != 'released'`,
						).catch(() => [] as Row[]);
						const granted = permits.filter((permit) => permit.state === "granted").length;
						mostGranted = Math.max(mostGranted, granted);
						const hosts = new Set(permits.map((permit) => String(permit.holder).split("/")[0]));
						if (granted === SESSIONS && permits.some((permit) => permit.state === "waiting"))
							fullWithWaiters = true;
						if (hosts.size >= 2) holdersOfBothHosts = true;
						return markers(directory, "started-").length >= SESSIONS && fullWithWaiters;
					},
					[hostB, rootA],
				);
				assert.ok(
					mostGranted <= SESSIONS,
					`at most ${SESSIONS} sessions were granted across hosts, saw ${mostGranted}`,
				);
				assert.ok(holdersOfBothHosts, "workers of both hosts asked the shared admission for sessions");
				const arrived = new Set(markers(directory, "arrived-").map((name) => name.split("-")[1]));
				assert.deepEqual([...arrived].sort(), ["A", "B"], "the fan-out ran children on both hosts");

				// Host A dies: its root, coordinator and worker are killed together, mid-run.
				process.kill(-rootA.process.pid!, "SIGKILL");
				await rootA.process.exited;
				writeFileSync(join(directory, "release"), "");

				// The root resumes on host B, whose worker host keeps serving it.
				const resumed = spawnWithinBudget(
					[process.execPath, rootFixture, "resume", directory, String(CHILDREN), "1"],
					{ cwd: directory, stdout: "ignore", env: env("B", { SHARED_POOL_SESSIONS: String(SESSIONS) }) },
					deadline,
				);
				await expectExitedCleanly(resumed);
				const outcome = await readJson<{
					status: string;
					children: { status: string; firstHost: string; finalHost: string }[];
				}>(join(directory, "outcome-resume.json"));
				assert.equal(outcome.status, "completed", JSON.stringify(outcome));
				assert.equal(outcome.children.length, CHILDREN);
				for (const child of outcome.children) {
					assert.equal(child.status, "completed", JSON.stringify(child));
					assert.equal(child.finalHost, "B", "every child finished on the surviving host");
				}
				assert.ok(
					outcome.children.some((child) => child.firstHost === "A"),
					"a child whose first step ran on the dead host finished from that step's checkpoint",
				);
				// Every checkpoint was recorded once: replayed, never repeated.
				assert.deepEqual(
					await query(
						`SELECT key, COUNT(*) AS n FROM ${PREFIX}wf_events WHERE run_id = ? AND key IS NOT NULL GROUP BY key HAVING COUNT(*) > 1`,
						root,
					),
					[],
				);
				const name = postgresDialect.jsonText("payload", "name");
				const checkpointId = postgresDialect.jsonText("payload", "checkpointId");
				const firsts = await query(
					`SELECT payload FROM ${PREFIX}wf_events WHERE run_id = ? AND ${name} = 'first' AND strpos(${checkpointId}, 'tool-replay-meta:') = 0`,
					root,
				);
				assert.equal(firsts.length, CHILDREN, "each child's first step is in the journal once");
				// The pool's queue, admission and stage records live in the shared database; no host kept one of its own.
				const tables = (
					await query(
						"SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()",
					)
				).map((row) => String(row.name));
				for (const table of ["work", "pool", "resource_permits", "stage_workspaces", "stage_inputs", "pool_hosts"])
					assert.ok(tables.includes(`${PREFIX}wf_runs_${table}`), table);
				for (const host of ["A", "B"]) {
					const state = join(directory, host, "workflows", "pool");
					const databases = existsSync(state) ? readdirSync(state).filter((file) => file.endsWith(".sqlite")) : [];
					assert.deepEqual(databases, [], `host ${host} kept no coordination database`);
				}
				const work = await query(`SELECT state FROM ${PREFIX}wf_runs_work WHERE root = ?`, root);
				assert.deepEqual(
					work.map((row) => row.state),
					Array(CHILDREN).fill("completed"),
				);
				hostB.process.kill("SIGTERM");
				await expectExitedCleanly(hostB);
				hostB = undefined;
			} finally {
				if (rootA?.process.exitCode === null) process.kill(-rootA.process.pid!, "SIGKILL");
				hostB?.process.kill("SIGKILL");
				removeTempDirectory(directory);
			}
		});
	},
	FANOUT_BUDGET.timeoutMs,
);
