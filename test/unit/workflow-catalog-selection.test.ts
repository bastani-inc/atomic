import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { exportWorkflowRuns } from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
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

it("does not filter or create output when the selected run's events cannot be read after a catalog refusal (#5537)", async () => {
	const directory = makeTempDirectory("atomic-selected-events-");
	const path = join(directory, "source.sqlite"),
		backup = join(directory, "backup");
	const writer = await openNodeSqliteDatabase(path),
		journal = await SqlRunJournal.open(writer);
	try {
		await journal.createRun({ runId: "one", name: "r", cwd: "/p", createdAt: 1, status: "completed" });
		const failure = new Error("event read failed");
		const open = async () => {
			const db = await openNodeSqliteDatabase(path);
			observeSqlReads(db, {
				before(sql) {
					if (sql.includes("ORDER BY run_id")) throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
					if (sql.includes("ORDER BY seq")) throw failure;
				},
			});
			return db;
		};
		await expect(
			exportWorkflowRuns({ kind: "database", location: "journal", open }, backup, {
				runs: ["one"],
				get unfinished(): boolean {
					throw new Error("no exportable events");
				},
				get limit(): number {
					throw new Error("no exportable events");
				},
			}),
		).rejects.toBe(failure);
		expect(existsSync(backup)).toBe(false);
	} finally {
		await journal.close();
		await writer.close();
		removeTempDirectory(directory);
	}
});

it("keeps the original diagnostic after close and leaves no output for a refused export (#5537)", async () => {
	const directory = makeTempDirectory("atomic-bulk-selection-");
	const file = join(directory, "source.sqlite");
	const writer = await openNodeSqliteDatabase(file);
	const journal = await SqlRunJournal.open(writer);
	try {
		for (const runId of ["one", "two"])
			await journal.createRun({ runId, name: "run", cwd: "/p", status: "completed", createdAt: 1 });
		for (const runs of [undefined, [], ["one", "two"], ["one"]]) {
			let closed = false,
				extraReads = 0,
				refusedPoints = 0;
			const failure = new StoragePayloadTooLargeError(0, 0, { kind: "response" });
			Object.defineProperty(failure, "message", {
				get() {
					if (!closed) throw new Error("reader is still open");
					return "refused header catalog";
				},
			});
			const open = async () => {
				const db = await openNodeSqliteDatabase(file);
				observeSqlReads(db, {
					after(_rows, sql, pinned) {
						if (!pinned && sql.includes("ORDER BY run_id")) throw failure;
						if (pinned && /^SELECT \* FROM \S+ WHERE run_id = \?$/.test(sql)) {
							refusedPoints++;
							throw new StoragePayloadTooLargeError(0, 0, { kind: "response" });
						}
					},
				});
				const close = db.close.bind(db),
					transaction = db.transaction.bind(db);
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
				exportWorkflowRuns({ kind: "database", location: "journal", open }, join(directory, "backup"), {
					runs,
					get unfinished(): boolean {
						throw new Error("no exportable header");
					},
					get limit(): number {
						throw new Error("no exportable header");
					},
				}),
			).rejects.toThrow("journal: the journal file cannot be read: refused header catalog");
			expect(existsSync(join(directory, "backup"))).toBe(false);
			if (runs?.length === 1) expect(refusedPoints).toBe(1);
			else expect(extraReads).toBe(0);
		}
	} finally {
		await journal.close();
		await writer.close();
		removeTempDirectory(directory);
	}
});
