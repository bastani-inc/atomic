/**
 * Consolidation under chaos (#4325): consolidators SIGKILLed after fencing a run, after copying it and after repointing
 * the catalog, several consolidators at once, and readers paging through multi-page runs the whole time. After each, every
 * run reads in full, dense and once, through the catalog; no adopted file keeps a run or a fence; and every shard and the
 * catalog pass `PRAGMA integrity_check`. A reader sees a complete run or the retryable `run-moved`, never a short one.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { adoptJournals, JOURNAL_CONSOLIDATION_HOLDER_PREFIX, JournalCatalog } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test } from "vitest";
import { JOURNAL_READ_PAGE_SIZE } from "../../packages/workflows/src/durable/journal/internal.js";
import { openSelectedRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const CONSOLIDATOR = join(ROOT, "test/fixtures/journal-store-consolidator.ts");
const RUNS = 4;
const EVENTS = 2 * JOURNAL_READ_PAGE_SIZE + 88;
/** Each process loads the workflow journal from source under Bun before it does anything. */
const CONSOLIDATION_CHAOS_TIMEOUT_MS = 240_000;

let directory: string;
let store: string;
let legacy: string;
const children: SpawnedProcess[] = [];
beforeEach(() => {
	directory = makeTempDirectory("journal-store-consolidation-chaos-");
	store = join(directory, "journal");
	legacy = join(directory, "old", "journal.sqlite");
});
afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	removeTempDirectory(directory);
});

const runIds = Array.from({ length: RUNS }, (_, index) => `consolidating-${index}`);

/** `RUNS` finished runs of `EVENTS` events each in one adopted journal file. */
async function seed(): Promise<void> {
	mkdirSync(join(legacy, ".."), { recursive: true });
	const sql = await openSqlRunJournal(legacy);
	for (const runId of runIds) {
		await sql.createRun({ runId, name: "wf", cwd: directory, createdAt: 1, status: "running" });
		const held = await sql.acquire(runId, "writer");
		assert.equal(held.status, "acquired");
		if (held.status !== "acquired") continue;
		await sql.append(held.lease, { type: "RunStarted", payload: { runId } }, { key: "start" });
		await sql.append(held.lease, { type: "StatusChanged", payload: { status: "completed" } }, { key: "finished" });
		await sql.release(held.lease);
	}
	await sql.close();
	const database = new DatabaseSync(legacy);
	database.exec(
		`WITH RECURSIVE n(i) AS (SELECT 3 UNION ALL SELECT i + 1 FROM n WHERE i < ${EVENTS})
		INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at)
		SELECT r.run_id, n.i, 1, 'k' || n.i, 'SummaryRecorded', 'null', 0 FROM n, wf_runs AS r`,
	);
	database.close();
	await adoptJournals(store, [legacy]);
}

function start(args: readonly string[]) {
	const child = spawnProcess([bunExecutable(), CONSOLIDATOR, ...args], { cwd: ROOT });
	children.push(child);
	const stdout = (async () => {
		const reader = decodeStream(child.stdout!).getReader();
		let output = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return output;
			output += value;
		}
	})();
	const stderr = readStreamText(child.stderr);
	return { child, stdout, stderr };
}

async function finished(process: ReturnType<typeof start>): Promise<Record<string, number>> {
	const exitCode = await process.child.exited;
	assert.equal(exitCode, 0, await process.stderr);
	return JSON.parse((await process.stdout).trim().split("\n").at(-1)!) as Record<string, number>;
}

async function assertConsolidatedAndIntact(): Promise<void> {
	const journal = await openSelectedRunJournal({ kind: "sharded", dir: store }, directory);
	try {
		for (const runId of runIds) {
			const seqs: number[] = [];
			for await (const entry of journal.read(runId)) seqs.push(entry.seq);
			assert.deepEqual(
				seqs,
				Array.from({ length: EVENTS }, (_, index) => index + 1),
				`${runId} reads in full, dense and once`,
			);
		}
	} finally {
		await journal.close();
	}
	const source = new DatabaseSync(legacy, { readOnly: true });
	assert.equal(source.prepare("SELECT count(*) AS n FROM wf_runs").get()?.n, 0, "no run is left in the adopted file");
	assert.equal(source.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
	source.close();
	const catalog = await JournalCatalog.open(store);
	try {
		for (const shard of await catalog.shards()) {
			const database = new DatabaseSync(shard.path, { readOnly: true });
			assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok", shard.path);
			assert.equal(
				database
					.prepare("SELECT count(*) AS n FROM wf_leases WHERE holder_id LIKE ?")
					.get(`${JOURNAL_CONSOLIDATION_HOLDER_PREFIX}%`)?.n,
				0,
				`no consolidation fence is left on ${shard.path}`,
			);
			database.close();
		}
	} finally {
		await catalog.close();
	}
	const catalogFile = new DatabaseSync(join(store, "catalog.sqlite"), { readOnly: true });
	assert.equal(catalogFile.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
	catalogFile.close();
}

for (const step of ["fence", "copy", "repoint"] as const)
	test(
		`a consolidator killed ${step === "fence" ? "after fencing" : step === "copy" ? "after copying" : "after repointing the catalog"} a run leaves every run whole, and the next consolidation finishes the move (#4325)`,
		async () => {
			await seed();
			const killed = start(["consolidate", store, step]);
			assert.notEqual(await killed.child.exited, 0, "the consolidator did not finish");
			assert.equal((await killed.stdout).trim(), "", "and printed no report");
			// Windows ends a process that kills itself with an exit status, not a signal.
			if (process.platform !== "win32") assert.equal(killed.child.signalCode, "SIGKILL");
			await finished(start(["consolidate", store]));
			await assertConsolidatedAndIntact();
		},
		CONSOLIDATION_CHAOS_TIMEOUT_MS,
	);

test(
	"concurrent consolidators and readers lose no checkpoint, repeat none, and no reader sees a short run (#4325)",
	async () => {
		await seed();
		const stopFile = join(directory, "stop");
		const readers = [0, 1].map(() => start(["read", store, stopFile, String(EVENTS), ...runIds]));
		const consolidators = [0, 1, 2].map(() => start(["consolidate", store]));
		const reports = await Promise.all(consolidators.map(finished));
		assert.equal(
			reports.reduce((total, report) => total + report.moved, 0),
			RUNS,
			"every run is moved exactly once between the consolidators",
		);
		writeFileSync(stopFile, "");
		for (const reader of readers) {
			const summary = await finished(reader);
			assert.equal(summary.truncated, 0, `a reader saw a short or gapped run: ${JSON.stringify(summary)}`);
			assert.ok(summary.complete > 0, "the reader completed reads");
		}
		await assertConsolidatedAndIntact();
		assert.equal(existsSync(stopFile), true);
		assert.ok(readdirSync(store).some((file) => file.startsWith("shard-")));
	},
	CONSOLIDATION_CHAOS_TIMEOUT_MS,
);
