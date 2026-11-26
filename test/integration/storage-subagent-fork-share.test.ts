import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { createForkArchive } from "../../packages/coding-agent/src/core/storage/session/fork-archive.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import {
	SESSION_BLOB_CHUNK_BYTES,
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type {
	SessionRecordHeader,
	SessionStore,
	SessionWriteResult,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";
import { countStorageRoundTrips } from "../helpers/storage-round-trips.js";
import {
	bytesOf,
	header,
	SERVER_TIMEOUT_MS,
	toolOutput,
	user,
	withBackendScope,
} from "./storage-conformance-matrix-fork-staging-helpers.js";

/**
 * A subagent's `context: "fork"` launch, `captureFork`, costs what a fresh session does where shared history is on
 * (#6560): the child names the rows of its parent it keeps unchanged instead of storing a copy of them, and stores only
 * the rows it rewrote. Runs on every backend of the storage matrix.
 */

const CWD = "/project";
const PARENT_LENGTH = 500;
/** The label's place in the parent: the child drops it, so the entry after it is rewritten onto the one before. */
const LABEL_INDEX = 250;
/** The entries a parent appends in this process, one at a time, after it was created. */
const APPENDED = 200;

/** A linear parent of `length` entries, with a label at `LABEL_INDEX` that marks an earlier entry. */
function parentEntries(length: number): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (let index = 0; index < length; index++) {
		const parentId = out.at(-1)?.id ?? null;
		out.push(
			index === LABEL_INDEX
				? ({
						type: "label",
						id: `m${index}`,
						parentId,
						timestamp: "2026-11-19T00:00:00.000Z",
						targetId: "m100",
						label: "kept",
					} as SessionEntry)
				: user(`m${index}`, parentId, `message ${index} ${"y".repeat(200)}`, index + 1),
		);
	}
	return out;
}

/** Shared history on, as a new database starts with it once no older build runs there. */
async function enable(store: SqlSessionStore): Promise<void> {
	const { status } = await store.enableSharedHistoryForks({ live: async () => false });
	assert.ok(status === "enabled" || status === "already", status);
}

/** Session `id`'s own entry rows, in seq order: its seq and entry id. */
async function ownRows(database: SqliteDatabase, prefix: string, id: string): Promise<[number, string][]> {
	const entries = renderStorageIdentifiers("sessions", SESSION_TABLES, prefix).entries;
	const rows = await database.all(`SELECT seq, entry_id FROM ${entries} WHERE session_id = ? ORDER BY seq`, id);
	return rows.map((row) => [Number(row.seq), String(row.entry_id)]);
}

/** Session `id`'s segments, in view order: source, from, to and base seq. */
async function segments(
	database: SqliteDatabase,
	prefix: string,
	id: string,
): Promise<[string, number, number, number][]> {
	const rows = await database.all(
		`SELECT source_id, from_seq, to_seq, base_seq FROM ${sessionForkTables(prefix).forkSegments} WHERE session_id = ? ORDER BY idx`,
		id,
	);
	return rows.map((row) => [String(row.source_id), Number(row.from_seq), Number(row.to_seq), Number(row.base_seq)]);
}

/**
 * Records the entries each array fork of `store` is given, and with `around`, runs it around the fork itself: what a
 * copy of the same fork stores is then `create` of those entries.
 */
function forksOf(
	store: SqlSessionStore,
	around?: { before(): void | Promise<void>; after(): void },
): { readonly forks: { header: SessionRecordHeader; entries: readonly SessionEntry[] }[] } {
	const forks: { header: SessionRecordHeader; entries: readonly SessionEntry[] }[] = [];
	const createFork = store.createFork.bind(store);
	store.createFork = async (child, entries, source) => {
		if (!("read" in entries)) forks.push({ header: child, entries: [...entries] });
		await around?.before();
		try {
			return await createFork(child, entries, source);
		} finally {
			around?.after();
		}
	};
	return { forks };
}

/** What a resume of session `id` loads, through a manager opened anew: its branch and its entries. */
async function opened(store: SessionStore, id: string) {
	const manager = await SessionManager.open(store, id, CWD);
	return { branch: manager.getBranch(), entries: manager.getEntries() };
}

/**
 * A parent with rows stored whole and in chunks, tool outputs whose blobs it stores or no longer holds, a branch and a
 * compaction, which a fork's window rewrites.
 */
async function richParent(store: SqlSessionStore, id: string): Promise<void> {
	await store.create(header(id), [user("e1", null, "hello", 1)]);
	const big = await store.putBlob(id, bytesOf(2 * SESSION_BLOB_CHUNK_BYTES + 99, 7));
	const small = await store.putBlob(id, bytesOf(100, 9));
	const entries: SessionEntry[] = [
		user("e2", "e1", "hi", 2),
		user("e3", "e2", `big ${"x".repeat(SESSION_ENTRY_CHUNK_BYTES + SESSION_ENTRY_CHUNK_BYTES / 2)}`, 3),
		toolOutput("e4", "e3", big.hash, big.bytes, 4),
		toolOutput("e5", "e4", small.hash, small.bytes, 5),
		user("e6", "e2", "a branch", 6),
		user("e7", "e6", "on the branch", 7),
		{
			type: "compaction",
			id: "e8",
			parentId: "e5",
			timestamp: "2026-11-19T00:00:08.000Z",
			summary: "compacted",
			firstKeptEntryId: "e4",
			tokensBefore: 42,
		} as SessionEntry,
		user("e9", "e8", "after the compaction", 9),
	];
	await store.append(id, entries, { expectSeq: 1 });
}

for (const backend of storageBackends) {
	const name = backend.skipReason === undefined ? backend.name : `${backend.name} (skipped: ${backend.skipReason})`;
	describe.skipIf(backend.skipReason !== undefined)(
		`a subagent's fork shares its parent's history on ${name} (#6560)`,
		() => {
			test(
				"captureFork of a 500-entry parent names the rows it keeps and stores only those it rewrote, in the round trips of creating a fresh session (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const made = parentEntries(PARENT_LENGTH);
						await store.create(header("p"), made);
						const parent = await SessionManager.open(store, "p", CWD);
						const trips = countStorageRoundTrips(backend);
						// What a fresh session costs: creating one of a single entry.
						await store.create(header("fresh"), [user("f1", null, "hello", 1)]);
						const freshTrips = trips.take();
						let forkTrips = 0;
						const { forks } = forksOf(store, {
							before: () => void trips.take(),
							after: () => {
								forkTrips = trips.take();
							},
						});
						try {
							const child = await parent.captureFork(parent.getLeafId()!, { internal: true })();
							const id = child.getSessionId();
							assert.equal(forks.length, 1, "one fork of the entries the child keeps");
							const kept = forks[0]!.entries;
							assert.equal(kept.length, PARENT_LENGTH, "the label is dropped and appended again");

							// The entry after the dropped label now follows the one before it, and the label is a new entry.
							const own = await ownRows(database, scope.prefix, id);
							assert.deepEqual(
								own.map(([seq]) => seq),
								[LABEL_INDEX + 1, PARENT_LENGTH],
							);
							assert.equal(own[0]![1], `m${LABEL_INDEX + 1}`);
							assert.equal(kept.at(-1)!.type, "label");
							assert.deepEqual(await segments(database, scope.prefix, id), [
								["p", 1, LABEL_INDEX, 0],
								// The parent's seqs are one past each index: its label is at seq 251, the rewritten entry at 252.
								["p", LABEL_INDEX + 3, PARENT_LENGTH, LABEL_INDEX + 1],
							]);

							// A copy of the same fork: `create` of the entries it was given.
							const copyHeader = { ...forks[0]!.header, id: "copy" };
							trips.take();
							await store.create(copyHeader, kept);
							const createTrips = trips.take();
							// The first load of each by a store that never read either, as another process makes it.
							const reader = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
							// Its first read opens its read handle, which neither load below should pay for.
							await reader.load("fresh");
							trips.take();
							const forkLoad = await reader.load(id);
							const forkLoadTrips = trips.take();
							const copyLoad = await reader.load("copy");
							const copyLoadTrips = trips.take();
							const report = `fork ${forkTrips}, a fresh session ${freshTrips}, a copy ${createTrips}; first load of the fork ${forkLoadTrips}, of the copy ${copyLoadTrips}`;
							console.info(`round trips of a 500-entry captureFork on ${backend.name}: ${report}`);
							assert.ok(forkTrips > 0 && forkTrips <= freshTrips, report);
							assert.ok(forkLoadTrips > 0 && forkLoadTrips <= copyLoadTrips, report);
							assert.deepEqual(forkLoad.entries, copyLoad.entries);
							assert.deepEqual((await store.load(id)).entries, (await store.load("copy")).entries);
							assert.deepEqual(child.getEntries(), (await opened(store, "copy")).entries);
						} finally {
							trips.restore();
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a captureFork with chunked rows, blobs, a branch and a compaction reads as its copy does (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						await richParent(store, "src");
						const { forks } = forksOf(store);
						for (const leaf of ["e9", "e5", "e7"]) {
							const parent = await SessionManager.open(store, "src", CWD);
							const child = await parent.captureFork(leaf, { internal: true })();
							const id = child.getSessionId();
							const { header: forkHeader, entries } = forks.at(-1)!;
							const copy = `copy-${leaf}`;
							await store.create({ ...forkHeader, id: copy }, entries);
							assert.ok(
								(await segments(database, scope.prefix, id)).length > 0,
								`the fork at ${leaf} shares rows`,
							);
							assert.ok(
								(await ownRows(database, scope.prefix, id)).length < entries.length,
								`the fork at ${leaf} stores fewer rows than its copy`,
							);
							assert.deepEqual((await store.load(id)).entries, (await store.load(copy)).entries);
							assert.deepEqual(await opened(store, id), await opened(store, copy));
							assert.deepEqual(await store.readRange(id, 1, entries.length), {
								...(await store.readRange(copy, 1, entries.length)),
								epoch: (await store.readRange(id, 1, 0)).epoch,
							});
							for (const entry of entries)
								if (entry.type === "custom" && entry.customType === "atomic.tool-output") {
									const hash = (entry.data as { hash: string }).hash;
									assert.deepEqual(await store.getBlob(id, hash), await store.getBlob("src", hash), hash);
								}
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"50 captureForks of one parent at once each share its rows (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const made = parentEntries(PARENT_LENGTH);
						await store.create(header("p"), made);
						const parent = await SessionManager.open(store, "p", CWD);
						const leaf = parent.getLeafId()!;
						const children = await Promise.all(
							Array.from({ length: 50 }, () => parent.captureFork(leaf, { internal: true })()),
						);
						const expected = (await store.load(children[0]!.getSessionId())).entries.slice(0, -1);
						for (const child of children) {
							const id = child.getSessionId();
							assert.deepEqual(
								(await ownRows(database, scope.prefix, id)).map(([seq]) => seq),
								[LABEL_INDEX + 1, PARENT_LENGTH],
								id,
							);
							assert.equal((await segments(database, scope.prefix, id)).length, 2, id);
							assert.deepEqual((await store.load(id)).entries.slice(0, -1), expected, id);
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"an entry edited in memory after it was read is stored by the fork, never shared (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const made = parentEntries(40);
						await store.create(header("p"), made);
						const read = await store.readRange("p", 1, 40);
						const edited = read.entries[10] as SessionEntry & { message: { content: string } };
						edited.message.content = "edited in memory";
						const created: SessionWriteResult = await createForkArchive(store, header("c", "p"), read.entries, {
							store,
							sessionId: "p",
							epoch: read.epoch,
							hashes: [],
							receipts: new Map(),
						});
						assert.equal(created.lastSeq, 40);
						assert.deepEqual(await ownRows(database, scope.prefix, "c"), [[11, "m10"]]);
						assert.deepEqual(await segments(database, scope.prefix, "c"), [
							["p", 1, 10, 0],
							["p", 12, 40, 11],
						]);
						const child = (await store.load("c")).entries;
						assert.equal((child[10] as typeof edited).message.content, "edited in memory");
						assert.deepEqual(child, read.entries);
						assert.notEqual(
							((await store.load("p")).entries[10] as typeof edited).message.content,
							"edited in memory",
							"the parent keeps its row",
						);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a parent replaced between the fork's read and its write is copied as read, never shared (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const made = parentEntries(60);
						await store.create(header("p"), made);
						const parent = await SessionManager.open(store, "p", CWD);
						// The same ids at the same seqs, each with other content: a fork that named the parent's rows now would
						// read the replacement, not the history it read.
						const replacement = made.map((entry) =>
							entry.type === "message" ? user(entry.id, entry.parentId, `replaced ${entry.id}`, 1) : entry,
						);
						let replaced = false;
						const { forks } = forksOf(store, {
							before: async () => {
								if (replaced) return;
								replaced = true;
								await store.replace("p", header("p"), replacement, { expectSeq: 60 });
							},
							after: () => {},
						});
						const child = await parent.captureFork(parent.getLeafId()!, { internal: true })();
						const id = child.getSessionId();
						assert.ok(replaced);
						const kept = forks[0]!.entries;
						assert.deepEqual(await segments(database, scope.prefix, id), [], "nothing is shared");
						assert.equal((await ownRows(database, scope.prefix, id)).length, kept.length);
						const loaded = (await store.load(id)).entries;
						assert.deepEqual(loaded, kept);
						assert.match(JSON.stringify(loaded[1]), /message 1 /, "the child holds the history it read");
						assert.match(JSON.stringify((await store.load("p")).entries[1]), /replaced m1/);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a tail branch and a clone of a session read in full share its rows too (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const made = parentEntries(PARENT_LENGTH);
						await store.create(header("p"), made);

						// The SDK's branch of what a resume at the leaf loads: the same entries a subagent's fork keeps.
						const branching = await SessionManager.open(store, "p", CWD);
						await branching.createBranchedSession(branching.getLeafId()!, { history: "tail" });
						const branch = branching.getSessionId();
						assert.deepEqual(
							(await ownRows(database, scope.prefix, branch)).map(([seq]) => seq),
							[LABEL_INDEX + 1, PARENT_LENGTH],
						);
						assert.equal((await segments(database, scope.prefix, branch)).length, 2);

						// A clone keeps every row as stored.
						const cloning = await SessionManager.open(store, "p", CWD);
						const clone = (await cloning.forkTo(CWD, store)).getSessionId();
						assert.deepEqual(await ownRows(database, scope.prefix, clone), []);
						assert.deepEqual(await segments(database, scope.prefix, clone), [["p", 1, PARENT_LENGTH, 0]]);
						assert.deepEqual((await store.load(clone)).entries, made);
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"a parent that appended its whole history in this process, never read back, shares it with its forks and clones, in the round trips of creating a fresh session (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const parent = await SessionManager.create(store, CWD);
						const id = parent.getSessionId();
						const ids: string[] = [];
						for (let index = 0; index < APPENDED; index++) {
							ids.push(await parent.appendMessage({ role: "user", content: `turn ${index}`, timestamp: index }));
							// A label the fork drops and appends again: the entry after it is rewritten onto the one before.
							if (index === APPENDED / 2) await parent.appendLabelChange(ids[10]!, "kept");
						}
						const length = APPENDED + 1;
						const labelSeq = APPENDED / 2 + 2;
						const trips = countStorageRoundTrips(backend);
						try {
							await store.create(header("fresh"), [user("f1", null, "hello", 1)]);
							const freshTrips = trips.take();
							let forkTrips = 0;
							forksOf(store, {
								before: () => void trips.take(),
								after: () => {
									forkTrips = trips.take();
								},
							});

							const child = await parent.captureFork(parent.getLeafId()!, { internal: true })();
							const forked = child.getSessionId();
							const captureTrips = forkTrips;
							assert.deepEqual(
								(await ownRows(database, scope.prefix, forked)).map(([seq]) => seq),
								[labelSeq, length],
							);
							assert.deepEqual(await segments(database, scope.prefix, forked), [
								[id, 1, labelSeq - 1, 0],
								// The parent's label is at seq labelSeq, the rewritten entry after it at labelSeq + 1.
								[id, labelSeq + 2, length, labelSeq],
							]);

							// A clone of the live manager forks the rows it holds as it appended them.
							const clone = (await parent.forkTo(CWD, store)).getSessionId();
							const cloneTrips = forkTrips;
							assert.deepEqual(await ownRows(database, scope.prefix, clone), []);
							assert.deepEqual(await segments(database, scope.prefix, clone), [[id, 1, length, 0]]);
							const report = `captureFork ${captureTrips}, clone ${cloneTrips}, a fresh session ${freshTrips}`;
							console.info(`round trips after ${APPENDED} appends on ${backend.name}: ${report}`);
							assert.ok(captureTrips > 0 && captureTrips <= freshTrips, report);
							assert.ok(cloneTrips > 0 && cloneTrips <= freshTrips, report);

							// The parent goes on: what the fork and the clone hold stays as it was.
							const forkView = (await store.load(forked)).entries;
							const cloneView = (await store.load(clone)).entries;
							for (let index = 0; index < 10; index++)
								await parent.appendMessage({ role: "user", content: `later ${index}`, timestamp: index });
							assert.equal((await store.load(id)).entries.length, length + 10);
							assert.deepEqual((await store.load(forked)).entries, forkView);
							assert.deepEqual((await store.load(clone)).entries, cloneView);
							assert.deepEqual(cloneView, (await store.load(id)).entries.slice(0, length));
							assert.deepEqual((await SessionManager.open(store, forked, CWD)).getEntries(), child.getEntries());

							// A clone after those appends still shares the whole history: the generation did not change.
							const later = (await parent.forkTo(CWD, store)).getSessionId();
							assert.deepEqual(await ownRows(database, scope.prefix, later), []);
							assert.deepEqual(await segments(database, scope.prefix, later), [[id, 1, length + 10, 0]]);
						} finally {
							trips.restore();
						}
					}),
				SERVER_TIMEOUT_MS,
			);

			test(
				"an appended entry edited in memory before a clone is stored by the clone, never shared (#6560)",
				() =>
					withBackendScope(backend, async (scope) => {
						const database = await scope.connect();
						const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
						await enable(store);
						const parent = await SessionManager.create(store, CWD);
						const id = parent.getSessionId();
						const ids: string[] = [];
						for (let index = 0; index < 30; index++)
							ids.push(await parent.appendMessage({ role: "user", content: `turn ${index}`, timestamp: index }));
						const edited = parent.getEntry(ids[10]!) as SessionEntry & { message: { content: string } };
						edited.message.content = "edited in memory";

						const clone = (await parent.forkTo(CWD, store)).getSessionId();

						assert.deepEqual(await ownRows(database, scope.prefix, clone), [[11, ids[10]!]]);
						assert.deepEqual(await segments(database, scope.prefix, clone), [
							[id, 1, 10, 0],
							[id, 12, 30, 11],
						]);
						const view = (await store.load(clone)).entries;
						assert.equal((view[10] as typeof edited).message.content, "edited in memory");
						assert.equal(((await store.load(id)).entries[10] as typeof edited).message.content, "turn 10");
					}),
				SERVER_TIMEOUT_MS,
			);
		},
	);
}
