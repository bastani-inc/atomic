/**
 * PostgreSQL search-index writes (history searches indexing a session) run beside saves to the session: they take a
 * lock of the session's index, not the session's. A rewrite of the session (`replace`) takes the index's lock too and
 * `delete` the whole database's, so no index write leaves rows for content that is gone, and two index writes of one
 * session take turns.
 *
 * Each test holds an index write open part way: another connection keeps the search rows table locked in SHARE mode,
 * so the write's INSERT waits there with its locks held, until the test lets it go.
 */
import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

const PREFIX = "sil_";
const FORMAT = 1;
const ENTRIES = 6;
const TEST_TIMEOUT_MS = 120_000;
const HEADER: SessionRecordHeader = {
	id: "s",
	version: SESSION_FORMAT_VERSION,
	createdAt: "2026-11-26T00:00:00.000Z",
	cwd: "/p",
};

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-26T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

const oldTexts = Array.from({ length: ENTRIES }, (_, index) => `original entry ${index + 1} kestrel`);
const newTexts = Array.from({ length: ENTRIES }, (_, index) => `rewritten entry ${index + 1} heron`);
const asSearchTexts = (texts: readonly string[]) => texts.map((text, index) => ({ seq: index + 1, text }));

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Whether `promise` has settled, as a function to poll. */
function settled(promise: Promise<unknown>): () => boolean {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	return () => done;
}

/** Settles to "pending" when `promise` has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = new Promise<"pending">((resolve) => {
		timer = setTimeout(() => resolve("pending"), ms);
	});
	try {
		return await Promise.race([promise, pending]);
	} finally {
		clearTimeout(timer);
	}
}

interface Fixture {
	readonly store: SqlSessionStore;
	/** A store on a pool of its own, as another process has. */
	readonly other: SqlSessionStore;
	readonly admin: SqliteDatabase;
	/** Holds the search rows table in SHARE mode until the returned function is called. */
	blockIndexWrites(): Promise<() => Promise<void>>;
	/** How many sessions wait for a lock of `kind` ("advisory", or "relation" for a table lock). */
	waiting(kind: "advisory" | "relation"): Promise<number>;
	/** The search rows, and how many belong to no state row. */
	searchRows(): Promise<{ rows: number; orphans: number }>;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
	await withPostgresDatabase(async (scope: PostgresScope) => {
		const database = await scope.open();
		const store = await SqlSessionStore.open(database, { prefix: PREFIX });
		await store.create(
			HEADER,
			oldTexts.map((text, index) => message(`e${index + 1}`, text)),
		);
		// Pools of their own, so the open transaction holds none of the store's connections, and the checks queue behind
		// nothing.
		const locker = await scope.open({ maxConnections: 2, readerMaxConnections: 0 });
		const admin = await scope.open({ maxConnections: 3, readerMaxConnections: 0 });
		const other = await SqlSessionStore.open(await scope.open({ maxConnections: 4 }), { prefix: PREFIX });
		const releases: (() => Promise<void>)[] = [];
		const fixture: Fixture = {
			store,
			other,
			admin,
			async blockIndexWrites() {
				let release!: () => void;
				const released = new Promise<void>((resolve) => {
					release = resolve;
				});
				let locked!: () => void;
				const isLocked = new Promise<void>((resolve) => {
					locked = resolve;
				});
				const holding = locker.transaction(
					async (tx) => {
						await tx.exec(`LOCK TABLE ${PREFIX}session_search_entries IN SHARE MODE`);
						locked();
						await released;
					},
					{ concurrency: { kind: "serial", domain: "test-table-lock" } },
				);
				await isLocked;
				const done = async () => {
					release();
					await holding;
				};
				releases.push(done);
				return done;
			},
			async waiting(kind) {
				const row = await admin.get<{ waiting: number | bigint }>(
					"SELECT count(*) AS waiting FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE d.datname = current_database() AND NOT l.granted AND l.locktype = ?",
					kind,
				);
				return Number(row?.waiting);
			},
			async searchRows() {
				const row = await admin.get<{ rows: number | bigint; orphans: number | bigint }>(
					`SELECT count(*) AS rows, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ${PREFIX}session_search_state st WHERE st.sid = e.sid)) AS orphans FROM ${PREFIX}session_search_entries e`,
				);
				return { rows: Number(row?.rows), orphans: Number(row?.orphans) };
			},
		};
		try {
			await body(fixture);
		} finally {
			await Promise.all(releases.map((done) => done()));
			await store.close();
			await other.close();
		}
	});
}

/** Starts indexing the whole session from its coverage, as a history search does. */
async function startIndexing(store: SqlSessionStore, texts: readonly string[]): Promise<boolean> {
	const index = store.searchIndex;
	assert.ok(index, "the store keeps a search index");
	const coverage = await index.coverage(HEADER.id, FORMAT);
	assert.ok(coverage);
	const { generation, revision } = coverage as unknown as { generation: string; revision: string };
	return index.extend(HEADER.id, FORMAT, coverage.indexedSeq, ENTRIES, asSearchTexts(texts), { generation, revision });
}

async function found(store: SqlSessionStore, literal: string): Promise<readonly number[] | undefined> {
	return store.searchIndex?.candidates(HEADER.id, [[literal]], 1, ENTRIES, 10);
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL search-index writes and session writes", () => {
	it(
		"a save to the session goes through while an index write of it is open",
		async () => {
			await withFixture(async ({ store, blockIndexWrites, waiting }) => {
				const release = await blockIndexWrites();
				const indexing = startIndexing(store, oldTexts);
				await waitFor("the index write waits", async () => (await waiting("relation")) > 0);
				const saved = await within(
					store.append(HEADER.id, [message("e7", "saved while indexing")], { expectSeq: ENTRIES }),
					10_000,
				);
				assert.notEqual(saved, "pending", "the save did not wait for the index write");
				assert.equal((saved as { lastSeq: number }).lastSeq, ENTRIES + 1);
				await release();
				assert.equal(await indexing, true);
				assert.deepEqual(await found(store, "kestrel"), [1, 2, 3, 4, 5, 6]);
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a rewrite waits for an open index write, then forgets everything it wrote",
		async () => {
			await withFixture(async ({ store, other, blockIndexWrites, waiting, searchRows }) => {
				const release = await blockIndexWrites();
				const indexing = startIndexing(store, oldTexts);
				await waitFor("the index write waits", async () => (await waiting("relation")) > 0);
				const rewriting = other.replace(
					HEADER.id,
					HEADER,
					newTexts.map((text, index) => message(`n${index + 1}`, text)),
					{ expectSeq: ENTRIES },
				);
				// Without the index's lock it would not wait, and would leave the index write's rows behind.
				const rewritten = settled(rewriting);
				await waitFor(
					"the rewrite waits for the index's lock",
					async () => rewritten() || (await waiting("advisory")) > 0,
				);
				await release();
				assert.equal(await indexing, true, "the index write committed first");
				await rewriting;
				assert.deepEqual(await searchRows(), { rows: 0, orphans: 0 }, "the rewrite forgot the index write's rows");
				assert.deepEqual(await found(store, "kestrel"), [], "no search finds the old content");
				assert.equal(await startIndexing(store, newTexts), true);
				assert.deepEqual(await found(store, "heron"), [1, 2, 3, 4, 5, 6]);
				assert.deepEqual(await found(store, "kestrel"), []);
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"an index write that starts during a rewrite waits for it, then writes nothing for the old content",
		async () => {
			await withFixture(async ({ store, other, blockIndexWrites, waiting, searchRows }) => {
				// Indexed once, so the rewrite has rows to forget: its DELETE then waits on the table lock, holding the
				// index's lock.
				assert.equal(await startIndexing(store, oldTexts.slice(0, ENTRIES)), true);
				const index = store.searchIndex!;
				const coverage = await index.coverage(HEADER.id, FORMAT);
				const { generation } = coverage as unknown as { generation: string };
				await store.append(HEADER.id, [message("e7", "one more kestrel")], { expectSeq: ENTRIES });
				const release = await blockIndexWrites();
				const rewriting = other.replace(
					HEADER.id,
					HEADER,
					newTexts.map((text, index) => message(`n${index + 1}`, text)),
					{ expectSeq: ENTRIES + 1 },
				);
				await waitFor("the rewrite waits", async () => (await waiting("relation")) > 0);
				const indexing = index.extend(
					HEADER.id,
					FORMAT,
					ENTRIES,
					ENTRIES + 1,
					[{ seq: 7, text: "one more kestrel" }],
					{
						generation,
					},
				);
				const written = settled(indexing);
				// Without the index's lock it would go on to wait on the table, as the rewrite does, and then leave rows of
				// the old content behind.
				await waitFor(
					"the index write waits for the index's lock",
					async () => written() || (await waiting("advisory")) > 0 || (await waiting("relation")) > 1,
				);
				await release();
				await rewriting;
				assert.equal(await indexing, false, "the index write saw the rewrite");
				assert.deepEqual(await searchRows(), { rows: 0, orphans: 0 });
				assert.deepEqual(await found(store, "kestrel"), []);
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a delete waits for an open index write, then removes everything it wrote",
		async () => {
			await withFixture(async ({ store, other, blockIndexWrites, waiting, searchRows }) => {
				const release = await blockIndexWrites();
				const indexing = startIndexing(store, oldTexts);
				await waitFor("the index write waits", async () => (await waiting("relation")) > 0);
				const deleting = other.delete(HEADER.id);
				await waitFor("the delete waits for the database's lock", async () => (await waiting("advisory")) > 0);
				await release();
				assert.equal(await indexing, true);
				await deleting;
				assert.deepEqual(await searchRows(), { rows: 0, orphans: 0 });
				const state = await store.searchIndex?.coverage(HEADER.id, FORMAT);
				assert.equal(state, undefined, "the session is gone");
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"two index writes of one session take turns, and only the first applies",
		async () => {
			await withFixture(async ({ store, other, blockIndexWrites, waiting, searchRows }) => {
				const release = await blockIndexWrites();
				const first = startIndexing(store, oldTexts);
				await waitFor("the first index write waits", async () => (await waiting("relation")) > 0);
				const second = startIndexing(other, oldTexts);
				await waitFor("the second waits for the index's lock", async () => (await waiting("advisory")) > 0);
				await release();
				assert.deepEqual(await Promise.all([first, second]), [true, false]);
				assert.deepEqual(await searchRows(), { rows: ENTRIES, orphans: 0 });
				assert.deepEqual(await found(store, "kestrel"), [1, 2, 3, 4, 5, 6]);
			});
		},
		TEST_TIMEOUT_MS,
	);
});
