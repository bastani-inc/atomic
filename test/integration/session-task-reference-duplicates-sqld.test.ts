import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { LegacySessionStore } from "../../packages/coding-agent/src/core/storage/session/legacy-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionStore,
	type SessionTaskReferenceCandidate,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { snapshotIndexTables } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { observeSqlReads } from "../helpers/observe-sql-reads.js";
import { type StorageBackend, type StorageBackendScope, storageBackends } from "../helpers/storage-backends.js";

/**
 * Raw task references de-duplicated from the session entry-ID index (#5593): the store finds the earlier entries that
 * may save the same reference as each candidate without reading entry bodies or binding an entry ID, on every SQL
 * backend. Server rows run when `ATOMIC_TEST_LIBSQL_URL` and `ATOMIC_TEST_POSTGRES_URL` are set.
 */

const MiB = 1024 * 1024;
/**
 * The longest entry ID each backend stores. Postgres refuses, at append, an ID whose compressed form exceeds a btree
 * row of the session-links entry index (about 2.7 KB), so its rows use the longest compressible ID it keeps.
 */
const largeIdChars = (backend: StorageBackend) => (backend.name === "Postgres" ? 120_000 : MiB + 1);
/** The longest text one statement of the lookup binds or returns: a session ID or an epoch, never an entry ID. */
const SMALL_TEXT_CHARS = 128;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: "2026-11-19T00:00:00.000Z", cwd: "/project" };
}

function entry(id: string, text = "body"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-19T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

/** Creates session `id` on `store`, with the epoch and watermark the store saved it at. */
async function created(store: SessionStore, id: string, entries: readonly SessionEntry[]) {
	const { epoch, lastSeq } = await store.create(header(id), entries);
	assert.ok(epoch !== undefined);
	return { epoch, lastSeq };
}

interface Statement {
	readonly sql: string;
	readonly params: readonly SqliteValue[];
}

/** A store on `scope` whose statements are recorded while `watching`, with the largest text each returned. */
async function observedStore(scope: StorageBackendScope) {
	const database = await scope.connect();
	const seen = { watching: false, statements: [] as Statement[], largestReturnedText: 0 };
	observeSqlReads(database, {
		before(sql, params) {
			if (seen.watching) seen.statements.push({ sql, params });
		},
		after(rows) {
			if (!seen.watching) return;
			for (const row of rows)
				for (const value of Object.values(row))
					if (typeof value === "string")
						seen.largestReturnedText = Math.max(seen.largestReturnedText, value.length);
		},
	});
	const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
	return { database, store, seen };
}

async function watched<T>(seen: { watching: boolean; statements: Statement[] }, body: () => Promise<T>) {
	seen.statements.length = 0;
	seen.watching = true;
	try {
		return await body();
	} finally {
		seen.watching = false;
	}
}

function largestBoundText(statements: readonly Statement[]): number {
	let largest = 0;
	for (const { params } of statements)
		for (const value of params) if (typeof value === "string") largest = Math.max(largest, value.length);
	return largest;
}

/**
 * How `statement` reaches the session-links table, one line per access, and whether each is an index lookup on the
 * session and one key: a sequence or an entry ID. Postgres plans it without sequential or bitmap scans, which its
 * planner would pick only for a links table as small as a test's.
 */
async function linkLookups(database: SqliteDatabase, prefix: string, statement: Statement) {
	const links = snapshotIndexTables(prefix).sessionLinks;
	const entryIndex = `${links}_entry`;
	if (dialectOf(database).name === "postgres") {
		const rows = await database.transaction(async (tx) => {
			for (const setting of ["enable_seqscan", "enable_bitmapscan"]) await tx.exec(`SET LOCAL ${setting} = off`);
			return tx.all(`EXPLAIN (FORMAT JSON) ${statement.sql}`, ...statement.params);
		});
		const plan = rows[0]!["QUERY PLAN"] as unknown;
		const lookups: string[] = [];
		const walk = (node: Record<string, unknown>) => {
			if (node["Relation Name"] === links)
				lookups.push(`${String(node["Node Type"])} ${String(node["Index Name"])} ${String(node["Index Cond"])}`);
			for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
		};
		walk(((typeof plan === "string" ? JSON.parse(plan) : plan) as { Plan: Record<string, unknown> }[])[0]!.Plan);
		const keyed = lookups.every((line) =>
			/^Index (Only )?Scan \S+ \(\(session_id = .*\) AND \((seq|entry_id) = .*\)\)$/.test(line),
		);
		return { lookups, keyed, entryIndex };
	}
	const rows = await database.all(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.params);
	// `s` and `e` are the statement's aliases of the links table.
	const lookups = rows
		.map((row: SqliteRow) => String(row.detail))
		.filter((detail) => /^(SCAN|SEARCH) [se]\b/.test(detail));
	const keyed = lookups.every((line) =>
		/^SEARCH [se] USING (COVERING )?INDEX \S+ \(session_id=\? AND (seq|entry_id)=\?\)$/.test(line),
	);
	return { lookups, keyed, entryIndex };
}

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? it : it.skip;
	describe(`task-reference duplicate candidates on ${backend.name} (#5593)`, () => {
		run("returns the first occurrence of A, B, A and nothing for a first occurrence", async () => {
			const scope = await backend.openScope();
			try {
				const { store } = await observedStore(scope);
				const { epoch, lastSeq } = await created(store, "s", [entry("A"), entry("B"), entry("A")]);
				const find = (candidates: readonly SessionTaskReferenceCandidate[]) =>
					store.findTaskReferenceDuplicateCandidates("s", { epoch, throughSeq: lastSeq, candidates });
				assert.deepEqual(await find([{ seq: 3 }]), { seqs: [1] });
				assert.deepEqual(await find([{ seq: 1 }, { seq: 2 }]), { seqs: [] });
				assert.deepEqual(await find([]), { seqs: [] });
			} finally {
				await scope.close();
			}
		});

		run("matches a block reference to a scalar ID that collides with it, and back", async () => {
			const scope = await backend.openScope();
			try {
				const { store } = await observedStore(scope);
				// "X" and "X:1" both save the reference "X:1": the second block of "X", and the entry "X:1".
				const { epoch, lastSeq } = await created(store, "s", [
					entry("X"),
					entry("X:1"),
					entry("X"),
					entry("Y:1"),
					entry("X:12"),
					entry(""),
					entry(":1"),
				]);
				const find = (candidates: readonly SessionTaskReferenceCandidate[]) =>
					store.findTaskReferenceDuplicateCandidates("s", { epoch, throughSeq: lastSeq, candidates });
				assert.deepEqual(await find([{ seq: 3, contentIndex: 1 }]), { seqs: [1, 2] });
				assert.deepEqual(await find([{ seq: 2, suffixChars: 2 }]), { seqs: [1] });
				assert.deepEqual(await find([{ seq: 5, suffixChars: 3 }]), { seqs: [1, 3] });
				assert.deepEqual(
					await find([{ seq: 7, suffixChars: 2 }]),
					{ seqs: [6] },
					"an imported empty entry ID can also be the root of a block reference",
				);
				assert.deepEqual(await find([{ seq: 2 }]), { seqs: [] });
				assert.deepEqual(
					await find([
						{ seq: 4, suffixChars: 2 },
						{ seq: 3, contentIndex: 0 },
					]),
					{ seqs: [1] },
				);
			} finally {
				await scope.close();
			}
		});

		run("pages ascending sequences after `afterSeq`, at most a page at a time", async () => {
			const scope = await backend.openScope();
			try {
				const { store } = await observedStore(scope);
				const { epoch, lastSeq } = await created(
					store,
					"s",
					Array.from({ length: 70 }, () => entry("D")),
				);
				const query = { epoch, throughSeq: lastSeq, candidates: [{ seq: 70 }, { seq: 40 }] };
				const first = await store.findTaskReferenceDuplicateCandidates("s", query);
				assert.deepEqual(first, { seqs: Array.from({ length: 64 }, (_, i) => i + 1), nextAfterSeq: 64 });
				assert.deepEqual(await store.findTaskReferenceDuplicateCandidates("s", { ...query, afterSeq: 64 }), {
					seqs: [65, 66, 67, 68, 69],
				});
				assert.deepEqual(
					await store.findTaskReferenceDuplicateCandidates("s", { ...query, limit: 2, afterSeq: 2 }),
					{
						seqs: [3, 4],
						nextAfterSeq: 4,
					},
				);
			} finally {
				await scope.close();
			}
		});

		run("conflicts on another epoch, a shorter history or a missing row, and allows later appends", async () => {
			const scope = await backend.openScope();
			try {
				const { database, store } = await observedStore(scope);
				const { epoch, lastSeq } = await created(store, "s", [entry("A"), entry("B"), entry("A")]);
				const query = { epoch, throughSeq: lastSeq, candidates: [{ seq: 3 }] };
				await store.append("s", [entry("A")], { expectSeq: lastSeq, epoch });
				assert.deepEqual(await store.findTaskReferenceDuplicateCandidates("s", query), { seqs: [1] });
				await assert.rejects(
					store.findTaskReferenceDuplicateCandidates("s", { ...query, epoch: `${epoch}-other` }),
					SessionConflictError,
				);
				await assert.rejects(
					store.findTaskReferenceDuplicateCandidates("s", { ...query, throughSeq: lastSeq + 2 }),
					SessionConflictError,
				);
				const { entries } = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
				await database.run(`DELETE FROM ${entries} WHERE session_id = ? AND seq = ?`, "s", 2);
				await assert.rejects(
					store.findTaskReferenceDuplicateCandidates("s", { ...query, candidates: [{ seq: 2 }] }),
					SessionConflictError,
				);
			} finally {
				await scope.close();
			}
		});

		run("rejects a query outside its bounds", async () => {
			const scope = await backend.openScope();
			try {
				const { store } = await observedStore(scope);
				const { epoch, lastSeq } = await created(store, "s", [entry("A"), entry("A")]);
				const find = (query: object) =>
					store.findTaskReferenceDuplicateCandidates("s", {
						epoch,
						throughSeq: lastSeq,
						candidates: [],
						...query,
					});
				await assert.rejects(find({ candidates: Array.from({ length: 101 }, () => ({ seq: 2 })) }), RangeError);
				await assert.rejects(find({ candidates: [{ seq: 3 }] }), RangeError);
				await assert.rejects(find({ candidates: [{ seq: 0 }] }), RangeError);
				await assert.rejects(find({ candidates: [{ seq: 2, contentIndex: -1 }] }), RangeError);
				await assert.rejects(find({ candidates: [{ seq: 2, suffixChars: 1.5 }] }), RangeError);
				await assert.rejects(find({ limit: 65 }), RangeError);
				await assert.rejects(find({ afterSeq: -1 }), RangeError);
			} finally {
				await scope.close();
			}
		});

		run("answers `undefined` while the entry-ID index is still being built", async () => {
			const scope = await backend.openScope();
			try {
				const { database, store } = await observedStore(scope);
				const { epoch, lastSeq } = await created(store, "s", [entry("A"), entry("A")]);
				const { sources } = snapshotIndexTables(scope.prefix);
				await database.run(
					`UPDATE ${sources} SET backfilled_through = watermark - 1 WHERE source = 'session-entries'`,
				);
				assert.equal(
					await store.findTaskReferenceDuplicateCandidates("s", {
						epoch,
						throughSeq: lastSeq,
						candidates: [{ seq: 2 }],
					}),
					undefined,
				);
			} finally {
				await scope.close();
			}
		});

		run("finds candidates in a constant number of statements through the entry-ID index", async () => {
			const scope = await backend.openScope();
			try {
				const { database, store, seen } = await observedStore(scope);
				const { epoch, lastSeq } = await created(
					store,
					"s",
					Array.from({ length: 120 }, (_, i) => entry(`e${i % 30}`)),
				);
				await store.create(header("other"), [entry("e0"), entry("e1")]);
				const query = (count: number) => ({
					epoch,
					throughSeq: lastSeq,
					candidates: Array.from({ length: count }, (_, i) => ({ seq: lastSeq - i, contentIndex: i % 2 })),
				});
				const one = await watched(seen, () => store.findTaskReferenceDuplicateCandidates("s", query(1)));
				const oneStatements = seen.statements.length;
				assert.deepEqual(one, { seqs: [30, 60, 90] });
				const many = await watched(seen, () => store.findTaskReferenceDuplicateCandidates("s", query(100)));
				assert.equal(many?.seqs.length, 64);
				assert.equal(seen.statements.length, oneStatements);
				assert.ok(oneStatements <= 3, `${oneStatements} statements`);
				const lookup = seen.statements.find(({ sql }) =>
					sql.includes(snapshotIndexTables(scope.prefix).sessionLinks),
				);
				assert.ok(lookup);
				const plan = await linkLookups(database, scope.prefix, lookup);
				assert.ok(plan.lookups.length > 0 && plan.keyed, `not every lookup is keyed:\n${plan.lookups.join("\n")}`);
				assert.ok(
					plan.lookups.some((line) => line.includes(` ${plan.entryIndex} `)),
					`the plan does not use ${plan.entryIndex}:\n${plan.lookups.join("\n")}`,
				);
			} finally {
				await scope.close();
			}
		});

		run("never binds or returns an entry ID over 1 MiB, or an entry body", async () => {
			const scope = await backend.openScope();
			try {
				const { store, seen } = await observedStore(scope);
				const root = `big-${"d".repeat(largeIdChars(backend))}`;
				const { epoch, lastSeq } = await created(store, "s", [
					entry(root, "x".repeat(300_000)),
					entry("small"),
					entry(`${root}:7`, "y".repeat(300_000)),
					entry(`${root}:7`),
				]);
				const page = await watched(seen, () =>
					store.findTaskReferenceDuplicateCandidates("s", {
						epoch,
						throughSeq: lastSeq,
						candidates: [
							{ seq: 4, suffixChars: 2 },
							{ seq: 3, contentIndex: 0 },
						],
					}),
				);
				assert.deepEqual(page, { seqs: [1, 3] });
				assert.ok(seen.statements.length > 0);
				assert.ok(largestBoundText(seen.statements) <= SMALL_TEXT_CHARS, "an entry ID was bound");
				assert.ok(seen.largestReturnedText <= SMALL_TEXT_CHARS, "an entry ID or body was returned");
			} finally {
				await scope.close();
			}
		});
	});
}

describe("task-reference duplicate candidates through the legacy store (#5593)", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
	});
	const legacyStore = (inner: SessionStore) => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-task-reference-duplicates-"));
		directories.push(directory);
		const legacyDirectory = join(directory, "legacy");
		const store = new LegacySessionStore(inner, {
			legacyDirectory,
			databasePath: join(directory, "deletions.sqlite"),
		});
		return { store, directory, legacyDirectory };
	};

	it("forwards to the wrapped store's index", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-task-reference-duplicates-"));
		directories.push(directory);
		const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
		const inner = await SqlSessionStore.open(database);
		const { store } = legacyStore(inner);
		try {
			const { epoch, lastSeq } = await created(store, "s", [entry("A"), entry("B"), entry("A")]);
			assert.deepEqual(
				await store.findTaskReferenceDuplicateCandidates("s", {
					epoch,
					throughSeq: lastSeq,
					candidates: [{ seq: 3 }],
				}),
				{ seqs: [1] },
			);
		} finally {
			await store.close();
			await database.close();
		}
	});

	it("answers `undefined` when the wrapped store has no index", async () => {
		const { store } = legacyStore(new MemorySessionStore());
		try {
			const { lastSeq } = await store.create(header("s"), [entry("A"), entry("A")]);
			assert.equal(
				await store.findTaskReferenceDuplicateCandidates("s", {
					epoch: "any",
					throughSeq: lastSeq,
					candidates: [{ seq: 2 }],
				}),
				undefined,
			);
		} finally {
			await store.close();
		}
	});

	it("answers `undefined` for a legacy session without converting it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-task-reference-duplicates-"));
		directories.push(directory);
		const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
		const inner = await SqlSessionStore.open(database);
		const { store, legacyDirectory } = legacyStore(inner);
		const legacy = await JsonlSessionStore.open(legacyDirectory);
		try {
			await legacy.create(header("old"), [entry("A"), entry("A")]);
			assert.ok(await store.readHeader("old"));
			assert.equal(
				await store.findTaskReferenceDuplicateCandidates("old", {
					epoch: "any",
					throughSeq: 2,
					candidates: [{ seq: 2 }],
				}),
				undefined,
			);
			assert.equal(await inner.readHeader("old"), undefined);
		} finally {
			await legacy.close();
			await store.close();
			await database.close();
		}
	});
});
