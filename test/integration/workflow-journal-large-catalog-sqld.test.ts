import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES as E } from "../../packages/workflows/src/durable/journal/types.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * A workflow journal of many runs lists every run's version on every backend of test/helpers/storage-backends.ts: a
 * SQLite file always, sqld and Postgres when their URLs are set (#5480).
 */

/** Runs in the catalog: far more arguments than one JavaScript call takes. */
const CATALOG_RUNS = 150_000;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (closers.length > 0) await closers.pop()!();
});

async function startRoot(journal: SqlRunJournal, runId: string): Promise<void> {
	const header = { runId, name: runId, cwd: "/project", createdAt: 1, status: "running" };
	assert.equal(
		await journal.createRunWithEvents(header, [
			{
				event: {
					type: E.runStarted,
					payload: {
						workflowId: runId,
						name: runId,
						inputs: {},
						status: "running",
						createdAt: 1,
						updatedAt: 1,
						completedCheckpoints: 0,
						pendingPrompts: 1,
						pendingStageMessages: [],
					},
				},
			},
		]),
		"created",
	);
}

async function seedHeaders(database: SqliteDatabase, runs: string, count: number): Promise<void> {
	await database.run(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
			INSERT INTO ${runs}(run_id, name, cwd, created_at, status, header_json)
			SELECT 'run-' || i, 'run', '/project', 1, 'running',
				'{"runId":"run-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`,
	);
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`a large workflow catalog on ${name} (#5480)`, () => {
		test("rehydrating an existing run moves it to the same catalog position at 1,024 and 1,025 events (#5480)", async () => {
			const scope = await backend.openScope();
			closers.push(() => scope.close());
			const database = await scope.connect();
			const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
			closers.push(() => journal.close());
			const { events } = runJournalTables(scope.prefix);
			const runs = ["short", "long", "peer"];
			for (const runId of runs) {
				await startRoot(journal, runId);
				if (runId === "peer") continue;
				const count = runId === "short" ? 1023 : 1024;
				await database.run(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${count})
					INSERT INTO ${events}(run_id,seq,epoch,key,type,payload,at)
					SELECT ?,i+1,0,'["${E.checkpointRecorded}","tool","cp-' || i || '"]',?,
					'{"kind":"tool","workflowId":"${runId}","checkpointId":"cp-' || i || '","argsHash":"h","name":"step","output":true,"completedAt":2}',2 FROM n`,
					runId,
					E.checkpointRecorded,
				);
			}
			const reader = await JournalDurableBackend.open(journal, { ownsJournal: false, runs });
			closers.push(() => reader.close());
			const order = async () => {
				const catalog = await reader.prepareWorkflowCatalog();
				const ids = catalog.resumable.map((entry) => entry.workflowId);
				assert.deepEqual(ids, catalog.inspectableIds);
				assert.deepEqual(
					ids,
					reader.listResumableWorkflows().map((entry) => entry.workflowId),
				);
				return ids;
			};
			assert.deepEqual(await order(), runs);
			await reader.hydrateWorkflow("short");
			assert.deepEqual(await order(), ["long", "peer", "short"]);
			await reader.hydrateWorkflow("long");
			assert.deepEqual(await order(), ["peer", "short", "long"]);
		});

		test.each(["run versions", "resumable catalog"])(
			"%s never combines a deleted root with its replacement across pages (#5480)",
			async (view) => {
				const scope = await backend.openScope();
				closers.push(() => scope.close());
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				closers.push(() => journal.close());
				const writer = await scope.connect();
				const peer = await SqlRunJournal.open(writer, { prefix: scope.prefix });
				closers.push(() => peer.close());
				const { runs } = runJournalTables(scope.prefix);
				const first = "aa-first",
					replacement = "zz-replacement";
				await startRoot(peer, first);
				const cutPage = view === "run versions" ? 2 : 1;
				const pageSize = database.descriptor.adapter === "node-sqlite" ? 128 : 4096;
				await seedHeaders(writer, runs, cutPage * pageSize);
				const reader = await JournalDurableBackend.open(journal, { ownsJournal: false, runs: [first] });
				closers.push(() => reader.close());
				assert.deepEqual(
					reader.listResumableWorkflows().map((entry) => entry.workflowId),
					[first],
				);
				let pages = 0;
				let replaced = false;
				const restore = observeSqlReads(database, {
					after: async (rows) => {
						if (replaced || rows.length <= 1 || !("run_id" in rows[0]!)) return;
						// With a single-statement listing the whole catalog has already been read.
						if (++pages < cutPage && rows.length <= pageSize) return;
						// The page has already been read. The other connection commits both writes before scanning continues.
						await peer.deleteRun(first);
						if (view === "resumable catalog") await writer.run(`DELETE FROM ${runs} WHERE name = 'run'`);
						await startRoot(peer, replacement);
						replaced = true;
					},
				});
				const list = async () =>
					view === "run versions"
						? [...(await journal.runVersions()).keys()]
						: (await reader.prepareWorkflowCatalog()).resumable.map((entry) => entry.workflowId);
				let ids: string[];
				try {
					ids = await list();
				} finally {
					restore();
				}
				assert.ok(replaced, "the writer replaced the root before the read returned");
				assert.equal(ids.includes(first) && ids.includes(replacement), false, "the two roots never coexisted");
				assert.deepEqual(
					(await list()).filter((id) => id === first || id === replacement),
					[replacement],
				);
			},
			180_000,
		);

		test("every run of a catalog of 150,000 runs has its version listed (#5480)", async () => {
			const scope = await backend.openScope();
			closers.push(() => scope.close());
			const database = await scope.connect();
			const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
			closers.push(() => journal.close());
			const { runs } = runJournalTables(scope.prefix);
			await seedHeaders(database, runs, CATALOG_RUNS);
			const versions = await journal.runVersions();
			assert.equal(versions.size, CATALOG_RUNS);
			assert.deepEqual(versions.get(`run-${CATALOG_RUNS}`), { seq: 0, at: 0 });
		});
	});
}
