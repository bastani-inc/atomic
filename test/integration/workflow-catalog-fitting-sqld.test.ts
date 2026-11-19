import { describe, expect, it } from "vitest";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	JOURNAL_SCHEMA_VERSION,
	JournalSchemaVersionError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { limitHeaderResponse, observeSqlReads } from "../helpers/observe-sql-reads.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`catalog response boundaries: ${backend.name}`, () => {
		it.each([1, 350])(
			"lists %i headers that fit a 150 KB reply without extra wire columns (#5537)",
			async (count) => {
				const scope = await backend.openScope();
				try {
					const db = await scope.connect();
					const journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
					try {
						const { runs } = runJournalTables(scope.prefix);
						const id = "c201abba-8f91-4bc4-946a-889a31345303";
						if (count === 1) {
							const header = {
								runId: id,
								name: "r",
								cwd: "/p",
								createdAt: 1,
								status: "completed",
								inputs: { data: "a".repeat(149_639) },
							} as const;
							expect(await journal.createRun(header)).toBe("created");
							expect(await journal.getRun(id)).toEqual(header);
						} else {
							await db.run(
								`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?) INSERT INTO ${runs}(run_id,name,cwd,created_at,status,header_json) SELECT 'm-'||i,'r','/p',1,'completed','{"runId":"m-'||i||'","name":"r","cwd":"/p","createdAt":1,"status":"completed","inputs":{"data":"'||?||'"}}' FROM n`,
								count,
								"x".repeat(200),
							);
						}
						const reads: string[][] = [];
						const restore = observeSqlReads(db, {
							after: (rows) => {
								reads.push(Object.keys(rows[0] ?? {}).sort());
							},
						});
						try {
							expect((await journal.listRuns()).map((r) => r.runId)).toEqual(
								count === 1 ? [id] : Array.from({ length: count }, (_, i) => `m-${i + 1}`).sort(),
							);
							expect(reads).toEqual([["header_json", "meta_version", "status"]]);
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

		it("can return two individually fitting headers in one-row pages (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
				try {
					const ids = ["c201abba-8f91-4bc4-946a-889a31345303", "c201abba-8f91-4bc4-946a-889a31345304"];
					const headers = ids.map((runId) => ({
						runId,
						name: "r",
						cwd: "/p",
						createdAt: 1,
						status: "completed" as const,
						inputs: { data: "a".repeat(149_639) },
					}));
					for (const h of headers) await journal.createRun(h);
					const release = limitHeaderResponse(db, (rows) => rows.length <= 1);
					const replies: string[][] = [];
					const restore = observeSqlReads(db, {
						after(rows) {
							for (const row of rows)
								if (typeof row.header_json === "string") replies.push(Object.keys(row).sort());
						},
					});
					try {
						expect(await journal.listRuns()).toEqual(headers);
						expect(replies).toEqual(ids.map(() => ["header_json", "meta_version", "status"]));
					} finally {
						restore();
						release();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("restarts from the first key in a fresh snapshot after a later size refusal (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const peer = await scope.connect();
				const journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
				try {
					const { runs } = runJournalTables(scope.prefix);
					await db.run(
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000) INSERT INTO ${runs}(run_id,name,cwd,created_at,status,header_json) SELECT 'm-'||i,'r','/p',1,'completed','{"runId":"m-'||i||'","name":"r","cwd":"/p","createdAt":1,"status":"completed"}' FROM n`,
					);
					let accepted = false;
					let refused = false;
					const restore = observeSqlReads(db, {
						after: async (rows, _sql, pinned) => {
							if (!rows.some((row) => typeof row.header_json === "string")) return;
							if (!pinned) throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
							if (accepted && !refused) {
								await peer.run(
									`INSERT INTO ${runs}(run_id,name,cwd,created_at,status,header_json) VALUES ('a-first','r','/p',1,'completed','{"runId":"a-first","name":"r","cwd":"/p","createdAt":1,"status":"completed"}')`,
								);
								refused = true;
								throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
							}
							accepted = true;
						},
					});
					try {
						expect((await journal.listRuns()).map((r) => r.runId)).toEqual([
							"a-first",
							...Array.from({ length: 5000 }, (_, i) => `m-${i + 1}`).sort(),
						]);
						expect(refused).toBe(true);
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

		it("notices a schema change committed after the empty filtered reply (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const writer = await scope.connect();
				const journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
				try {
					await journal.createRun({ runId: "one", name: "r", cwd: "/p", createdAt: 1, status: "completed" });
					const tables = runJournalTables(scope.prefix);
					let committed = false;
					const restore = observeSqlReads(db, {
						after: async (_rows, sql) => {
							if (!committed && sql.includes(tables.runs)) {
								await writer.run(`UPDATE ${tables.meta} SET schema_version = ?`, JOURNAL_SCHEMA_VERSION + 1);
								committed = true;
							}
						},
					});
					try {
						await expect(journal.listRuns({ cwd: "/missing" })).rejects.toBeInstanceOf(JournalSchemaVersionError);
						expect(committed).toBe(true);
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
	});
}
