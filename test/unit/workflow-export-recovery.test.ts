import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { exportWorkflowRuns } from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { JOURNAL_SCHEMA_VERSION } from "../../packages/workflows/src/durable/journal/types.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

it.each(["catalog refusal", "completed catalog recovery", "event refusal", "run deleted after event refusal"])(
	"preserves the previous complete export across %s (#5537)",
	async (cut) => {
		const directory = makeTempDirectory("atomic-export-cut-");
		const path = join(directory, "journal.sqlite"),
			prefix = "backup_",
			id = "one";
		const tables = runJournalTables(prefix);
		const open = () => openNodeSqliteDatabase(path);
		const writer = await open(),
			journal = await SqlRunJournal.open(writer, { prefix });
		const storage = { kind: "database", location: "journal", prefix, open } as const;
		try {
			await journal.createRun({ runId: id, name: "trusted", cwd: "/p", createdAt: 1, status: "running" });
			const lease = await journal.acquire(id, "writer");
			if (lease.status !== "acquired") throw new Error("lease not acquired");
			await journal.append(lease.lease, { type: "MessageQueued", payload: { message: "saved" } });
			await exportWorkflowRuns(storage, directory, { runs: [id] });
			const file = join(directory, `${id}.jsonl`),
				previous = await readFile(file);
			await journal.append(lease.lease, { type: "MessageQueued", payload: { message: "new" } });
			const failure = new StoragePayloadTooLargeError(0, 0, { kind: "response" });
			let refused = false,
				changed = false;
			const change = async () => {
				if (changed) return;
				if (cut.startsWith("run deleted")) await journal.deleteRun(id);
				else
					await writer.transaction(async (tx) => {
						await tx.run(`UPDATE ${tables.meta} SET schema_version=?`, JOURNAL_SCHEMA_VERSION + 1);
						await tx.run(`UPDATE ${tables.runs} SET name='future' WHERE run_id=?`, id);
					});
				changed = true;
			};
			const openReader = async () => {
				const db = await open();
				observeSqlReads(db, {
					after: async (_rows, sql, pinned) => {
						if (
							refused ||
							!(cut.includes("catalog")
								? !pinned && sql.includes(`FROM ${tables.runs} ORDER BY`)
								: pinned && sql.includes(`FROM ${tables.events} WHERE`))
						)
							return;
						refused = true;
						if (cut === "catalog refusal") await change();
						throw failure;
					},
				});
				const transaction = db.transaction.bind(db);
				db.transaction = async (body, options) => {
					try {
						const result = await transaction(body, options);
						if (refused && cut === "completed catalog recovery") await change();
						return result;
					} catch (error) {
						if (error === failure && cut.includes("event refusal")) await change();
						throw error;
					}
				};
				return db;
			};
			const exported = exportWorkflowRuns({ ...storage, open: openReader }, directory, { runs: [id] });
			if (cut.includes("event refusal")) await expect(exported).rejects.toBe(failure);
			else await expect(exported).rejects.toThrow(/unsupported journal schema version/);
			expect(changed).toBe(true);
			expect(await readFile(file)).toEqual(previous);
		} finally {
			await journal.close();
			await writer.close();
			removeTempDirectory(directory);
		}
	},
);
