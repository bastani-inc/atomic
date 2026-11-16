import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { observeSqlPoolTransactions, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";

/**
 * A pooled child starts in a fresh worker, and the worker opens the pool's queue and its session store over the journal
 * every host shares (#4768). On a shared libSQL server every write transaction waits its turn for the database's one
 * write lock, and holds it for each of its round trips, so a pool whose tables exist opens with reads alone: the opens'
 * schema probes and their idempotent setup never queue another host's writes, or a fresh client's, behind them.
 */
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A journal in a libSQL database file, which the libSQL adapter opens as it opens a server's. */
async function sharedJournal(): Promise<RunJournal> {
	const directory = makeLibsqlDirectory("pool-open-locks-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const journal = await resolveRunJournal({
		agentDir: join(directory, "agent"),
		journal: { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" },
	});
	cleanups.push(() => journal.close());
	return journal;
}

/** Counts the write transactions and batches of `journal`'s pool from now on. */
function countWrites(journal: RunJournal): () => number {
	let writes = 0;
	observeSqlPoolTransactions(journal, () => {
		writes++;
	});
	return () => writes;
}

test("a worker opens the pool's session store without a write transaction once its tables exist (#4768)", async () => {
	const journal = await sharedJournal();
	// The first open creates the store's tables, under the write lock.
	const first = await openPoolSessions(sqlPoolStorage(journal)!);
	await first.close();

	const writes = countWrites(journal);
	const again = await openPoolSessions(sqlPoolStorage(journal)!);
	try {
		assert.equal(await again.readHeader("no-such-session"), undefined, "the store reads its tables");
	} finally {
		await again.close();
	}
	assert.equal(writes(), 0, "opening and reading the store took the write lock");
});

test("a worker opens the pool's queue without a write transaction once its tables exist (#4768)", async () => {
	const journal = await sharedJournal();
	// The first open creates the queue's tables, under the write lock.
	await openSqlPoolQueue(journal);

	const writes = countWrites(journal);
	const again = await openSqlPoolQueue(journal);
	assert.equal(await again.initialized("no-such-root"), false, "the queue reads its tables");
	assert.equal(writes(), 0, "opening and reading the queue took the write lock");
});
