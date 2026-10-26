import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	RELEASED_PERMIT_RETENTION,
	SqlResourceAdmission,
} from "../../packages/workflows/src/workers/resource-admission.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Owners still holding a session permit, as every live pooled worker attempt does. */
const LIVE_OWNERS = 4;
/** Released process permits: the history every command a stage ran leaves behind. */
const RELEASED_HISTORY = 20;
/** A full read of the permits table, under its name or the `p` alias reconciliation reads it as. */
const PERMIT_SCAN = /^SCAN (wf_runs_resource_permits|p)\b/;

/**
 * Wraps a database so that, while `recording` is set, every statement also reports how SQLite plans to read it and
 * every write transaction is counted. Only full reads of the permits table are kept: each costs the whole history.
 */
function observeJournal(database: SqliteDatabase) {
	const observer = { recording: false, scans: [] as string[], transactions: 0 };
	const explain = async (executor: SqliteExecutor, sql: string, params: readonly SqliteValue[]) => {
		if (!observer.recording || !/^\s*(SELECT|UPDATE|DELETE)\b/i.test(sql)) return;
		const plan = await executor.all<SqliteRow & { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
		for (const step of plan) if (PERMIT_SCAN.test(step.detail)) observer.scans.push(sql.replace(/\s+/g, " "));
	};
	const observe = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		async run(sql, ...params) {
			await explain(executor, sql, params);
			return executor.run(sql, ...params);
		},
		async get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) {
			await explain(executor, sql, params);
			return executor.get<T>(sql, ...params);
		},
		async all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) {
			await explain(executor, sql, params);
			return executor.all<T>(sql, ...params);
		},
	});
	const observed: SqliteDatabase = {
		...observe(database),
		descriptor: database.descriptor,
		transaction: (callback) => {
			if (observer.recording) observer.transactions += 1;
			return database.transaction((tx) => callback(observe(tx)));
		},
		close: () => database.close(),
	};
	return { observer, observed };
}

async function admissionFixture() {
	const directory = makeTempDirectory("resource-admission-reconcile-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const { observer, observed } = observeJournal(database);
	const journal = await SqlRunJournal.open(observed);
	return {
		database,
		journal,
		observer,
		/** Releases `count` process permits, then opens `LIVE_OWNERS` owners that each keep a session permit. */
		async seed(count: number) {
			const history = await SqlResourceAdmission.open(journal, { root: "root", holder: "history" });
			for (let index = 0; index < count; index += 1) await (await history.acquire("process"))();
			const live: SqlResourceAdmission[] = [];
			for (let index = 0; index < LIVE_OWNERS; index += 1) {
				const admission = await SqlResourceAdmission.open(journal, { root: "root", holder: `worker-${index}` });
				await admission.acquire("session");
				live.push(admission);
			}
			return live;
		},
		async reconcileObserved(admission: SqlResourceAdmission) {
			observer.recording = true;
			observer.scans = [];
			observer.transactions = 0;
			try {
				await admission.reconcile();
			} finally {
				observer.recording = false;
			}
		},
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("reconciling resource admission never reads the whole permit history (#3978)", async () => {
	const f = await admissionFixture();
	try {
		const live = await f.seed(RELEASED_HISTORY);
		// Every pooled worker reconciles before it admits a command. A full read of the permit history per live owner,
		// inside the write transaction, held the shared journal's write lock for ~0.8 s with 160 workers and 26k permits,
		// until other writers gave up waiting for it.
		await f.reconcileObserved(live[0]!);
		assert.deepEqual(f.observer.scans, [], "reconcile read every permit");
		const granted = (await live[0]!.inspect()).filter((row) => row.state === "granted");
		assert.equal(granted.length, LIVE_OWNERS, "reconciliation keeps live owners' permits granted");
	} finally {
		await f.close();
	}
});

test("reconciling with nothing left to fence does not take the journal write lock (#3978)", async () => {
	const f = await admissionFixture();
	try {
		const live = await f.seed(RELEASED_HISTORY);
		// An owner that is idle past its lease looks expired: its grants are marked once, not rewritten on every pass.
		await f.database.run("UPDATE wf_runs_resource_owners SET expires_at = 0");
		await f.reconcileObserved(live[0]!);
		assert.equal(f.observer.transactions, 1, "the first pass records the expired owners");
		assert.deepEqual(f.observer.scans, [], "the write pass reads no permit history either");
		const marked = (await live[0]!.inspect()).filter((row) => row.state === "granted");
		assert.deepEqual(
			marked.map((row) => row.reason),
			Array(LIVE_OWNERS).fill("owner expired; cleanup unconfirmed"),
		);

		await f.reconcileObserved(live[0]!);
		assert.equal(f.observer.transactions, 0, "a pass that changes nothing takes no write transaction");
	} finally {
		await f.close();
	}
});

test("reconciling prunes released permits beyond the retained history (#3978)", async () => {
	const f = await admissionFixture();
	try {
		const live = await f.seed(RELEASED_PERMIT_RETENTION + 10);
		await live[0]!.reconcile();
		const rows = await live[0]!.inspect();
		assert.equal(rows.filter((row) => row.state === "released").length, RELEASED_PERMIT_RETENTION);
		assert.equal(rows.filter((row) => row.state === "granted").length, LIVE_OWNERS, "live grants are never pruned");
	} finally {
		await f.close();
	}
});
