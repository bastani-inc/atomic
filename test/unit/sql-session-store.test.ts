import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
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
import { summarizeSession } from "../../packages/coding-agent/src/core/storage/session/session-summary.ts";
import {
	SESSION_SCHEMA_VERSION,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
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

for (const [kind, cwd] of [
	["high", "\uD800"],
	["low", "\uDC00"],
] as const) {
	for (const operation of ["list", "findMostRecent"] as const) {
		test(`SQL session ${operation} does not match a lone ${kind} surrogate cwd to U+FFFD`, async () => {
			await withNodeSqliteDatabase(async ({ database }) => {
				const store = await SqlSessionStore.open(database);
				await store.create({ ...header, cwd: "\uFFFD" }, []);
				if (operation === "list") {
					const matches: SessionSummary[] = [];
					for await (const summary of store.list({ cwd: "\uFFFD" })) matches.push(summary);
					assert.deepEqual(
						matches.map((summary) => summary.id),
						[header.id],
					);
					const mismatches: SessionSummary[] = [];
					for await (const summary of store.list({ cwd })) mismatches.push(summary);
					assert.deepEqual(mismatches, []);
				} else {
					assert.equal((await store.findMostRecent({ cwd: "\uFFFD" }))?.id, header.id);
					assert.equal(await store.findMostRecent({ cwd }), undefined);
				}
				await store.close();
			});
		});
	}
}

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
		for (const cwd of ["bad\u0000cwd", "\uD800\u0000", "\u0000\uDC00"]) {
			for (const operation of ["list", "findMostRecent"] as const) {
				await assert.rejects(
					operation === "list"
						? store.list({ cwd })[Symbol.asyncIterator]().next()
						: store.findMostRecent({ cwd }),
					(error: Error) => {
						assert.ok(error instanceof StorageInvalidTextError);
						assert.equal(error.parameterIndex, 0);
						assert.equal(error.reason, "nul-character");
						return true;
					},
				);
			}
		}
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

test("SQL append and replace read bounded state and append writes stay bounded (#3645)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		let rowsRead = 0;
		let measureWrites = false;
		let bytesWritten = 0;
		const pageSize = (await database.get<SqliteRow & { page_size: number }>("PRAGMA page_size"))!.page_size;
		let bytesRead = 0;
		const observe = (rows: readonly SqliteRow[]) => {
			rowsRead += rows.length;
			bytesRead += JSON.stringify(rows).length;
		};
		const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
			exec: (sql) => executor.exec(sql),
			run: (sql, ...params) => executor.run(sql, ...params),
			get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const row = await executor.get<T>(sql, ...params);
				observe(row ? [row] : []);
				return row;
			},
			all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const rows = await executor.all<T>(sql, ...params);
				observe(rows);
				return rows;
			},
		});
		const observed: SqliteDatabase = {
			...wrap(database),
			descriptor: database.descriptor,
			transaction: async (callback) => {
				const result = await database.transaction((tx) => callback(wrap(tx)));
				if (measureWrites) {
					const checkpoint = await database.get<SqliteRow & { log: number }>("PRAGMA wal_checkpoint(PASSIVE)");
					assert.ok(checkpoint);
					bytesWritten = 32 + checkpoint.log * (pageSize + 24);
				}
				return result;
			},
			close: () => database.close(),
		};
		const store = await SqlSessionStore.open(observed);
		for (const priorCount of [128, 1024]) {
			const prior = Array.from({ length: priorCount }, (_, index) => message(`old-${index}`, "x".repeat(2048)));
			await store.create(header, prior);
			for (const operation of ["append", "replace"] as const) {
				rowsRead = 0;
				bytesRead = 0;
				await database.get("PRAGMA wal_checkpoint(TRUNCATE)");
				measureWrites = true;
				if (operation === "append") {
					await store.append(header.id, [message("new", "new")], { expectSeq: prior.length });
				} else {
					await store.replace(header.id, header, [message("replacement", "replacement")], {
						expectSeq: prior.length + 1,
					});
				}
				assert.equal(rowsRead, 1, `${operation} should read just one session state row`);
				measureWrites = false;
				assert.ok(bytesRead < 4096, `${operation} must not read accumulated search text: ${bytesRead} bytes`);
				if (operation === "append") {
					assert.ok(bytesWritten <= 128 * 1024, `append wrote ${bytesWritten} WAL bytes for one new entry`);
				}
			}
			assert.equal((await store.load(header.id)).lastSeq, 1);
			await store.delete(header.id);
		}
		await store.close();
	});
});

test("SQL replace and delete remove search text before reusing a session ID (#3645)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		await store.create(header, [message("old", "old search text")]);
		await store.create({ ...header, id: "other" }, [message("other", "unaffected")]);
		await store.replace(header.id, header, [], { expectSeq: 1 });
		assert.equal((await collect(store)).find(({ id }) => id === header.id)?.searchText, "");
		await store.append(header.id, [message("new", "new search text")], { expectSeq: 0 });
		await store.delete(header.id);
		await store.create(header, []);
		assert.deepEqual(
			(await collect(store))
				.map(({ id, searchText }) => ({ id, searchText }))
				.sort((a, b) => a.id.localeCompare(b.id)),
			[
				{ id: "other", searchText: "unaffected" },
				{ id: header.id, searchText: "" },
			],
		);
		await store.close();
	});
});

for (let seed = 1; seed <= 16; seed++) {
	test(`SQL incremental summaries match full history after reopen for random sequence ${seed} (#3645)`, async () => {
		const directory = makeTempDirectory("atomic-summary-property-");
		const path = join(directory, "sessions.sqlite");
		let database = await openNodeSqliteDatabase(path);
		let store = await SqlSessionStore.open(database);
		let randomState = seed;
		const random = (limit: number) => {
			randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
			return Math.floor((randomState / 0x100000000) * limit);
		};
		const texts = ["", " ", "(no messages)", "hello", 'quote"\\\n', "\u0000\ud800", "\udc00🙂"];
		const pickText = () => texts[random(texts.length)]!;
		const nextEntry = (id: string): SessionEntry => {
			const base = { id, parentId: null, timestamp: header.createdAt };
			const timestamp = Date.parse(header.createdAt) + random(2001) - 1000;
			switch (random(7)) {
				case 0:
					return { ...base, type: "session_info", name: pickText() };
				case 1:
					return { ...base, type: "session_summary", summary: pickText(), summarizedThroughId: "earlier" };
				case 2:
					return { ...base, type: "model_change", provider: "test", modelId: "test" };
				case 3:
					return {
						...base,
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: "call",
							toolName: "test",
							isError: false,
							content: [{ type: "text", text: pickText() }],
							timestamp,
						},
					};
				case 4:
					return {
						...base,
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "hidden" },
								{ type: "text", text: pickText() },
							],
							api: "openai-completions",
							provider: "test",
							model: "test",
							stopReason: "stop",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp,
						},
					};
				default:
					return {
						...base,
						type: "message",
						message: {
							role: "user",
							content: random(2)
								? pickText()
								: [
										{ type: "text", text: pickText() },
										{ type: "text", text: pickText() },
									],
							timestamp,
						},
					};
			}
		};
		try {
			await store.create(header, []);
			let history: SessionEntry[] = [];
			let currentHeader: SessionRecordHeader = header;
			for (let step = 0; step < 40; step++) {
				const entries = Array.from({ length: random(5) }, (_, index) => nextEntry(`${step}-${index}`));
				if (random(4) === 0) {
					currentHeader = {
						...header,
						cwd: `/project/${random(3)}`,
						...(random(2) === 0 ? { internal: true as const } : {}),
						parentSessionId: `parent-${random(3)}`,
						createdAt: new Date(Date.parse(header.createdAt) + random(1000)).toISOString(),
						workflow: { runId: "run", stageId: "stage", stageName: pickText() },
					};
					await store.replace(header.id, currentHeader, entries, { expectSeq: history.length });
					history = entries;
				} else {
					await store.append(header.id, entries, { expectSeq: history.length });
					history = [...history, ...entries];
				}
				await store.close();
				await database.close();
				database = await openNodeSqliteDatabase(path);
				store = await SqlSessionStore.open(database);
				const snapshot = await store.load(header.id);
				assert.deepEqual(snapshot, { header: currentHeader, entries: history, lastSeq: history.length });
				const actual: SessionSummary[] = [];
				for await (const summary of store.list({ includeInternal: true })) actual.push(summary);
				assert.deepEqual(actual, [summarizeSession(snapshot)], `seed ${seed}, step ${step}`);
			}
		} finally {
			await store.close();
			await database.close();
			removeTempDirectory(directory);
		}
	});
}
