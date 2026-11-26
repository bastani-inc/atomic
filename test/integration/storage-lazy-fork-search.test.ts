import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import {
	completeSessionForkStream,
	humanForkStream,
} from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import type { InternalSearchRequest } from "../../packages/coding-agent/src/core/tools/resource-selectors.js";
import { snapshotIndexTables } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { pathTo, seeded } from "../helpers/lazy-fork-worlds.js";
import { holdOlderBuildMarker } from "../helpers/older-build-marker.js";
import { snapshotEntry, syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";
import { type StorageBackend, storageBackends } from "../helpers/storage-backends.js";

/**
 * Searching a fork that shares its parent's history finds what searching a copy of it finds (#6560): the session
 * listing's search text and the history search, its index included, read only the rows of each source that the fork's
 * segments name, never a source's rows past the fork's cut or a sibling's.
 *
 * Each random history is written through the store twice on one database: under one prefix whose forks copy, as forks
 * always have, and under another where shared-history forks are on. Forks are whole-history clones cut at a random
 * entry and branch forks to a random entry, which edit the rows whose parent they drop, three deep with a sibling, and
 * every parent goes on after it is forked. The copy is the expected result; the snapshot index of the entries each fork
 * stores is compared with it too.
 */

const SERVER_TIMEOUT_MS = 240_000;
const PROJECT = resolve("/projects/lazy-fork-search");
const CREATED = "2026-11-01T00:00:00.000Z";
const SEEDS: Record<string, number> = { "SQLite file": 8, "libSQL server (sqld)": 3, Postgres: 4 };
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const PATTERNS = ["alpha bravo", "charlie", "no such needle", "\\b(echo|golf) [a-j]+\\b", "juliet$"];

async function withScope(backend: StorageBackend, body: (database: SqliteDatabase, prefix: string) => Promise<void>) {
	const scope = await backend.openScope();
	try {
		await body(await scope.connect(), scope.prefix);
	} finally {
		await scope.close();
	}
}

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: CREATED, cwd: PROJECT };
}

/** The two stores of one history: forks copy in one, share in the other. */
interface Stores {
	readonly copy: SqlSessionStore;
	readonly shared: SqlSessionStore;
	readonly sharedPrefix: string;
}

/**
 * `count` random entries under the last entry of `view` or, now and then, an earlier one: messages of random words,
 * and snapshots, whose blobs both stores hold first.
 */
async function randomEntries(
	random: () => number,
	stores: Stores,
	view: readonly SessionEntry[],
	count: number,
	tag: string,
): Promise<SessionEntry[]> {
	const added: SessionEntry[] = [];
	for (let index = 0; index < count; index++) {
		const all = [...view, ...added];
		const parent = all.length === 0 ? null : random() < 0.8 ? all.at(-1)! : all[Math.floor(random() * all.length)]!;
		const id = `${tag}-${all.length + 1}-${Math.floor(random() * 1e9).toString(36)}`;
		if (random() < 0.25) {
			const blob = textBlob(id);
			for (const store of [stores.copy, stores.shared]) await store.snapshotBlobs.putBlobs([blob]);
			const root = random() < 0.5 ? "/repo" : "/other";
			added.push({ ...snapshotEntry(root, id, syntheticSnapshot(id, [blob.hash], { root }), parent?.id), id });
			continue;
		}
		const text = Array.from({ length: 3 + Math.floor(random() * 6) }, () => WORDS[Math.floor(random() * 10)]).join(
			" ",
		);
		const at = Date.parse(CREATED) + (all.length + 1) * 1000;
		added.push({
			type: "message",
			id,
			parentId: parent?.id ?? null,
			timestamp: new Date(at).toISOString(),
			message: { role: random() < 0.5 ? "user" : "assistant", content: text, timestamp: at },
		} as SessionEntry);
	}
	return added;
}

/** Forks `source` of `store` into `id`: its whole history through `cut`, or, with `leaf`, the branch to that entry. */
async function fork(
	store: SqlSessionStore,
	source: string,
	id: string,
	kind: { readonly cut: number } | { readonly leaf: SessionEntry; readonly leafSeq: number },
): Promise<number> {
	const head = await store.readEntrySizes(source, 1, 0);
	const stream =
		"cut" in kind
			? completeSessionForkStream(source, head.epoch, kind.cut)
			: humanForkStream(source, head.epoch, head.lastSeq, kind.leafSeq, kind.leaf.id, new Map(), new Map());
	const created = await store.createFork(header(id), stream, {
		store,
		sessionId: source,
		epoch: head.epoch,
		hashes: [],
		receipts: new Map(),
	});
	assert.ok(created, `the store forks ${source} into ${id}`);
	return created.lastSeq;
}

function request(pattern: string): InternalSearchRequest {
	return { pattern, ignoreCase: true, literal: false, contextBefore: 1, contextAfter: 1 };
}

/** What the history search finds in `id` for each pattern, twice: the first search builds the session's index. */
async function historySearches(store: SqlSessionStore, id: string): Promise<string[]> {
	const router = createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => store,
		budget: { timeMs: 120_000, rows: 10_000_000 },
	});
	const found: string[] = [];
	for (let round = 0; round < 2; round++)
		for (const pattern of PATTERNS)
			found.push((await router.search?.(`history://sessions/${id}`, request(pattern))) ?? "");
	return found;
}

async function searchTexts(store: SqlSessionStore): Promise<Map<string, string>> {
	const texts = new Map<string, string>();
	for await (const summary of store.list({ includeInternal: true })) texts.set(summary.id, summary.searchText);
	return texts;
}

/** The snapshot index's links of the entries `id` stores itself, keyed by seq. */
async function ownLinks(database: SqliteDatabase, prefix: string, id: string, seqs?: ReadonlySet<number>) {
	const rows = await database.all(
		`SELECT seq, entry_id, parent_id, anchor_seq, broken FROM ${snapshotIndexTables(prefix).sessionLinks} WHERE session_id = ? ORDER BY seq`,
		id,
	);
	return rows
		.map((row) => ({
			seq: Number(row.seq),
			entry: row.entry_id,
			parent: row.parent_id,
			anchor: row.anchor_seq === null ? null : Number(row.anchor_seq),
			broken: Number(row.broken),
		}))
		.filter((row) => seqs === undefined || seqs.has(row.seq));
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(`search in shared-history forks on ${name} (#6560)`, () => {
		test(
			"forks that share history, three deep, search as their copies do: the listing's text, the history search and its index",
			() =>
				withScope(backend, async (database, scopePrefix) => {
					for (let seed = 1; seed <= (SEEDS[backend.name] ?? 2); seed++) {
						const sharedPrefix = `${scopePrefix}${seed}l_`;
						const copyPrefix = `${scopePrefix}${seed}c_`;
						// The copying store stays at schema 2 while an older build's session runs on its prefix.
						await holdOlderBuildMarker(database, copyPrefix);
						const stores: Stores = {
							copy: await SqlSessionStore.open(database, { prefix: copyPrefix }),
							shared: await SqlSessionStore.open(database, { prefix: sharedPrefix }),
							sharedPrefix,
						};
						const both = [stores.copy, stores.shared];
						const random = seeded(seed);
						const views = new Map<string, SessionEntry[]>();
						const append = async (id: string, count: number) => {
							const view = views.get(id)!;
							const entries = await randomEntries(random, stores, view, count, id);
							for (const store of both) await store.append(id, entries, { expectSeq: view.length });
							view.push(...entries);
						};
						const root = `root-${seed}`;
						const rootEntries = await randomEntries(random, stores, [], 8 + Math.floor(random() * 16), root);
						for (const store of both) await store.create(header(root), rootEntries);
						views.set(root, rootEntries);
						const forks: string[] = [];
						const forkBoth = async (parent: string, id: string) => {
							const view = views.get(parent)!;
							const at = Math.floor(random() * view.length);
							const kind = random() < 0.5 ? { cut: at + 1 } : { leaf: view[at]!, leafSeq: at + 1 };
							const lengths = await Promise.all(both.map((store) => fork(store, parent, id, kind)));
							assert.equal(lengths[0], lengths[1], `${id}: both forks keep as many entries`);
							views.set(id, "cut" in kind ? view.slice(0, kind.cut) : pathTo(view, kind.leaf));
							await append(id, 1 + Math.floor(random() * 5));
							// The parent goes on: its later entries are never the fork's.
							await append(parent, Math.floor(random() * 3));
							forks.push(id);
						};
						let parent = root;
						for (let depth = 1; depth <= 3; depth++) {
							const id = `f${seed}-${depth}`;
							await forkBoth(parent, id);
							parent = id;
						}
						await forkBoth(root, `s${seed}`);

						const segments = await database.all(
							`SELECT DISTINCT session_id FROM ${sessionForkTables(sharedPrefix).forkSegments}`,
						);
						assert.ok(segments.length > 0, `seed ${seed}: forks share history`);
						const copyTexts = await searchTexts(stores.copy);
						const sharedTexts = await searchTexts(stores.shared);
						for (const id of forks) {
							const where = `seed ${seed}, ${id}`;
							assert.equal(sharedTexts.get(id), copyTexts.get(id), `${where}: listing search text`);
							assert.deepEqual(
								await historySearches(stores.shared, id),
								await historySearches(stores.copy, id),
								`${where}: history search`,
							);
							const stored = await ownLinks(database, sharedPrefix, id);
							const expected = await ownLinks(
								database,
								`${scopePrefix}${seed}c_`,
								id,
								new Set(stored.map((row) => row.seq)),
							);
							assert.deepEqual(stored, expected, `${where}: links of the entries the fork stores`);
							for (const row of stored) assert.equal(row.broken, 0, `${where} seq ${row.seq}: not broken`);
						}
						for (const store of both) await store.close();
					}
				}),
			SERVER_TIMEOUT_MS,
		);
	});
}
