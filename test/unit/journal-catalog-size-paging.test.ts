import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { JournalCatalog } from "../../packages/coding-agent/src/core/storage/journal-catalog.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	JOURNAL_SCHEMA_VERSION,
	JournalSchemaVersionError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { limitHeaderResponse, observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

describe("journal catalog paging", () => {
	it("refuses a schema upgrade that arrives before the final empty catalog page (#5537)", async () => {
		const directory = makeTempDirectory("atomic-catalog-version-");
		const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
		const journal = await SqlRunJournal.open(database);
		try {
			// Two exact pages at this ceiling need an empty-page completion check.
			for (let index = 0; index < 256; index++) {
				await journal.createRun({
					runId: `run-${index}`,
					name: "run",
					cwd: "/project",
					createdAt: 1,
					status: "running",
				});
			}
			const writer = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
			const order: string[] = [];
			const releaseLimit = limitHeaderResponse(database, (rows) => rows.length <= 128);
			const restore = observeSqlReads(database, {
				after: async (rows) => {
					if (rows.length === 0) order.push("empty page");
					if (order.length === 0 && rows.some((row) => typeof row.header_json === "string")) {
						await writer.run(
							`UPDATE ${runJournalTables().meta} SET schema_version = ?`,
							JOURNAL_SCHEMA_VERSION + 1,
						);
						order.push("upgrade committed");
					}
				},
			});
			try {
				await expect(journal.listRuns()).rejects.toBeInstanceOf(JournalSchemaVersionError);
				expect(order).toEqual(["upgrade committed", "empty page"]);
			} finally {
				restore();
				releaseLimit();
				await writer.close();
			}
		} finally {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	});

	it("returns one ownership map while another connection commits on either side of the cursor (#5537)", async () => {
		const directory = makeTempDirectory("atomic-owners-snapshot-");
		const catalog = await JournalCatalog.open(directory);
		try {
			const { shard } = await catalog.place({ runId: "m-0", status: "completed" });
			const writer = new DatabaseSync(catalog.path);
			try {
				writer
					.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
				INSERT INTO catalog_runs(run_id,shard,root_run_id,updated_at) SELECT 'm-'||i,?,'m-'||i,1 FROM n`)
					.run(shard.id);
				const all = StatementSync.prototype.all;
				let wrote = false;
				const observed = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
					this: StatementSync,
					...args: Parameters<typeof all>
				) {
					const rows = all.apply(this, args);
					if (!wrote && rows.some((row) => typeof row.run_id === "string" && "shard" in row)) {
						wrote = true;
						const insert = writer.prepare(
							"INSERT INTO catalog_runs(run_id,shard,root_run_id,updated_at) VALUES (?,?,?,1)",
						);
						for (const id of ["a-first", "z-second"]) insert.run(id, shard.id, id);
					}
					return rows;
				});
				try {
					const owners = await catalog.owners();
					expect(wrote).toBe(true);
					expect(owners.size).toBe(501);
					expect(owners.has("a-first")).toBe(false);
					expect(owners.has("z-second")).toBe(false);
				} finally {
					observed.mockRestore();
				}
			} finally {
				writer.close();
			}
		} finally {
			await catalog.close();
			removeTempDirectory(directory);
		}
	});

	it("can cancel a large ownership catalog between pages and then read it completely (#5537)", async () => {
		const directory = makeTempDirectory("atomic-catalog-paging-");
		const catalog = await JournalCatalog.open(directory);
		try {
			const { shard } = await catalog.place({ runId: "root", status: "running" });
			const database = await openNodeSqliteDatabase(catalog.path);
			try {
				await database.run(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
					INSERT INTO catalog_runs(run_id, shard, root_run_id, cwd, workflow, status, updated_at)
					SELECT 'run-' || i, ?, 'root', '/project', 'run', 'running', 1 FROM n`,
					shard.id,
				);
			} finally {
				await database.close();
			}
			const controller = new AbortController();
			const reason = new Error("ownership catalog cancelled");
			const timer = setImmediate(() => controller.abort(reason));
			try {
				await expect(catalog.owners({ signal: controller.signal })).rejects.toBe(reason);
			} finally {
				clearImmediate(timer);
			}
			const owners = await catalog.owners();
			expect(owners.size).toBe(150_001);
			expect([...owners.values()].every((owner) => owner === shard.id)).toBe(true);
			expect((await catalog.runs()).map((run) => run.runId)).toEqual([...owners.keys()].sort());
		} finally {
			await catalog.close();
			removeTempDirectory(directory);
		}
	});
});
