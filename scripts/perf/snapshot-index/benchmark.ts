#!/usr/bin/env bun
/**
 * Benchmark for what the snapshot reference index costs each write (#4355).
 *
 * Triggers on the run journal's events and runs tables and on the session store's entries keep the index current in
 * the same transaction as every write. This measures that cost: for each kind of write it appends `--appends`
 * records to a fresh database with the index triggers installed, and to a fresh database whose triggers were dropped,
 * `--rounds` times, alternating the two so that drift in the host affects both. It reports the median microseconds
 * per append of each, the difference, and the index rows the triggers wrote per append (SQLite's `total_changes()`,
 * the number `test/unit/worktree-snapshot-index-write-cost.test.ts` pins).
 *
 * A write that carries no snapshot only evaluates the trigger's `WHEN` condition, a text search of its payload. A
 * checkpoint that carries a snapshot also parses the payload as JSON and inserts one row for each blob it needs.
 *
 *   bun run scripts/perf/snapshot-index/benchmark.ts --appends 3000 --rounds 5 --dir /dev/shm --out /tmp/snapshot-index.md
 *
 * `--dir` is where the throwaway databases live (default: the temporary directory; a memory-backed directory such as
 * `/dev/shm` leaves the disk out of the numbers).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "../../../packages/coding-agent/src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import { SESSION_FORMAT_VERSION } from "../../../packages/coding-agent/src/core/storage/session/types.ts";
import type { WorktreeSnapshot } from "../../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { SqlRunJournal } from "../../../packages/workflows/src/durable/journal/sql-run-journal.ts";
import type { Lease, RunEvent } from "../../../packages/workflows/src/durable/journal/types.ts";

const RUN = "benchmark-run";
const SESSION = "benchmark-session";
const FILLER = "x".repeat(1_400);
const LINKS = 10;

interface Options {
	readonly appends: number;
	readonly rounds: number;
	readonly dir: string;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		appends: Number(value("appends") ?? "2000"),
		rounds: Number(value("rounds") ?? "5"),
		dir: value("dir") ?? tmpdir(),
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

function snapshot(index: number): WorktreeSnapshot {
	const patches = Array.from({ length: LINKS }, (_, link) => `patch-${index}-${link}`);
	return {
		version: 1,
		id: `snapshot-${index}`,
		root: "/repo",
		remotes: [],
		branch: "main",
		head: "a".repeat(40),
		snapshot: "b".repeat(40),
		tree: "c".repeat(40),
		envHash: "env",
		delta: { base: "head", patch: patches.at(-1) ?? null, bytes: 1 },
		chain: patches.map((patch, link) => ({ tree: `${link}`.padStart(40, "d"), patch, bytes: 1 })),
		bundle: { blob: `bundle-${index}`, bytes: 1, commits: ["e".repeat(40)] },
		omitted: [],
		filters: null,
		capturedAt: "2026-01-01T00:00:00.000Z",
	};
}

const checkpoint = (index: number, snapshots: readonly WorktreeSnapshot[]) =>
	({
		type: "CheckpointRecorded",
		payload: {
			kind: "tool",
			checkpointId: `checkpoint-${index}`,
			name: "edit",
			output: FILLER,
			...(snapshots.length === 0 ? {} : { worktreeSnapshots: snapshots }),
		},
	}) as unknown as RunEvent;

const status = (index: number) =>
	({
		type: "StatusChanged",
		payload: { workflowId: RUN, status: "running", completedCheckpoints: index, pendingPrompts: 0 },
	}) as unknown as RunEvent;

/** Entries follow each other, as a session records them: each one's parent is the one before it. */
const entryBase = (index: number) => ({
	id: `entry-${index}`,
	parentId: index === 1 ? null : `entry-${index - 1}`,
	timestamp: "2026-01-01T00:00:00.000Z",
});

const messageEntry = (index: number) =>
	({ type: "message", ...entryBase(index), message: { role: "user", content: FILLER, timestamp: 1 } }) as SessionEntry;

const snapshotEntry = (index: number) =>
	({
		type: "worktree_snapshot",
		...entryBase(index),
		root: "/repo",
		snapshotId: `snapshot-${index}`,
		snapshot: snapshot(index),
	}) as SessionEntry;

interface Writers {
	readonly journal: SqlRunJournal;
	readonly sessions: SqlSessionStore;
	readonly lease: Lease;
	lastSeq: number;
}

interface Case {
	readonly name: string;
	write(writers: Writers, index: number): Promise<unknown>;
}

const CASES: readonly Case[] = [
	{ name: "checkpoint, no snapshot", write: (w, i) => w.journal.append(w.lease, checkpoint(i, [])) },
	{
		name: `checkpoint, one snapshot (${LINKS} patches and a bundle)`,
		write: (w, i) => w.journal.append(w.lease, checkpoint(i, [snapshot(i)])),
	},
	{ name: "status event", write: (w, i) => w.journal.append(w.lease, status(i)) },
	{
		name: "session entry, no snapshot",
		write: async (w, i) => {
			({ lastSeq: w.lastSeq } = await w.sessions.append(SESSION, [messageEntry(i)], { expectSeq: w.lastSeq }));
		},
	},
	{
		name: `session entry, one snapshot record (${LINKS} patches and a bundle)`,
		write: async (w, i) => {
			({ lastSeq: w.lastSeq } = await w.sessions.append(SESSION, [snapshotEntry(i)], { expectSeq: w.lastSeq }));
		},
	},
];

interface Sample {
	readonly microseconds: number;
	readonly rowsChanged: number;
}

/** Appends `appends` records of `kind` to a fresh database, with or without the index triggers. */
async function measure(kind: Case, indexed: boolean, appends: number, dir: string): Promise<Sample> {
	const database = await openNodeSqliteDatabase(join(dir, "benchmark.sqlite"));
	try {
		const sessions = await SqlSessionStore.open(database);
		const journal = await SqlRunJournal.open(database);
		await journal.createRun({ runId: RUN, name: "benchmark", cwd: "/repo", createdAt: 1, status: "running" });
		const acquired = await journal.acquire(RUN, "benchmark");
		if (acquired.status !== "acquired") throw new Error("the benchmark run's lease is held");
		const created = await sessions.create(
			{ id: SESSION, version: SESSION_FORMAT_VERSION, createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" },
			[],
		);
		await journal.append(acquired.lease, status(0));
		if (!indexed) {
			const triggers = await database.all<{ name: string }>(
				"SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%snapshot%'",
			);
			for (const { name } of triggers) await database.exec(`DROP TRIGGER ${name}`);
		}
		const writers: Writers = { journal, sessions, lease: acquired.lease, lastSeq: created.lastSeq };
		const changes = async () => Number((await database.get<{ n: number }>("SELECT total_changes() AS n"))?.n);
		const before = await changes();
		const start = performance.now();
		for (let index = 1; index <= appends; index++) await kind.write(writers, index);
		const elapsed = performance.now() - start;
		const rowsChanged = (await changes()) - before;
		await journal.close();
		await sessions.close();
		return { microseconds: (elapsed * 1_000) / appends, rowsChanged };
	} finally {
		await database.close();
		rmSync(join(dir, "benchmark.sqlite"), { force: true });
		rmSync(join(dir, "benchmark.sqlite-wal"), { force: true });
		rmSync(join(dir, "benchmark.sqlite-shm"), { force: true });
	}
}

const median = (values: readonly number[]): number => {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	mkdirSync(options.dir, { recursive: true });
	const dir = mkdtempSync(join(options.dir, "snapshot-index-benchmark-"));
	const rows: string[] = [];
	try {
		for (const kind of CASES) {
			const plain: Sample[] = [];
			const indexed: Sample[] = [];
			for (let round = 0; round < options.rounds; round++) {
				for (const withIndex of round % 2 === 0 ? [false, true] : [true, false]) {
					(withIndex ? indexed : plain).push(await measure(kind, withIndex, options.appends, dir));
				}
			}
			const without = median(plain.map((sample) => sample.microseconds));
			const withTriggers = median(indexed.map((sample) => sample.microseconds));
			const indexRows =
				(median(indexed.map((s) => s.rowsChanged)) - median(plain.map((s) => s.rowsChanged))) / options.appends;
			rows.push(
				`| ${kind.name} | ${without.toFixed(1)} | ${withTriggers.toFixed(1)} | ${(withTriggers - without).toFixed(1)} | ${((100 * (withTriggers - without)) / without).toFixed(0)}% | ${indexRows} |`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const report = [
		`Snapshot reference index write cost: ${options.appends} appends per sample, median of ${options.rounds} rounds, Bun ${Bun.version}`,
		"",
		"| Write | Without index (µs) | With index (µs) | Added (µs) | Added | Index rows per append |",
		"|---|---:|---:|---:|---:|---:|",
		...rows,
		"",
	].join("\n");
	console.log(report);
	if (options.out !== undefined) writeFileSync(options.out, report);
}

await main();
