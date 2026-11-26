import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
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
				assert.equal((await store.enableSharedHistoryForks({ live: async () => false })).status, "enabled");
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

	test("the first load of a fork that shares its parent's history takes no more round trips than a session of the same length (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.enableSharedHistoryForks({ live: async () => false });
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
});
