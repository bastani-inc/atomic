import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "vitest";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { startOutageProxy } from "../helpers/outage-proxy.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * An outage that cuts a stream holding the write lock, against a real libSQL server (#5114): the adapter sends the
 * stream's close again once sqld is reachable, which frees the lock at once. Runs when
 * `ATOMIC_TEST_LIBSQL_URL` names a sqld (see test/helpers/storage-backends.ts), as CI's storage conformance job sets.
 */

useTemporaryAgentDir();

const url = process.env.ATOMIC_TEST_LIBSQL_URL;
/**
 * How soon after the outage a write must commit: well under the 5 s sqld itself takes to free the lock of a stream its
 * client lost, so only the adapter's resent close can make it.
 */
const SQLD_RECOVERY_BOUND_MS = 2_000;
/** How long the outage lasts after the transaction failed. */
const OUTAGE_MS = 300;

test.skipIf(url === undefined || url === "")(
	"against sqld, a stream cut while it holds the write lock is closed once the server is reachable, and the next write commits before sqld would free the lock itself (#5114)",
	async () => {
		const proxy = await startOutageProxy(new URL(url!));
		const database = await openLibsqlDatabase({ url: proxy.url });
		const table = `abandoned_${randomBytes(6).toString("hex")}`;
		try {
			await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
			await assert.rejects(
				database.transaction(async (tx) => {
					await tx.run(`INSERT INTO ${table} VALUES (1)`);
					proxy.cut();
					await tx.run(`INSERT INTO ${table} VALUES (2)`);
				}),
				(error: unknown) => error instanceof StorageTransientError,
			);
			// The client's own close of the stream fails during the outage.
			await sleep(OUTAGE_MS);
			proxy.restore();
			const restoredAt = Date.now();
			await database.run(`INSERT INTO ${table} VALUES (3)`);
			const took = Date.now() - restoredAt;
			assert.ok(took <= SQLD_RECOVERY_BOUND_MS, `the write after the outage took ${took} ms`);
			const rows = await database.all<{ n: number }>(`SELECT n FROM ${table} ORDER BY n`);
			assert.deepEqual(
				rows.map((row) => row.n),
				[3],
			);
		} finally {
			proxy.restore();
			await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await database.close();
			await proxy.close();
		}
	},
	60_000,
);
