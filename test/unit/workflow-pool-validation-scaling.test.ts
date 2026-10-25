import assert from "node:assert/strict";
import { join } from "node:path";
import type { SqliteExecutor } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { POOL_USAGE_FIELDS, upsertPoolUsage } from "../../packages/workflows/src/durable/journal/pool-stage-usage.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage, type PoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Per-commit cost may grow this much from a 10× smaller history before it counts as scaling with history. */
const MAX_HISTORY_SLOWDOWN = 3;
/** Building and timing two journals with thousands of rows each is structural cost, not a slow test. */
const HISTORY_FIXTURE_TIMEOUT_MS = 120_000;
const SAMPLES = 25;
/** A usage total takes microseconds, so each sample times a run of them. */
const TOTALS_PER_SAMPLE = 20;
const OUTPUT = "x".repeat(600);

const { work, boundary } = poolWorkFixture();
const run = { ...boundary.topology!.boundary!.child };

async function poolFixture() {
	const directory = makeTempDirectory("pool-validation-scaling-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, 600_000);
	await pool.enqueue(lease, work, boundary);
	const attempt = await pool.claim(lease, "worker", [work], 600_000);
	assert.ok(attempt);
	return {
		database,
		journal,
		lease,
		pool,
		attempt,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

async function nextSeq(tx: SqliteExecutor): Promise<number> {
	return Number((await tx.get("SELECT COALESCE(MAX(seq), 0) AS seq FROM wf_events WHERE run_id = 'root'"))!.seq) + 1;
}

/** Record `checkpoints` checkpoints across `children` other child runs, each child's boundary start first. */
async function recordHistory(tx: SqliteExecutor, children: number, checkpoints: number): Promise<void> {
	let seq = await nextSeq(tx);
	const insert = async (checkpoint: DurableCheckpoint) => {
		const key = JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, checkpoint.kind, checkpoint.checkpointId]);
		await tx.run(
			"INSERT INTO wf_events VALUES ('root', ?, 1, ?, ?, ?, ?)",
			seq++,
			key,
			RUN_EVENT_TYPES.checkpointRecorded,
			JSON.stringify(checkpoint),
			seq,
		);
		await tx.run(
			"INSERT INTO wf_events VALUES ('root', ?, 1, NULL, ?, ?, ?)",
			seq++,
			RUN_EVENT_TYPES.messageDelivered,
			JSON.stringify({ delivered: seq }),
			seq,
		);
	};
	const perChild = checkpoints / children;
	for (let index = 0; index < children; index++) {
		const other = poolWorkFixture(`other-${index}`);
		const otherRun = { ...other.boundary.topology!.boundary!.child };
		await insert(other.boundary);
		for (let stage = 1; stage < perChild; stage++)
			await insert({
				kind: "stage",
				workflowId: "root",
				checkpointId: `${other.work.scope}:stage-${stage}:0`,
				name: `stage-${stage}`,
				replayKey: `${other.work.scope}:stage-${stage}`,
				output: OUTPUT,
				completedAt: stage,
				topology: {
					version: 1,
					stageId: `stage-${stage}`,
					parentIds: stage > 1 ? [`stage-${stage - 1}`] : [],
					sourceOrder: stage,
					status: "completed",
					run: otherRun,
				},
			});
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)]!;
}

/** Median time of one pool commit of a fresh stage checkpoint for the leased child, after `checkpoints` are recorded. */
async function commitTime(children: number, checkpoints: number): Promise<number> {
	const f = await poolFixture();
	try {
		await f.database.transaction((tx) => recordHistory(tx, children, checkpoints));
		const samples: number[] = [];
		for (let index = 0; index < SAMPLES + 3; index++) {
			const started = performance.now();
			await f.pool.commit(f.lease, f.attempt, `stage-${index}`, {
				kind: "checkpoint",
				checkpoint: {
					kind: "stage",
					workflowId: "root",
					checkpointId: `${work.scope}:stage-${index}:0`,
					name: `stage-${index}`,
					replayKey: `${work.scope}:stage-${index}`,
					output: OUTPUT,
					completedAt: 1,
					topology: {
						version: 1,
						stageId: `stage-${index}`,
						parentIds: index > 0 ? [`stage-${index - 1}`] : [],
						sourceOrder: index + 1,
						status: "completed",
						run,
					},
				},
			});
			// The first commits build the index from the whole history; only steady-state commits are measured.
			if (index >= 3) samples.push(performance.now() - started);
		}
		return median(samples);
	} finally {
		await f.close();
	}
}

test(
	"a pool commit's validation stays flat as the root's checkpoint history grows",
	async () => {
		const small = await commitTime(40, 500);
		const large = await commitTime(400, 5_000);
		assert.ok(
			large < small * MAX_HISTORY_SLOWDOWN,
			`5,000 checkpoints: ${large.toFixed(2)} ms per commit; 500 checkpoints: ${small.toFixed(2)} ms`,
		);
	},
	HISTORY_FIXTURE_TIMEOUT_MS,
);

const FIELDS = POOL_USAGE_FIELDS;
const zero: PoolUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** Add pool work rows for the root, so usage can be charged to them. */
async function addWork(tx: SqliteExecutor, root: string, count: number, from = 0): Promise<string[]> {
	const ids: string[] = [];
	for (let index = from; index < from + count; index++) {
		const id = `${root}-work-${index}`;
		await tx.run(
			"INSERT INTO wf_runs_work(id, root, boundary, descriptor, fingerprint, ready_at) VALUES (?, ?, ?, ?, '', 0)",
			id,
			root,
			`boundary-${index}`,
			JSON.stringify({ scope: `scope-${index}`, childRunId: `child-run-${index}` }),
		);
		ids.push(id);
	}
	return ids;
}

async function sumOfRows(executor: Pick<SqliteExecutor, "get">, root: string): Promise<PoolUsage> {
	const row = await executor.get(
		`SELECT ${FIELDS.map((field) => `COALESCE(SUM(u.${field.toLowerCase()}), 0) AS ${field}`).join(", ")}
		 FROM wf_runs_pool_usage u JOIN wf_runs_work w ON w.id = u.work WHERE w.root = ?`,
		root,
	);
	return Object.fromEntries(FIELDS.map((field) => [field, Number(row?.[field] ?? 0)])) as PoolUsage;
}

function seeded(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

test("a root's usage total always equals SUM over its usage rows, through every kind of write", async () => {
	for (const seed of [7, 11, 13, 17]) await usageHistory(seed);
});

async function usageHistory(seed: number): Promise<void> {
	const f = await poolFixture();
	const other = await openNodeSqliteDatabase(f.database.descriptor.location);
	try {
		const ledger = await openSqlPoolUsage(f.journal);
		const next = seeded(seed);
		const value = () => (next() < 0.5 ? Math.floor(next() * 5_000) : next() * 3);
		const usage = (): PoolUsage => ({
			input: Math.floor(next() * 10_000),
			output: Math.floor(next() * 2_000),
			cacheRead: value(),
			cacheWrite: value(),
			cost: next() * 0.37,
		});
		let works = await f.database.transaction((tx) => addWork(tx, "root", 20));
		let added = 20;
		assert.deepEqual(await ledger.total("root"), zero);
		for (let step = 0; step < 1_000; step++) {
			const roll = next();
			const id = works[Math.floor(next() * works.length)]!;
			const key = `stage-${Math.floor(next() * 6)}`;
			if (roll < 0.7) await f.database.transaction((tx) => upsertPoolUsage(tx, "wf_runs", id, 1, key, usage()));
			else if (roll < 0.8)
				// Another connection rewrites a row in place, as a repair or an older Atomic might.
				await other.run("UPDATE wf_runs_pool_usage SET cost = ?, input = input + 1 WHERE work = ?", next(), id);
			else if (roll < 0.85) await other.run("DELETE FROM wf_runs_pool_usage WHERE work = ? AND key = ?", id, key);
			else if (roll < 0.88) {
				await other.run("DELETE FROM wf_runs_work WHERE id = ?", id);
				works = works.filter((work) => work !== id);
				works.push(...(await f.database.transaction((tx) => addWork(tx, "root", 1, added++))));
			}
			if (next() < 0.5 || step % 50 === 0)
				assert.deepEqual(
					await ledger.total("root"),
					await sumOfRows(f.database, "root"),
					`seed ${seed} step ${step}`,
				);
		}
		assert.deepEqual(await ledger.total("root"), await sumOfRows(f.database, "root"));
		assert.notDeepEqual(await ledger.total("root"), zero);
	} finally {
		await other.close();
		await f.close();
	}
}

test("a journal written before usage totals existed reports its full SUM", async () => {
	const f = await poolFixture();
	try {
		const ids = await f.database.transaction((tx) => addWork(tx, "root", 5));
		await f.database.exec(`DROP TABLE wf_runs_pool_usage_totals;
			DROP TRIGGER wf_runs_pool_usage_totals_insert; DROP TRIGGER wf_runs_pool_usage_totals_update;
			DROP TRIGGER wf_runs_pool_usage_totals_delete; DROP TRIGGER wf_runs_pool_usage_totals_work_delete;`);
		await f.database.transaction(async (tx) => {
			for (const [index, id] of ids.entries())
				await upsertPoolUsage(tx, "wf_runs", id, 1, "stage", { ...zero, input: 10 * index, cost: 0.1 * index });
		});
		const ledger = await openSqlPoolUsage(f.journal);
		const expected = await sumOfRows(f.database, "root");
		assert.equal(expected.input, 100);
		assert.deepEqual(await ledger.total("root"), expected);
		await f.database.transaction((tx) =>
			upsertPoolUsage(tx, "wf_runs", ids[0]!, 2, "stage", { ...zero, input: 1, cost: 0.3 }),
		);
		assert.deepEqual(await ledger.total("root"), await sumOfRows(f.database, "root"));
	} finally {
		await f.close();
	}
});

/** Median time to read a root's usage total with `rows` usage rows charged to it. */
async function totalTime(rows: number): Promise<number> {
	const f = await poolFixture();
	try {
		const ledger = await openSqlPoolUsage(f.journal);
		await f.database.transaction(async (tx) => {
			const ids = await addWork(tx, "root", 400);
			for (let row = 0; row < rows; row++)
				await upsertPoolUsage(tx, "wf_runs", ids[row % ids.length]!, 1, `stage-${row}`, {
					...zero,
					input: row,
					cost: row / 1_000,
				});
		});
		await ledger.total("root");
		const samples: number[] = [];
		for (let index = 0; index < SAMPLES; index++) {
			const started = performance.now();
			for (let read = 0; read < TOTALS_PER_SAMPLE; read++) await ledger.total("root");
			samples.push((performance.now() - started) / TOTALS_PER_SAMPLE);
		}
		return median(samples);
	} finally {
		await f.close();
	}
}

test(
	"reading a root's usage total stays flat as its usage rows grow",
	async () => {
		const small = await totalTime(1_000);
		const large = await totalTime(40_000);
		assert.ok(
			large < small * MAX_HISTORY_SLOWDOWN,
			`40,000 usage rows: ${large.toFixed(3)} ms per total; 1,000 rows: ${small.toFixed(3)} ms`,
		);
	},
	HISTORY_FIXTURE_TIMEOUT_MS,
);
