import { join } from "node:path";
import { expect, it } from "vitest";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { exportWorkflowRuns } from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

it("selects a run only after opening and listing its named source (#5537)", async () => {
	const directory = makeTempDirectory("atomic-export-selection-");
	const file = join(directory, "source.sqlite");
	const writer = await openNodeSqliteDatabase(file);
	const journal = await SqlRunJournal.open(writer);
	try {
		await journal.createRun({ runId: "one", name: "run", cwd: "/p", status: "completed", createdAt: 1 });
		let opened = false;
		const storage = {
			kind: "database",
			location: "journal",
			open: async () => {
				const database = await openNodeSqliteDatabase(file);
				opened = true;
				return database;
			},
		} as const;
		const report = await exportWorkflowRuns(storage, join(directory, "backup"), {
			get runs() {
				if (!opened) throw new Error("selection is unavailable until the source opens");
				return ["one"];
			},
		});
		expect(report.written).toEqual(["one"]);
	} finally {
		await journal.close();
		await writer.close();
		removeTempDirectory(directory);
	}
});

it("keeps the catalog refusal for a bulk export, including its original diagnostic after close (#5537)", async () => {
	const directory = makeTempDirectory("atomic-bulk-selection-");
	const file = join(directory, "source.sqlite");
	const writer = await openNodeSqliteDatabase(file);
	const journal = await SqlRunJournal.open(writer);
	try {
		for (const runId of ["one", "two"])
			await journal.createRun({ runId, name: "run", cwd: "/p", status: "completed", createdAt: 1 });
		for (const runs of [undefined, [], ["one", "two"]]) {
			let closed = false,
				extraReads = 0;
			const failure = new StoragePayloadTooLargeError(0, 0, { kind: "response" });
			Object.defineProperty(failure, "message", {
				get() {
					if (!closed) throw new Error("reader is still open");
					return "refused header catalog";
				},
			});
			const open = async () => {
				const db = await openNodeSqliteDatabase(file);
				const all = db.all.bind(db),
					close = db.close.bind(db),
					transaction = db.transaction.bind(db);
				db.all = (sql, ...args) => (sql.includes("ORDER BY run_id") ? Promise.reject(failure) : all(sql, ...args));
				db.transaction = (fn, options) => {
					extraReads++;
					return transaction(fn, options);
				};
				db.close = async () => {
					await close();
					closed = true;
				};
				return db;
			};
			await expect(
				exportWorkflowRuns({ kind: "database", location: "journal", open }, join(directory, "backup"), { runs }),
			).rejects.toThrow("journal: the journal file cannot be read: refused header catalog");
			expect(extraReads).toBe(0);
		}
	} finally {
		await journal.close();
		await writer.close();
		removeTempDirectory(directory);
	}
});
