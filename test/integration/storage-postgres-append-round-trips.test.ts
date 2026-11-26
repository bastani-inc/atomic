import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SessionConflictError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";

/** Counts the round trips to the server until the test ends. */
function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
function message(id: string, text: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-25T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL session append round trips (#6560)", () => {
	test("an append to a session costs two round trips, not seven or more: the locks with the checks, then the writes with the commit (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const store = await SqlSessionStore.open(database);
			try {
				const created = await store.create(header("s1"), []);
				const trips = countRoundTrips();
				const first = message("m1", "first", null);
				const appended = await store.append("s1", [first], { expectSeq: created.lastSeq, epoch: created.epoch });
				const appendTrips = trips.take();
				await store.append("s1", [message("m2", "second", first.id), message("m3", "third", first.id)], {
					expectSeq: appended.lastSeq,
					epoch: created.epoch,
				});
				const twoEntryTrips = trips.take();
				assert.equal(appendTrips, 2);
				assert.equal(twoEntryTrips, 2);
				assert.deepEqual(
					(await store.load("s1")).entries.map((entry) => entry.id),
					["m1", "m2", "m3"],
				);
			} finally {
				await store.close();
			}
		});
	});

	test("appends racing on separate connections with one expected seq: one commits, the rest conflict, seqs stay dense (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const stores = await Promise.all([0, 1, 2, 3].map(async () => SqlSessionStore.open(await open())));
			try {
				const created = await stores[0]!.create(header("s1"), []);
				const outcomes = await Promise.allSettled(
					stores.map((store, index) =>
						store.append("s1", [message(`m${index}`, `racer ${index}`, null)], {
							expectSeq: created.lastSeq,
							epoch: created.epoch,
						}),
					),
				);
				assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
				for (const outcome of outcomes)
					if (outcome.status === "rejected")
						assert.ok(outcome.reason instanceof SessionConflictError, String(outcome.reason));
				const loaded = await stores[1]!.load("s1");
				assert.equal(loaded.entries.length, 1);
				assert.equal(loaded.lastSeq, 1);
			} finally {
				await Promise.all(stores.map((store) => store.close()));
			}
		});
	});

	test("a write sent with the commit that the server refuses commits nothing and fails with its own error (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const store = await SqlSessionStore.open(database);
			try {
				const created = await store.create(header("s1"), []);
				// A row in the way of the append's first entry, as no Atomic writer leaves one.
				await database.run(
					"INSERT INTO session_entries (session_id, seq, entry_id, entry_json, chunks) VALUES (?, ?, ?, ?, ?)",
					"s1",
					1,
					"in-the-way",
					"{}",
					0,
				);
				const failure = await store
					.append("s1", [message("m1", "first", null)], { expectSeq: created.lastSeq, epoch: created.epoch })
					.then(
						() => undefined,
						(error: Error) => error,
					);
				assert.ok(failure, "the append committed");
				assert.match(causes(failure).join("\n"), /duplicate key/);
				const row = await database.get<{ last_seq: number }>(
					"SELECT last_seq FROM session_sessions WHERE id = ?",
					"s1",
				);
				assert.equal(row?.last_seq, 0);
				const searchTexts = await database.get<{ count: number }>(
					"SELECT count(*)::int AS count FROM session_search_texts WHERE session_id = ?",
					"s1",
				);
				assert.equal(searchTexts?.count, 0);
			} finally {
				await store.close();
			}
		});
	});
});

/** `count` messages, each the child of the one before. */
function thread(count: number, prefix = "m"): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= count; i++)
		entries.push(message(`${prefix}${i}`, `entry ${i}`, i === 1 ? null : `${prefix}${i - 1}`));
	return entries;
}

/** A fork stream of `entries`, as a session forked from its whole transcript passes them. */
function streamOf(entries: readonly SessionEntry[]) {
	return {
		kind: "complete-session" as const,
		async *read() {
			for (const entry of entries) yield { entry };
		},
	};
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL session create and fork round trips (#6560)", () => {
	test("creating a session with 40 entries, or forking one, sends the entries together: a few round trips, not one per entry", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				const entries = thread(40);
				const trips = countRoundTrips();
				const created = await store.create(header("s1"), entries);
				const createTrips = trips.take();
				const forked = await store.createFork({ ...header("c1"), parentSessionId: "s1" }, streamOf(entries), {
					store,
					sessionId: "s1",
					epoch: created.epoch,
					hashes: [],
					receipts: new Map(),
				});
				const forkTrips = trips.take();
				assert.ok(createTrips <= 4, `create took ${createTrips} round trips`);
				assert.ok(forkTrips <= 12, `fork took ${forkTrips} round trips`);
				assert.equal(forked?.lastSeq, 40);
				assert.deepEqual(
					(await store.load("c1")).entries.map((entry) => entry.id),
					entries.map((entry) => entry.id),
				);
			} finally {
				await store.close();
			}
		});
	});

	test("an entry of a fork that the server refuses fails the fork with its own error and leaves no child", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const store = await SqlSessionStore.open(database);
			try {
				const entries = thread(20);
				const created = await store.create(header("s1"), entries);
				// A row in the way of the child's tenth entry, as no Atomic writer leaves one.
				await database.run(
					"INSERT INTO session_entries (session_id, seq, entry_id, entry_json, chunks) VALUES (?, ?, ?, ?, ?)",
					"c1",
					10,
					"in-the-way",
					"{}",
					0,
				);
				const failure = await store
					.createFork({ ...header("c1"), parentSessionId: "s1" }, streamOf(entries), {
						store,
						sessionId: "s1",
						epoch: created.epoch,
						hashes: [],
						receipts: new Map(),
					})
					.then(
						() => undefined,
						(error: Error) => error,
					);
				assert.ok(failure, "the fork committed");
				assert.match(causes(failure).join("\n"), /duplicate key/);
				assert.equal(await store.readHeader("c1"), undefined);
				const rows = await database.get<{ count: number }>(
					"SELECT count(*)::int AS count FROM session_entries WHERE session_id = ?",
					"c1",
				);
				assert.equal(rows?.count, 1);
			} finally {
				await store.close();
			}
		});
	});
});

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL leading reads (#6560)", () => {
	test("a leading read the server refused aborts the transaction, which runs again even when the callback made no call", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const holder = await open();
			const worker = await open();
			await holder.exec("CREATE TABLE leading_rows (id integer PRIMARY KEY)");
			await holder.run("INSERT INTO leading_rows (id) VALUES (?)", 1);
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let locked!: () => void;
			const rowLocked = new Promise<void>((resolve) => {
				locked = resolve;
			});
			const holding = holder.transaction(
				async (tx) => {
					await tx.all("SELECT id FROM leading_rows WHERE id = ? FOR UPDATE", 1);
					locked();
					await released;
				},
				{ concurrency: { kind: "serial", domain: "leading-holder" } },
			);
			await rowLocked;
			let runs = 0;
			const answer = await worker.transaction(
				async () => {
					runs += 1;
					// The first run's leading read waits for the held row until its lock wait ends; the row is free after it.
					if (runs === 1) release();
					return runs;
				},
				{
					retryTransientFailures: true,
					concurrency: { kind: "serial", domain: "leading-worker" },
					lockWaitMs: 200,
					leading: [{ sql: "SELECT id FROM leading_rows WHERE id = ? FOR UPDATE", params: [1] }],
				},
			);
			await holding;
			assert.ok(answer >= 2, `the transaction ran ${answer} time(s)`);
		});
	});
});

/** The messages of `error` and its causes. */
function causes(error: unknown): string[] {
	const messages: string[] = [];
	for (let current = error; current instanceof Error; current = current.cause) messages.push(current.message);
	return messages;
}
