import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const actions = ["enqueue", "claim", "unplaced", "exited", "expire", "resume"] as const;
type Action = (typeof actions)[number];

for (const seed of [7, 41, 97]) {
	test(`ready marks stay fresh across mixed queue transitions with seed ${seed} (#5230)`, async () => {
		const directory = makeTempDirectory("pool-ready-revision-");
		const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
		const journal = await SqlRunJournal.open(database);
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "coordinator");
			if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
			const lease = acquired.lease;
			const pool = await openSqlPoolQueue(journal);
			await pool.initialize(lease, 600_000);
			const ready = new Map<string, PoolWork>();
			const held = new Map<string, PoolWork>();
			const marks = new Set<string>();
			let random = seed;
			let children = 0;
			let claims = 0;
			let controlRevision = 0;
			const next = (limit: number) => {
				random ^= random << 13;
				random ^= random >>> 17;
				random ^= random << 5;
				return (random >>> 0) % limit;
			};
			const record = async (action: Action) => {
				const mark = await pool.readyMark("root");
				if (mark !== undefined) {
					assert.equal(marks.has(mark), false, `${action} repeated ready mark ${mark}`);
					marks.add(mark);
					assert.equal(await pool.readyMark("root"), mark, "reading readiness must not change its mark");
				}
				assert.deepEqual(await pool.control(lease), { state: "running", revision: controlRevision });
			};
			const take = async (durationMs: number) => {
				if (ready.size === 0) return undefined;
				const candidate = [...ready.values()][next(ready.size)]!;
				const claimed = await pool.claim(lease, `worker-${claims++}`, [candidate], durationMs, {
					kind: "work",
					id: candidate.id,
					generation: candidate.generation,
				});
				assert.ok(claimed);
				ready.delete(claimed.id);
				return claimed;
			};
			const prefix: Action[] = ["enqueue", "claim", "unplaced", "claim", "exited", "expire", "resume"];
			for (let index = 0; index < 64; index++) {
				const action = prefix[index] ?? actions[next(actions.length)]!;
				if (action === "enqueue") {
					const fixture = poolWorkFixture(`child-${children++}`);
					const queued = await pool.enqueue(lease, fixture.work, fixture.boundary);
					ready.set(queued.id, queued);
					await record(action);
				} else if (action === "claim") {
					const claimed = await take(60_000);
					if (claimed !== undefined) held.set(claimed.id, claimed);
				} else if (action === "unplaced" || action === "exited") {
					if (held.size === 0) continue;
					const claim = [...held.values()][next(held.size)]!;
					const settle = () =>
						action === "unplaced" ? pool.releaseUnplaced(lease, claim) : pool.releaseExited(lease, claim);
					assert.equal(await settle(), true);
					held.delete(claim.id);
					ready.set(claim.id, { ...claim, generation: claim.generation - Number(action === "unplaced") });
					await record(action);
					const mark = await pool.readyMark("root");
					assert.equal(await settle(), false);
					assert.equal(await pool.readyMark("root"), mark, "a stale release must not change readiness");
				} else if (action === "expire") {
					const claim = await take(1);
					if (claim === undefined) continue;
					while (
						Number((await database.get("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now"))!.now) <=
						claim.expiresAt
					)
						await sleep(1);
					assert.equal(await pool.expire(lease, claim), true);
					ready.set(claim.id, claim);
					await record(action);
				} else {
					await pool.setControl(lease, "paused");
					await pool.setControl(lease, "running");
					controlRevision += 2;
					await record(action);
				}
			}
		} finally {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	});
}

test("an existing pool gains ready tracking without changing legacy initialization or attempt accounting (#5230)", async () => {
	const directory = makeTempDirectory("pool-ready-upgrade-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	try {
		const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
		await journal.createRun(header);
		const acquired = await journal.acquire("root", "coordinator");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		const lease = acquired.lease;
		const previous = await openSqlPoolQueue(journal);
		await previous.initialize(lease, 600_000);
		const fixture = poolWorkFixture();
		await previous.enqueue(lease, fixture.work, fixture.boundary);
		const version = await database.get("SELECT version FROM wf_runs_pool_meta");
		await database.exec("DROP TABLE wf_runs_pool_ready");
		const pool = await openSqlPoolQueue(journal);
		assert.deepEqual(await database.get("SELECT version FROM wf_runs_pool_meta"), version);
		const legacyMark = await pool.readyMark("root");
		assert.ok(legacyMark !== undefined);
		assert.equal(await pool.readyMark("root"), legacyMark);
		await journal.createRun({ ...header, runId: "legacy" });
		await database.run("INSERT INTO wf_runs_pool VALUES (?, ?)", "legacy", 600_000);
		const legacyLease = await journal.acquire("legacy", "legacy-coordinator");
		if (legacyLease.status !== "acquired") assert.fail("legacy root lease was not acquired");
		await pool.initialize(legacyLease.lease, 600_000);
		const claim = await pool.claim(lease, "worker", [fixture.work], 60_000);
		assert.ok(claim);
		assert.equal(await pool.releaseUnplaced(lease, claim), true);
		assert.notEqual(await pool.readyMark("root"), legacyMark);
		const next = await pool.claim(lease, "replacement", [fixture.work], 60_000);
		assert.ok(next);
		assert.equal(next.generation, claim.generation);
		assert.equal(await pool.releaseExited(lease, next), true);
		await database.run("DELETE FROM wf_runs_pool_ready WHERE root = ?", "root");
		const withoutCounter = await pool.readyMark("root");
		assert.ok(withoutCounter !== undefined);
		assert.equal(withoutCounter, legacyMark);
		assert.deepEqual(await pool.control(lease), { state: "running", revision: 0 });
	} finally {
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	}
});
