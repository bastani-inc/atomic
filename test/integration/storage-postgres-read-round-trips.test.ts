import assert from "node:assert/strict";
import pg from "pg";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";
import { sleep } from "../helpers/runtime.js";

/** Long enough for a local server to answer a read's commit, which the read itself does not wait for. */
const COMMIT_SETTLE_MS = 200;

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Counts the round trips to the server until the test ends. */
function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

/** Counts the connections opened to the server until the test ends. */
function countConnections() {
	const connect = pg.Client.prototype.connect;
	let opened = 0;
	pg.Client.prototype.connect = function (this: pg.Client, ...args: unknown[]) {
		opened += 1;
		return Reflect.apply(connect, this, args);
	} as pg.Client["connect"];
	restores.push(() => {
		pg.Client.prototype.connect = connect;
	});
	return {
		take() {
			const counted = opened;
			opened = 0;
			return counted;
		},
	};
}

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
function thread(count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= count; i++)
		entries.push({
			type: "message",
			id: `m${i}`,
			parentId: i === 1 ? null : `m${i - 1}`,
			timestamp: "2026-11-25T00:00:01.000Z",
			message: { role: "user", content: `entry ${i}`, timestamp: 1 },
		} as SessionEntry);
	return entries;
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL session read round trips (#6560)", () => {
	test("reads made one after another reuse the reader connection: a read's commit does not hold it, so none opens another", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.create(header("s1"), thread(12));
				// The first read opens the reader's connection.
				await store.load("s1");
				const connections = countConnections();
				for (let read = 0; read < 4; read++) {
					assert.equal((await store.load("s1")).entries.length, 12);
					assert.equal((await store.readTail("s1", 10)).entries.length, 3);
				}
				// Each read went on as soon as its rows came; its connection waited one more round trip for the commit's answer,
				// so the next read found it busy and opened a connection of its own.
				assert.equal(connections.take(), 0);
			} finally {
				await store.close();
			}
		});
	});

	test("the tail and the resume of a session whose index is current cost no round trip before their transaction", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.create(header("s1"), thread(12));
				await store.readResume("s1");
				await store.readTail("s1", 10);
				// Each read's commit goes out behind its reads, and its answer comes after the read returned: the reads are
				// counted apart, once the commit before them was answered.
				await sleep(COMMIT_SETTLE_MS);
				const trips = countRoundTrips();
				const tail = await store.readTail("s1", 10);
				await sleep(COMMIT_SETTLE_MS);
				const tailTrips = trips.take();
				const resume = await store.readResume("s1");
				await sleep(COMMIT_SETTLE_MS);
				const resumeTrips = trips.take();
				assert.deepEqual(
					tail.entries.map((entry) => entry.id),
					["m10", "m11", "m12"],
				);
				assert.equal(resume.leafId, "m12");
				// The start with the schema check and the session's row, then the entries the row's index names, then the commit
				// the read does not wait for. Five and six before: the row was read once before the transaction too, on its own,
				// and the tail's state, the resume's branch and its leaf each waited for the read before them.
				assert.equal(tailTrips, 3);
				assert.equal(resumeTrips, 3);
			} finally {
				await store.close();
			}
		});
	});

	test("a page of entries costs one round trip with the session's watermark, not two", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			try {
				await store.create(header("s1"), thread(12));
				const trips = countRoundTrips();
				const page = await store.readEntryRange("s1", { fromSeq: 3, toSeq: Number.POSITIVE_INFINITY });
				assert.equal(trips.take(), 1);
				assert.equal(page.lastSeq, 12);
				assert.equal(page.throughSeq, 12);
				assert.equal(page.entries.length, 10);
				const past = await store.readEntryRange("s1", { fromSeq: 20, toSeq: 30 });
				assert.deepEqual(past, { lastSeq: 12, entries: [], throughSeq: 19 });
				await assert.rejects(store.readEntryRange("missing", { fromSeq: 1, toSeq: 2 }), /missing/);
			} finally {
				await store.close();
			}
		});
	});
});
