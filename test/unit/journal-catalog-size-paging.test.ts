import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoragePayloadTooLargeError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { runJournalTables } from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	JOURNAL_SCHEMA_VERSION,
	JournalSchemaVersionError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { limitHeaderResponse, observeSqlReads } from "../helpers/observe-sql-reads.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

async function openWithReader(path: string) {
	const database = await openNodeSqliteDatabase(path);
	database.openReader = () => openNodeSqliteDatabase(path, { readOnly: true });
	return database;
}

describe("journal catalog paging", () => {
	it.each([16, 512])(
		"a permanently oversized header after %i fitting rows does not replay the prefix (#5537)",
		async (count) => {
			const dir = makeTempDirectory("catalog-tail-");
			const database = await openWithReader(join(dir, "journal.sqlite"));
			const journal = await SqlRunJournal.open(database, { prefix: "tail_" });
			try {
				await database.run(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?) INSERT INTO ${runJournalTables("tail_").runs}(run_id,name,cwd,created_at,status,header_json) SELECT 'a'||i,'r','/p',1,'completed','{"runId":"a'||i||'"}' FROM n`,
					count,
				);
				await journal.createRun({
					runId: "z",
					name: "wide",
					cwd: "/p",
					createdAt: 1,
					status: "completed",
					inputs: { text: "x".repeat(2000) },
				});
				let requests = 0,
					transferred = 0;
				const release = limitHeaderResponse(database, (rows) => {
					requests++;
					if (rows.some((row) => String(row.header_json).length > 1000)) return false;
					transferred += rows.length;
					return true;
				});
				try {
					await expect(journal.listRuns()).rejects.toMatchObject({ code: "payload-too-large", kind: "response" });
					expect({ requests, transferred }).toEqual({ requests: 2, transferred: 0 });
				} finally {
					release();
				}
			} finally {
				await journal.close();
				await database.close();
				removeTempDirectory(dir);
			}
		},
	);

	it.each(["absent", "unavailable", "same handle"])(
		"keeps the original refusal when the independent reader is %s (#5537)",
		async (kind) => {
			const db = await openNodeSqliteDatabase(":memory:");
			const journal = await SqlRunJournal.open(db);
			try {
				if (kind === "unavailable") db.openReader = () => Promise.reject(new Error("cannot open reader"));
				if (kind === "same handle") db.openReader = async () => db;
				const refusal = new StoragePayloadTooLargeError(0, 0, { kind: "response" });
				db.all = () => Promise.reject(refusal);
				await expect(journal.listRuns()).rejects.toBe(refusal);
				expect(await journal.getRun("missing")).toBeUndefined();
			} finally {
				await journal.close();
				await db.close();
			}
		},
	);

	it("does not inspect an unused options argument (#5537)", async () => {
		const db = await openNodeSqliteDatabase(":memory:"),
			journal = await SqlRunJournal.open(db);
		try {
			const header = { runId: "run", name: "r", cwd: "/p", createdAt: 1, status: "completed" as const };
			await journal.createRun(header);
			const unused = new Proxy(
				{},
				{
					get() {
						throw new Error("unexpected option access");
					},
				},
			);
			expect(await Reflect.apply(journal.listRuns, journal, [undefined, unused])).toEqual([header]);
		} finally {
			await journal.close();
			await db.close();
		}
	});

	it.each(["revoked proxy", "foreign kind getter"])(
		"forwards a %s rejection without probing it (#5537)",
		async (kind) => {
			const db = await openNodeSqliteDatabase(":memory:"),
				journal = await SqlRunJournal.open(db);
			try {
				const revoked = Proxy.revocable(new Error("adapter unavailable"), {});
				revoked.revoke();
				let reads = 0;
				const foreign = Object.create(StoragePayloadTooLargeError.prototype, {
					kind: {
						get() {
							++reads;
							throw new Error("unexpected kind lookup");
						},
					},
				});
				const diagnostic = kind === "revoked proxy" ? revoked.proxy : foreign;
				const all = db.all;
				db.all = () => Promise.reject(diagnostic);
				try {
					expect(
						await journal.listRuns().then(
							() => false,
							(error) => error === diagnostic,
						),
					).toBe(true);
					expect(reads).toBe(0);
				} finally {
					db.all = all;
				}
			} finally {
				await journal.close();
				await db.close();
			}
		},
	);

	it("does not claim a complete catalog when a stored key differs from the published run ID (#5537)", async () => {
		const dir = makeTempDirectory("catalog-keys-");
		const database = await openWithReader(join(dir, "journal.sqlite"));
		const journal = await SqlRunJournal.open(database, { prefix: "keys_" });
		try {
			const header = { runId: "zzz", name: "r", cwd: "/p", createdAt: 1, status: "completed" as const };
			const accepted = journal.createRun(header);
			header.runId = "a";
			await accepted;
			await journal.createRun({ ...header, runId: "z" });
			expect((await journal.listRuns()).map((r) => r.runId)).toEqual(["z", "zzz"]);
			const restore = limitHeaderResponse(database, (rows) => rows.length <= 1);
			try {
				await expect(journal.listRuns()).rejects.toMatchObject({ code: "payload-too-large", kind: "response" });
			} finally {
				restore();
			}
		} finally {
			await journal.close();
			await database.close();
			removeTempDirectory(dir);
		}
	});

	it("does not publish recovered headers after the journal upgrades (#5537)", async () => {
		const dir = makeTempDirectory("catalog-schema-");
		const path = join(dir, "journal.sqlite"),
			db = await openWithReader(path),
			peer = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(db);
		try {
			for (const runId of ["a", "b"])
				await journal.createRun({ runId, name: "run", cwd: "/p", createdAt: 1, status: "running" });
			const release = limitHeaderResponse(db, (rows) => rows.length === 1);
			let upgraded = false;
			const observe = observeSqlReads(db, {
				after: async (rows, _sql, pinned) => {
					if (!pinned || upgraded || !rows.some((row) => typeof row.header_json === "string")) return;
					await peer.run(`UPDATE ${runJournalTables().meta} SET schema_version = ?`, JOURNAL_SCHEMA_VERSION + 1);
					upgraded = true;
				},
			});
			try {
				await expect(journal.listRuns()).rejects.toBeInstanceOf(JournalSchemaVersionError);
				expect(upgraded).toBe(true);
			} finally {
				observe();
				release();
			}
		} finally {
			await journal.close();
			await db.close();
			await peer.close();
			removeTempDirectory(dir);
		}
	});
});
