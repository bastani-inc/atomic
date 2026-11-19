import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("an already-open SQL store refuses a newer format before reading or writing session data (#5554)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		try {
			await store.create(header, [message("first", "saved")]);
			const blob = await store.putBlob(header.id, Uint8Array.of(42));
			await database.run("UPDATE session_meta SET schema_version = ?", SESSION_SCHEMA_VERSION + 1);
			const newer = (error: Error) =>
				error instanceof StorageSchemaVersionError && /newer Atomic/i.test(error.message);
			for (const read of [
				() => store.readHeader(header.id),
				() => store.readEntryRange(header.id, { fromSeq: 1, toSeq: 1 }),
				() => store.getBlob(header.id, blob.hash),
				() => store.snapshotBlobs.listBlobHashes(),
				() => store.searchIndex!.coverage(header.id, 1),
				() => store.findMostRecent({ cwd: header.cwd }),
				() => store.readResume(header.id),
				() => store.append(header.id, [message("wrong", "no")], { expectSeq: 1 }),
			])
				await assert.rejects(read(), newer);
			assert.equal((await database.get("SELECT count(*) AS n FROM session_entries"))?.n, 1);
		} finally {
			await store.close();
		}
	});
});

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
			SESSION_SCHEMA_VERSION - 1,
		);
		for (const name of Object.values(tables)) {
			assert.equal((await database.get("SELECT strict FROM pragma_table_list WHERE name = ?", name))?.strict, 1);
		}
		await assert.rejects(
			database.run(
				`INSERT INTO ${tables.entries} (session_id, seq, entry_id, entry_json) VALUES (?, ?, ?, ?)`,
				"session",
				1,
				"entry",
				"not json",
			),
			StorageUnavailableError,
		);
		await store.close();
		await database.run(`UPDATE ${tables.meta} SET schema_version = 3`);
		await assert.rejects(SqlSessionStore.open(database, { prefix: "tenant_" }), (error: Error) => {
			assert.ok(error instanceof StorageSchemaVersionError);
			assert.equal(error.domain, "sessions");
			assert.equal(error.found, 3);
			assert.equal(error.supported, 2);
			return true;
		});
		assert.equal((await database.get(`SELECT schema_version FROM ${tables.meta}`))?.schema_version, 3);
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
				// The schema version row each transaction checks (#5065), and one session state row.
				assert.equal(rowsRead, 2, `${operation} should read just the schema version and one session state row`);
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

test("SQL light listing bounds its key scan by size and fetches wide columns per page (#5250)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		const sessions = 200;
		for (let index = 0; index < sessions; index++) {
			const id = `s-${String(index).padStart(4, "0")}`;
			await store.create({ ...header, id }, [
				message(`${id}-m`, "x".repeat(60_000)),
				{
					type: "session_summary",
					id: `${id}-sum`,
					parentId: `${id}-m`,
					timestamp: header.createdAt,
					summary: "y".repeat(200_000),
					summarizedThroughId: `${id}-m`,
				},
			]);
		}
		let longLengths = 0;
		const configured = new WeakSet<DatabaseSync>();
		const prepare = DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
			if (!configured.has(this)) {
				configured.add(this);
				this.function("length", { deterministic: true }, (value) => {
					if (value === null) return null;
					if (typeof value === "string") {
						if (value.length >= 10_000) longLengths++;
						return [...value].length;
					}
					return value instanceof Uint8Array ? value.byteLength : String(value).length;
				});
			}
			return prepare.call(this, sql);
		} as typeof prepare;
		const listed: SessionSummary[] = [];
		try {
			for await (const summary of store.list({ includeInternal: true, withoutSearchText: true })) {
				listed.push(summary);
			}
		} finally {
			DatabaseSync.prototype.prepare = prepare;
		}
		assert.deepEqual(
			listed.map((summary) => summary.id),
			Array.from({ length: sessions }, (_, index) => `s-${String(index).padStart(4, "0")}`),
		);
		assert.ok(
			longLengths <= 8 * sessions,
			`light listing measured ${longLengths} long values across ${sessions} sessions`,
		);
		await store.close();
	});
});

test("SQL light listing advances past oversized rows with bounded statements and key work (#5250)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		const expected = ["first", ...Array.from({ length: 24 }, (_, index) => `wide-${index}`), "last"];
		for (const id of expected) {
			await store.create({ ...header, id }, [
				{
					type: "session_info",
					id: `${id}-name`,
					parentId: null,
					timestamp: header.createdAt,
					name: id.startsWith("wide-") ? "w".repeat(1_100_000) : id,
				},
			]);
		}
		let statements = 0;
		let wideLengths = 0;
		let oneRowPages = 0;
		const configured = new WeakSet<DatabaseSync>();
		const prepare = DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
			if (!configured.has(this)) {
				configured.add(this);
				this.function("length", { deterministic: true }, (value) => {
					if (typeof value === "string" && value.length > 1_000_000) wideLengths++;
					return value === null ? null : typeof value === "string" ? value.length : String(value).length;
				});
			}
			return prepare.call(this, sql);
		} as typeof prepare;
		const all = database.all.bind(database);
		database.all = async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> => {
			const rows = await all<T>(sql, ...params);
			statements++;
			assert.ok(statements <= expected.length + 1, "listing must not stall on an oversized row");
			if (rows.some((row) => typeof row.id === "string")) {
				if (rows.length === 1) oneRowPages++;
				assert.equal(rows.length, 1, "each oversized listing row needs its own page");
			}
			return rows;
		};
		const actual: string[] = [];
		try {
			for await (const summary of store.list({ includeInternal: true, withoutSearchText: true }))
				actual.push(summary.id);
		} finally {
			database.all = all;
			DatabaseSync.prototype.prepare = prepare;
		}
		assert.deepEqual(actual, expected);
		assert.equal(oneRowPages, expected.length);
		assert.ok(wideLengths <= expected.length * 6, `listing measured ${wideLengths} oversized values`);
		await store.close();
	});
});

/** Seeding 2,000 sessions of 20 KB rows, each its own write, before the listing; about 17 s on an idle Windows runner. */
const WIDE_LISTING_SEED_TIMEOUT_MS = 90_000;

test(
	"SQL light listing reads 2,000 wide rows in bounded statements without collapsing its fetch limit (#5250)",
	async () => {
		await withNodeSqliteDatabase(async ({ database }) => {
			const store = await SqlSessionStore.open(database);
			const sessions = 2_000;
			const wideName = "w".repeat(20_000);
			await database.exec("PRAGMA synchronous=OFF");
			for (let index = 0; index < sessions; index++) {
				const id = `s-${String(index).padStart(4, "0")}`;
				await store.create({ ...header, id }, [
					{
						type: "session_info",
						id: `${id}-name`,
						parentId: null,
						timestamp: header.createdAt,
						name: wideName,
					},
				]);
			}
			let statements = 0;
			const all = database.all.bind(database);
			database.all = async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> => {
				statements++;
				return all<T>(sql, ...params);
			};
			const actual: string[] = [];
			try {
				for await (const summary of store.list({ includeInternal: true, withoutSearchText: true }))
					actual.push(summary.id);
			} finally {
				database.all = all;
			}
			assert.deepEqual(
				actual,
				Array.from({ length: sessions }, (_, index) => `s-${String(index).padStart(4, "0")}`),
			);
			assert.ok(statements <= 60, `listing used ${statements} statements across ${sessions} sessions`);
			await store.close();
		});
	},
	WIDE_LISTING_SEED_TIMEOUT_MS,
);

/** The sessions a light listing may scan in one turn of the event loop; an uncached store reads each in up to ~0.4 ms. */
const LIGHT_LISTING_ROWS_PER_TURN = 256;

test("SQL light listing of a project gives the event loop a turn every 256 sessions it scans (#5480)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		const sessions = 2 * LIGHT_LISTING_ROWS_PER_TURN + 100;
		const expected = Array.from({ length: sessions }, (_, index) => `s-${String(index).padStart(4, "0")}`);
		await database.exec("PRAGMA synchronous=OFF");
		for (const id of expected) await store.create({ ...header, id }, []);
		let turns = 0;
		let ticking = true;
		const tick = () => {
			turns++;
			if (ticking) setImmediate(tick);
		};
		setImmediate(tick);
		const start = turns;
		const listedPerTurn = new Map<number, number>();
		const actual: string[] = [];
		try {
			for await (const summary of store.list({ cwd: header.cwd, withoutSearchText: true })) {
				actual.push(summary.id);
				listedPerTurn.set(turns, (listedPerTurn.get(turns) ?? 0) + 1);
			}
		} finally {
			ticking = false;
		}
		assert.deepEqual(actual, expected);
		const mostInOneTurn = Math.max(...listedPerTurn.values());
		assert.ok(
			mostInOneTurn <= LIGHT_LISTING_ROWS_PER_TURN,
			`the listing handed over ${mostInOneTurn} sessions in one turn`,
		);
		// Finding the project's stored spellings scans every session too, and gets the same turns.
		const scanTurns = 2 * Math.ceil(sessions / LIGHT_LISTING_ROWS_PER_TURN);
		assert.ok(turns - start >= scanTurns, `the listing took ${turns - start} turns, expected ${scanTurns}`);
		await store.close();
	});
});

/** Sessions of another project whose wide columns a light listing of this project must not read. */
const OTHER_PROJECT_SESSIONS = 128;
/** Characters of each other session's stored summary: 64 MiB across them, most of it in overflow pages. */
const OTHER_SUMMARY_CHARS = 512 * 1024;
/** Best of several listings, so a pause of the test process does not decide the comparison. */
const LISTING_TIMINGS = 5;
/** Time a listing may take beyond four times its time beside narrow sessions; copying the summaries takes ~20 ms. */
const LISTING_TIMING_SLACK_MS = 5;

test("SQL light listing of a project reads only the keys of other projects' sessions (#5480)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const store = await SqlSessionStore.open(database);
		const tables = renderStorageIdentifiers("sessions", SESSION_TABLES);
		await database.exec("PRAGMA synchronous=OFF");
		await store.create(header, [message("m", "this project")]);
		for (let index = 0; index < OTHER_PROJECT_SESSIONS; index++)
			await store.create({ ...header, id: `other-${index}`, cwd: "/other" }, [message("m", "other project")]);
		const fastestListing = async (): Promise<number> => {
			let fastest = Number.POSITIVE_INFINITY;
			for (let run = 0; run < LISTING_TIMINGS; run++) {
				const started = performance.now();
				const listed: string[] = [];
				for await (const summary of store.list({ cwd: header.cwd, withoutSearchText: true }))
					listed.push(summary.id);
				fastest = Math.min(fastest, performance.now() - started);
				assert.deepEqual(listed, [header.id]);
			}
			return fastest;
		};
		const narrow = await fastestListing();
		await database.run(
			`UPDATE ${tables.sessions} SET summary = json_quote(printf('%.*c', ?, 'y')) WHERE cwd = '/other'`,
			OTHER_SUMMARY_CHARS,
		);
		const wide = await fastestListing();
		assert.ok(
			wide <= narrow * 4 + LISTING_TIMING_SLACK_MS,
			`listing took ${wide.toFixed(1)} ms beside wide sessions, ${narrow.toFixed(1)} ms beside narrow ones`,
		);
		await store.close();
	});
});

/** Stored project spellings a paced listing resolves at once: each can be a chain of file system calls. */
const PROJECT_SPELLINGS_AT_ONCE = 64;

test("SQL light listing resolves other projects' spellings a few at a time (#5480)", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		let resolving = 0;
		let mostAtOnce = 0;
		const store = await SqlSessionStore.open(database, {
			cwdMatcher: (cwd) => async (candidate) => {
				resolving++;
				mostAtOnce = Math.max(mostAtOnce, resolving);
				await new Promise<void>((resolve) => setImmediate(resolve));
				resolving--;
				return candidate === cwd;
			},
		});
		await database.exec("PRAGMA synchronous=OFF");
		await store.create(header, []);
		for (let index = 0; index < PROJECT_SPELLINGS_AT_ONCE * 3; index++)
			await store.create({ ...header, id: `other-${index}`, cwd: `/other-${index}` }, []);
		const listed: string[] = [];
		for await (const summary of store.list({ cwd: header.cwd, withoutSearchText: true })) listed.push(summary.id);
		assert.deepEqual(listed, [header.id]);
		assert.ok(mostAtOnce <= PROJECT_SPELLINGS_AT_ONCE, `the listing resolved ${mostAtOnce} spellings at once`);
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
