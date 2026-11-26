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

/**
 * The most round trips a whole-session clone within one store makes, whatever the session's length (#6560): the
 * transaction's start with the schema check, the child's absence with the source's locked row, the source's resume
 * index, one page of the source, the copy of every row and blob with its checks, and the commit.
 */
const CLONE_ROUND_TRIPS = 6;
/**
 * The most round trips a fork of given entries within one store makes, whatever their number (#6560): the start, the
 * child's absence with the source's locked row, the entries and blobs with their checks, and the commit.
 */
const FORK_ROUND_TRIPS = 4;

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });

/** A session of `length` entries, every tenth a tool output whose blob the session holds. */
async function session(store: SqlSessionStore, id: string, length: number): Promise<{ readonly hashes: string[] }> {
	const created = await store.create(header(id), []);
	const entries: SessionEntry[] = [];
	const hashes: string[] = [];
	for (let index = 0; index < length; index++) {
		const parentId = entries.at(-1)?.id ?? null;
		const timestamp = "2026-11-25T00:00:01.000Z";
		if (index % 10 === 9) {
			const blob = await store.putBlob(id, new TextEncoder().encode(`output ${index} of ${id}`));
			hashes.push(blob.hash);
			entries.push({
				type: "custom",
				id: `${id}-${index}`,
				parentId,
				timestamp,
				customType: "atomic.tool-output",
				data: { toolCallId: `call-${index}`, hash: blob.hash, bytes: blob.bytes },
			} as SessionEntry);
		} else
			entries.push({
				type: "message",
				id: `${id}-${index}`,
				parentId,
				timestamp,
				message: { role: "user", content: `message ${index} ${"y".repeat(200)}`, timestamp: 1 },
			} as SessionEntry);
	}
	await store.append(id, entries, { expectSeq: 0, epoch: created.epoch });
	return { hashes };
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL fork round trips (#6560)", () => {
	test("a whole-session clone within one store makes the same few round trips for 20 entries as for 400 (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				const counted: number[] = [];
				for (const length of [20, 400]) {
					const id = `s${length}`;
					await session(store, id, length);
					const head = await store.readEntrySizes(id, 1, 0);
					const trips = countRoundTrips();
					const created = await store.createFork(
						header(`c${length}`),
						completeSessionForkStream(id, head.epoch, head.lastSeq),
						{ store, sessionId: id, epoch: head.epoch, hashes: [], receipts: new Map() },
					);
					counted.push(trips.take());
					trips.restore();
					assert.equal(created?.lastSeq, length);
					assert.deepEqual(created?.remainingBlobs, []);
					assert.deepEqual(
						await store.load(`c${length}`).then(({ entries }) => entries),
						(await store.load(id)).entries,
					);
				}
				assert.equal(counted[0], counted[1], `round trips for 20 and 400 entries: ${counted.join(", ")}`);
				assert.ok(counted[1]! <= CLONE_ROUND_TRIPS, `${counted[1]} round trips`);
			} finally {
				await store.close();
			}
		});
	});

	test("a fork of given entries within one store makes the same few round trips for 20 entries as for 400 (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				const counted: number[] = [];
				for (const length of [20, 400]) {
					const id = `s${length}`;
					const { hashes } = await session(store, id, length);
					const loaded = await store.load(id);
					const trips = countRoundTrips();
					const created = await store.createFork(header(`c${length}`), loaded.entries, {
						store,
						sessionId: id,
						epoch: loaded.epoch,
						hashes,
						receipts: new Map(),
					});
					counted.push(trips.take());
					trips.restore();
					assert.equal(created?.lastSeq, length);
					assert.deepEqual(created?.remainingBlobs, []);
					const child = await store.load(`c${length}`);
					assert.deepEqual(child.entries, loaded.entries);
					for (const hash of hashes) assert.ok(await store.getBlob(`c${length}`, hash), `blob ${hash} copied`);
				}
				assert.equal(counted[0], counted[1], `round trips for 20 and 400 entries: ${counted.join(", ")}`);
				assert.ok(counted[1]! <= FORK_ROUND_TRIPS, `${counted[1]} round trips`);
			} finally {
				await store.close();
			}
		});
	});
});
