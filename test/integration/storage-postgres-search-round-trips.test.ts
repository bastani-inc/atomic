import assert from "node:assert/strict";
import { resolve } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SESSION_SEARCH_TABLES } from "../../packages/coding-agent/src/core/storage/session/session-search-index.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionSearchIndex,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import { HISTORY_TEXT_FORMAT } from "../../packages/coding-agent/src/core/tools/history-session.js";
import type { InternalSearchRequest } from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";
import { sleep } from "../helpers/runtime.js";
import { storageBackends } from "../helpers/storage-backends.js";

const PROJECT = resolve("/projects/pg-history-search-rt");
const BASE = Date.parse("2026-11-26T00:00:00.000Z");
const COMMIT_SETTLE_MS = 200;
const PART_BITS = 14;
const PART_MASK = (1 << PART_BITS) - 1;
const SEQ_SPACE = 67_108_864;
const SEQ_MASK = SEQ_SPACE - 1;
const CANDIDATE_ROWS = 256;
const SEQ_WINDOW = 4_096;
const CONTINUE = /continue with (history:\/\/\S+?)\]/;
const WORDS = ["alpha", "bravo", "charlie", "delta", "needle", "quasar", "omega", "vector", "zephyr", "prism"];

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

function header(id: string, offsetMs = 0): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE + offsetMs).toISOString(), cwd: PROJECT };
}

function message(id: string, text: string, offsetMs: number, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(BASE + offsetMs).toISOString(),
		message: { role: "user", content: text, timestamp: BASE + offsetMs },
	} as SessionEntry;
}

function searchRequest(pattern: string, extra: Partial<InternalSearchRequest> = {}): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0, ...extra };
}

function sequentialIndexStore(
	store: SqlSessionStore,
	database: SqliteDatabase,
	prefix: string | undefined,
): SessionStore {
	const index = store.searchIndex!;
	const seqIndex: SessionSearchIndex = {
		coverage: (...args) => index.coverage(...args),
		extend: (...args) => index.extend(...args),
		candidates: (sessionId, anyOf, fromSeq, toSeq, limit, generation) =>
			sequentialCandidates(database, prefix, sessionId, anyOf, fromSeq, toSeq, limit, generation),
	};
	return new Proxy(store, {
		get(target, key) {
			if (key === "searchIndex") return seqIndex;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

function trigramsOf(literal: string): string[] {
	const chars = Array.from(literal);
	const starts = new Set<number>();
	for (let start = 0; start + 3 <= chars.length; start += 3) starts.add(start);
	starts.add(chars.length - 3);
	return [...starts].map((start) => chars.slice(start, start + 3).join(""));
}

function ftsLiteral(literal: string): string {
	const terms = [...new Set(trigramsOf(literal))].slice(0, 24);
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function foldForLike(text: string): string {
	return text.replaceAll("\u0000", "\ufffd").toLowerCase().replaceAll("\u03c2", "\u03c3").replaceAll("\u017f", "s");
}

function likePattern(literal: string): string {
	return `%${foldForLike(literal).replace(/[\\%_]/g, "\\$&")}%`;
}

function likeColumn(literal: string): string {
	return /[A-Za-z0-9]{3}/.test(foldForLike(literal)) ? "body" : "(body || '')";
}

function normalizeSets(anyOf: readonly (readonly string[])[]): string[][] {
	const sets = anyOf
		.map((all) =>
			[
				...new Set(
					all
						.map((literal) => Array.from(literal).slice(0, 200).join(""))
						.filter((literal) => Array.from(literal).length >= 3),
				),
			].slice(0, 8),
		)
		.filter((all) => all.length > 0);
	let total = sets.reduce((sum, all) => sum + all.length, 0);
	while (total > 24) {
		const multi = sets.find((all) => all.length > 1);
		if (!multi) break;
		multi.pop();
		total--;
	}
	return sets;
}

/** Sequential two-step reference implementation of `candidates` for both SQLite and PostgreSQL. */
async function sequentialCandidates(
	database: SqliteDatabase,
	prefix: string | undefined,
	sessionId: string,
	anyOf: readonly (readonly string[])[],
	fromSeq: number,
	toSeq: number,
	limit: number,
	generation?: string,
): Promise<readonly number[] | undefined> {
	if (anyOf.length === 0 || fromSeq > toSeq) return [];
	const tables = renderStorageIdentifiers("sessions", SESSION_SEARCH_TABLES, prefix);
	const dialect = dialectOf(database);
	const state = await database.get<
		SqliteRow & { sid: number | bigint; indexed_seq: number | bigint; generation: string; whole_seqs: string }
	>(
		`SELECT sid, indexed_seq, revision AS generation, entry_id AS whole_seqs FROM ${tables.state} WHERE session_id = ?`,
		sessionId,
	);
	if (!state) return generation !== undefined ? undefined : [];
	const indexedSeq = Number(state.indexed_seq);
	if (generation !== undefined && (state.generation !== generation || indexedSeq < toSeq)) return undefined;
	const through = Math.min(toSeq, indexedSeq, SEQ_SPACE - 1);
	if (fromSeq > through) return [];
	const sid = Number(state.sid);
	const sets = normalizeSets(anyOf);
	const engineSeqs: number[] = [];
	if (sets.length > 0 && limit > 0) {
		if (dialect.name === "postgres") {
			if (sets.every((all) => all.length === 1)) {
				const params: SqliteValue[] = [];
				const where = sets
					.map((all) => {
						const literal = all[0]!;
						params.push(likePattern(literal));
						return `${likeColumn(literal)} LIKE ? ESCAPE '\\'`;
					})
					.join(" OR ");
				for (let from = fromSeq; from <= through && engineSeqs.length < limit; from += SEQ_WINDOW) {
					const winTo = Math.min(through, from + SEQ_WINDOW - 1);
					const rows = await database.all<SqliteRow & { seq: number | bigint }>(
						`SELECT DISTINCT seq FROM ${tables.entries} WHERE sid = ? AND seq >= ? AND seq <= ? AND (${where}) ORDER BY seq LIMIT ?`,
						sid,
						from,
						winTo,
						...params,
						limit - engineSeqs.length,
					);
					for (const row of rows) engineSeqs.push(Number(row.seq));
				}
			} else {
				for (let from = fromSeq; from <= through && engineSeqs.length < limit; from += SEQ_WINDOW) {
					const winTo = Math.min(through, from + SEQ_WINDOW - 1);
					const arms: string[] = [];
					const params: SqliteValue[] = [];
					for (const [setIndex, all] of sets.entries()) {
						for (const [litIndex, literal] of all.entries()) {
							arms.push(
								`SELECT seq, ${setIndex} AS set_id, ${litIndex} AS lit_id, ${all.length} AS need FROM ${tables.entries} WHERE sid = ? AND seq >= ? AND seq <= ? AND ${likeColumn(literal)} LIKE ? ESCAPE '\\'`,
							);
							params.push(sid, from, winTo, likePattern(literal));
						}
					}
					const rows = await database.all<SqliteRow & { seq: number | bigint }>(
						`SELECT DISTINCT seq FROM (
							SELECT seq, set_id FROM (${arms.join(" UNION ALL ")}) AS hits
							GROUP BY seq, set_id HAVING count(DISTINCT lit_id) = max(need)
						) AS matched ORDER BY seq LIMIT ?`,
						...params,
						limit - engineSeqs.length,
					);
					for (const row of rows) {
						const seq = Number(row.seq);
						if (engineSeqs.at(-1) !== seq && engineSeqs.length < limit) engineSeqs.push(seq);
					}
				}
			}
		} else if (sets.every((all) => all.length === 1)) {
			const query = sets.map((all) => `(${ftsLiteral(all[0]!)})`).join(" OR ");
			for (let from = fromSeq; from <= through && engineSeqs.length < limit; ) {
				const rows = await database.all<SqliteRow & { seq: number | bigint }>(
					`SELECT (rowid >> ${PART_BITS}) & ${SEQ_MASK} AS seq FROM ${tables.fts} WHERE ${tables.fts} MATCH ? AND rowid BETWEEN (? << 40) + (? << ${PART_BITS}) AND (? << 40) + (? << ${PART_BITS}) + ${PART_MASK} ORDER BY rowid LIMIT ?`,
					query,
					sid,
					from,
					sid,
					through,
					CANDIDATE_ROWS,
				);
				for (const row of rows) {
					const seq = Number(row.seq);
					if (engineSeqs.at(-1) !== seq && engineSeqs.length < limit) engineSeqs.push(seq);
				}
				if (rows.length < CANDIDATE_ROWS) break;
				from = Number(rows.at(-1)!.seq) + 1;
			}
		} else {
			for (let from = fromSeq; from <= through && engineSeqs.length < limit; from += SEQ_WINDOW) {
				const winTo = Math.min(through, from + SEQ_WINDOW - 1);
				const arms: string[] = [];
				const params: SqliteValue[] = [];
				for (const [setIndex, all] of sets.entries()) {
					for (const [litIndex, literal] of all.entries()) {
						arms.push(
							`SELECT (rowid >> ${PART_BITS}) & ${SEQ_MASK} AS seq, ${setIndex} AS set_id, ${litIndex} AS lit_id, ${all.length} AS need FROM ${tables.fts} WHERE ${tables.fts} MATCH ? AND rowid BETWEEN (? << 40) + (? << ${PART_BITS}) AND (? << 40) + (? << ${PART_BITS}) + ${PART_MASK}`,
						);
						params.push(ftsLiteral(literal), sid, from, sid, winTo);
					}
				}
				const rows = await database.all<SqliteRow & { seq: number | bigint }>(
					`SELECT DISTINCT seq FROM (
						SELECT seq, set_id FROM (${arms.join(" UNION ALL ")})
						GROUP BY seq, set_id HAVING count(DISTINCT lit_id) = max(need)
					) ORDER BY seq LIMIT ?`,
					...params,
					limit - engineSeqs.length,
				);
				for (const row of rows) {
					const seq = Number(row.seq);
					if (engineSeqs.at(-1) !== seq && engineSeqs.length < limit) engineSeqs.push(seq);
				}
			}
		}
	}
	const wholeSeqs = (state.whole_seqs ?? "")
		.split(",")
		.map((part) => Number.parseInt(part, 10))
		.filter((seq) => Number.isInteger(seq) && seq >= 1 && seq >= fromSeq && seq <= through);
	if (wholeSeqs.length === 0) return engineSeqs;
	return [...new Set([...engineSeqs, ...wholeSeqs])].sort((a, b) => a - b).slice(0, limit);
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL history search round trips (#6708)", () => {
	test("candidates reads search state and its first window in one round trip and one snapshot (#6708)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				const index = store.searchIndex!;
				assert.ok(index, "PostgreSQL store exposes a search index");
				await store.create(
					header("s"),
					Array.from({ length: 120 }, (_, i) =>
						message(`e${i + 1}`, i === 80 ? "alpha needle-text omega" : `filler ${i}`, i * 1000),
					),
				);
				const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
				const req = searchRequest("needle-text");
				// Warm up the search index and connection pool.
				assert.match((await router.search?.("history://sessions/s", req)) ?? "", /s:81: alpha needle-text omega/);
				const cov = await index.coverage("s", HISTORY_TEXT_FORMAT);
				assert.ok(cov?.generation);
				await sleep(COMMIT_SETTLE_MS);

				const trips = countRoundTrips();
				const single = await index.candidates("s", [["needle-text"]], 1, 120, 64, cov.generation);
				await sleep(COMMIT_SETTLE_MS);
				assert.deepEqual(single, [81]);
				assert.equal(trips.take(), 1, "single-literal candidates costs one round trip (was 2)");

				const multi = await index.candidates("s", [["alpha", "omega"]], 1, 120, 64, cov.generation);
				await sleep(COMMIT_SETTLE_MS);
				assert.deepEqual(multi, [81]);
				assert.equal(trips.take(), 1, "multi-literal candidates costs one round trip (was 2)");

				const missing = await index.candidates("missing", [["needle-text"]], 1, 120, 64, cov.generation);
				await sleep(COMMIT_SETTLE_MS);
				assert.equal(missing, undefined);
				assert.equal(trips.take(), 1, "missing session candidates costs one round trip");

				const stale = await index.candidates("s", [["needle-text"]], 1, 120, 64, "g:stale");
				await sleep(COMMIT_SETTLE_MS);
				assert.equal(stale, undefined);
				assert.equal(trips.take(), 1, "stale generation candidates costs one round trip");

				// Warm full search of one session: header, coverage, batched candidates, entry page <= 4 round trips (was 5).
				const found = await router.search?.("history://sessions/s", req);
				await sleep(COMMIT_SETTLE_MS);
				const warmTrips = trips.take();
				assert.match(found ?? "", /s:81: alpha needle-text omega/);
				assert.ok(warmTrips <= 4, `expected at most 4 round trips for warm search, got ${warmTrips}`);
			} finally {
				await store.close();
			}
		});
	});

	test("candidates reads search state and first window in one consistent REPEATABLE READ snapshot under concurrent replace (#6708)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const writer = await SqlSessionStore.open(await open());
			const reader = await SqlSessionStore.open(await open());
			try {
				const readerIndex = reader.searchIndex!;
				assert.ok(readerIndex);
				for (let round = 0; round < 12; round++) {
					const id = `snap-${round}`;
					await writer.create(header(id), [
						message("e1", "target-needle-token in original life", 1000),
						message("e2", "filler entry", 2000),
					]);
					const cov = await readerIndex.coverage(id, HISTORY_TEXT_FORMAT);
					assert.ok(cov?.generation);
					assert.equal(
						await writer.searchIndex!.extend(
							id,
							HISTORY_TEXT_FORMAT,
							0,
							2,
							[
								{ seq: 1, text: "target-needle-token in original life" },
								{ seq: 2, text: "filler entry" },
							],
							{ generation: cov.generation, revision: cov.revision },
						),
						true,
					);

					// Race reader candidates(oldGen) against concurrent replace that deletes the old search state + entries.
					const replacing = writer.replace(id, header(id), [message("r1", "brand new content", 3000)], {
						expectSeq: 2,
					});
					const reads = await Promise.all(
						Array.from({ length: 6 }, () =>
							readerIndex.candidates(id, [["target-needle-token"]], 1, 2, 10, cov.generation),
						),
					);
					await replacing;
					for (const result of reads) {
						// One snapshot guarantees either the pre-replace match [1] or post-replace invalidation undefined,
						// never a torn empty [] claiming gen was valid yet rows were missing.
						assert.ok(
							result === undefined || (result.length === 1 && result[0] === 1),
							`torn snapshot result on ${id}: ${JSON.stringify(result)}`,
						);
					}
				}
			} finally {
				await reader.close();
				await writer.close();
			}
		});
	});
});

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	run(
		`batched candidates and paged history search match sequential behavior across randomized histories on ${backend.name} (#6708)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
				try {
					const index = store.searchIndex!;
					assert.ok(index);
					const next = random(670801);
					const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
					const makeEntries = (count: number, tag: string): SessionEntry[] => {
						const entries: SessionEntry[] = [];
						for (let i = 0; i < count; i++) {
							const words = Array.from({ length: 2 + Math.floor(next() * 4) }, () => pick(WORDS));
							entries.push(message(`${tag}-${i + 1}`, words.join(" "), i * 1000, entries.at(-1)?.id ?? null));
						}
						return entries;
					};

					// 1. Empty session
					await store.create(header("empty", 0), []);
					// 2. Short session
					await store.create(header("short", 1_000), makeEntries(10, "sh"));
					// 3. Multi-window session (> SEQ_WINDOW = 4096)
					const multiCount = SEQ_WINDOW + 180;
					await store.create(
						header("multi-win", 2_000),
						Array.from({ length: multiCount }, (_, i) => {
							const seq = i + 1;
							const text =
								seq === 15 || seq === SEQ_WINDOW || seq === SEQ_WINDOW + 1 || seq === SEQ_WINDOW + 120
									? "alpha needle-cross omega"
									: `row ${seq}`;
							return message(`mw-${seq}`, text, i * 100);
						}),
					);
					for (let after = 0; after < multiCount; after += 1_500) {
						const through = Math.min(multiCount, after + 1_500);
						const batch = Array.from({ length: through - after }, (_, j) => {
							const seq = after + j + 1;
							return {
								seq,
								text:
									seq === 15 || seq === SEQ_WINDOW || seq === SEQ_WINDOW + 1 || seq === SEQ_WINDOW + 120
										? "alpha needle-cross omega"
										: `row ${seq}`,
								oversized: seq === 50 || seq === SEQ_WINDOW + 50,
							};
						});
						assert.equal(await index.extend("multi-win", HISTORY_TEXT_FORMAT, after, through, batch), true);
					}
					// 4. Updated mid-history session (indexed, then appended -> partial index)
					await store.create(header("updated", 3_000), makeEntries(60, "upd"));
					// 5. Forked session (parent + fork + appended fork-only entries)
					await store.create(header("parent", 4_000), makeEntries(50, "par"));
					const parentHead = await store.readEntrySizes("parent", 1, 0);
					await store.createFork(
						header("forked", 5_000),
						completeSessionForkStream("parent", parentHead.epoch, 30),
						{ store, sessionId: "parent", epoch: parentHead.epoch, hashes: [], receipts: new Map() },
					);
					await store.append("forked", makeEntries(20, "fk"), { expectSeq: 30 });

					const routerFor = (s: SessionStore, bytes: number, rows: number) =>
						createHistoryRouter({ cwd: PROJECT, sessionStore: () => s, budget: { bytes, rows, timeMs: 60_000 } });
					const seqStore = sequentialIndexStore(store, database, scope.prefix);

					// Warm index on non-multi-win sessions via search.
					for (const id of ["empty", "short", "updated", "parent", "forked"]) {
						await routerFor(store, 1_000_000, 10_000_000).search?.(
							`history://sessions/${id}`,
							searchRequest("alpha"),
						);
					}
					// Append mid-history unindexed tail to "updated".
					const prevCov = await index.coverage("updated", HISTORY_TEXT_FORMAT);
					assert.ok(prevCov?.generation);
					await store.append("updated", makeEntries(20, "upd-tail"), { expectSeq: 60 });

					// Direct candidates + multi-window paging equivalence against sequential reference SQL.
					const querySpecs: readonly (readonly (readonly string[])[])[] = [
						[["alpha"]],
						[["needle-cross"]],
						[["alpha"], ["needle"]],
						[["alpha", "omega"]],
						[
							["alpha", "bravo"],
							["omega", "prism"],
						],
						[["ab"]],
						[],
					];
					for (const id of ["empty", "short", "multi-win", "updated", "parent", "forked", "missing"]) {
						const cov = await index.coverage(id, HISTORY_TEXT_FORMAT);
						for (const anyOf of querySpecs) {
							const maxSeq = id === "multi-win" ? multiCount : 90;
							for (const limit of [0, 1, 2, 7, 64]) {
								const fromSeq = id === "multi-win" ? 1 : 1 + Math.floor(next() * 20);
								const toSeq = next() < 0.2 ? Number.POSITIVE_INFINITY : Math.min(maxSeq, fromSeq + maxSeq);
								for (const gen of [undefined, cov?.generation, "g:stale"]) {
									const actual = await index.candidates(id, anyOf, fromSeq, toSeq, limit, gen);
									const expected = await sequentialCandidates(
										database,
										scope.prefix,
										id,
										anyOf,
										fromSeq,
										toSeq,
										limit,
										gen,
									);
									assert.deepEqual(
										actual,
										expected,
										`${backend.name} ${id} anyOf=${JSON.stringify(anyOf)} [${fromSeq},${toSeq}] lim=${limit} gen=${String(gen)}`,
									);
								}
							}
						}
					}

					// Replace "updated" mid-history and verify stale generation returns undefined, then re-index.
					await store.replace("updated", header("updated", 3_000), makeEntries(40, "upd-rep"), { expectSeq: 80 });
					assert.equal(await index.candidates("updated", [["alpha"]], 1, 40, 64, prevCov.generation), undefined);
					await routerFor(store, 1_000_000, 10_000_000).search?.(
						"history://sessions/updated",
						searchRequest("alpha"),
					);

					// End-to-end paged history:// search equivalence against sequential two-step candidates.
					let continuations = 0;
					for (const id of ["empty", "short", "updated", "parent", "forked"]) {
						for (let q = 0; q < 6; q++) {
							const w1 = pick(WORDS);
							const w2 = pick(WORDS);
							const req = searchRequest(q % 2 === 0 ? w1 : `${w1}.*${w2}`, {
								ignoreCase: q % 3 === 0,
								contextBefore: q % 2,
								contextAfter: (q + 1) % 2,
							});
							const bytes = [350, 1_200, 10_000][q % 3]!;
							const rows = [15, 60, 100_000][q % 3]!;
							let url: string | undefined = `history://sessions/${id}`;
							for (let page = 0; url !== undefined && page < 5; page++) {
								const batchedOut: string = (await routerFor(store, bytes, rows).search?.(url, req)) ?? "";
								const seqOut: string = (await routerFor(seqStore, bytes, rows).search?.(url, req)) ?? "";
								assert.equal(batchedOut, seqOut, `${backend.name} ${url} pattern=${req.pattern}`);
								url = CONTINUE.exec(batchedOut)?.[1];
								if (url !== undefined) continuations++;
							}
						}
					}
					assert.ok(continuations > 3, `expected paged continuations on ${backend.name}, saw ${continuations}`);
				} finally {
					await store.close();
				}
			} finally {
				await scope.close();
			}
		},
	);
}
