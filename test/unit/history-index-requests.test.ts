import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type {
	ConnectionRequest,
	ThreadConnection,
} from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import { HISTORY_TEXT_FORMAT } from "../../packages/coding-agent/src/core/tools/history-session.js";
import type { InternalSearchRequest } from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

const PROJECT = resolve("/projects/index-requests");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
/** Entries of the session the search indexes: several pages, each written in several transactions. */
const ENTRIES = 600;
/**
 * Most requests one transaction of the build sends its connection's thread: BEGIN, the index's own read or check,
 * the first write's setup (two statements) and the index state it creates, one request for a page of entries with
 * its merge steps, the update that publishes the build, and COMMIT.
 */
const MAX_TRANSACTION_REQUESTS = 8;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Entries of 240 pseudo-random words, the same for every call. */
function longSession(): SessionEntry[] {
	let state = 6082;
	const word = () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state.toString(36);
	};
	return Array.from({ length: ENTRIES }, (_, index) => {
		const at = BASE + index * 1000;
		const text = Array.from({ length: 240 }, word).join(" ");
		return {
			type: "message",
			id: `e${index + 1}`,
			parentId: null,
			timestamp: new Date(at).toISOString(),
			message: { role: "user", content: text, timestamp: at },
		};
	});
}

async function openStore(
	wrap: (database: SqliteDatabase) => SqliteDatabase = (database) => database,
): Promise<{ readonly raw: SqliteDatabase; readonly store: SqlSessionStore }> {
	const directory = makeTempDirectory("atomic-index-requests-");
	cleanups.push(() => removeTempDirectory(directory));
	const raw = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	cleanups.push(() => raw.close());
	await raw.exec("PRAGMA synchronous=OFF");
	const store = await SqlSessionStore.open(wrap(raw));
	cleanups.push(() => store.close());
	await store.create(
		{ id: "long", version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
		longSession(),
	);
	return { raw, store };
}

function search(pattern: string): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0 };
}

/** What every search below finds, building the index on the first. */
async function searches(store: SqlSessionStore): Promise<string[]> {
	const router = createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => store,
		budget: { timeMs: 120_000, rows: 10_000_000 },
	});
	const found: string[] = [];
	for (const pattern of ["no such needle", "1k9", "zz", "\\b[a-f]{4}\\b"])
		found.push((await router.search?.("history://sessions/long", search(pattern))) ?? "");
	return found;
}

/** Every row of the index's tables, in a fixed order; the build's random generation left out. */
async function indexRows(database: SqliteDatabase): Promise<unknown> {
	const tables = await database.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_search_fts_%' ORDER BY name",
	);
	const contents: Record<string, unknown> = {};
	for (const { name } of tables) contents[name] = await database.all(`SELECT * FROM ${name} ORDER BY 1, 2`);
	contents.state = await database.all(
		"SELECT sid, session_id, format, indexed_seq, entry_id FROM session_search_state ORDER BY sid",
	);
	return contents;
}

function ftsMerge(sql: string): boolean {
	return sql.includes("search_fts, rank) VALUES ('merge'");
}

function ftsInsert(sql: string): boolean {
	return sql.includes("search_fts (rowid, body)");
}

/** What a connection's thread was asked to do while a store built its index. */
interface Traffic {
	readonly commits: number;
	readonly merges: number;
	readonly sequences: number;
	/** Merge steps and inserts sent one at a time. */
	readonly ftsStatements: number;
	readonly perTransaction: readonly number[];
	/** Requests carrying merge steps or inserts, for each transaction. */
	readonly ftsPerTransaction: readonly number[];
}

/** Records the requests file connections send their threads until it is stopped: those of one store's connection. */
function watchTraffic(): { stop(): Traffic } {
	const requests: ConnectionRequest[] = [];
	const answers = new Map<ConnectionRequest, unknown>();
	const connections = new Set<ThreadConnection>();
	const interception = interceptConnectionRequests(async (request, send, connection) => {
		connections.add(connection);
		requests.push(request);
		const answer = await send(request);
		answers.set(request, answer);
		return answer;
	});
	cleanups.push(() => interception.restore());
	return {
		stop() {
			interception.restore();
			assert.equal(connections.size, 1, "one connection answered the store");
			let commits = 0;
			let merges = 0;
			let sequences = 0;
			let ftsStatements = 0;
			const perTransaction: number[] = [];
			const ftsPerTransaction: number[] = [];
			let open: number | undefined;
			let fts = 0;
			for (const request of requests) {
				if (request.kind === "begin") {
					open = 0;
					fts = 0;
				}
				if (open !== undefined) open++;
				if (request.kind === "exec" && (request.sql === "COMMIT" || request.sql === "ROLLBACK")) {
					if (request.sql === "COMMIT") commits++;
					if (open !== undefined) {
						perTransaction.push(open);
						ftsPerTransaction.push(fts);
					}
					open = undefined;
				}
				if (request.kind === "run" && (ftsMerge(request.sql) || ftsInsert(request.sql))) {
					ftsStatements++;
					fts++;
					if (ftsMerge(request.sql)) merges++;
				}
				if (request.kind === "sequence") {
					sequences++;
					fts++;
					const answer = answers.get(request) as { readonly repeated: number } | undefined;
					// The runs that did work, and the one that found none and stopped the merge.
					if (request.repeat !== undefined && answer !== undefined)
						merges += answer.repeated + (answer.repeated < request.repeat.times ? 1 : 0);
				}
			}
			return { commits, merges, sequences, ftsStatements, perTransaction, ftsPerTransaction };
		},
	};
}

/** A database whose transactions hand their callbacks a decorator of the transaction, which sees each statement. */
function decorated(database: SqliteDatabase): SqliteDatabase {
	const decorate = (tx: SqliteExecutor): SqliteExecutor =>
		new Proxy(tx, {
			get(target, key) {
				if (key === "run") return (sql: string, ...params: readonly SqliteValue[]) => target.run(sql, ...params);
				return Reflect.get(target, key);
			},
		});
	return new Proxy(database, {
		get(target, key) {
			if (key === "transaction")
				return <T>(
					body: (tx: SqliteExecutor) => Promise<T>,
					options?: Parameters<SqliteDatabase["transaction"]>[1],
				) => target.transaction((tx) => body(decorate(tx)), options);
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

test("the history:// search index sends each page of entries with its merge steps to the database thread as one request (#6082)", async () => {
	const { store } = await openStore();
	const traffic = watchTraffic();
	await searches(store);
	const coverage = await store.searchIndex?.coverage("long", HISTORY_TEXT_FORMAT);
	const { perTransaction, ftsPerTransaction } = traffic.stop();
	assert.equal(coverage?.indexedSeq, ENTRIES, "the search indexed the whole session");
	assert.ok(perTransaction.length > 10, `the build wrote in ${perTransaction.length} transactions`);
	assert.equal(Math.max(...ftsPerTransaction), 1, "a transaction sent its merge steps and inserts in one request");
	assert.ok(
		Math.max(...perTransaction) <= MAX_TRANSACTION_REQUESTS,
		`a transaction of the build sent ${Math.max(...perTransaction)} requests`,
	);
});

test("the history:// search index is built the same, with the same merge work and commits, whether a page goes as one request or one statement at a time (#6082)", async () => {
	const together = await openStore();
	let traffic = watchTraffic();
	const foundTogether = await searches(together.store);
	const togetherTraffic = traffic.stop();
	const oneByOne = await openStore(decorated);
	traffic = watchTraffic();
	const foundOneByOne = await searches(oneByOne.store);
	const oneByOneTraffic = traffic.stop();
	assert.ok(togetherTraffic.sequences > 0 && togetherTraffic.ftsStatements === 0, "pages went as one request");
	assert.equal(oneByOneTraffic.sequences, 0, "a decorated transaction runs each statement through the decorator");
	assert.ok(oneByOneTraffic.merges > 0, "the build merged");
	assert.deepEqual(
		{ commits: togetherTraffic.commits, merges: togetherTraffic.merges },
		{ commits: oneByOneTraffic.commits, merges: oneByOneTraffic.merges },
	);
	assert.deepEqual(await indexRows(together.raw), await indexRows(oneByOne.raw));
	assert.deepEqual(foundTogether, foundOneByOne);
});

test.each([
	[
		"wraps it",
		(tx: SqliteExecutor, seen: (sql: string) => void): SqliteExecutor =>
			new Proxy(tx, {
				get(target, key) {
					if (key === "run")
						return (sql: string, ...params: readonly SqliteValue[]) => {
							seen(sql);
							return target.run(sql, ...params);
						};
					return Reflect.get(target, key);
				},
			}),
	],
	[
		"replaces its run",
		(tx: SqliteExecutor, seen: (sql: string) => void): SqliteExecutor => {
			const run = tx.run;
			tx.run = (sql, ...params) => {
				seen(sql);
				return run.call(tx, sql, ...params);
			};
			return tx;
		},
	],
])("a caller that %s sees each statement of an index write (#6082)", async (_how, decorate) => {
	const inserts: string[] = [];
	const { raw } = await openStore();
	const store = await SqlSessionStore.open(
		new Proxy(raw, {
			get(target, key) {
				if (key === "transaction")
					return <T>(
						body: (tx: SqliteExecutor) => Promise<T>,
						options?: Parameters<SqliteDatabase["transaction"]>[1],
					) =>
						target.transaction((tx) => body(decorate(tx, (sql) => ftsInsert(sql) && inserts.push(sql))), options);
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	);
	cleanups.push(() => store.close());
	const texts = [
		{ seq: 1, text: "alpha" },
		{ seq: 2, text: "bravo" },
		{ seq: 3, text: "cider" },
	];
	assert.equal(await store.searchIndex!.extend("long", HISTORY_TEXT_FORMAT, 0, 3, texts), true);
	assert.equal(inserts.length, 3);
});

test("an index write whose signal aborts after its page's statements ran publishes nothing (#6082)", async () => {
	const { store } = await openStore();
	const index = store.searchIndex!;
	const controller = new AbortController();
	const reason = new Error("stop indexing");
	const texts = [
		{ seq: 1, text: "first ABORTED_NEEDLE" },
		{ seq: 2, text: "last ABORTED_NEEDLE" },
	];
	// The request that carries the page's last insert, one statement at a time or the whole page at once.
	const carriesLast = (request: ConnectionRequest) =>
		(request.kind === "run"
			? request.params
			: request.kind === "sequence"
				? request.statements.flatMap((statement) => statement.params)
				: []
		).includes("last ABORTED_NEEDLE");
	const interception = interceptConnectionRequests(async (request, send) => {
		const answer = await send(request);
		if (carriesLast(request)) controller.abort(reason);
		return answer;
	});
	cleanups.push(() => interception.restore());
	await assert.rejects(index.extend("long", HISTORY_TEXT_FORMAT, 0, 2, texts, { signal: controller.signal }), reason);
	interception.restore();
	assert.equal((await index.coverage("long", HISTORY_TEXT_FORMAT))?.indexedSeq, 0);
	assert.deepEqual(await index.candidates("long", [["ABORTED_NEEDLE"]], 1, 2, 10), []);
	assert.equal(await index.extend("long", HISTORY_TEXT_FORMAT, 0, 2, texts), true);
	assert.deepEqual(await index.candidates("long", [["ABORTED_NEEDLE"]], 1, 2, 10), [1, 2]);
});
