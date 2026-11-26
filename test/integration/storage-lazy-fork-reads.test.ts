import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	completeSessionForkStream,
	humanForkStream,
} from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import {
	materializeForkSegments,
	readForkSegments,
} from "../../packages/coding-agent/src/core/storage/session/fork-lineage.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	historyPages,
	selectedHistoryPages,
} from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { historySnapshotFor } from "../../packages/coding-agent/src/core/storage/session/history-snapshot.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";
import {
	bytesOf,
	header,
	SERVER_TIMEOUT_MS,
	toolOutput,
	user,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * A fork that shares its parent's history (#6560) reads exactly as a fork that copies it. Two stores on one database,
 * under prefixes of their own, apply the same random history: one copies its forks, as every database did before shared
 * history, and the other has shared history turned on. Every read API must answer the same for every session.
 */

/** A small seeded generator, so a failure names the seed that reproduces it. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		below: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!,
	};
}

function assistant(id: string, parentId: string | null, text: string, second: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(Date.parse("2026-11-19T00:00:00.000Z") + second * 1_000).toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: `/f/${id}` } },
			],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		},
	} as SessionEntry;
}

/** One session's history as the test applies it to both stores: its entries, in order. */
interface Known {
	readonly entries: SessionEntry[];
}

/** Two stores the same operations go to, the copying one first. */
interface Pair {
	readonly copy: SqlSessionStore;
	readonly shared: SqlSessionStore;
	readonly known: Map<string, Known>;
	readonly seed: number;
	readonly rng: ReturnType<typeof random>;
	big: number;
	serial: number;
}

/** `count` new entries continuing `known`'s last, of every shape a read path treats apart. */
async function newEntries(pair: Pair, id: string, count: number): Promise<SessionEntry[]> {
	const known = pair.known.get(id)!;
	const out: SessionEntry[] = [];
	let parent = known.entries.at(-1)?.id ?? null;
	for (let index = 0; index < count; index++) {
		const name = `${id}.${pair.serial++}`;
		const roll = pair.rng.below(20);
		let entry: SessionEntry;
		if (roll === 0 && pair.big > 0) {
			pair.big--;
			// Longer than a stored row holds: stored in chunks.
			entry = user(name, parent, `big ${name} ${"z".repeat(SESSION_ENTRY_CHUNK_BYTES + 1000)}`, pair.serial);
		} else if (roll <= 2) {
			const data = bytesOf(50 + pair.rng.below(500), pair.serial);
			const [a, b] = await Promise.all([pair.copy.putBlob(id, data), pair.shared.putBlob(id, data)]);
			assert.equal(a.hash, b.hash);
			entry = toolOutput(name, parent ?? name, a.hash, a.bytes, pair.serial);
			if (parent === null) entry = { ...entry, parentId: null } as SessionEntry;
		} else if (roll === 3 && parent !== null) {
			entry = {
				type: "label",
				id: name,
				parentId: parent,
				timestamp: "2026-11-19T00:00:00.000Z",
				targetId: parent,
				label: `mark ${name}`,
			} as SessionEntry;
		} else if (roll === 4) {
			entry = {
				type: "session_info",
				id: name,
				parentId: parent,
				timestamp: "2026-11-19T00:00:00.000Z",
				name: `named ${name}`,
			} as SessionEntry;
		} else if (roll <= 11)
			entry = assistant(name, parent, `answer ${name} ${"a".repeat(pair.rng.below(3000))}`, pair.serial);
		else entry = user(name, parent, `question ${name} ${"q".repeat(pair.rng.below(3000))}`, pair.serial);
		out.push(entry);
		// Some entries branch off an earlier one, so forks at an entry take a path that is not a prefix.
		parent = pair.rng.below(6) === 0 && known.entries.length > 2 ? pair.rng.pick(known.entries).id : entry.id;
	}
	return out;
}

async function create(pair: Pair, id: string, count: number): Promise<void> {
	await Promise.all([pair.copy.create(header(id), []), pair.shared.create(header(id), [])]);
	pair.known.set(id, { entries: [] });
	await append(pair, id, count);
}

async function append(pair: Pair, id: string, count: number): Promise<void> {
	const known = pair.known.get(id)!;
	const entries = await newEntries(pair, id, count);
	const expectSeq = known.entries.length;
	await Promise.all([pair.copy.append(id, entries, { expectSeq }), pair.shared.append(id, entries, { expectSeq })]);
	known.entries.push(...entries);
}

/** A clone of `parent`'s whole history, as `forkTo` makes one in the same store. */
async function clone(store: SqlSessionStore, parent: string, child: string): Promise<void> {
	const head = await store.readEntrySizes(parent, 1, 0);
	const created = await store.createFork(
		header(child, parent),
		completeSessionForkStream(parent, head.epoch, head.lastSeq),
		{
			store,
			sessionId: parent,
			epoch: head.epoch,
			hashes: [],
			receipts: new Map(),
		},
	);
	assert.ok(created, "the store takes the clone");
	assert.deepEqual(created.remainingBlobs ?? [], []);
}

/** A fork of `parent` at the entry at `leafSeq`, as `/fork` makes one: the path from the root to it. */
async function branch(store: SqlSessionStore, parent: string, leafSeq: number, leafId: string, child: string) {
	const head = await store.readEntrySizes(parent, 1, 0);
	const created = await store.createFork(
		header(child, parent),
		humanForkStream(parent, head.epoch, head.lastSeq, leafSeq, leafId, new Map(), new Map()),
		{ store, sessionId: parent, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	assert.ok(created, "the store takes the fork");
	return created;
}

async function cloneBoth(pair: Pair, parent: string, child: string): Promise<void> {
	await Promise.all([clone(pair.copy, parent, child), clone(pair.shared, parent, child)]);
	const known = pair.known.get(parent)!;
	pair.known.set(child, { entries: [...known.entries] });
}

async function branchBoth(pair: Pair, parent: string, child: string): Promise<void> {
	const known = pair.known.get(parent)!;
	const leafSeq = 1 + pair.rng.below(known.entries.length);
	const leafId = known.entries[leafSeq - 1]!.id;
	const [a, b] = await Promise.all([
		branch(pair.copy, parent, leafSeq, leafId, child),
		branch(pair.shared, parent, leafSeq, leafId, child),
	]);
	assert.equal(a.lastSeq, b.lastSeq);
	const loaded = await pair.copy.load(child);
	pair.known.set(child, { entries: [...loaded.entries] });
}

/** Drops each write's random generation, the one thing two stores never share. */
function normalized(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalized);
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	if (value instanceof Map) return [...value.entries()].map(([key, item]) => [key, normalized(item)]);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value))
		if (key !== "epoch" && key !== "nextCursor" && key !== "adjacent" && key !== "revision")
			out[key] = normalized(item);
	return out;
}

async function same<T>(pair: Pair, what: string, read: (store: SqlSessionStore) => Promise<T>): Promise<void> {
	const [expected, actual] = await Promise.all([read(pair.copy), read(pair.shared)]);
	assert.deepEqual(normalized(actual), normalized(expected), `${what} (seed ${pair.seed})`);
}

async function historyItems(store: SessionStore, id: string, options: Parameters<typeof historyPages>[4]) {
	const head = await store.readEntrySizes!(id, 1, 0);
	const items = [];
	for await (const page of historyPages(store, id, head.epoch, head.lastSeq, options)) items.push(...page.items);
	return items;
}

/** Every read API, the same for `id` in both stores. */
async function compare(pair: Pair, id: string): Promise<void> {
	const known = pair.known.get(id)!;
	const last = known.entries.length;
	const rng = pair.rng;
	await same(pair, `load ${id}`, (store) => store.load(id));
	const from = 1 + rng.below(Math.max(1, last));
	await same(pair, `readTail ${id} ${from}`, (store) => store.readTail(id, from));
	const through = from + rng.below(Math.max(1, last - from + 1));
	await same(pair, `readRange ${id} ${from}..${through}`, (store) => store.readRange(id, from, through));
	const maxChars = 20_000 + rng.below(100_000);
	await same(pair, `readEntryRange ${id}`, (store) =>
		store.readEntryRange(id, { fromSeq: from, toSeq: through, maxChars }),
	);
	await same(pair, `readEntrySizes ${id}`, (store) => store.readEntrySizes(id, from, through, 7));
	await same(pair, `readResume ${id}`, (store) => store.readResume(id));
	await same(pair, `readTreeOutline ${id}`, (store) => store.readTreeOutline(id, 1, last));
	await same(pair, `history pages ${id}`, (store) => historyItems(store, id, {}));
	await same(pair, `history scan ${id}`, (store) => historyItems(store, id, { scan: { pageEntries: 50 } } as never));
	await same(pair, `history backward ${id}`, (store) => historyItems(store, id, { direction: "backward", limit: 9 }));
	await same(pair, `selected scan ${id}`, async (store) => {
		const head = await store.readEntrySizes(id, 1, 0);
		const pages = [];
		for await (const page of selectedHistoryPages(store, id, head.epoch, head.lastSeq, {
			select: { exceptCalls: [] },
			trailingReference: true,
			referencePrefix: 64,
		}))
			pages.push(page);
		return pages;
	});
	await same(pair, `history:// ${id}`, (store) =>
		historySnapshotFor(store)!(id, async (_epoch, lastSeq, packet) => ({
			items: [
				...(await packet(1, Math.min(lastSeq, 40), false)),
				...(await packet(Math.max(1, lastSeq - 5), lastSeq, true)),
			],
		})),
	);
	for (let probe = 0; probe < 3 && last > 0; probe++) {
		const entry = rng.pick(known.entries);
		await same(pair, `findEntrySeq ${id} ${entry.id}`, (store) => store.findEntrySeq(id, entry.id));
		await same(pair, `readForkWindow ${id} ${entry.id}`, (store) => store.readForkWindow(id, entry.id));
		await same(pair, `readResume ${id} at ${entry.id}`, (store) => store.readResume(id, entry.id));
	}
	await same(pair, `findEntrySeq ${id} missing`, (store) => store.findEntrySeq(id, "no-such-entry"));
	// The blobs its entries name. A shared fork also finds the blobs of its sources that it does not name, which no reader
	// asks it for: a copied fork holds only those its entries name.
	for (const hash of named(known.entries))
		await same(pair, `getBlob ${id} ${hash}`, (store) => store.getBlob(id, hash));
}

/** The blobs `entries` name. */
function named(entries: readonly SessionEntry[]): string[] {
	return entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === "atomic.tool-output"
			? [(entry.data as { hash: string }).hash]
			: [],
	);
}

async function summaries(store: SqlSessionStore) {
	const all = [];
	for await (const summary of store.list({ includeInternal: true })) all.push(summary);
	return all.sort((a, b) => a.id.localeCompare(b.id));
}

/** The rows a session stores itself in `store`'s entries table. */
async function ownRows(store: SqlSessionStore, prefix: string, id: string): Promise<number> {
	const t = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix);
	const row = await (
		store as unknown as { database: { get(sql: string, ...p: unknown[]): Promise<{ n: number }> } }
	).database.get(`SELECT count(*) AS n FROM ${t.entries} WHERE session_id = ?`, id);
	return Number(row.n);
}

async function openPair(
	scope: {
		prefix: string;
		connect(): Promise<import("../../packages/coding-agent/src/core/storage/database.js").SqliteDatabase>;
	},
	seed: number,
) {
	const copy = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}c_` });
	const shared = await SqlSessionStore.open(await scope.connect(), { prefix: `${scope.prefix}l_` });
	const enabled = await shared.enableSharedHistoryForks({ live: async () => false });
	assert.equal(enabled.status, "enabled");
	const pair: Pair = { copy, shared, known: new Map(), seed, rng: random(seed), big: 2, serial: 0 };
	return pair;
}

const SEEDS = [11, 12, 13];

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(
		`forks that share their parent's history on ${name} (#6560)`,
		() => {
			for (const seed of SEEDS)
				test(
					`a shared fork reads as a copied one through every read API, random history ${seed} (#6560)`,
					() =>
						withBackendScope(backend, async (scope) => {
							const pair = await openPair(scope, seed);
							const ids = ["root"];
							await create(pair, "root", 20 + pair.rng.below(30));
							for (let step = 0; step < 14; step++) {
								const parent = pair.rng.pick(ids);
								const child = `s${step}`;
								const roll = pair.rng.below(4);
								if (roll === 0) await cloneBoth(pair, parent, child);
								else if (roll === 1) await branchBoth(pair, parent, child);
								else {
									await append(pair, parent, 1 + pair.rng.below(12));
									continue;
								}
								ids.push(child);
								if (pair.rng.below(2) === 0) await append(pair, child, 1 + pair.rng.below(8));
							}
							for (const id of ids) await compare(pair, id);
							await same(pair, "list", summaries);
						}),
					SERVER_TIMEOUT_MS,
				);

			test(
				"a chain of fifty shared forks, each appended to, reads as the copied chain, and stores none of what it inherits (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const pair = await openPair(scope, 50);
						pair.big = 0;
						await create(pair, "g0", 6);
						for (let depth = 1; depth <= 50; depth++) {
							await cloneBoth(pair, `g${depth - 1}`, `g${depth}`);
							assert.equal(
								await ownRows(pair.shared, `${scope.prefix}l_`, `g${depth}`),
								0,
								"a clone stores no entry",
							);
							await append(pair, `g${depth}`, 2);
						}
						for (const depth of [1, 25, 50]) await compare(pair, `g${depth}`);
						assert.equal(
							await ownRows(pair.shared, `${scope.prefix}l_`, "g50"),
							2,
							"the last fork stores only its own",
						);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"reads of a shared fork while its parent's rows move into it and the parent is replaced never mix two histories (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const pair = await openPair(scope, 21);
						pair.big = 1;
						await create(pair, "p", 120);
						await cloneBoth(pair, "p", "c");
						await append(pair, "c", 5);
						const store = pair.shared;
						const expected = (await store.load("c")).entries;
						const last = expected.length;
						// What a replace of a parent others share does first, in one transaction: the child takes its own copy
						// of every row it reads from the parent, and its segments go. Then the parent's rows are rewritten.
						const prefix = `${scope.prefix}l_`;
						const database = await scope.connect();
						const tables = {
							...renderStorageIdentifiers("sessions", SESSION_TABLES, prefix),
							...sessionForkTables(prefix),
						};
						let writing = true;
						const writer = (async () => {
							await new Promise((resolve) => setTimeout(resolve, 20));
							await database.transaction(async (tx) => {
								const segments = await readForkSegments(tx, tables, "c");
								assert.ok(segments.length > 0, "the child shares the parent's history");
								await materializeForkSegments(
									tx,
									dialectOf(database),
									tables,
									{ legacyBlobData: false, chunkBytes: SESSION_BLOB_CHUNK_BYTES },
									"c",
									last,
									segments,
								);
							});
							const head = await store.readEntrySizes("p", 1, 0);
							const rewritten = (await store.load("p")).entries.map((entry) =>
								entry.type === "message" ? ({ ...entry, id: `${entry.id}.new` } as SessionEntry) : entry,
							);
							await store.replace("p", header("p"), rewritten, { expectSeq: head.lastSeq });
							writing = false;
						})();
						let reads = 0;
						const reader = async () => {
							while (writing || reads < 8) {
								reads++;
								assert.deepEqual((await store.load("c")).entries, expected, "load");
								assert.deepEqual((await store.readRange("c", 1, last)).entries, expected, "readRange");
								assert.deepEqual(
									(await store.readTail("c", last - 9)).entries.slice(-10),
									expected.slice(-10),
									"readTail",
								);
								const items = await historyItems(store, "c", { limit: 7 });
								assert.deepEqual(
									items.map((item) => ("entry" in item ? item.entry.id : `oversized ${item.seq}`)),
									expected.map((entry, index) =>
										JSON.stringify(entry).length > 64 * 1024 ? `oversized ${index + 1}` : entry.id,
									),
									"history pages",
								);
							}
						};
						await Promise.all([writer, reader(), reader()]);
						assert.equal(await ownRows(store, prefix, "c"), last, "the child now stores every row itself");
						assert.deepEqual((await store.load("c")).entries, expected);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"forks of one parent made in parallel while it appends each read the history it forked (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const pair = await openPair(scope, 7);
						pair.big = 0;
						await create(pair, "p", 30);
						const before = [...pair.known.get("p")!.entries];
						const children = Array.from({ length: 8 }, (_, index) => `k${index}`);
						const appended = await newEntries(pair, "p", 10);
						// The shared store's forks race its parent's append; each takes the parent as its own read found it.
						const results = await Promise.all([
							...children.map((child) => clone(pair.shared, "p", child).then(() => child)),
							pair.shared.append("p", appended, { expectSeq: before.length }),
						]);
						assert.equal(results.length, children.length + 1);
						for (const child of children) {
							const loaded = await pair.shared.load(child);
							const prefix = loaded.entries.length === before.length ? before : [...before, ...appended];
							assert.deepEqual(loaded.entries, prefix, `${child} holds the parent as one read found it`);
							// The copying store holds the same history, to compare every other read with.
							await pair.copy.create(header(child, "p"), prefix);
							for (const hash of named(prefix))
								await pair.copy.putBlob(child, (await pair.copy.getBlob("p", hash))!);
							pair.known.set(child, { entries: [...prefix] });
						}
						await pair.copy.append("p", appended, { expectSeq: before.length });
						pair.known.get("p")!.entries.push(...appended);
						for (const child of children) await compare(pair, child);
						await compare(pair, "p");
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);
}
