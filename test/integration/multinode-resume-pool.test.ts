import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import {
	isSharedPoolSetupError,
	isWorkerPlacementError,
	rehydrateWorkerPlacementError,
	serializeWorkerPlacementError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { treeDigest } from "../helpers/tree-digest.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

useTemporaryAgentDir();

const rootFixture = fileURLToPath(new URL("../fixtures/multinode-pool-root.mjs", import.meta.url));
const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const PREFIX = "mnr_";
/** One child per worker that can restore the root's tree at first: the two hosts the faults land on. */
const CHILDREN = 2;
/**
 * The work lease of the root's pool, so that a child whose host was killed or cut off is back in the queue within the
 * test. Long enough that a healthy host under the load of this many cold-starting pools never loses a lease.
 */
const WORK_LEASE_MS = 10_000;
/** Long enough that reclaimed work waits for the host that arrives late, instead of failing for want of a host. */
const CLAIM_WINDOW_MS = 240_000;
/** The root's pool and the worker hosts B, C, D and E: five pools cold-start, one of them after the faults. */
const CAMPAIGN_BUDGET = poolTestBudgetMs(5);

type Row = Record<string, unknown>;

interface Campaign {
	readonly directory: string;
	readonly url: string;
	readonly root: string;
	readonly deadline: number;
	query(sql: string, ...args: (string | number)[]): Promise<Row[]>;
	/** The environment of a process of node `name`: its own agent directory, and the shared journal. */
	env(name: string, extra?: Record<string, string>): Record<string, string | undefined>;
}

function campaign(label: string, budgetMs: number, git: GitSandbox): Campaign {
	const directory = makeTempDirectory(`${label}-`);
	const url = pathToFileURL(join(directory, "shared.db")).href;
	const root = "multinode-pool-root";
	return {
		directory,
		url,
		root,
		deadline: Date.now() + budgetMs,
		async query(sql, ...args) {
			// Through the adapter that owns the file: another SQLite library must not read a libSQL file in WAL mode.
			const database = await openLibsqlDatabase({ url });
			try {
				return await database.all(sql, ...args);
			} finally {
				await database.close();
			}
		},
		env(name, extra = {}) {
			const agentDir = join(directory, name, "agent");
			return {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: agentDir,
				SHARED_POOL_HOST: name,
				SHARED_POOL_AGENT_DIR: agentDir,
				SHARED_POOL_ADAPTER: libsql,
				SHARED_POOL_URL: url,
				SHARED_POOL_PREFIX: PREFIX,
				SHARED_POOL_ROOT: root,
				GIT_CONFIG_GLOBAL: git.globalConfig,
				GIT_CONFIG_NOSYSTEM: "1",
				...extra,
			};
		},
	};
}

async function until(
	what: string,
	deadline: number,
	check: () => boolean | Promise<boolean>,
	watched: readonly BudgetedProcess[],
	describe: () => Promise<string> = async () => "",
): Promise<void> {
	while (!(await check())) {
		for (const watchedProcess of watched)
			if (watchedProcess.process.exitCode !== null)
				assert.fail(`a process ended while waiting for ${what}:\n${await expectExitedCleanly(watchedProcess)}`);
		if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}\n${await describe()}`);
		await sleep(50);
	}
}

function markers(directory: string, prefix: string): string[] {
	return readdirSync(directory).filter((name) => name.startsWith(prefix));
}

/** The child indexes a host holds in flight, from the markers `hold` leaves. */
function heldBy(directory: string, host: string): number[] {
	return markers(directory, `held-${host}-`).map((name) => Number(name.split("-")[2]));
}

/** A worker host in a process group of its own, so a fault reaches its coordinator and workers with it. */
function startHost(c: Campaign, name: string, workers: number, extra: Record<string, string> = {}): BudgetedProcess {
	return spawnWithinBudget(
		[process.execPath, hostFixture, c.directory, String(workers)],
		{ cwd: c.directory, stdout: "ignore", env: c.env(name, extra), detached: true },
		c.deadline,
	);
}

async function stopHost(host: BudgetedProcess): Promise<void> {
	host.process.kill("SIGTERM");
	await expectExitedCleanly(host);
}

interface ChildOutcome {
	readonly status: string;
	readonly error: string | null;
	readonly firstHost: string;
	readonly firstCwd: string;
	readonly finalHost: string;
	readonly finalCwd: string;
	readonly finalHead: string;
	readonly finalFiles: string;
}

/** What a typed refusal of pooled workers on Windows carries, whichever entry point raised it (#4310). */
function assertContainmentRefusal(error: unknown, operation: "shared-placement" | "worker-host"): void {
	assert.ok(isSharedPoolSetupError(error), String(error));
	assert.ok(isWorkerPlacementError(error));
	assert.equal(error.code, "process-containment-unavailable");
	assert.equal(error.operation, operation);
	assert.equal(error.retryable, false);
	assert.deepEqual(error.problems[0]?.fields, { platform: "win32" });
	const crossed = rehydrateWorkerPlacementError(JSON.parse(JSON.stringify(serializeWorkerPlacementError(error))));
	assert.ok(isSharedPoolSetupError(crossed));
	assert.deepEqual([crossed.code, crossed.operation, crossed.retryable], [error.code, error.operation, false]);
}

/**
 * Windows cannot contain a pool's worker processes, so neither a root with shared placement nor a worker host starts
 * there: both refuse typed, before the shared journal is opened. The campaign needs both, so it ends here, asserting
 * exactly that refusal.
 */
async function assertWindowsRefusesPooledWorkers(): Promise<void> {
	const directory = makeTempDirectory("multinode-pool-windows-");
	try {
		const journal = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: PREFIX,
		};
		const root = workflow({
			name: "multinode-pool-windows-root",
			description: "",
			inputs: {},
			outputs: {},
			async run() {
				return {};
			},
		});
		await assert.rejects(
			run(
				root,
				{},
				{
					runId: "multinode-pool-windows",
					cwd: directory,
					journal,
					localWorkers: { count: 1, definitions: [{ path: join(directory, "child.ts"), exportName: "child" }] },
					workers: { placement: "shared" },
				},
			),
			(error: unknown) => {
				assertContainmentRefusal(error, "shared-placement");
				return true;
			},
		);
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		await assert.rejects(startWorkflowWorkerHost({ journal, agentDir, maxWorkers: 1 }), (error: unknown) => {
			assertContainmentRefusal(error, "worker-host");
			return true;
		});
		assert.equal(existsSync(join(directory, "shared.db")), false, "neither refusal opened the shared journal");
	} finally {
		removeTempDirectory(directory);
	}
}

describe("multi-node resume of a pooled campaign (#4329)", () => {
	test(
		"scenario 3: a pooled campaign over three nodes loses one node: its child is reclaimed and restored elsewhere, and bound work never runs on a host that cannot restore",
		async () => {
			if (process.platform === "win32") {
				await assertWindowsRefusesPooledWorkers();
				return;
			}
			const git = new GitSandbox();
			const { clone: nodeA } = await git.remoteWithClone("node-a", {
				"README.md": "hello\n",
				"lib/util.txt": "util\n",
				"package-lock.json": "{}\n",
			});
			// Node A's worktree, as a session leaves it: an unpushed commit, an uncommitted edit and an untracked file.
			git.write(join(nodeA, "committed.txt"), "unpushed\n");
			const head = await git.commitAll(nodeA, "unpushed commit");
			git.write(join(nodeA, "README.md"), "uncommitted edit\n");
			git.write(join(nodeA, "notes", "untracked.txt"), "untracked\n");
			const expected = treeDigest(nodeA);
			const c = campaign("multinode-pool", CAMPAIGN_BUDGET.waitMs, git);
			// Every host's own agent directory configures the resume setup hook: it records each worktree it sets up.
			const hookLog = (host: string) => join(c.directory, `hook-${host}.log`);
			for (const host of ["B", "C", "D", "E"]) {
				const agentDir = join(c.directory, host, "agent");
				mkdirSync(agentDir, { recursive: true });
				const record = `require('fs').appendFileSync('${hookLog(host).replaceAll("\\", "/")}', process.env.ATOMIC_RESUME_WORKTREE + '\\n')`;
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ resume: { setupCommand: `"${process.execPath}" -e "${record}"` } }),
				);
			}
			const hosts = new Map<string, BudgetedProcess>();
			let rootA: BudgetedProcess | undefined;
			try {
				// B and D restore the root's tree. C has no git: idle, but never a home for bound work.
				hosts.set("B", startHost(c, "B", 1));
				hosts.set("D", startHost(c, "D", 1));
				hosts.set("C", startHost(c, "C", 1, { SHARED_POOL_GIT_MISSING: "1" }));
				await until(
					"hosts B, C and D",
					c.deadline,
					() => ["B", "C", "D"].every((name) => existsSync(join(c.directory, `host-ready-${name}`))),
					[...hosts.values()],
				);
				const statsOf = (name: string) =>
					readJson<{ git: string; restore: boolean; busy: number }>(join(c.directory, `host-stats-${name}.json`));
				assert.deepEqual(
					await Promise.all(
						["B", "C", "D"].map(async (name) => (({ restore }) => [name, restore])(await statsOf(name))),
					),
					[
						["B", true],
						["C", false],
						["D", true],
					],
				);
				assert.equal((await statsOf("C")).git, "unavailable");

				rootA = spawnWithinBudget(
					[process.execPath, rootFixture, c.directory, String(CHILDREN), "1"],
					{
						cwd: c.directory,
						stdout: "ignore",
						env: c.env("A", {
							MULTINODE_WORKTREE: nodeA,
							SHARED_POOL_LEASE_MS: String(WORK_LEASE_MS),
							SHARED_POOL_CLAIM_WINDOW_MS: String(CLAIM_WINDOW_MS),
						}),
						detached: true,
					},
					c.deadline,
				);
				// Each capable host holds one child, in the worktree it restored; the host without git holds none.
				await until(
					"hosts B and D to hold a child each",
					c.deadline,
					() => heldBy(c.directory, "B").length === 1 && heldBy(c.directory, "D").length === 1,
					[rootA, ...hosts.values()],
				);
				const [onB] = heldBy(c.directory, "B");
				const [onD] = heldBy(c.directory, "D");
				assert.notEqual(onB, onD);
				assert.deepEqual(heldBy(c.directory, "C"), []);

				// Node B is killed mid-child. Node D is cut off from the database for longer than the work lease: its whole
				// process group is stopped, so it renews no lease and writes nothing, as a host on a partitioned network
				// does (the shared database here is a libSQL file, which no network fault reaches; the Azure run partitions
				// a real sqld).
				process.kill(-hosts.get("B")!.process.pid!, "SIGKILL");
				await hosts.get("B")!.process.exited;
				hosts.delete("B");
				process.kill(-hosts.get("D")!.process.pid!, "SIGSTOP");
				// Neither child can run elsewhere: their leases lapse and they wait in the queue, and the idle host without git
				// leaves them there.
				await until(
					"both children back in the queue after their leases lapsed",
					c.deadline,
					async () =>
						(
							await c.query(
								`SELECT 1 AS ready FROM ${PREFIX}wf_runs_work WHERE root = ? AND state = 'ready'`,
								c.root,
							)
						).length === CHILDREN,
					[rootA, ...hosts.values()],
				);
				assert.equal((await statsOf("C")).busy, 0, "the host without git took none of the waiting work");
				assert.deepEqual(heldBy(c.directory, "C"), []);

				// Node E joins late, with none of the tree, and takes both children over.
				hosts.set("E", startHost(c, "E", CHILDREN));
				await until(
					"host E to hold both reclaimed children",
					c.deadline,
					() => [onB, onD].every((index) => heldBy(c.directory, "E").includes(index!)),
					[rootA, ...hosts.values()],
				);
				// Node D is reachable again, still holding the child that was reclaimed from it. It finishes its step when
				// the children are released, and its writes are refused because E holds the child now.
				process.kill(-hosts.get("D")!.process.pid!, "SIGCONT");
				writeFileSync(join(c.directory, "release"), "");
				await expectExitedCleanly(rootA);
				await until(
					"host D to give up its reclaimed child",
					c.deadline,
					async () => (await statsOf("D")).busy === 0,
					[...hosts.values()],
				);

				// Whatever host D recorded for the work it lost is a typed placement error, never a bare one.
				const healed = await readJson<{
					lastPlacementFailure?: { code?: string };
					lastDetach?: { code?: string };
				}>(join(c.directory, "host-stats-D.json"));
				for (const failure of [healed.lastPlacementFailure, healed.lastDetach])
					if (failure !== undefined) assert.equal(typeof failure.code, "string", JSON.stringify(failure));

				const outcome = await readJson<{ status: string; error: string | null; children: ChildOutcome[] }>(
					join(c.directory, "outcome-start.json"),
				);
				assert.equal(outcome.status, "completed", JSON.stringify(outcome));
				assert.equal(outcome.children.length, CHILDREN);
				const restoreRoots = (host: string) => join(c.directory, host, "agent", "worktree-snapshots", "worktrees");
				for (const [index, child] of outcome.children.entries()) {
					assert.deepEqual([child.status, child.error], ["completed", null], JSON.stringify(child));
					// The child began on the host that was lost, in a worktree that host restored, and finished on E from there.
					const lost = index === onB ? "B" : "D";
					assert.equal(child.firstHost, lost);
					assert.ok(child.firstCwd.startsWith(restoreRoots(lost)), child.firstCwd);
					assert.equal(child.finalHost, "E");
					assert.ok(child.finalCwd.startsWith(restoreRoots("E")), child.finalCwd);
					// Restored byte for byte: every file of node A's worktree, and the commit it was on.
					assert.deepEqual(JSON.parse(child.finalFiles), expected);
					assert.equal(child.finalHead, head);
				}
				// Each host set up every worktree it restored exactly once, before the child ran there; C restored none.
				const setUp = (host: string) =>
					existsSync(hookLog(host)) ? readFileSync(hookLog(host), "utf8").trim().split("\n") : [];
				for (const host of ["B", "D", "E"]) {
					const worktrees = setUp(host);
					assert.equal(new Set(worktrees).size, worktrees.length, `${host} set up a worktree twice`);
					for (const worktree of worktrees) assert.ok(worktree.startsWith(restoreRoots(host)), worktree);
				}
				assert.deepEqual(setUp("C"), []);
				for (const [index, child] of outcome.children.entries()) {
					const lost = index === onB ? "B" : "D";
					assert.ok(
						setUp(lost).some((worktree) => child.firstCwd.startsWith(worktree)),
						child.firstCwd,
					);
					assert.ok(
						setUp("E").some((worktree) => child.finalCwd.startsWith(worktree)),
						child.finalCwd,
					);
				}
				// Bound work only ever ran on hosts that can restore, never on C.
				const holders = new Set(markers(c.directory, "held-").map((name) => name.split("-")[1]));
				assert.deepEqual([...holders].sort(), ["B", "D", "E"]);
				const work = await c.query(
					`SELECT state, generation, worker FROM ${PREFIX}wf_runs_work WHERE root = ?`,
					c.root,
				);
				assert.deepEqual(
					work.map((row) => row.state),
					Array(CHILDREN).fill("completed"),
				);
				for (const row of work) {
					assert.ok(Number(row.generation) >= 2, "each child was claimed again after its host was lost");
					assert.ok(String(row.worker).startsWith("E/"), String(row.worker));
				}
				// Each step of each child was checkpointed once: replayed from the journal, never repeated by a stale worker.
				assert.deepEqual(
					await c.query(
						`SELECT key, COUNT(*) AS n FROM ${PREFIX}wf_events WHERE run_id = ? AND key IS NOT NULL GROUP BY key HAVING COUNT(*) > 1`,
						c.root,
					),
					[],
				);
				for (const name of ["E", "C"]) {
					await stopHost(hosts.get(name)!);
					hosts.delete(name);
				}
			} finally {
				for (const host of hosts.values())
					if (host.process.exitCode === null) process.kill(-host.process.pid!, "SIGKILL");
				if (rootA?.process.exitCode === null) process.kill(-rootA.process.pid!, "SIGKILL");
				removeTempDirectory(c.directory);
				git.dispose();
			}
		},
		CAMPAIGN_BUDGET.timeoutMs,
	);
});
