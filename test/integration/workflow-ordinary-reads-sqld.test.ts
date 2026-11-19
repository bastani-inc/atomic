import { expect, it } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import {
	exportWorkflowRuns,
	readWorkflowRunExports,
} from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	it.skipIf(backend.skipReason)(
		`${backend.name}: a fitting selected export reads 5,000 events in one reply (#5537)`,
		async () => {
			const scope = await backend.openScope();
			const dir = makeTempDirectory("catalog-export-");
			try {
				const db = await scope.connect();
				const journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
				try {
					const table = runJournalTables(scope.prefix).events;
					await journal.createRun({ runId: "one", name: "r", cwd: "/p", createdAt: 1, status: "completed" });
					await db.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) INSERT INTO ${table}(run_id,seq,epoch,key,type,payload,at,chunks) SELECT 'one',i,1,NULL,'RunStarted','{}',i,0 FROM n`,
					);
					const reads: number[] = [];
					const restore = observeSqlReads(db, {
						after(rows, sql) {
							if (sql.includes(`FROM ${table} `)) reads.push(rows.length);
						},
					});
					try {
						expect(
							(
								await exportWorkflowRuns(
									{ kind: "database", prefix: scope.prefix, location: "catalog", open: async () => db },
									dir,
									{ runs: ["one"] },
								)
							).written,
						).toEqual(["one"]);
						expect((await readWorkflowRunExports(dir))[0]!.events).toHaveLength(5000);
						expect(reads).toEqual([5000]);
					} finally {
						restore();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
				removeTempDirectory(dir);
			}
		},
	);
	it.skipIf(backend.skipReason)(
		`${backend.name}: a fitting four-event response keeps the original payload offsets (#5537)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect(),
					journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
				try {
					const id = "r".repeat(200),
						sizes = [0, 40000, 40000, 67414];
					await journal.createRun({ runId: id, name: "r", cwd: "/p", createdAt: 1, status: "running" });
					const claim = await journal.acquire(id, "owner");
					if (claim.status !== "acquired") throw new Error("lease not acquired");
					for (const n of sizes)
						expect(
							(
								await journal.append(claim.lease, {
									type: "RunStarted",
									payload: { inputs: { s: "x".repeat(n) } },
								})
							).status,
						).toBe("appended");
					const offsets: number[] = [];
					const restore = observeSqlReads(db, {
						after(rows) {
							for (const row of rows) if ("before_chars" in row) offsets.push(Number(row.before_chars));
						},
					});
					try {
						const entries = await Array.fromAsync(journal.read(id));
						expect(entries.map((entry) => entry.event.payload)).toEqual(
							sizes.map((n) => ({ inputs: { s: "x".repeat(n) } })),
						);
						expect(offsets).toEqual([0, 19, 40038, 80057]);
					} finally {
						restore();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		},
	);
}
