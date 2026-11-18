import { describe, expect, it } from "vitest";
import { JournalCatalog } from "../../packages/coding-agent/src/core/storage/journal-catalog.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

describe("journal catalog paging", () => {
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
