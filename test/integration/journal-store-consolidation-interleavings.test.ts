/**
 * Consolidation crash interleavings (#4402), with real consolidator processes ordered through file barriers and
 * SIGKILLed at the cleanup's catalog check, at its deletion, or after its recopy. A resume (this process) takes the
 * run's source over and appends while the consolidators move it. After each, every committed event reads through the
 * catalog, dense and once, from a shard that holds all of them; and once the resume is done, a consolidation moves the
 * run, no consolidation fence is left, and every file passes `PRAGMA integrity_check`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adoptJournals,
	JOURNAL_CONSOLIDATION_HOLDER_PREFIX,
	JournalCatalog,
	type Lease,
	type RunJournal,
} from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";
import { expireWorkflowLease } from "../helpers/workflow-lease.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const CONSOLIDATOR = join(ROOT, "test/fixtures/journal-store-consolidator.ts");
/** Up to five processes per test each load the workflow journal from source under Bun before they do anything. */
const INTERLEAVING_TIMEOUT_MS = 240_000;
const EVENTS = 3;

let directory: string;
let store: string;
let source: string;
const children: SpawnedProcess[] = [];
const journals: RunJournal[] = [];
beforeEach(() => {
	directory = makeTempDirectory("journal-store-consolidation-interleavings-");
	store = join(directory, "journal");
	source = join(directory, "old", "journal.sqlite");
});
afterEach(async () => {
	for (const journal of journals.splice(0)) await journal.close();
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	removeTempDirectory(directory);
});

/** One finished run `r` of `EVENTS` events in an adopted journal file. */
async function seed(): Promise<string> {
	mkdirSync(join(source, ".."), { recursive: true });
	const sql = await openSqlRunJournal(source);
	await sql.createRun({ runId: "r", name: "wf", cwd: directory, createdAt: 1, status: "failed" });
	const held = await sql.acquire("r", "writer");
	assert.equal(held.status, "acquired");
	if (held.status === "acquired") {
		for (let index = 1; index <= EVENTS; index++)
			await sql.append(held.lease, { type: "SummaryRecorded", payload: { index } }, { key: `k${index}` });
		await sql.release(held.lease);
	}
	await sql.close();
	await adoptJournals(store, [source]);
	const catalog = await JournalCatalog.open(store);
	try {
		return (await catalog.homeShard("r")).path;
	} finally {
		await catalog.close();
	}
}

interface Consolidator {
	readonly child: SpawnedProcess;
	readonly barrier: string;
	readonly stdout: Promise<string>;
	readonly stderr: Promise<string>;
}

/** A consolidator process stopping at `points` (`<point>=<pause|kill>`), or a plain one. */
function consolidator(name: string, points: readonly string[] = []): Consolidator {
	const barrier = join(directory, `barrier-${name}`);
	mkdirSync(barrier, { recursive: true });
	const args = points.length > 0 ? [barrier, ...points] : [];
	const child = spawnProcess([bunExecutable(), CONSOLIDATOR, "consolidate", store, ...args], { cwd: ROOT });
	children.push(child);
	return { child, barrier, stdout: readStreamText(child.stdout), stderr: readStreamText(child.stderr) };
}

/** Waits until the consolidator pauses at `point`; fails if it exits first. */
async function reached(running: Consolidator, point: string): Promise<void> {
	while (!existsSync(join(running.barrier, `${point}.reached`))) {
		if (running.child.exitCode !== null)
			assert.fail(`the consolidator exited ${running.child.exitCode} before ${point}: ${await running.stderr}`);
		await sleep(10);
	}
}

function release(running: Consolidator, point: string): void {
	writeFileSync(join(running.barrier, `${point}.go`), "");
}

async function finished(running: Consolidator): Promise<{ moved: number; skipped: number }> {
	assert.equal(await running.child.exited, 0, await running.stderr);
	return JSON.parse((await running.stdout).trim().split("\n").at(-1)!) as { moved: number; skipped: number };
}

async function killed(running: Consolidator): Promise<void> {
	assert.notEqual(await running.child.exited, 0, "the consolidator did not finish");
	assert.equal((await running.stdout).trim(), "", "and printed no report");
	// Windows ends a process that kills itself with an exit status, not a signal.
	if (process.platform !== "win32") assert.equal(running.child.signalCode, "SIGKILL");
}

async function consolidate(): Promise<{ moved: number; skipped: number }> {
	return finished(consolidator(`plain-${children.length}`));
}

async function storeJournal(): Promise<RunJournal> {
	const journal = await openSelectedRunJournal({ kind: "sharded", dir: store }, directory);
	journals.push(journal);
	return journal;
}

/** A resume that takes the run over from wherever the catalog names it and appends one event. */
async function resume(holder: string, staleAfterMs = -1): Promise<{ journal: RunJournal; lease: Lease }> {
	const journal = await storeJournal();
	const taken = await journal.takeoverExpired("r", holder, staleAfterMs);
	assert.equal(taken.status, "acquired", JSON.stringify(taken));
	if (taken.status !== "acquired") throw new Error("unreachable");
	await journal.append(taken.lease, { type: "SummaryRecorded", payload: { holder } }, { key: holder });
	return { journal, lease: taken.lease };
}

function scalar(path: string, sql: string): unknown {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return Object.values(database.prepare(sql).get() ?? {})[0];
	} finally {
		database.close();
	}
}

async function named(): Promise<string | undefined> {
	const catalog = await JournalCatalog.open(store);
	try {
		return (await catalog.locate("r"))?.shard.path;
	} finally {
		await catalog.close();
	}
}

/** Every committed event reads through the catalog, dense and once, and the shard it names holds every one. */
async function assertNothingLost(events: number, lastKey: string): Promise<string> {
	const journal = await openSelectedRunJournal({ kind: "sharded", dir: store }, directory);
	try {
		const read: { seq: number; key: string | undefined }[] = [];
		for await (const entry of journal.read("r")) read.push({ seq: entry.seq, key: entry.key });
		assert.deepEqual(
			read.map((entry) => entry.seq),
			Array.from({ length: events }, (_, index) => index + 1),
		);
		assert.equal(read.at(-1)?.key, lastKey);
	} finally {
		await journal.close();
	}
	const shard = await named();
	assert.ok(shard !== undefined);
	assert.equal(scalar(shard, "SELECT count(*) FROM wf_events WHERE run_id = 'r'"), events, shard);
	return shard;
}

/** No consolidation fence is left on any shard, and every shard and the catalog pass `PRAGMA integrity_check`. */
async function assertSettled(): Promise<void> {
	const catalog = await JournalCatalog.open(store);
	try {
		for (const shard of await catalog.shards()) {
			assert.equal(scalar(shard.path, "PRAGMA integrity_check"), "ok", shard.path);
			assert.equal(
				scalar(
					shard.path,
					`SELECT count(*) FROM wf_leases WHERE holder_id LIKE '${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}%'`,
				),
				0,
				`no consolidation fence is left on ${shard.path}`,
			);
		}
	} finally {
		await catalog.close();
	}
	assert.equal(scalar(join(store, "catalog.sqlite"), "PRAGMA integrity_check"), "ok");
}

/** The resume finishes, and a consolidation then moves the run with every event into the destination. */
async function assertMovedOnceReleased(
	resumed: { journal: RunJournal; lease: Lease },
	destination: string,
	events: number,
	lastKey: string,
) {
	await resumed.journal.release(resumed.lease);
	assert.equal((await consolidate()).moved, 1);
	assert.equal(await assertNothingLost(events, lastKey), destination);
	assert.equal(scalar(source, "SELECT count(*) FROM wf_runs"), 0);
	await assertSettled();
}

test(
	"a move that a resume overtakes, onto a destination a crashed consolidator still fences, is returned to the source (#4402)",
	async () => {
		const destination = await seed();
		await killed(consolidator("crashed", ["copied=kill"]));
		const deadFence = String(scalar(destination, "SELECT holder_id FROM wf_leases WHERE run_id = 'r'"));
		assert.ok(deadFence.startsWith(JOURNAL_CONSOLIDATION_HOLDER_PREFIX), "the crashed consolidator's fence");
		expireWorkflowLease(destination, "r");
		const moving = consolidator("moving", ["repointing=pause"]);
		await reached(moving, "repointing");
		const resumed = await resume("p1");
		release(moving, "repointing");
		assert.deepEqual(await finished(moving), { moved: 0, skipped: 1 });
		assert.equal(await assertNothingLost(EVENTS + 1, "p1"), source);
		assert.equal(scalar(destination, "SELECT count(*) FROM wf_runs"), 0, "the crashed consolidator's copy is gone");
		await resumed.journal.append(resumed.lease, { type: "SummaryRecorded", payload: null }, { key: "after" });
		await assertMovedOnceReleased(resumed, destination, EVENTS + 2, "after");
	},
	INTERLEAVING_TIMEOUT_MS,
);

for (const point of ["checked", "deleted"] as const)
	test(
		`a consolidator that a resume overtakes and that crashes ${point === "checked" ? "at its cleanup's catalog check" : "after its cleanup's deletion"} leaves the next move nothing to lose (#4402)`,
		async () => {
			const destination = await seed();
			const crashed = consolidator("crashed", ["copied=pause", `${point}=kill`]);
			await reached(crashed, "copied");
			const resumed = await resume("p1");
			release(crashed, "copied");
			await killed(crashed);
			assert.equal(await assertNothingLost(EVENTS + 1, "p1"), source);
			const fences = scalar(destination, "SELECT count(*) FROM wf_leases WHERE run_id = 'r'");
			// A deletion removes the copy and its fence together: a crash after it leaves no fence to recover.
			assert.equal(fences, point === "checked" ? 1 : 0);
			if (point === "checked") expireWorkflowLease(destination, "r");
			await assertMovedOnceReleased(resumed, destination, EVENTS + 1, "p1");
		},
		INTERLEAVING_TIMEOUT_MS,
	);

for (const point of ["checked", "deleted", "recopied"] as const)
	test(
		`a cleanup that another consolidator's repoint overtakes and that crashes ${point === "checked" ? "at its catalog check" : point === "deleted" ? "after its deletion" : "after its recopy"} loses no checkpoint (#4402)`,
		async () => {
			const destination = await seed();
			const cleaning = consolidator("cleaning", [
				"copied=pause",
				point === "checked" ? "checked=kill" : "checked=pause",
				...(point === "checked" ? [] : [`${point}=kill`]),
			]);
			await reached(cleaning, "copied");
			const repointing = consolidator("repointing", ["repointing=pause"]);
			await reached(repointing, "repointing");
			const resumed = await resume("p1");
			release(cleaning, "copied");
			if (point === "checked") await killed(cleaning);
			else await reached(cleaning, "checked");
			release(repointing, "repointing");
			assert.deepEqual(await finished(repointing), { moved: 0, skipped: 1 });
			if (point !== "checked") {
				release(cleaning, "checked");
				await killed(cleaning);
			}
			assert.equal(await named(), destination, "the other consolidator repointed the catalog");
			assert.equal(
				scalar(destination, "SELECT count(*) FROM wf_events WHERE run_id = 'r'"),
				{ checked: EVENTS, deleted: 0, recopied: EVENTS + 1 }[point],
			);
			await consolidate();
			if (point === "checked") {
				assert.equal(
					await named(),
					destination,
					"a fresh fence is left to the consolidator that may still hold it",
				);
				expireWorkflowLease(destination, "r");
				await consolidate();
			}
			if (point === "recopied") {
				assert.equal(await assertNothingLost(EVENTS + 1, "p1"), destination);
				const fenced = await storeJournal();
				const early = await fenced.takeoverExpired("r", "p2", FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
				assert.equal(early.status, "held", "a resume waits out the crashed consolidator's fresh fence");
				expireWorkflowLease(destination, "r");
				const next = await resume("p2", FOREIGN_LIVE_WORKFLOW_WINDOW_MS);
				assert.equal(await assertNothingLost(EVENTS + 2, "p2"), destination);
				await next.journal.release(next.lease);
				await assertSettled();
				return;
			}
			assert.equal(await assertNothingLost(EVENTS + 1, "p1"), source);
			await resumed.journal.append(resumed.lease, { type: "SummaryRecorded", payload: null }, { key: "after" });
			await assertMovedOnceReleased(resumed, destination, EVENTS + 2, "after");
		},
		INTERLEAVING_TIMEOUT_MS,
	);

function waitsForWriteLock(path: string): boolean {
	return existsSync(`${path}-writers`) && readdirSync(`${path}-writers`).length > 0;
}

test(
	"a run returned to its source while another consolidator moves it out again and deletes the source loses no checkpoint (#4402)",
	async () => {
		const destination = await seed();
		const cleaning = consolidator("cleaning", ["copied=pause", "checked=pause", "deleted=kill"]);
		await reached(cleaning, "copied");
		const repointing = consolidator("repointing", ["repointing=pause"]);
		await reached(repointing, "repointing");
		const resumed = await resume("p1");
		release(cleaning, "copied");
		await reached(cleaning, "checked");
		release(repointing, "repointing");
		await finished(repointing);
		release(cleaning, "checked");
		await killed(cleaning);
		const onSource = await openSqlRunJournal(source);
		try {
			await onSource.release(resumed.lease);
		} finally {
			await onSource.close();
		}
		assert.equal(await named(), destination);
		assert.equal(scalar(destination, "SELECT count(*) FROM wf_runs"), 0, "the catalog names a shard without the run");
		const returning = consolidator("returning", ["repointing=pause"]);
		await reached(returning, "repointing");
		const moving = consolidator("moving");
		while (moving.child.exitCode === null && !waitsForWriteLock(source)) await sleep(10);
		release(returning, "repointing");
		await finished(moving);
		await finished(returning);
		await assertNothingLost(EVENTS + 1, "p1");
		await consolidate();
		assert.equal(await assertNothingLost(EVENTS + 1, "p1"), destination);
		assert.equal(scalar(source, "SELECT count(*) FROM wf_runs"), 0);
		await assertSettled();
	},
	INTERLEAVING_TIMEOUT_MS,
);

test(
	"an undo whose destination a resume takes over, writes to and releases before the undo's delete keeps that checkpoint selected (#4402)",
	async () => {
		const destination = await seed();
		const undoing = consolidator("undoing", ["repointing=pause", "undoing=pause"]);
		await reached(undoing, "repointing");
		const onSource = await openSqlRunJournal(source);
		try {
			const held = await onSource.takeoverExpired("r", "p1", -1);
			assert.equal(held.status, "acquired", JSON.stringify(held));
			if (held.status !== "acquired") throw new Error("unreachable");
			release(undoing, "repointing");
			await reached(undoing, "undoing");
			assert.equal(await named(), destination);
			const resumed = await resume("p2");
			await resumed.journal.release(resumed.lease);
			release(undoing, "undoing");
			assert.deepEqual(await finished(undoing), { moved: 0, skipped: 1 });
			assert.equal(await assertNothingLost(EVENTS + 1, "p2"), destination);
			await onSource.release(held.lease);
		} finally {
			await onSource.close();
		}
		await consolidate();
		assert.equal(await assertNothingLost(EVENTS + 1, "p2"), destination);
		await assertSettled();
	},
	INTERLEAVING_TIMEOUT_MS,
);
