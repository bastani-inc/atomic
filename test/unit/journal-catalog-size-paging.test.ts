import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { JournalCatalog } from "../../packages/coding-agent/src/core/storage/journal-catalog.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	JOURNAL_SCHEMA_VERSION,
	JournalSchemaVersionError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

describe("journal catalog paging", () => {
	it("refuses a schema upgrade that arrives before the final empty catalog page (#5537)", async () => {
		const directory = makeTempDirectory("atomic-catalog-version-");
		const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
		const journal = await SqlRunJournal.open(database);
		try {
			await journal.createRun({ runId: "run", name: "run", cwd: "/project", createdAt: 1, status: "running" });
			let upgraded: Promise<unknown> = Promise.resolve();
			const timer = setImmediate(() => {
				upgraded = database.run(
					`UPDATE ${runJournalTables().meta} SET schema_version = ?`,
					JOURNAL_SCHEMA_VERSION + 1,
				);
			});
			try {
				await expect(journal.listRuns()).rejects.toBeInstanceOf(JournalSchemaVersionError);
			} finally {
				clearImmediate(timer);
				await upgraded;
			}
		} finally {
			await journal.close();
			await database.close();
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
