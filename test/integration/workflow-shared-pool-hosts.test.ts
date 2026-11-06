import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { type BudgetedProcess, expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

const rootFixture = fileURLToPath(new URL("../fixtures/shared-pool-root.mjs", import.meta.url));
const hostFixture = fileURLToPath(new URL("../fixtures/shared-pool-host.mjs", import.meta.url));
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const PREFIX = "acme_";
const CHILDREN = 4;
/** Fewer session permits than the three workers of the two hosts that want one at once. */
const SESSIONS = 2;
/** Root A's pool, worker host B, and the root resumed on B: three pools cold-start. */
const FANOUT_BUDGET = poolTestBudgetMs(3);
/** The root's pool and two worker hosts. */
const PLACEMENT_BUDGET = poolTestBudgetMs(3);
/** The root's pool and one worker host. */
const TYPED_FAILURE_BUDGET = poolTestBudgetMs(2);

type Row = Record<string, unknown>;

interface Scenario {
	readonly directory: string;
	readonly url: string;
	readonly root: string;
	readonly deadline: number;
	query(sql: string, ...args: (string | number)[]): Promise<Row[]>;
	/** The environment of a process of host `name`: its own agent directory, and the shared journal. */
	env(name: string, extra?: Record<string, string>): Record<string, string | undefined>;
	/** This host's id in the pool, as the pool records its workers and leases. */
	hostId(name: string): string;
}

function scenario(label: string, budgetMs: number): Scenario {
	const directory = makeTempDirectory(`${label}-`);
	const url = pathToFileURL(join(directory, "shared.db")).href;
	const root = randomUUID();
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
			return {
				...process.env,
				SHARED_POOL_HOST: name,
				SHARED_POOL_AGENT_DIR: join(directory, name, "agent"),
				SHARED_POOL_ADAPTER: libsql,
				SHARED_POOL_URL: url,
				SHARED_POOL_PREFIX: PREFIX,
				SHARED_POOL_ROOT: root,
				...extra,
			};
		},
		hostId(name) {
			const file = join(directory, name, "workflows", "pool", "host-id");
			return existsSync(file) ? readFileSync(file, "utf8").trim() : name;
		},
	};
}

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

function startHost(s: Scenario, name: string, workers: number, extra: Record<string, string> = {}): BudgetedProcess {
	return spawnWithinBudget(
		[process.execPath, hostFixture, s.directory, String(workers)],
		{ cwd: s.directory, stdout: "ignore", env: s.env(name, extra) },
		s.deadline,
	);
}

async function stopHost(host: BudgetedProcess): Promise<void> {
	host.process.kill("SIGTERM");
	await expectExitedCleanly(host);
}

test.skipIf(process.platform === "win32")(
	"two hosts on one shared libSQL journal run a fan-out; killing one host mid-run and resuming the root on the other finishes it from its checkpoints (#4310)",
	async () => {
		const s = scenario("shared-pool-hosts", FANOUT_BUDGET.waitMs);
		let hostB: BudgetedProcess | undefined;
		let rootA: BudgetedProcess | undefined;
		try {
			hostB = startHost(s, "B", 2);
			await until("host B", s.deadline, () => existsSync(join(s.directory, "host-ready-B")), [hostB]);
			// Host A runs the root, in a process group of its own with its coordinator and its worker.
			rootA = spawnWithinBudget(
				[process.execPath, rootFixture, "start", s.directory, String(CHILDREN), "1"],
				{
					cwd: s.directory,
					stdout: "ignore",
					env: s.env("A", { SHARED_POOL_SESSIONS: String(SESSIONS) }),
					detached: true,
				},
				s.deadline,
			);
			// Admission counts across hosts: sampled while both hosts' workers want sessions.
			let mostGranted = 0;
			let fullWithWaiters = false;
			let holdersOfBothHosts = false;
			await until(
				"both hosts' children to hold their sessions",
				s.deadline,
				async () => {
					const permits = await s
						.query(
							`SELECT holder, state FROM ${PREFIX}wf_runs_resource_permits WHERE kind = 'session' AND state != 'released'`,
						)
						.catch(() => [] as Row[]);
					const granted = permits.filter((permit) => permit.state === "granted").length;
					mostGranted = Math.max(mostGranted, granted);
					const hosts = new Set(permits.map((permit) => String(permit.holder).split("/")[0]));
					if (granted === SESSIONS && permits.some((permit) => permit.state === "waiting")) fullWithWaiters = true;
					if (hosts.size >= 2) holdersOfBothHosts = true;
					return markers(s.directory, "started-").length >= SESSIONS && fullWithWaiters;
				},
				[hostB, rootA],
			);
			assert.ok(
				mostGranted <= SESSIONS,
				`at most ${SESSIONS} sessions were granted across hosts, saw ${mostGranted}`,
			);
			assert.ok(holdersOfBothHosts, "workers of both hosts asked the shared admission for sessions");
			const arrived = new Set(markers(s.directory, "arrived-").map((name) => name.split("-")[1]));
			assert.deepEqual([...arrived].sort(), ["A", "B"], "the fan-out ran children on both hosts");

			// Host A dies: its root, coordinator and worker are killed together, mid-run.
			process.kill(-rootA.process.pid!, "SIGKILL");
			await rootA.process.exited;
			writeFileSync(join(s.directory, "release"), "");

			// The root resumes on host B, whose worker host keeps serving it; nothing of host A's survives.
			const resumed = spawnWithinBudget(
				[process.execPath, rootFixture, "resume", s.directory, String(CHILDREN), "1"],
				{ cwd: s.directory, stdout: "ignore", env: s.env("B", { SHARED_POOL_SESSIONS: String(SESSIONS) }) },
				s.deadline,
			);
			await expectExitedCleanly(resumed);
			const outcome = await readJson<{
				status: string;
				children: {
					status: string;
					firstHost: string;
					firstInstance: string;
					finalHost: string;
					finalInstance: string;
				}[];
			}>(join(s.directory, "outcome-resume.json"));
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
				await s.query(
					`SELECT key, COUNT(*) AS n FROM ${PREFIX}wf_events WHERE run_id = ? AND key IS NOT NULL GROUP BY key HAVING COUNT(*) > 1`,
					s.root,
				),
				[],
			);
			const firsts = await s.query(
				`SELECT payload FROM ${PREFIX}wf_events WHERE run_id = ? AND json_extract(payload, '$.name') = 'first'`,
				s.root,
			);
			assert.equal(firsts.length, CHILDREN, "each child's first step is in the journal once");

			// The pool's queue, leases, admission and stage records live in the shared journal, under its prefix; no host
			// kept a pool database of its own.
			const tables = (await s.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) =>
				String(row.name),
			);
			for (const table of ["work", "pool", "resource_permits", "stage_workspaces", "stage_inputs", "pool_hosts"])
				assert.ok(tables.includes(`${PREFIX}wf_runs_${table}`), table);
			for (const host of ["A", "B"]) {
				const state = join(s.directory, host, "workflows", "pool");
				const databases = existsSync(state) ? readdirSync(state).filter((name) => name.endsWith(".sqlite")) : [];
				assert.deepEqual(databases, [], `host ${host} kept no coordination database`);
			}
			const work = await s.query(`SELECT state, worker FROM ${PREFIX}wf_runs_work WHERE root = ?`, s.root);
			assert.deepEqual(
				work.map((row) => row.state),
				Array(CHILDREN).fill("completed"),
			);
			// Each stage that ran recorded where it ran: its host and working directory, with no binding.
			const stages = await s.query(
				`SELECT host, worktree, binding FROM ${PREFIX}wf_runs_stage_workspaces WHERE root = ?`,
				s.root,
			);
			assert.equal(stages.length, CHILDREN);
			for (const stage of stages) {
				assert.ok([s.hostId("A"), s.hostId("B"), "B"].includes(String(stage.host)), String(stage.host));
				assert.equal(stage.worktree, s.directory);
				assert.equal(stage.binding, null);
			}
			const stats = await readJson<{ hostId: string; git: string; maxWorkers: number }>(
				join(s.directory, "host-stats-B.json"),
			);
			assert.deepEqual([stats.hostId, stats.maxWorkers], ["B", 2]);
			await stopHost(hostB);
			hostB = undefined;
		} finally {
			if (rootA?.process.exitCode === null) process.kill(-rootA.process.pid!, "SIGKILL");
			hostB?.process.kill("SIGKILL");
			removeTempDirectory(s.directory);
		}
	},
	FANOUT_BUDGET.timeoutMs,
);

const BINDING = {
	remotes: ["https://example.invalid/repo.git"],
	head: "1111111111111111111111111111111111111111",
	tree: "2222222222222222222222222222222222222222",
	envHash: "fixture-env",
};

test.skipIf(process.platform === "win32")(
	"bound children run only on a host that can restore their tree, never on an idle host that cannot (#4310)",
	async () => {
		const s = scenario("shared-pool-placement", PLACEMENT_BUDGET.waitMs);
		const restored = join(s.directory, "restored");
		mkdirSync(restored);
		let hostB: BudgetedProcess | undefined;
		let hostC: BudgetedProcess | undefined;
		try {
			// Host C has no git and no restore port: idle, but never a home for bound work. Host B can restore, one child at
			// a time, so bound work waits for it.
			hostC = startHost(s, "C", 2, { SHARED_POOL_GIT_MISSING: "1" });
			hostB = startHost(s, "B", 1, { SHARED_POOL_RESTORE: restored });
			await until(
				"hosts B and C",
				s.deadline,
				() => existsSync(join(s.directory, "host-ready-B")) && existsSync(join(s.directory, "host-ready-C")),
				[hostB, hostC],
			);
			const root = spawnWithinBudget(
				[process.execPath, rootFixture, "start", s.directory, "3", "1", "bound"],
				{ cwd: s.directory, stdout: "ignore", env: s.env("A", { SHARED_POOL_BINDING: JSON.stringify(BINDING) }) },
				s.deadline,
			);
			await expectExitedCleanly(root);
			const outcome = await readJson<{
				status: string;
				children: { status: string; host: string; cwd: string; answer: string }[];
			}>(join(s.directory, "outcome-start.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			for (const child of outcome.children)
				assert.deepEqual(
					[child.status, child.host, child.cwd, child.answer],
					["completed", "B", restored, "answer-from-root"],
				);
			// Each child's prompt was answered from the root through its stage's input queue, taken by host B in order.
			const inputs = await s.query(
				`SELECT kind, state, receipt FROM ${PREFIX}wf_runs_stage_inputs WHERE root = ? ORDER BY run_id, stage_id, seq`,
				s.root,
			);
			assert.equal(inputs.length, 3);
			for (const input of inputs)
				assert.deepEqual(
					[input.kind, input.state, JSON.parse(String(input.receipt))],
					["prompt-answer", "done", { ok: true }],
				);
			assert.ok(existsSync(join(s.directory, `restored-B-${BINDING.tree}`)));
			const stages = await s.query(
				`SELECT host, worktree, binding FROM ${PREFIX}wf_runs_stage_workspaces WHERE root = ?`,
				s.root,
			);
			assert.equal(stages.length, 3);
			for (const stage of stages) {
				assert.deepEqual([stage.host, stage.worktree], ["B", restored]);
				assert.deepEqual(JSON.parse(String(stage.binding)), BINDING);
			}
			const statsC = await readJson<{ git: string; restore: boolean; busy: number }>(
				join(s.directory, "host-stats-C.json"),
			);
			assert.deepEqual([statsC.git, statsC.restore], ["unavailable", false]);
			const workers = await s.query(`SELECT worker FROM ${PREFIX}wf_runs_work WHERE root = ?`, s.root);
			assert.ok(workers.every((row) => row.worker === null || String(row.worker).startsWith("B/")));

			// With only the incapable host left, bound work fails typed once its claim window passes.
			await stopHost(hostB);
			hostB = undefined;
			const alone = spawnWithinBudget(
				[process.execPath, rootFixture, "start", s.directory, "1", "1", "bound"],
				{
					cwd: s.directory,
					stdout: "ignore",
					env: {
						...s.env("A", { SHARED_POOL_BINDING: JSON.stringify(BINDING), SHARED_POOL_CLAIM_WINDOW_MS: "1000" }),
						SHARED_POOL_ROOT: randomUUID(),
					},
				},
				s.deadline,
			);
			await expectExitedCleanly(alone);
			const failed = await readJson<{ children: { status: string; error: string | null; code?: string }[] }>(
				join(s.directory, "outcome-start.json"),
			);
			assert.equal(failed.children.length, 1);
			assert.notEqual(failed.children[0]?.status, "completed");
			assert.equal(failed.children[0]?.code, "workspace-restore-unavailable", JSON.stringify(failed));
			await stopHost(hostC);
			hostC = undefined;
		} finally {
			hostB?.process.kill("SIGKILL");
			hostC?.process.kill("SIGKILL");
			removeTempDirectory(s.directory);
		}
	},
	PLACEMENT_BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a child that fails typed on another host reaches the root as its own class, with its typed cause (#4378)",
	async () => {
		const s = scenario("shared-pool-typed-failure", TYPED_FAILURE_BUDGET.waitMs);
		const restored = join(s.directory, "restored");
		mkdirSync(restored);
		let hostB: BudgetedProcess | undefined;
		try {
			// Only host B can restore the child's binding, so the child runs there and fails there.
			hostB = startHost(s, "B", 1, { SHARED_POOL_RESTORE: restored });
			await until("host B", s.deadline, () => existsSync(join(s.directory, "host-ready-B")), [hostB]);
			const root = spawnWithinBudget(
				[process.execPath, rootFixture, "start", s.directory, "1", "1", "typed"],
				{ cwd: s.directory, stdout: "ignore", env: s.env("A", { SHARED_POOL_BINDING: JSON.stringify(BINDING) }) },
				s.deadline,
			);
			await expectExitedCleanly(root);
			const outcome = await readJson<{
				children: {
					status: string;
					typed: {
						name: string;
						code: string;
						fields: Record<string, unknown>;
						hint: string;
						retryable: boolean;
						cause: { name: string | null; code: string | null; instance: boolean; guard: boolean };
					} | null;
				}[];
			}>(join(s.directory, "outcome-start.json"));
			assert.equal(outcome.children.length, 1);
			const [failed] = outcome.children;
			assert.equal(failed?.status, "rejected", JSON.stringify(outcome));
			const typed = failed?.typed;
			assert.ok(typed, `the root's error held no WorkflowGitRequiredError: ${JSON.stringify(failed)}`);
			assert.deepEqual(
				[typed.name, typed.code, typed.retryable],
				["WorkflowGitRequiredError", "git-required", false],
			);
			assert.equal(typed.fields.gitWorktreeDir, "/worktrees/B", "the error was made on host B");
			assert.deepEqual(typed.cause, { name: "GitUnavailableError", code: "offline", instance: true, guard: true });
			assert.ok(typed.hint.length > 0);
			const work = await s.query(
				`SELECT w.worker, r.result FROM ${PREFIX}wf_runs_work w LEFT JOIN ${PREFIX}wf_runs_work_results r ON r.work = w.id WHERE w.root = ?`,
				s.root,
			);
			assert.equal(work.length, 1);
			assert.ok(String(work[0]?.worker).startsWith("B/"), `the child ran on ${String(work[0]?.worker)}`);
			const sent = JSON.parse(String(work[0]?.result)) as { failureDetail?: { family?: string } };
			assert.equal(sent.failureDetail?.family, "git-required", "host B sent the typed detail through the journal");
			await stopHost(hostB);
			hostB = undefined;
		} finally {
			hostB?.process.kill("SIGKILL");
			removeTempDirectory(s.directory);
		}
	},
	TYPED_FAILURE_BUDGET.timeoutMs,
);
