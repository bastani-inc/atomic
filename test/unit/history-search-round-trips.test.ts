import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
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
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

const PROJECT = resolve("/projects/history-search-round-trips");
const BASE = Date.parse("2026-11-26T00:00:00.000Z");
const PART_BITS = 14;
const PART_MASK = (1 << PART_BITS) - 1;
const SEQ_SPACE = 67_108_864;
const SEQ_MASK = SEQ_SPACE - 1;
const CANDIDATE_ROWS = 256;
const SEQ_WINDOW = 4_096;
const CONTINUE = /continue with (history:\/\/\S+?)\]/;
const WORDS = ["alpha", "bravo", "charlie", "delta", "needle", "quasar", "omega", "vector", "zephyr", "prism"];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

async function openStore(): Promise<{ readonly database: SqliteDatabase; readonly store: SqlSessionStore }> {
	const directory = makeTempDirectory("atomic-history-search-rt-");
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
		removeTempDirectory(directory);
	});
	return { database, store };
}

/**
 * Records every request sent to a connection thread while `run` executes, and counts the awaited waits: requests sent
 * while no awaited request was in flight. `endRead` is fire-and-forget on node:sqlite so it is recorded in `sent` only.
 */
async function measureWaits<T>(run: () => Promise<T>): Promise<{
	readonly value: T;
	readonly sent: readonly ConnectionRequest[];
	readonly waits: number;
}> {
	const sent: ConnectionRequest[] = [];
	let awaitedInFlight = 0;
	let waits = 0;
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		if (request.kind === "endRead") return send(request);
		if (awaitedInFlight === 0) waits += 1;
		awaitedInFlight += 1;
		return send(request).finally(() => {
			awaitedInFlight -= 1;
		});
	});
	try {
		const value = await run();
		return { value, sent, waits };
	} finally {
		interception.restore();
	}
}

function searchRequest(pattern: string, extra: Partial<InternalSearchRequest> = {}): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0, ...extra };
}

function sequentialIndexStore(store: SqlSessionStore, database: SqliteDatabase): SessionStore {
	const index = store.searchIndex!;
	const seqIndex: SessionSearchIndex = {
		coverage: (...args) => index.coverage(...args),
		extend: (...args) => index.extend(...args),
		candidates: (sessionId, anyOf, fromSeq, toSeq, limit, generation) =>
			sequentialSqliteCandidates(database, sessionId, anyOf, fromSeq, toSeq, limit, generation),
	};
	return new Proxy(store, {
		get(target, key) {
			if (key === "searchIndex") return seqIndex;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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

/** Sequential two-step reference implementation of SQLite `candidates` (state read, then direct numeric-sid windows). */
async function sequentialSqliteCandidates(
	database: SqliteDatabase,
	sessionId: string,
	anyOf: readonly (readonly string[])[],
	fromSeq: number,
	toSeq: number,
	limit: number,
	generation?: string,
): Promise<readonly number[] | undefined> {
	if (anyOf.length === 0 || fromSeq > toSeq) return [];
	const state = await database.get<
		SqliteRow & { sid: number | bigint; indexed_seq: number | bigint; generation: string; whole_seqs: string }
	>(
		"SELECT sid, indexed_seq, revision AS generation, entry_id AS whole_seqs FROM session_search_state WHERE session_id = ?",
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
		if (sets.every((all) => all.length === 1)) {
			const query = sets.map((all) => `(${ftsLiteral(all[0]!)})`).join(" OR ");
			for (let from = fromSeq; from <= through && engineSeqs.length < limit; ) {
				const rows = await database.all<SqliteRow & { seq: number | bigint }>(
					`SELECT (rowid >> ${PART_BITS}) & ${SEQ_MASK} AS seq FROM session_search_fts WHERE session_search_fts MATCH ? AND rowid BETWEEN (? << 40) + (? << ${PART_BITS}) AND (? << 40) + (? << ${PART_BITS}) + ${PART_MASK} ORDER BY rowid LIMIT ?`,
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
							`SELECT (rowid >> ${PART_BITS}) & ${SEQ_MASK} AS seq, ${setIndex} AS set_id, ${litIndex} AS lit_id, ${all.length} AS need FROM session_search_fts WHERE session_search_fts MATCH ? AND rowid BETWEEN (? << 40) + (? << ${PART_BITS}) AND (? << 40) + (? << ${PART_BITS}) + ${PART_MASK}`,
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

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

test("candidates reads search state and its first index window in one SQLite thread wait (#6708)", async () => {
	const { store } = await openStore();
	const index = store.searchIndex!;
	await store.create(
		header("s"),
		Array.from({ length: 200 }, (_, i) =>
			message(`e${i + 1}`, i === 120 ? "alpha needle-text omega" : `filler entry ${i}`, i * 1000),
		),
	);
	const cov = await index.coverage("s", HISTORY_TEXT_FORMAT);
	assert.ok(cov?.generation);
	assert.equal(
		await index.extend(
			"s",
			HISTORY_TEXT_FORMAT,
			0,
			200,
			Array.from({ length: 200 }, (_, i) => ({
				seq: i + 1,
				text: i === 120 ? "alpha needle-text omega" : `filler entry ${i}`,
				oversized: i === 150,
			})),
			{ generation: cov.generation, revision: cov.revision },
		),
		true,
	);

	// Single-literal query: 1 wait (read carrying state + first FTS window), down from 2.
	const single = await measureWaits(() => index.candidates("s", [["needle-text"]], 1, 200, 64, cov.generation));
	assert.deepEqual(single.value, [121, 151]);
	assert.equal(single.waits, 1);
	assert.deepEqual(
		single.sent.map((r) => r.kind),
		["read", "endRead"],
	);
	assert.equal(single.sent[0]?.kind === "read" ? single.sent[0].statements.length : 0, 2);

	// Multi-literal query: 1 wait as well.
	const multi = await measureWaits(() => index.candidates("s", [["alpha", "omega"]], 1, 200, 64, cov.generation));
	assert.deepEqual(multi.value, [121, 151]);
	assert.equal(multi.waits, 1);
	assert.deepEqual(
		multi.sent.map((r) => r.kind),
		["read", "endRead"],
	);

	// Missing session, stale generation, and indexed_seq < toSeq still take 1 wait and preserve exact returns.
	const missingNoGen = await measureWaits(() => index.candidates("missing", [["needle-text"]], 1, 50, 64));
	assert.deepEqual(missingNoGen.value, []);
	assert.equal(missingNoGen.waits, 1);

	const missingWithGen = await measureWaits(() =>
		index.candidates("missing", [["needle-text"]], 1, 50, 64, cov.generation),
	);
	assert.equal(missingWithGen.value, undefined);
	assert.equal(missingWithGen.waits, 1);

	const staleGen = await measureWaits(() => index.candidates("s", [["needle-text"]], 1, 200, 64, "g:stale"));
	assert.equal(staleGen.value, undefined);
	assert.equal(staleGen.waits, 1);

	const partialWithGen = await measureWaits(() =>
		index.candidates("s", [["needle-text"]], 1, 250, 64, cov.generation),
	);
	assert.equal(partialWithGen.value, undefined);
	assert.equal(partialWithGen.waits, 1);

	// Short literals (< 3 chars) normalize to empty sets: single state read still returns oversized whole_seqs.
	const shortLit = await measureWaits(() => index.candidates("s", [["ab"]], 1, 200, 64, cov.generation));
	assert.deepEqual(shortLit.value, [151]);
	assert.equal(shortLit.waits, 1);
	assert.deepEqual(
		shortLit.sent.map((r) => r.kind),
		["get"],
	);

	// limit = 0: single state read, validates generation and returns [].
	const zeroLimit = await measureWaits(() => index.candidates("s", [["needle-text"]], 1, 200, 0, cov.generation));
	assert.deepEqual(zeroLimit.value, []);
	assert.equal(zeroLimit.waits, 1);
	assert.deepEqual(
		zeroLimit.sent.map((r) => r.kind),
		["get"],
	);
});

test("a warm history:// search pins its reduced SQLite wait counts for single and all sessions (#6708)", async () => {
	const { store } = await openStore();
	await store.create(
		header("s", 0),
		Array.from({ length: 200 }, (_, i) =>
			message(`e${i + 1}`, i === 120 ? "the needle-text here" : `filler ${i}`, i),
		),
	);
	await store.create(
		header("t", 5_000),
		Array.from({ length: 50 }, (_, i) => message(`f${i + 1}`, i === 10 ? "another needle-text" : `other ${i}`, i)),
	);
	await store.create(
		header("u", 10_000),
		Array.from({ length: 30 }, (_, i) => message(`g${i + 1}`, `quiet entry ${i}`, i)),
	);

	const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store });
	const req = searchRequest("needle-text");
	// Warm up every session's search index.
	const warmAll = await router.search?.("history://sessions", req);
	assert.match(warmAll ?? "", /history:\/\/sessions\/s:121: the needle-text here/);
	assert.match(warmAll ?? "", /history:\/\/sessions\/t:11: another needle-text/);

	// Single session with match: header, coverage, batched candidates (state + first window), entry page = 4 waits (was 5).
	const oneHit = await measureWaits(async () => (await router.search?.("history://sessions/s", req)) ?? "");
	assert.match(oneHit.value, /history:\/\/sessions\/s:121: the needle-text here/);
	assert.equal(oneHit.waits, 4);
	assert.deepEqual(
		oneHit.sent.map((r) => r.kind),
		["get", "get", "read", "endRead", "all"],
	);

	// Single session without match: header, coverage, batched candidates = 3 waits (was 4).
	const oneMiss = await measureWaits(async () => (await router.search?.("history://sessions/u", req)) ?? "");
	assert.doesNotMatch(oneMiss.value, /needle-text/);
	assert.equal(oneMiss.waits, 3);
	assert.deepEqual(
		oneMiss.sent.map((r) => r.kind),
		["get", "get", "read", "endRead"],
	);

	// All sessions (3 indexed: 2 matching + 1 non-matching): 4 listing waits + 3 + 3 + 2 = 12 waits (was 15).
	const allSessions = await measureWaits(async () => (await router.search?.("history://sessions", req)) ?? "");
	assert.equal(allSessions.value, warmAll);
	assert.equal(allSessions.waits, 12);
});

test("multi-window candidates on SQLite batch the first window and continue subsequent windows identically (#6708)", async () => {
	const { database, store } = await openStore();
	const index = store.searchIndex!;
	const count = SEQ_WINDOW + 350;
	await store.create(
		header("multi-win"),
		Array.from({ length: count }, (_, i) => message(`e${i + 1}`, `row ${i + 1}`, i)),
	);
	const texts = Array.from({ length: count }, (_, i) => {
		const seq = i + 1;
		// 300 single-literal hits spanning > CANDIDATE_ROWS (256), plus multi-literal hits across SEQ_WINDOW (4096).
		if (seq <= 300) return { seq, text: `dense-token alpha ${seq}` };
		if (seq === 1000 || seq === SEQ_WINDOW + 100 || seq === SEQ_WINDOW + 250)
			return { seq, text: "beacon-one and beacon-two together" };
		return { seq, text: `plain filler ${seq}` };
	});
	// Batch extend in chunks of 1000 so indexing stays fast.
	for (let after = 0; after < count; after += 1000) {
		const through = Math.min(count, after + 1000);
		assert.equal(
			await index.extend("multi-win", HISTORY_TEXT_FORMAT, after, through, texts.slice(after, through)),
			true,
		);
	}

	// Single-literal exceeding CANDIDATE_ROWS (256): 1 batched read + 1 follow-up window = 2 waits.
	const single = await measureWaits(() => index.candidates("multi-win", [["dense-token"]], 1, count, 300));
	const expectedSingle = await sequentialSqliteCandidates(database, "multi-win", [["dense-token"]], 1, count, 300);
	assert.deepEqual(single.value, expectedSingle);
	assert.equal(single.value?.length, 300);
	assert.equal(single.waits, 2);
	assert.deepEqual(
		single.sent.map((r) => r.kind),
		["read", "endRead", "all"],
	);

	// Multi-literal spanning SEQ_WINDOW (4096): 1 batched read + 1 follow-up window = 2 waits.
	const multi = await measureWaits(() => index.candidates("multi-win", [["beacon-one", "beacon-two"]], 1, count, 64));
	const expectedMulti = await sequentialSqliteCandidates(
		database,
		"multi-win",
		[["beacon-one", "beacon-two"]],
		1,
		count,
		64,
	);
	assert.deepEqual(multi.value, expectedMulti);
	assert.deepEqual(multi.value, [1000, SEQ_WINDOW + 100, SEQ_WINDOW + 250]);
	assert.equal(multi.waits, 2);
	assert.deepEqual(
		multi.sent.map((r) => r.kind),
		["read", "endRead", "all"],
	);
});

test("randomized histories produce identical candidates and paged search results as sequential reads on SQLite (#6708)", async () => {
	const { database, store } = await openStore();
	const index = store.searchIndex!;
	const next = random(6708);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const makeEntries = (count: number, tag: string): SessionEntry[] => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < count; i++) {
			const words = Array.from({ length: 2 + Math.floor(next() * 5) }, () => pick(WORDS));
			if (next() < 0.08) words.push("ab");
			const text = words.join(" ");
			entries.push(message(`${tag}-${i + 1}`, text, i * 1000, entries.at(-1)?.id ?? null));
		}
		return entries;
	};

	// 1. Empty session
	await store.create(header("empty", 0), []);
	// 2. Short session
	await store.create(header("short", 10_000), makeEntries(12, "sh"));
	// 3. Medium session updated mid-history (append after indexing -> partial index, then replace -> rotated generation)
	const medInit = makeEntries(80, "med");
	await store.create(header("updated", 20_000), medInit);
	// 4. Forked session (parent + fork with extra appended entries)
	await store.create(header("parent", 30_000), makeEntries(60, "par"));
	const parentHead = await store.readEntrySizes("parent", 1, 0);
	await store.createFork(header("forked", 40_000), completeSessionForkStream("parent", parentHead.epoch, 35), {
		store,
		sessionId: "parent",
		epoch: parentHead.epoch,
		hashes: [],
		receipts: new Map(),
	});
	await store.append("forked", makeEntries(25, "fk"), { expectSeq: 35 });

	const routerFor = (s: SessionStore, bytes: number, rows: number) =>
		createHistoryRouter({ cwd: PROJECT, sessionStore: () => s, budget: { bytes, rows, timeMs: 60_000 } });
	const seqStore = sequentialIndexStore(store, database);

	// Warm index on all sessions.
	for (const id of ["empty", "short", "updated", "parent", "forked"]) {
		await routerFor(store, 1_000_000, 10_000_000).search?.(`history://sessions/${id}`, searchRequest("alpha"));
	}

	// Update "updated" mid-history: append unindexed tail, check partial index, then add oversized entry via extend.
	const staleCov = await index.coverage("updated", HISTORY_TEXT_FORMAT);
	assert.ok(staleCov?.generation);
	await store.append("updated", makeEntries(30, "med-app"), { expectSeq: 80 });

	// Verify partial-index candidates + paged history:// search match sequential & unindexed scan.
	const sessions = ["empty", "short", "updated", "parent", "forked", "missing"];
	const querySpecs: readonly (readonly (readonly string[])[])[] = [
		[["alpha"]],
		[["alpha"], ["needle"]],
		[["alpha", "bravo"]],
		[
			["alpha", "bravo"],
			["omega", "prism"],
		],
		[["no-match-literal"]],
		[["ab"]],
		[],
	];

	for (const id of sessions) {
		const cov = await index.coverage(id, HISTORY_TEXT_FORMAT);
		for (const anyOf of querySpecs) {
			for (const limit of [0, 1, 3, 17, 64]) {
				const fromSeq = 1 + Math.floor(next() * 25);
				const toSeq = next() < 0.2 ? Number.POSITIVE_INFINITY : fromSeq + Math.floor(next() * 120);
				for (const gen of [undefined, cov?.generation, "g:stale"]) {
					const actual = await index.candidates(id, anyOf, fromSeq, toSeq, limit, gen);
					const expected = await sequentialSqliteCandidates(database, id, anyOf, fromSeq, toSeq, limit, gen);
					assert.deepEqual(
						actual,
						expected,
						`${id} anyOf=${JSON.stringify(anyOf)} [${fromSeq},${toSeq}] lim=${limit} gen=${String(gen)}`,
					);
				}
			}
		}
	}

	// Replace "updated" (forgets old index + rotates generation) and re-index via search, verifying stale generation returns undefined.
	await store.replace("updated", header("updated", 20_000), makeEntries(50, "med-rep"), { expectSeq: 110 });
	assert.equal(await index.candidates("updated", [["alpha"]], 1, 50, 64, staleCov.generation), undefined);
	await routerFor(store, 1_000_000, 10_000_000).search?.("history://sessions/updated", searchRequest("alpha"));

	// End-to-end paged history:// search equivalence (with continuations) against sequential two-step candidates.
	let continuations = 0;
	for (const id of ["empty", "short", "updated", "parent", "forked"]) {
		for (let q = 0; q < 8; q++) {
			const w1 = pick(WORDS);
			const w2 = pick(WORDS);
			const req = searchRequest(q % 2 === 0 ? w1 : `${w1}.*${w2}`, {
				ignoreCase: q % 3 === 0,
				contextBefore: q % 3,
				contextAfter: (q + 1) % 3,
			});
			const bytes = [350, 1_200, 10_000][q % 3]!;
			const rows = [15, 60, 100_000][q % 3]!;
			let url: string | undefined = `history://sessions/${id}`;
			for (let page = 0; url !== undefined && page < 6; page++) {
				const batchedOut: string = (await routerFor(store, bytes, rows).search?.(url, req)) ?? "";
				const seqOut: string = (await routerFor(seqStore, bytes, rows).search?.(url, req)) ?? "";
				assert.equal(batchedOut, seqOut, `mismatch on ${url} pattern=${req.pattern}`);
				url = CONTINUE.exec(batchedOut)?.[1];
				if (url !== undefined) continuations++;
			}
		}
	}
	assert.ok(continuations > 5, `expected multiple paged continuations, saw ${continuations}`);
});
