import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { completeSessionForkStream } from "../../packages/coding-agent/src/core/storage/session/branch-fork-source.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { countingDatabase } from "../helpers/counting-database.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { countRoundTrips } from "../helpers/postgres-round-trips.js";

/**
 * What detaching a parent's shared-history forks costs (#6560): the parent's rows are copied into one fork, linked in
 * the snapshot index a statement a piece, and the other fork is moved onto that copy. The links are checked in the
 * request that writes each fork's segments, so the statements and round trips do not grow with the rows copied.
 */

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });

function entries(id: string, length: number): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (let index = 0; index < length; index++)
		out.push({
			type: "message",
			id: `${id}-${index}`,
			parentId: out.at(-1)?.id ?? null,
			timestamp: "2026-11-25T00:00:01.000Z",
			message: { role: "user", content: `message ${index}`, timestamp: 1 },
		} as SessionEntry);
	return out;
}

/** Parent `p` with `length` entries and two forks of its whole history, each with an entry of its own. */
async function parentWithForks(store: SqlSessionStore, length: number): Promise<void> {
	const made = entries("p", length);
	await store.create(header("p"), made);
	for (const child of ["f1", "f2"]) {
		const head = await store.readEntrySizes("p", 1, 0);
		const created = await store.createFork(header(child), completeSessionForkStream("p", head.epoch, head.lastSeq), {
			store,
			sessionId: "p",
			epoch: head.epoch,
			hashes: [],
			receipts: new Map(),
		});
		assert.equal(created?.lastSeq, length);
		await store.append(child, [{ ...entries(`${child}-own`, 1)[0]!, parentId: made.at(-1)!.id } as SessionEntry], {
			expectSeq: length,
		});
	}
}

/** The detach of `p`'s forks: one copies `p`'s rows, the other moves onto that copy. */
async function detach(store: SqlSessionStore): Promise<void> {
	const report = await store.detachForks("p");
	assert.deepEqual([...report.detached, ...report.reparented].sort(), ["f1", "f2"]);
}

describe("detaching a parent's shared-history forks (#6560)", () => {
	test("on SQLite, runs the same 43 statements whether the parent has 200 or 1,000 entries", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-fork-detach-counts-"));
		try {
			const counts: number[] = [];
			for (const length of [200, 1000]) {
				const counted = countingDatabase(await openNodeSqliteDatabase(join(directory, `${length}.sqlite`)));
				const store = await SqlSessionStore.open(counted.wrapped);
				try {
					await parentWithForks(store, length);
					counted.statements.length = 0;
					await detach(store);
					counts.push(counted.statements.length);
				} finally {
					await store.close();
					await counted.wrapped.close();
				}
			}
			assert.deepEqual(counts, [43, 43]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.skipIf(postgresSkipReason !== undefined)(
		"on PostgreSQL, takes the same 51 round trips whether the parent has 200 or 1,000 entries",
		async () => {
			const counts: number[] = [];
			for (const length of [200, 1000])
				await withPostgresDatabase(async ({ open }) => {
					const database: SqliteDatabase = await open();
					const store = await SqlSessionStore.open(database);
					try {
						await parentWithForks(store, length);
						const trips = countRoundTrips();
						restores.push(trips.restore);
						await detach(store);
						counts.push(trips.take());
					} finally {
						await store.close();
					}
				});
			assert.deepEqual(counts, [51, 51]);
		},
	);
});
