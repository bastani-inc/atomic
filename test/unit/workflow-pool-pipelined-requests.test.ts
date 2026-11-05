/**
 * Counting benchmark and chaos runs for #4315 (cause C of #4312): one pool worker's requests to its coordinator used
 * to run strictly one after another, so every request of an agent step waited behind the lease renewal, control poll
 * and usage report its heartbeat kept in flight.
 *
 * 300 simulated workers (test/helpers/pool-request-rounds.ts) each claim a pooled child of one root and run agent
 * steps through the real pool coordinator, in this process, against a real SQLite journal. The test holds every pool
 * journal call and runs them in rounds, one group commit of a loaded journal each, so the counts below are exact and
 * independent of the host: rounds per agent step, journal transactions, and the order each worker's commits applied
 * in. It then reads back every session and usage row the workers wrote. The chaos runs repeat it with a slow journal
 * whose calls finish out of order, with a journal clock that lags the coordinator's, and with usage reports refused
 * as on a full disk.
 *
 * The measured numbers are printed on every run. Under an agent shell, add `--reporter=default`.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageProvider, StorageUnavailableError } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { poolUsageTable } from "../../packages/workflows/src/durable/journal/pool-stage-usage.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { type PoolWork, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import type { WorkerStart } from "../../packages/workflows/src/workers/protocol.js";
import {
	expectedSessionEntries,
	expectedUsage,
	JournalRounds,
	type PooledChildRun,
	SimulatedPoolWorker,
	SimulatedRequestRefusedError,
	sessionIdOf,
	usageKeyOf,
} from "../helpers/pool-request-rounds.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const simulation = vi.hoisted(() => ({
	/** Set while a test simulates the pool's workers: the coordinator's `fork` returns one of them. */
	spawn: undefined as ((args: readonly string[]) => object) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		fork: (modulePath: string, args: readonly string[], options: ForkOptions) =>
			simulation.spawn === undefined ? actual.fork(modulePath, args, options) : simulation.spawn(args),
	};
});

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

afterEach(() => {
	simulation.spawn = undefined;
	vi.restoreAllMocks();
});

/** Simulated local workers, one pooled child each: a pool of the size #4312 measured. */
const WORKERS = 300;
/** Agent steps each worker runs while its heartbeat is in flight. */
const STEPS = 3;
/**
 * Journal transactions one agent step needs one after another on its own: the admission check's two (the attempt's
 * lease, then the pool's control), then the assistant entry and the tool result, which must apply in that order.
 */
const AGENT_STEP_ROUNDS = 4;
/** Journal transactions one worker may hold in a round: one of its heartbeat and one of its agent step. */
const TRANSACTIONS_PER_WORKER_ROUND = 2;
/** Long enough that no request renews a work lease on its own while the test holds the journal. */
const LEASE_MS = 600_000;
const WORKER_STARTUP_TIMEOUT_MS = 120_000;
/** How long the test waits for the pool to start every worker. */
const SPAWN_DEADLINE_MS = 120_000;
const SPAWN_POLL_MS = 25;
/** Rounds in a row with nothing held while workers have not finished; past it, a request is stuck outside the journal. */
const IDLE_ROUNDS_LIMIT = 200;
const IDLE_POLL_MS = 10;
/** Longest delay a slow journal gives one call before it runs, in milliseconds. */
const SLOW_SYNC_MAX_MS = 4;
/** The usage report, among each work's reports while the journal is held, that a full disk refuses. */
const REFUSED_REPORT = 1;
/**
 * The admission check, among each work's checks while the journal is held, that a late root renewal refuses. The second
 * step's runs in a round where the worker's heartbeat polls control rather than renewing its lease, so the renewal the
 * refusal makes is its own.
 */
const LATE_ADMISSION = 1;
/** Structural: a root with 300 pooled children, their workers' attachment, then every journal round of their steps. */
const PIPELINED_POOL_TIMEOUT_MS = 600_000;

interface Scenario {
	readonly name: string;
	/** Delay before each journal call runs, as a slow fsync gives it, so calls finish out of order. */
	readonly slowSync?: () => number;
	/** How far the journal's clock lags the coordinator's: every work lease it grants looks that much spent. */
	readonly clockLagMs?: number;
	/** Usage reports refuse as on a full disk, each work's {@link REFUSED_REPORT}th while the journal is held. */
	readonly diskFull?: boolean;
	/** The root renews its own lease late once: each work's {@link LATE_ADMISSION}th admission check is refused for it. */
	readonly lateRoot?: boolean;
}

interface Outcome {
	readonly workers: readonly SimulatedPoolWorker[];
	readonly rounds: JournalRounds;
	readonly contents: object;
	readonly expected: object;
	/** Each work's lease extensions in the order the coordinator asked: the round and the lease it extended. */
	readonly extensions: ReadonlyMap<string, readonly { readonly round: number; readonly expiresAt: number }[]>;
	/** The round in which each work's admission check was refused for a late root. */
	readonly lateRefusals: ReadonlyMap<string, number>;
}

/** What a full disk makes the journal throw. */
function diskFull(path: string): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "node-sqlite", location: path },
		{ errcode: 13, errstr: "database or disk is full" },
		"database or disk is full",
	);
}

/** Routes every pool journal call a worker request makes through `rounds`, with the scenario's faults. */
function holdPoolJournal(
	rounds: JournalRounds,
	scenario: Scenario,
	path: string,
	measuring: () => boolean,
): Pick<Outcome, "extensions" | "lateRefusals"> {
	const lag = (work: PoolWork): PoolWork =>
		scenario.clockLagMs === undefined ? work : { ...work, expiresAt: work.expiresAt - scenario.clockLagMs };
	const commit = SqlPoolQueue.prototype.commit;
	vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
		this: SqlPoolQueue,
		lease,
		work,
		operation,
		mutation,
	) {
		const receipt = await rounds.through("commit", () => commit.call(this, lease, work, operation, mutation));
		rounds.commitApplied(work.id, operation);
		return receipt;
	});
	const claim = SqlPoolQueue.prototype.claim;
	vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
		const claimed = await claim.apply(this, args);
		return claimed === undefined ? undefined : lag(claimed);
	});
	const extensions = new Map<string, { round: number; expiresAt: number }[]>();
	const extend = SqlPoolQueue.prototype.extend;
	vi.spyOn(SqlPoolQueue.prototype, "extend").mockImplementation(async function (
		this: SqlPoolQueue,
		lease,
		work,
		duration,
	) {
		if (measuring()) {
			const asked = extensions.get(work.id) ?? [];
			asked.push({ round: rounds.count, expiresAt: (work as PoolWork).expiresAt });
			extensions.set(work.id, asked);
		}
		return lag(await rounds.through("extend", () => extend.call(this, lease, work, duration)));
	});
	const control = SqlPoolQueue.prototype.control;
	vi.spyOn(SqlPoolQueue.prototype, "control").mockImplementation(function (this: SqlPoolQueue, lease) {
		return rounds.through("control", () => control.call(this, lease));
	});
	const admissions = new Map<string, number>();
	const lateRefusals = new Map<string, number>();
	const assertCurrent = SqlPoolQueue.prototype.assertCurrent;
	vi.spyOn(SqlPoolQueue.prototype, "assertCurrent").mockImplementation(function (this: SqlPoolQueue, lease, work) {
		const ordinal = measuring() ? (admissions.get(work.id) ?? 0) : -1;
		if (ordinal >= 0) admissions.set(work.id, ordinal + 1);
		const late = scenario.lateRoot === true && ordinal === LATE_ADMISSION;
		return rounds.through("assertCurrent", () =>
			late
				? (() => {
						lateRefusals.set(work.id, rounds.count);
						return Promise.reject(new StaleLeaseError(lease.runId, lease.epoch, lease.epoch));
					})()
				: assertCurrent.call(this, lease, work),
		);
	});
	const reports = new Map<string, number>();
	const report = SqlPoolUsage.prototype.report;
	vi.spyOn(SqlPoolUsage.prototype, "report").mockImplementation(function (this: SqlPoolUsage, lease, work, usage) {
		const ordinal = measuring() ? (reports.get(work.id) ?? 0) : -1;
		if (ordinal >= 0) reports.set(work.id, ordinal + 1);
		return rounds.through("report", () =>
			scenario.diskFull === true && ordinal === REFUSED_REPORT
				? Promise.reject(diskFull(path))
				: report.call(this, lease, work, usage),
		);
	});
	const total = SqlPoolUsage.prototype.total;
	vi.spyOn(SqlPoolUsage.prototype, "total").mockImplementation(function (this: SqlPoolUsage, root) {
		return rounds.through("total", () => total.call(this, root));
	});
	return { extensions, lateRefusals };
}

/** Runs journal rounds until every worker has finished its steps; the workers' heartbeats tick before each round. */
async function runRounds(rounds: JournalRounds, workers: readonly SimulatedPoolWorker[]): Promise<void> {
	let finished = false;
	const outcome = Promise.all(workers.map((worker) => worker.measure(STEPS))).then(
		() => undefined,
		(error: Error) => error,
	);
	void outcome.then(() => {
		finished = true;
	});
	for (let idle = 0; !finished; ) {
		for (const worker of workers) worker.tick();
		if (await rounds.next()) idle = 0;
		else if (!finished) {
			assert.ok(++idle < IDLE_ROUNDS_LIMIT, "workers are waiting on something other than the journal");
			await sleep(IDLE_POLL_MS);
		}
	}
	const failure = await outcome;
	if (failure !== undefined) throw failure;
}

function digest(value: object): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Runs one root with {@link WORKERS} simulated workers through {@link STEPS} agent steps each, under `scenario`. */
async function runPipelinedPool(scenario: Scenario): Promise<Outcome> {
	const directory = makeTempDirectory("pool-pipelined-requests-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const reader = new TestSqliteDatabase(path);
	reader.run("PRAGMA query_only=ON");
	const boundaryStart = reader.query("SELECT payload FROM wf_events WHERE run_id = ? AND key = ?");
	const rounds = new JournalRounds(scenario.slowSync);
	let measuring = false;
	const { extensions, lateRefusals } = holdPoolJournal(rounds, scenario, path, () => measuring);
	const workers: SimulatedPoolWorker[] = [];
	const attached: Promise<void>[] = [];
	simulation.spawn = (args) => {
		const start = JSON.parse(args[0]!) as WorkerStart;
		const worker = new SimulatedPoolWorker(start, rounds, (scope) => {
			const row = boundaryStart.get(
				start.root,
				JSON.stringify(["CheckpointRecorded", "stage", `boundary-start:${scope}`]),
			);
			const payload = JSON.parse(String(row!.payload)) as { topology: { boundary: { child: PooledChildRun } } };
			return payload.topology.boundary.child;
		});
		workers.push(worker);
		attached.push(worker.attach());
		return worker.process;
	};
	const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: WORKERS,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
		leaseMs: LEASE_MS,
		coordinator: "in-process",
	});
	const execution = run(
		workflow({
			name: "pool-pipelined-requests-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(
					Array.from({ length: WORKERS }, (_, index) => ctx.workflow(child, { inputs: { index } })),
				);
				return {};
			},
		}),
		{},
		{
			runId: testRunId(`pool-pipelined-requests-${scenario.name}`),
			cwd: directory,
			store: createStore(),
			durableBackend: backend,
		},
	).catch((error: Error) => error);
	let outcome: Outcome | undefined;
	let failure: Error | undefined;
	try {
		const deadline = performance.now() + SPAWN_DEADLINE_MS;
		while (workers.length < WORKERS) {
			assert.ok(performance.now() < deadline, `only ${workers.length} of ${WORKERS} workers started`);
			await sleep(SPAWN_POLL_MS);
		}
		await Promise.all(attached);

		rounds.hold();
		measuring = true;
		await runRounds(rounds, workers);
		measuring = false;
		rounds.release();

		const runs = sqlPoolStorage(journal)!.tables.runs;
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "sqlite", path, prefix: `${runs}_pool_` },
			{ agentDir: "", domain: "sessions" },
		);
		const indices = Array.from({ length: WORKERS }, (_, index) => index);
		const contents = {
			sessions: await Promise.all(indices.map(async (index) => (await sessions.load(sessionIdOf(index))).entries)),
			usage: reader
				.query(
					`SELECT key, input, output, cacheread AS cacheRead, cachewrite AS cacheWrite, cost FROM ${poolUsageTable(runs)} ORDER BY key`,
				)
				.all()
				.map((row) => ({ ...row })),
		};
		await sessions.close();
		const expected = {
			sessions: indices.map((index) => expectedSessionEntries(index, STEPS)),
			usage: indices
				.map((index) => ({ key: usageKeyOf(index), ...expectedUsage(STEPS) }))
				.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
		};
		const steps = workers.flatMap((worker) => worker.stepRounds);
		console.log(
			`pipelined worker requests (#4315), ${scenario.name}: ${WORKERS} workers x ${STEPS} agent steps; rounds per step mean ${(steps.reduce((sum, value) => sum + value, 0) / steps.length).toFixed(2)} max ${Math.max(...steps)}; journal transactions ${rounds.total()} (${(rounds.total() / steps.length).toFixed(2)} per step) ${JSON.stringify(Object.fromEntries(rounds.transactions))}; ${rounds.count} rounds; journal contents sha256 ${digest(contents)} (expected ${digest(expected)})`,
		);
		outcome = { workers, rounds, contents, expected, extensions, lateRefusals };
	} catch (error) {
		failure = error as Error;
	}
	// The root's children never finish, so closing the pool ends the root run. A cleanup failure fails only a run that
	// succeeded; it never replaces the failure of one that did not.
	rounds.release();
	const closed = await Promise.allSettled([pool.close()]);
	await execution;
	await backend.close();
	reader.close();
	removeTempDirectory(directory);
	if (failure !== undefined) throw failure;
	for (const result of closed) if (result.status === "rejected") throw result.reason;
	return outcome!;
}

/** What every run must show: each worker's entries in order and its final usage, commits applied in send order. */
function assertJournalIntact(outcome: Outcome): void {
	assert.deepEqual(
		outcome.contents,
		outcome.expected,
		"the journal holds every worker's entries in order and its usage",
	);
	for (const worker of outcome.workers)
		assert.deepEqual(outcome.rounds.applied.get(worker.work!.id), worker.sentCommits, "commits apply in send order");
}

function stepRounds(outcome: Outcome): readonly number[] {
	return outcome.workers.flatMap((worker) => worker.stepRounds);
}

test(
	"300 workers' agent steps take only their own journal round trips, apply each worker's commits in order and leave the same journal (#4315)",
	async () => {
		const outcome = await runPipelinedPool({ name: "benchmark" });
		assert.deepEqual(
			outcome.workers.flatMap((worker) => worker.failures),
			[],
		);
		assertJournalIntact(outcome);
		assert.deepEqual(
			[...new Set(stepRounds(outcome))],
			[AGENT_STEP_ROUNDS],
			"each agent step waits only for its own journal transactions, not for its worker's heartbeat",
		);
		assert.ok(
			outcome.rounds.total() <= WORKERS * outcome.rounds.count * TRANSACTIONS_PER_WORKER_ROUND,
			"a worker holds at most one heartbeat and one agent-step transaction at a time",
		);
		for (const worker of outcome.workers)
			assert.equal(
				outcome.extensions.get(worker.work!.id)?.length,
				worker.renewals,
				"only the heartbeat's renewals extend a lease that is not half spent",
			);
	},
	PIPELINED_POOL_TIMEOUT_MS,
);

test(
	"a slow journal whose calls finish out of order still applies each of 300 workers' commits in send order (#4315)",
	async () => {
		let seed = 4315;
		const outcome = await runPipelinedPool({
			name: "slow-sync",
			// A fixed linear congruential sequence, so every run gives the same delays.
			slowSync: () => {
				seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
				return seed % (SLOW_SYNC_MAX_MS + 1);
			},
		});
		assert.deepEqual(
			outcome.workers.flatMap((worker) => worker.failures),
			[],
		);
		assertJournalIntact(outcome);
		assert.deepEqual([...new Set(stepRounds(outcome))], [AGENT_STEP_ROUNDS]);
	},
	PIPELINED_POOL_TIMEOUT_MS,
);

test(
	"when the journal's clock lags the coordinator's, a worker's requests in flight share one lease extension and its lease never goes back (#4315)",
	async () => {
		const outcome = await runPipelinedPool({ name: "clock-lag", clockLagMs: (3 * LEASE_MS) / 4 });
		assert.deepEqual(
			outcome.workers.flatMap((worker) => worker.failures),
			[],
		);
		assertJournalIntact(outcome);
		for (const worker of outcome.workers) {
			const asked = outcome.extensions.get(worker.work!.id) ?? [];
			assert.ok(asked.length >= STEPS, "every step finds its lease half spent and extends it again");
			const rounds = asked.map((extension) => extension.round);
			assert.deepEqual(rounds, [...new Set(rounds)], "at most one extension of a worker's lease is in flight");
			const leases = asked.map((extension) => extension.expiresAt);
			assert.deepEqual(
				leases,
				[...leases].sort((left, right) => left - right),
				"each extension starts from a lease at least as late as the one before",
			);
		}
		assert.ok(
			Math.max(...stepRounds(outcome)) <= 2 * AGENT_STEP_ROUNDS,
			"a lease that looks spent adds at most one extension before each of a step's transactions",
		);
	},
	PIPELINED_POOL_TIMEOUT_MS,
);

test(
	"a usage report refused by a full disk fails only that report: 300 workers' heartbeats and agent steps go on (#4315)",
	async () => {
		const outcome = await runPipelinedPool({ name: "disk-full", diskFull: true });
		for (const worker of outcome.workers) {
			assert.equal(worker.failures.length, 1, "exactly the refused report failed");
			const [refusal] = worker.failures;
			assert.ok(refusal instanceof SimulatedRequestRefusedError);
			assert.equal(refusal.code, "request-refused");
			assert.equal(refusal.request, "usage");
		}
		assertJournalIntact(outcome);
		assert.deepEqual([...new Set(stepRounds(outcome))], [AGENT_STEP_ROUNDS]);
	},
	PIPELINED_POOL_TIMEOUT_MS,
);

test(
	"while the root renews its lease late, 300 workers' requests wait for it and renew their own attempts' leases before running again (#4315)",
	async () => {
		const outcome = await runPipelinedPool({ name: "late-root", lateRoot: true });
		assert.deepEqual(
			outcome.workers.flatMap((worker) => worker.failures),
			[],
		);
		assertJournalIntact(outcome);
		for (const worker of outcome.workers) {
			const refused = outcome.lateRefusals.get(worker.work!.id);
			const asked = (outcome.extensions.get(worker.work!.id) ?? []).map((extension) => extension.round);
			assert.ok(refused !== undefined, "each worker's admission check was refused once");
			assert.ok(
				asked.includes(refused),
				`the refused admission check renews its attempt's lease before it runs again (refused in round ${refused}; extensions asked after rounds ${asked.join(", ")})`,
			);
			assert.deepEqual(
				worker.stepRounds,
				[AGENT_STEP_ROUNDS, AGENT_STEP_ROUNDS + 2, AGENT_STEP_ROUNDS],
				"the refused step pays the refused round and its lease renewal, and no other step waits",
			);
		}
	},
	PIPELINED_POOL_TIMEOUT_MS,
);
