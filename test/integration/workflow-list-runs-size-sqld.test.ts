import { describe, expect, it } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import {
	exportWorkflowRuns,
	readWorkflowRunExports,
} from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { seedCatalogSeries } from "../helpers/seed-catalog-series.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`run catalog size: ${backend.name}`, () => {
		it("lists 150,000 runs once in run-id order and can export from that catalog (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await seedCatalogSeries(
						database,
						1,
						150_000,
						`INSERT INTO ${runJournalTables(scope.prefix).runs}(run_id, name, cwd, created_at, status, header_json)
						SELECT 'run-' || i, 'run', '/project', 1, 'running',
						'{"runId":"run-' || i || '","name":"run","cwd":"/project","createdAt":1,"status":"running"}' FROM n`,
					);
					const runs = await journal.listRuns();
					expect(runs.map((run) => run.runId)).toEqual(
						Array.from({ length: 150_000 }, (_, i) => `run-${i + 1}`).sort(),
					);
					const directory = makeTempDirectory("atomic-large-catalog-export-");
					try {
						expect(
							await exportWorkflowRuns(
								{
									kind: "database",
									open: scope.connect,
									prefix: scope.prefix,
									location: "catalog",
								},
								directory,
								{ runs: ["run-1"] },
							),
						).toEqual({ written: ["run-1"], unchanged: [], skipped: [] });
						expect((await readWorkflowRunExports(directory)).map((file) => file.header.runId)).toEqual(["run-1"]);
					} finally {
						removeTempDirectory(directory);
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});
	});
}
