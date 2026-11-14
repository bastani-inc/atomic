import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * Shared placement at the scale where it used to stop committing (#4768): 8 and 16 worker hosts, each a process of its
 * own with 4 workers, run one root's pooled children against a real libSQL server. Every child commits checkpoints
 * from whichever host runs it. While they run, a fresh client's write must land within
 * {@link WRITE_PROBE_TIMEOUT_MS} every {@link WRITE_PROBE_INTERVAL_MS}: a store that stops committing fails the test
 * instead of hanging it. Runs only when a server is named, as workflow-local-pool-sqld.test.ts does, for example one
 * started with
 *   docker run -d --rm -p 127.0.0.1:8080:8080 ghcr.io/tursodatabase/libsql-server:v0.24.33
 * and `ATOMIC_TEST_LIBSQL_URL=http://127.0.0.1:8080`. Each case works under a table prefix of its own and drops it.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const SLOTS = 4;
/** Two children per worker slot, so every host claims more than once. */
const CHILDREN_PER_SLOT = 2;
/** Checkpoints each child commits. */
const STEPS = 20;
/** How long a fresh client's write may take before the store counts as wedged; the measured wedge never answered. */
const WRITE_PROBE_TIMEOUT_MS = 15_000;
const WRITE_PROBE_INTERVAL_MS = 5_000;
/**
 * The whole case, from the first host's start to the last host's exit: 17 processes and their 64 workers cold-start on
 * one CI runner (each host and the root load the workflow runtime), then up to 128 children commit 20 checkpoints each.
 * A wedged store never finishes, so the bound only needs to sit well above a healthy run on a loaded runner.
 */
const SCALE_CASE_BUDGET_MS = 600_000;
/** What the case keeps of its budget, after its waits give up, to stop its processes and drop its tables. */
const CLEANUP_HEADROOM_MS = 30_000;

interface Outcome {
	readonly status: string;
	readonly error: unknown;
	readonly children: readonly { readonly status: string; readonly host?: string; readonly error?: unknown }[];
}

async function withDatabase<T>(
	url: string,
	use: (database: Awaited<ReturnType<typeof openLibsqlDatabase>>) => Promise<T>,
) {
	const database = await openLibsqlDatabase({ url });
	try {
		return await use(database);
	} finally {
		await database.close();
	}
}

/** One write from a fresh client, as a host joining the fleet would make it; its time, or the timeout it ran into. */
async function probeWrite(url: string, table: string): Promise<number> {
	const started = performance.now();
	const write = withDatabase(url, async (database) => {
		await database.exec(`CREATE TABLE IF NOT EXISTS ${table}(at INTEGER NOT NULL)`);
		await database.run(`INSERT INTO ${table} VALUES (?)`, Date.now());
	});
	const timedOut = Symbol("timed out");
	const result = await Promise.race([write.then(() => undefined), sleep(WRITE_PROBE_TIMEOUT_MS).then(() => timedOut)]);
	if (result === timedOut) {
		void write.catch(() => {});
		throw new Error(
			`a fresh client's write did not land within ${WRITE_PROBE_TIMEOUT_MS} ms: the store stopped committing`,
		);
	}
	return Math.round(performance.now() - started);
}

async function dropPrefix(url: string, prefix: string): Promise<void> {
	await withDatabase(url, async (database) => {
		const tables = await database.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, ?) = ?",
			prefix.length,
			prefix,
		);
		await database.exec("PRAGMA foreign_keys = OFF");
		for (const { name } of tables) await database.exec(`DROP TABLE IF EXISTS "${name}"`);
	});
}

async function runScale(url: string, hosts: number): Promise<void> {
	const directory = makeTempDirectory(`shared-pool-scale-${hosts}-`);
	const prefix = `scale${hosts}_${randomBytes(4).toString("hex")}_`;
	const root = randomUUID();
	const deadline = Date.now() + SCALE_CASE_BUDGET_MS - CLEANUP_HEADROOM_MS;
	const env = (name: string, extra: Record<string, string> = {}) => {
		const agentDir = join(directory, name, "agent");
		mkdirSync(agentDir, { recursive: true });
		return {
			...process.env,
			SHARED_POOL_HOST: name,
			SHARED_POOL_AGENT_DIR: agentDir,
			SHARED_POOL_ADAPTER: libsql,
			SHARED_POOL_URL: url,
			SHARED_POOL_PREFIX: prefix,
			SHARED_POOL_ROOT: root,
			...extra,
		};
	};
	const processes: BudgetedProcess[] = [];
	const watch = async (what: string, done: () => boolean, tick?: () => Promise<void>) => {
		while (!done()) {
			await tick?.();
			for (const child of processes)
				if (child.process.exitCode !== null && child.process.exitCode !== 0)
					assert.fail(`a process ended while waiting for ${what}:\n${await expectExitedCleanly(child)}`);
			if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`);
			await sleep(100);
		}
	};
	const probes: number[] = [];
	try {
		for (let index = 0; index < hosts; index++)
			processes.push(
				spawnWithinBudget(
					[process.execPath, hostFixture, directory, String(SLOTS)],
					{ cwd: directory, stdout: "ignore", env: env(`h${index}`) },
					deadline,
				),
			);
		await watch("every host to join", () =>
			processes.every((_, index) => existsSync(join(directory, `host-ready-h${index}`))),
		);
		const rootProcess = spawnWithinBudget(
			[process.execPath, rootFixture, "start", directory, String(hosts * SLOTS * CHILDREN_PER_SLOT), "1", "scale"],
			{
				cwd: directory,
				stdout: "ignore",
				env: env("root", { SHARED_POOL_STEPS: String(STEPS), SHARED_POOL_SESSIONS: String(hosts * SLOTS) }),
			},
			deadline,
		);
		processes.push(rootProcess);
		// A fresh client's write lands throughout the run: the store never stops committing.
		let nextProbe = Date.now();
		await watch(
			"the root to finish",
			() => rootProcess.process.exitCode !== null,
			async () => {
				if (Date.now() < nextProbe) return;
				probes.push(await probeWrite(url, `${prefix}probe`));
				nextProbe = Date.now() + WRITE_PROBE_INTERVAL_MS;
			},
		);
		const rootLog = await expectExitedCleanly(rootProcess);
		const outcome = await readJson<Outcome>(join(directory, "outcome-start.json"));
		assert.equal(outcome.status, "completed", `${JSON.stringify(outcome.error)}\n${rootLog}`);
		const failed = outcome.children.filter((child) => child.status !== "completed");
		assert.deepEqual(failed, []);
		assert.equal(outcome.children.length, hosts * SLOTS * CHILDREN_PER_SLOT);
		// The fan-out spread over the fleet, as the scale it tests needs.
		assert.ok(new Set(outcome.children.map((child) => child.host)).size > hosts / 2);
		probes.push(await probeWrite(url, `${prefix}probe`));
		assert.ok(probes.length >= 2);
	} finally {
		for (const child of processes) if (child.process.exitCode === null) child.process.kill("SIGTERM");
		await Promise.allSettled(processes.map((child) => child.process.exited));
		await dropPrefix(url, prefix).catch(() => {});
		removeTempDirectory(directory);
	}
}

test.skipIf(serverUrl === undefined || process.platform === "win32").each([{ hosts: 8 }, { hosts: 16 }])(
	"$hosts hosts × 4 workers run one root's pooled children on one libSQL server without it ever stopping to commit (#4768)",
	({ hosts }) => runScale(serverUrl!, hosts),
	SCALE_CASE_BUDGET_MS,
);
