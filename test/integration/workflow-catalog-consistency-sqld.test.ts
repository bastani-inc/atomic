import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { exportWorkflowRuns } from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { JournalSchemaVersionError } from "../../packages/workflows/src/durable/journal/types.js";
import { limitHeaderResponse, observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { storageBackends } from "../helpers/storage-backends.js";

const header = { runId: "one", name: "run", cwd: "/project", createdAt: 1, status: "completed" } as const;

async function seed(database: SqliteDatabase, prefix: string) {
	await database.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
		INSERT INTO ${runJournalTables(prefix).runs}(run_id,name,cwd,created_at,status,header_json)
		SELECT 'm-'||i,'run','/project',1,'completed','{"runId":"m-'||i||'","name":"run","cwd":"/project","createdAt":1,"status":"completed"}' FROM n`);
}

async function checkWriterProgress(db: SqliteDatabase, prefix: string) {
	const reader = await SqlRunJournal.open(db, { prefix });
	try {
		await seed(db, prefix);
		let writer: Promise<boolean> | undefined;
		let committed = false;
		const restore = observeSqlReads(db, {
			after: async (rows) => {
				if (writer || !rows.some((row) => typeof row.header_json === "string")) return;
				writer = reader.createRun(header).then((result) => result === "created");
				const stop = new AbortController();
				try {
					committed = await Promise.race([writer, delay(2000, false, { signal: stop.signal })]);
				} finally {
					stop.abort();
				}
			},
		});
		try {
			expect(await reader.listRuns()).toHaveLength(5000);
			expect(committed).toBe(true);
		} finally {
			restore();
			await writer;
		}
	} finally {
		await reader.close();
	}
}

it.each(["native memory", "local file", "local memory"])(
	"a writer on %s can finish between catalog pages (#5537)",
	async (kind) => {
		const directory = makeTempDirectory("atomic-local-catalog-");
		try {
			const db =
				kind === "native memory"
					? await openNodeSqliteDatabase(":memory:")
					: await openLibsqlDatabase({
							url:
								kind === "local memory"
									? "file::memory:"
									: pathToFileURL(join(directory, "journal.sqlite")).href,
						});
			try {
				await checkWriterProgress(db, "local_");
			} finally {
				await db.close();
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
);

for (const backend of storageBackends) {
	describe.skipIf(backend.skipReason !== undefined)(`catalog consistency: ${backend.name}`, () => {
		it("after a header response refusal a single-run export fetches only the requested header (#5537)", async () => {
			const scope = await backend.openScope();
			const directory = makeTempDirectory("atomic-selected-run-");
			try {
				const database = await scope.connect();
				const reader = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await reader.createRun(header);
					await reader.createRun({ ...header, runId: "unselected" });
					let fetchedOther = false;
					let selectedHeaders = 0;
					const release = limitHeaderResponse(database, (rows) => rows.length <= 1);
					const restore = observeSqlReads(database, {
						after: (rows) => {
							if (rows.some((row) => row.run_id === "unselected")) fetchedOther = true;
							selectedHeaders += rows.filter(
								(row) => row.run_id === header.runId && "header_json" in row,
							).length;
						},
					});
					try {
						const result = await exportWorkflowRuns(
							{ kind: "database", prefix: scope.prefix, location: "catalog", open: async () => database },
							directory,
							{ runs: [header.runId] },
						);
						expect(result.written).toEqual([header.runId]);
						expect(fetchedOther).toBe(false);
						expect(selectedHeaders).toBe(1);
					} finally {
						restore();
						release();
					}
				} finally {
					await reader.close();
				}
			} finally {
				await scope.close();
				removeTempDirectory(directory);
			}
		});

		it("stops after the selected header alone is still too large to export (#5537)", async () => {
			const scope = await backend.openScope();
			const directory = makeTempDirectory("atomic-selected-run-");
			try {
				const database = await scope.connect();
				const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
				try {
					await journal.createRun(header);
					await journal.createRun({ ...header, runId: "unselected" });
					const attempts: number[] = [];
					const restore = limitHeaderResponse(database, (rows) => {
						attempts.push(rows.length);
						return false;
					});
					try {
						await expect(
							exportWorkflowRuns(
								{ kind: "database", prefix: scope.prefix, location: "catalog", open: async () => database },
								directory,
								{ runs: [header.runId] },
							),
						).rejects.toThrow(/response/i);
						expect(attempts).toEqual([2, 1]);
					} finally {
						restore();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
				removeTempDirectory(directory);
			}
		});

		it.each(["run versions", "named export"])(
			"%s cannot include a later commit without its predecessor (#5537)",
			async (view) => {
				const scope = await backend.openScope();
				const directory = makeTempDirectory("atomic-catalog-export-");
				try {
					const db = await scope.connect();
					const reader = await SqlRunJournal.open(db, { prefix: scope.prefix });
					const writer = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
					try {
						await seed(db, scope.prefix);
						let captured = false;
						const restore = observeSqlReads(db, {
							after: async (rows, _sql, pinned) => {
								if (view === "run versions" && !pinned) return; // A full first page is discarded and reread in the snapshot.
								if (captured || !rows.some((row) => typeof row.run_id === "string")) return;
								captured = true;
								await writer.createRun({ ...header, runId: "a-first", createdAt: 100 });
								await writer.createRun({ ...header, runId: "z-second", createdAt: 99 });
							},
						});
						try {
							const ids =
								view === "run versions"
									? [...(await reader.runVersions()).keys()]
									: (
											await exportWorkflowRuns(
												{
													kind: "database",
													open: async () => db,
													prefix: scope.prefix,
													location: "catalog",
												},
												directory,
												{ limit: 2 },
											)
										).written;
							expect(captured).toBe(true);
							expect(ids).not.toContain("z-second");
							expect(ids).not.toContain("a-first");
						} finally {
							restore();
						}
					} finally {
						await reader.close();
						await writer.close();
					}
				} finally {
					await scope.close();
					removeTempDirectory(directory);
				}
			},
		);

		it("reports a missing version in an already-open journal (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				const reader = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				try {
					await reader.createRun(header);
					await (await scope.connect()).run(`DELETE FROM ${runJournalTables(scope.prefix).meta}`);
					await expect(reader.listRuns()).rejects.toBeInstanceOf(JournalSchemaVersionError);
				} finally {
					await reader.close();
				}
			} finally {
				await scope.close();
			}
		});

		it("a writer on the same journal can finish between catalog pages (#5537)", async () => {
			const scope = await backend.openScope();
			try {
				await checkWriterProgress(await scope.connect(), scope.prefix);
			} finally {
				await scope.close();
			}
		});
	});
}

async function refusedAddress() {
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const { port } = listener.address() as { port: number };
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	return `http://127.0.0.1:${port}/`;
}

const sqld = storageBackends.find((backend) => backend.name.includes("sqld"))!;
describe.skipIf(sqld.skipReason !== undefined)("warm sqld catalog", () => {
	it("does not replay the catalog after losing the recovery connection (#5537)", async () => {
		const scope = await sqld.openScope();
		try {
			const db = await scope.connect();
			const journal = await SqlRunJournal.open(db, { prefix: scope.prefix });
			const writer = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
			try {
				await seed(db, scope.prefix);
				const refused = await refusedAddress();
				const fetch = globalThis.fetch;
				let armed = false;
				let failed = false;
				let headersAfterFailure = 0;
				const send = vi.spyOn(globalThis, "fetch");
				const releaseLimit = limitHeaderResponse(db, (rows) => rows.length <= 4096);
				const restore = observeSqlReads(db, {
					after: async (rows) => {
						if (failed) headersAfterFailure += rows.filter((row) => typeof row.header_json === "string").length;
						if (armed || !rows.some((row) => typeof row.header_json === "string")) return;
						await writer.createRun({ ...header, runId: "a-first" });
						armed = true;
						send.mockImplementationOnce(() => {
							failed = true;
							return fetch(refused);
						});
					},
				});
				try {
					await expect(journal.listRuns()).rejects.toThrow();
					expect(failed).toBe(true);
					expect(headersAfterFailure).toBe(0);
				} finally {
					send.mockRestore();
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
	it.each([false, true])(
		"reads a complete page in one request after connection refusal=%s (#5537)",
		async (refuse) => {
			const scope = await sqld.openScope();
			try {
				const journal = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
				try {
					await journal.createRun(header);
					await journal.listRuns();
					const refused = await refusedAddress();
					const fetch = globalThis.fetch;
					let requests = 0;
					const send = vi
						.spyOn(globalThis, "fetch")
						.mockImplementation((input, init) =>
							++requests === 1 && refuse ? fetch(refused) : fetch(input, init),
						);
					try {
						expect(await journal.listRuns()).toEqual([header]);
						if (refuse)
							expect(requests).toBeGreaterThan(1); // The failed stream may also need a close request.
						else expect(requests).toBe(1);
					} finally {
						send.mockRestore();
					}
				} finally {
					await journal.close();
				}
			} finally {
				await scope.close();
			}
		},
	);
});
