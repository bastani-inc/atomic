import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { sessionForkTables } from "../../packages/coding-agent/src/core/storage/session/fork-schema.js";
import { forkView, withForkViews } from "../../packages/coding-agent/src/core/storage/session/fork-view.js";
import {
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";
import { gate, instrumented, within } from "./storage-conformance-matrix-fork-staging-helpers.js";

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

const header = (id: string, parent?: string) => ({
	id,
	version: 4 as const,
	cwd: "/work",
	createdAt: "2026-11-25T00:00:00.000Z",
	...(parent === undefined ? {} : { parentSessionId: parent }),
});

function entries(id: string, length: number): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (let index = 0; index < length; index++)
		out.push({
			type: "message",
			id: `${id}-${index}`,
			parentId: out.at(-1)?.id ?? null,
			timestamp: "2026-11-25T00:00:01.000Z",
			message: { role: "user", content: `message ${index} ${"y".repeat(200)}`, timestamp: 1 },
		} as SessionEntry);
	return out;
}

/** A clone of `parent`'s whole history, as `forkTo` makes one; `counted` runs around the fork alone. */
async function clone(store: SqlSessionStore, parent: string, child: string, counted?: () => void) {
	const head = await store.readEntrySizes(parent, 1, 0);
	counted?.();
	const created = await store.createFork(
		header(child, parent),
		completeSessionForkStream(parent, head.epoch, head.lastSeq),
		{ store, sessionId: parent, epoch: head.epoch, hashes: [], receipts: new Map() },
	);
	counted?.();
	assert.equal(created?.lastSeq, head.lastSeq);
	return created;
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL round trips of forks that share history (#6560)", () => {
	test("a fork that shares its parent's history takes the round trips of creating a session, at any length or depth (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				// A new store shares its forks' history from its first open.
				assert.equal((await store.enableSharedHistoryForks()).status, "already");
				const report: string[] = [];
				// What creating a session of one entry takes: the start with the schema check and the child's absence, then
				// the writes with the commit.
				const baseline = countRoundTrips();
				await store.create(header("one"), entries("one", 1));
				const created = baseline.take();
				baseline.restore();
				for (const length of [20, 400]) {
					const made = entries(`s${length}`, length);
					await store.create(header(`s${length}`), made);
					const trips = countRoundTrips();
					let forked = 0;
					await clone(store, `s${length}`, `c${length}`, () => {
						forked = trips.take();
					});
					// Forks of forks, the last of a fork no fork was made of before.
					await clone(store, `c${length}`, `cc${length}`);
					await clone(store, `c${length}`, `cc${length}b`);
					let deeper = 0;
					await clone(store, `cc${length}`, `ccc${length}`, () => {
						deeper = trips.take();
					});
					trips.restore();
					report.push(`${length}: create ${created}, fork ${forked}, fork of a fork ${deeper}`);
					assert.ok(forked <= created, report.join("; "));
					assert.ok(deeper <= created, report.join("; "));
					assert.deepEqual((await store.load(`ccc${length}`)).entries, made);
				}
				console.info(`round trips: ${report.join("; ")}`);
			} finally {
				await store.close();
			}
		});
	});

	test("a replace of a session forks read, and a fork of one of them, take no more round trips than before the replace locked its forks with the session (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				assert.equal((await store.enableSharedHistoryForks()).status, "already");
				await store.create(header("lone"), entries("lone", 20));
				await store.create(header("read"), entries("read", 20));
				await clone(store, "read", "reader");
				await store.create(header("x"), entries("x", 1));
				const trips = countRoundTrips();
				await store.replace("lone", header("lone"), entries("lone2", 2), { expectSeq: 20 });
				const lone = trips.take();
				await store.replace("read", header("read"), entries("read2", 2), { expectSeq: 20 });
				const read = trips.take();
				let forked = 0;
				await clone(store, "reader", "reader-fork", () => {
					forked = trips.take();
				});
				trips.restore();
				// Measured before the replace locked its forks with the session: 11, 29 and 2.
				const report = `replace without forks ${lone}, replace of a session a fork reads ${read}, fork of the reader ${forked}`;
				assert.ok(lone <= 11 && read <= 29 && forked <= 2, report);
			} finally {
				await store.close();
			}
		});
	});

	test("the first load of a fork that shares its parent's history takes no more round trips than a session of the same length (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				assert.equal((await store.enableSharedHistoryForks()).status, "already");
				const report: string[] = [];
				for (const length of [20, 2000]) {
					const made = entries(`p${length}`, length);
					await store.create(header(`p${length}`), made);
					await store.create(header(`own${length}`), made);
					await clone(store, `p${length}`, `f${length}`);
					// A reader that never read either: a store opened anew.
					const reader = await SqlSessionStore.open(await open());
					try {
						const trips = countRoundTrips();
						const own = await reader.load(`own${length}`);
						const ownTrips = trips.take();
						const forked = await reader.load(`f${length}`);
						const forkTrips = trips.take();
						const tail = await reader.readTail(`f${length}`, length - 5);
						const tailTrips = trips.take();
						await reader.readTail(`own${length}`, length - 5);
						const ownTailTrips = trips.take();
						trips.restore();
						report.push(
							`${length}: load own ${ownTrips}, shared ${forkTrips}; tail own ${ownTailTrips}, shared ${tailTrips}`,
						);
						assert.deepEqual(forked.entries, own.entries);
						assert.equal(tail.entries.length, 6);
						assert.ok(forkTrips <= ownTrips, report.join("; "));
						assert.ok(tailTrips <= ownTailTrips, report.join("; "));
					} finally {
						await reader.close();
					}
				}
				console.info(`round trips: ${report.join("; ")}`);
			} finally {
				await store.close();
			}
		});
	});
	test("a parent's append does not wait for a fork that shares its history, and the fork keeps the history it locked (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const held = gate();
			let armed = true;
			// The fork's transaction stops once it holds the parent's row locked, as it reads the parent's segments.
			const forking = await SqlSessionStore.open(
				instrumented(await open(), {
					pause: (sql, inTransaction) => {
						if (!armed || !inTransaction || !sql.includes("ORDER BY idx")) return undefined;
						armed = false;
						return held.wait();
					},
				}),
			);
			const appending = await SqlSessionStore.open(await open());
			try {
				assert.equal((await forking.enableSharedHistoryForks()).status, "already");
				const made = entries("p", 30);
				await forking.create(header("p"), made);
				const fork = clone(forking, "p", "c");
				await within(held.reached, "the fork locking the parent", 20_000);
				const more = entries("q", 5).map((entry, index) =>
					index === 0 ? ({ ...entry, parentId: made.at(-1)!.id } as SessionEntry) : entry,
				);
				await within(appending.append("p", more, { expectSeq: 30 }), "the parent's append", 10_000);
				held.release();
				await fork;
				assert.deepEqual((await forking.load("c")).entries, made, "the fork holds the parent as it locked it");
				assert.deepEqual((await appending.load("p")).entries, [...made, ...more]);
			} finally {
				held.release();
				await forking.close();
				await appending.close();
			}
		});
	});
	test("a fork fifty deep takes the round trips of creating a session, and its first load those of a session of its own (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.enableSharedHistoryForks({ live: async () => false });
				await store.create(header("one"), entries("one", 1));
				const made = entries("g", 400);
				await store.create(header("g0"), made);
				const trips = countRoundTrips();
				let deepest = 0;
				for (let depth = 1; depth <= 50; depth++) {
					await clone(store, `g${depth - 1}`, `g${depth}`, () => {
						deepest = trips.take();
					});
					const own = entries(`g${depth}`, 2).map((entry, index) =>
						index === 0 ? ({ ...entry, parentId: made.at(-1)!.id } as SessionEntry) : entry,
					);
					await store.append(`g${depth}`, own, { expectSeq: made.length });
					made.push(...own);
				}
				trips.take();
				await store.create(header("x"), entries("x", 1));
				const created = trips.take();
				await store.create(header("own"), made);
				const reader = await SqlSessionStore.open(await open());
				try {
					trips.take();
					const ownLoad = await reader.load("own");
					const ownTrips = trips.take();
					const forkLoad = await reader.load("g50");
					const forkTrips = trips.take();
					trips.restore();
					const report = `create ${created}, fork at depth 50 ${deepest}; load own ${ownTrips}, fork ${forkTrips}`;
					assert.deepEqual(forkLoad.entries, ownLoad.entries);
					assert.ok(deepest <= created, report);
					assert.ok(forkTrips <= ownTrips, report);
				} finally {
					await reader.close();
				}
			} finally {
				await store.close();
			}
		});
	});

	test("a fork's read finds its segments by session and each source's rows by key on PostgreSQL (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const database = await open();
			const store = await SqlSessionStore.open(database);
			try {
				await store.enableSharedHistoryForks({ live: async () => false });
				const made = entries("p", 3000);
				await store.create(header("p"), made);
				await clone(store, "p", "c");
				await store.append(
					"c",
					entries("c", 5).map((entry, index) =>
						index === 0 ? ({ ...entry, parentId: made.at(-1)!.id } as SessionEntry) : entry,
					),
					{ expectSeq: 3000 },
				);
				await clone(store, "c", "cc");
				// Many sessions' segments, as a store that has made many forks holds: one fork's, made by the store, copied to
				// 999 more sessions in one statement. Making each by a fork took 6,000 round trips, which a loaded machine could
				// not fit in the test's time.
				await clone(store, "c", "k0");
				const segments = sessionForkTables().forkSegments;
				await database.run(
					`INSERT INTO ${segments} (session_id, idx, source_id, from_seq, to_seq, base_seq)
					SELECT 'k' || g, idx, source_id, from_seq, to_seq, base_seq FROM ${segments}, generate_series(1, 999) AS g
					WHERE session_id = ?`,
					"k0",
				);
				assert.equal(
					Number(
						(await database.get<{ n: number }>(`SELECT count(DISTINCT session_id) AS n FROM ${segments}`))?.n,
					),
					1002,
				);
				await database.run("ANALYZE");
				const view = forkView(
					{ segments: sessionForkTables().forkSegments, dialect: dialectOf(database) },
					{
						name: "v",
						table: renderStorageIdentifiers("sessions", SESSION_TABLES).entries,
						columns: ["entry_id", "entry_json", "chunks"],
						sessionId: "cc",
						after: 2990,
						through: 3005,
					},
				);
				const plan = (
					await database.all(
						`EXPLAIN ${withForkViews([view], "SELECT seq, entry_json FROM v ORDER BY seq")}`,
						...view.params,
					)
				)
					.map((row) => String(Object.values(row)[0]))
					.join("\n");
				assert.match(plan, /Index[^\n]* on session_fork_segments/, plan);
				assert.match(plan, /Index[^\n]* on session_entries/, plan);
				assert.doesNotMatch(plan, /Seq Scan on session_entries/, plan);
			} finally {
				await store.close();
			}
		});
	});
});
