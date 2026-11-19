import { describe, expect, it } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { connectCatalogScope, limitHeaderResponse, observeSqlReads } from "../helpers/observe-sql-reads.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`catalog observables: ${backend.name}`, () => {
		it("reads a one-run catalog in one SQL read, including an unchanged repeat (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					const header = { runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" } as const;
					await journal.createRun(header);
					let reads = 0;
					const restore = observeSqlReads(database, {
						before: () => {
							reads++;
						},
					});
					try {
						for (let repeat = 0; repeat < 2; repeat++) {
							reads = 0;
							expect(await journal.listRuns()).toEqual([header]);
							expect(reads).toBe(1);
						}
						reads = 0;
						expect(await journal.listRuns({ cwd: "/missing" })).toEqual([]);
						expect(reads).toBe(2); // An empty row set carries no schema version.
					} finally {
						restore();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("reads every page from one snapshot while another journal commits ordered creations (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await connectCatalogScope(scope);
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				const writer = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				try {
					await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
						INSERT INTO ${runJournalTables(scope.prefix).runs}(run_id, name, cwd, created_at, status, header_json)
						SELECT 'm-' || i, 'run', '/project', 1, 'running',
						'{"runId":"m-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`);
					const releaseLimit = limitHeaderResponse(database, (rows) => rows.length <= 4096);
					let wrote = false;
					const restore = observeSqlReads(database, {
						after: async (rows) => {
							if (wrote || !rows.some((row) => typeof row.header_json === "string")) return;
							wrote = true;
							for (const runId of ["a-first", "z-second"]) {
								expect(
									await writer.createRun({
										runId,
										name: "run",
										cwd: "/project",
										createdAt: 1,
										status: "running",
									}),
								).toBe("created");
							}
						},
					});
					try {
						expect((await journal.listRuns()).map((run) => run.runId)).toEqual(
							Array.from({ length: 5_000 }, (_, i) => `m-${i + 1}`).sort(),
						);
						expect(wrote).toBe(true);
					} finally {
						restore();
						releaseLimit();
					}
				} finally {
					await writer.close();
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});
	});
}
