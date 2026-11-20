import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { ensureForkStagingTable } from "../../packages/coding-agent/src/core/storage/session/fork-staging.js";
import { FORK_STAGING_CLEANUP_ROWS } from "../../packages/coding-agent/src/core/storage/session/fork-staging-maintenance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * #5594: an idle open of a local session database sweeps a bounded share of an abandoned clone's staging rows. It
 * still does once another process has held the database's write lock and a writer here waited for it.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("an idle open sweeps an abandoned clone's staging rows after another process held the database's lock", async () => {
	const directory = makeTempDirectory("fork-staging-contention-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "sessions.sqlite");
	const prefix = "s_";
	const table = renderStorageIdentifiers("sessions", { forkStaging: "fork_staging" }, prefix).forkStaging;
	const database = await openNodeSqliteDatabase(path, { lockWaitMs: 200 });
	cleanups.push(() => database.close());
	await (await SqlSessionStore.open(database, { prefix })).close();
	await ensureForkStagingTable(database, dialectOf(database), table);
	const rows = 2 * FORK_STAGING_CLEANUP_ROWS;
	await database.transaction(async (tx) => {
		await tx.run(
			`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES ('stopped', 0, 0, 0, 'child', 0, 'token')`,
		);
		for (let seq = 1; seq <= rows; seq++)
			await tx.run(
				`INSERT INTO ${table} (transfer_id, kind, seq, idx, name, size, body) VALUES ('stopped', 1, ?, 0, ?, 0, '{}')`,
				seq,
				`e${seq}`,
			);
	});
	// Another process holds the write lock; a write here waits for it, and gives up.
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	await assert.rejects(database.transaction((tx) => tx.run(`DELETE FROM ${table} WHERE transfer_id = 'none'`)));
	other.exec("ROLLBACK");
	other.close();
	const left = async () => Number((await database.get(`SELECT count(*) AS n FROM ${table}`))!.n);
	const before = await left();
	await (await SqlSessionStore.open(database, { prefix })).close();
	assert.ok((await left()) < before, `an idle open swept nothing: ${await left()} of ${before} rows left`);
});
