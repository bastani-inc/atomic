import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import {
	StorageInvalidTextError,
	StoragePrefixError,
	StorageSchemaVersionError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	SESSION_SCHEMA_VERSION,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionSummary,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";

const header = {
	id: "session",
	version: SESSION_FORMAT_VERSION,
	cwd: "/project",
	createdAt: "2026-10-15T00:00:00Z",
} as const;
const message = (id: string, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: header.createdAt,
	message: { role: "user", content: text, timestamp: Date.parse(header.createdAt) },
});
const collect = async (store: SqlSessionStore): Promise<SessionSummary[]> => {
	const summaries: SessionSummary[] = [];
	for await (const summary of store.list({})) summaries.push(summary);
	return summaries;
};

for (const shared of [false, true]) {
	registerSessionStoreConformance(
		{ describe, it },
		`SqlSessionStore${shared ? " shared database" : ""}`,
		async (body) => {
			const directory = makeTempDirectory("atomic-sql-session-");
			const path = join(directory, "sessions.sqlite");
			let database = await openNodeSqliteDatabase(path);
			const other = renderStorageIdentifiers("sessions", { data: "data" }, "other_");
			let writes = 0;
			const writeOther = async () => {
				if (!shared) return;
				await database.exec(`CREATE TABLE IF NOT EXISTS ${other.data} (value INTEGER) STRICT`);
				await database.run(`INSERT INTO ${other.data} VALUES (?)`, ++writes);
			};
			await writeOther();
			let store = await SqlSessionStore.open(database);
			try {
				await body({
					store,
					reopen: async () => {
						await database.close();
						database = await openNodeSqliteDatabase(path);
						await writeOther();
						store = await SqlSessionStore.open(database);
						return store;
					},
				});
				await writeOther();
				if (shared) {
					assert.equal((await database.get(`SELECT COUNT(*) AS count FROM ${other.data}`))?.count, writes);
					assert.equal(
						await database.get("SELECT name FROM sqlite_schema WHERE name = 'session_data'"),
						undefined,
					);
					assert.equal(
						await database.get("SELECT name FROM sqlite_schema WHERE name = 'other_session_sessions'"),
						undefined,
					);
				}
			} finally {
				await store.close().catch((error: Error) => assert.ok(error instanceof StoreClosedError));
				await database.close();
				removeTempDirectory(directory);
			}
		},
	);
}

test("SQL sessions list materialized summaries after create, append and replace without reading entries", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		await store.create({ ...header, id: "created" }, [message("first", "created")]);
		await store.create({ ...header, id: "appended" }, [message("first", "first")]);
		await store.append("appended", [message("next", "next")], { expectSeq: 1 });
		await store.create({ ...header, id: "replaced" }, [message("old", "old")]);
		await store.replace("replaced", { ...header, id: "replaced" }, [message("new", "new")], { expectSeq: 1 });
		await database.exec("DROP TABLE session_entries");
		const summaries = await collect(store);
		assert.deepEqual(
			summaries
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(({ id, messageCount, firstMessage, searchText }) => ({ id, messageCount, firstMessage, searchText })),
			[
				{ id: "appended", messageCount: 2, firstMessage: "first", searchText: "first next" },
				{ id: "created", messageCount: 1, firstMessage: "created", searchText: "created" },
				{ id: "replaced", messageCount: 1, firstMessage: "new", searchText: "new" },
			],
		);
		assert.ok(await store.findMostRecent({ cwd: header.cwd }));
		await store.close();
	});
});

test("SQL session prefixes isolate identical IDs and do not own the shared database", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const first = await SqlSessionStore.open(database, { prefix: "first_" });
		const second = await SqlSessionStore.open(database, { prefix: "second_" });
		await first.create(header, [message("same", "first")]);
		await second.create(header, [message("same", "second")]);
		assert.equal((await collect(first))[0]?.firstMessage, "first");
		assert.equal((await collect(second))[0]?.firstMessage, "second");
		await first.delete(header.id);
		assert.deepEqual(await collect(first), []);
		assert.deepEqual((await second.load(header.id)).entries, [message("same", "second")]);
		await first.close();
		await second.append(header.id, [message("next", "still open")], { expectSeq: 1 });
		await second.close();
		const reopened = await SqlSessionStore.open(database, { prefix: "second_" });
		assert.equal((await reopened.load(header.id)).lastSeq, 2);
		await reopened.close();
	});
});

test("SQL session schema is strict, checks JSON, and rejects unsupported versions without changing tables", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, "tenant_");
		const store = await SqlSessionStore.open(database, { prefix: "tenant_" });
		assert.equal(
			(await database.get(`SELECT schema_version FROM ${tables.meta}`))?.schema_version,
			SESSION_SCHEMA_VERSION,
		);
		for (const name of Object.values(tables)) {
			assert.equal((await database.get("SELECT strict FROM pragma_table_list WHERE name = ?", name))?.strict, 1);
		}
		await assert.rejects(
			database.run(`INSERT INTO ${tables.entries} VALUES (?, ?, ?, ?)`, "session", 1, "entry", "not json"),
			StorageUnavailableError,
		);
		await store.close();
		await database.run(`UPDATE ${tables.meta} SET schema_version = 2`);
		await assert.rejects(SqlSessionStore.open(database, { prefix: "tenant_" }), (error: Error) => {
			assert.ok(error instanceof StorageSchemaVersionError);
			assert.equal(error.domain, "sessions");
			assert.equal(error.found, 2);
			assert.equal(error.supported, 1);
			return true;
		});
		assert.equal((await database.get(`SELECT schema_version FROM ${tables.meta}`))?.schema_version, 2);
	});
});

test("SQL session prefix validation runs before schema writes and preserves facade NUL errors", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		for (const [prefix, reason] of [
			["bad-prefix", "pattern"],
			["SQLITE_private_", "reserved"],
		] as const) {
			await assert.rejects(SqlSessionStore.open(database, { prefix }), (error: Error) => {
				assert.ok(error instanceof StoragePrefixError);
				assert.equal(error.prefix, prefix);
				assert.equal(error.reason, reason);
				return true;
			});
		}
		assert.deepEqual(await database.all("SELECT name FROM sqlite_schema WHERE type = 'table'"), []);
		const store = await SqlSessionStore.open(database);
		await assert.rejects(store.list({ cwd: "bad\u0000cwd" })[Symbol.asyncIterator]().next(), (error: Error) => {
			assert.ok(error instanceof StorageInvalidTextError);
			assert.equal(error.parameterIndex, 0);
			assert.equal(error.reason, "nul-character");
			return true;
		});
		await store.close();
	});
});

test("SQL session batches roll back entries and summaries when a later insert fails", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		await store.create(header, [message("original", "original")]);
		const before = await store.load(header.id);
		const summaries = await collect(store);
		await database.exec(`CREATE TRIGGER reject_entry BEFORE INSERT ON session_entries
			WHEN NEW.entry_id = 'reject' BEGIN SELECT RAISE(ABORT, 'rejected entry'); END`);
		const entries = [message("accepted", "new summary"), message("reject", "rejected")];
		await assert.rejects(store.create({ ...header, id: "rejected" }, entries), StorageUnavailableError);
		await assert.rejects(store.append(header.id, entries, { expectSeq: 1 }), StorageUnavailableError);
		await assert.rejects(
			store.replace(header.id, { ...header, internal: true }, entries, { expectSeq: 1 }),
			StorageUnavailableError,
		);
		assert.equal(await store.readHeader("rejected"), undefined);
		assert.deepEqual(await store.load(header.id), before);
		assert.deepEqual(await collect(store), summaries);
		await store.close();
	});
});
