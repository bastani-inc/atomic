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
 * The write's own latency, without other clients, is checked against a fake server in
 * test/unit/storage-libsql-abandoned-stream.test.ts.
 */

useTemporaryAgentDir();

const url = process.env.ATOMIC_TEST_LIBSQL_URL;
/**
 * How long sqld lets a transaction keep the write lock while another writer waits for it: after its `TXN_TIMEOUT` of
 * 5 s, counted from when the transaction took the lock, the waiting writer rolls the transaction back and takes the
 * lock. That is how sqld frees the lock of a stream its client lost, when nothing closes the stream.
 */
const SQLD_LOCK_RELEASE_MS = 5_000;
/** How long the outage lasts after the transaction failed. */
const OUTAGE_MS = 300;
/** Slack for timers and clocks. */
const MARGIN_MS = 500;
/**
 * How soon after the transaction's first statement asked for the lock the write after the outage must commit. sqld
 * takes the lock no sooner than that statement is sent and frees it itself `SQLD_LOCK_RELEASE_MS` after it took it, so
 * only the adapter's resent close lets the write commit sooner, however long the transaction ran before the outage. The
 * rest is left to the writes other clients of a shared sqld queued for the lock meanwhile, which sqld grants in turn
 * before this one.
 */
const SQLD_RECOVERY_BOUND_MS = SQLD_LOCK_RELEASE_MS - MARGIN_MS;

/** A request body, as the client sends it, that only closes a stream. */
const CLOSE_ONLY = /"requests":\[\{"type":"close"\}\]\}/g;

/**
 * Runs a transaction whose stream an outage cuts after its first statement took the write lock, and the write that
 * follows once the server is reachable again. Reports how long after the first statement was sent the write committed,
 * and in which order the client's closes and the write reached sqld between the outage and the commit. With `withholdCloses`, the proxy
 * resets every connection that carries a close instead, so none reaches sqld.
 */
async function cutAndWrite(withholdCloses: boolean) {
	const table = `abandoned_${randomBytes(6).toString("hex")}`;
	const write = `INSERT INTO ${table} VALUES (3)`;
	/** What reached sqld after the outage, in order. */
	const reached: ("close" | "write")[] = [];
	let restored = false;
	let withholding = withholdCloses;
	const counted = new Map<number, { closes: number; writes: number }>();
	const proxy = await startOutageProxy(new URL(url!), {
		inspect(connection, sent) {
			const before = counted.get(connection) ?? { closes: 0, writes: 0 };
			const now = { closes: sent.match(CLOSE_ONLY)?.length ?? 0, writes: sent.split(write).length - 1 };
			counted.set(connection, now);
			if (!restored) return true;
			if (withholding && now.closes > before.closes) return false;
			for (let close = before.closes; close < now.closes; close++) reached.push("close");
			for (let sentWrite = before.writes; sentWrite < now.writes; sentWrite++) reached.push("write");
			return true;
		},
	});
	const database = await openLibsqlDatabase({ url: proxy.url });
	try {
		await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
		let lockedAt = 0;
		await assert.rejects(
			database.transaction(async (tx) => {
				lockedAt = Date.now();
				await tx.run(`INSERT INTO ${table} VALUES (1)`);
				proxy.cut();
				await tx.run(`INSERT INTO ${table} VALUES (2)`);
			}),
			(error: unknown) => error instanceof StorageTransientError,
		);
		// The client's own close of the stream fails during the outage.
		await sleep(OUTAGE_MS);
		restored = true;
		proxy.restore();
		const restoredAt = Date.now();
		await database.run(write);
		const committedAt = Date.now();
		const reachedByCommit = [...reached];
		const rows = await database.all<{ n: number }>(`SELECT n FROM ${table} ORDER BY n`);
		return {
			sinceLock: committedAt - lockedAt,
			sinceRestore: committedAt - restoredAt,
			reached: reachedByCommit,
			rows: rows.map((row) => row.n),
		};
	} finally {
		withholding = false;
		proxy.restore();
		await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
		await database.close();
		await proxy.close();
	}
}

test.skipIf(url === undefined || url === "")(
	"against sqld, a stream cut while it holds the write lock is closed once the server is reachable, and the next write commits before sqld would free the lock itself (#5114)",
	async () => {
		const { sinceLock, sinceRestore, reached, rows } = await cutAndWrite(false);
		const close = reached.indexOf("close");
		assert.ok(
			close !== -1 && close < reached.indexOf("write"),
			`the client's close reached sqld before the write: ${reached.join(", ")}`,
		);
		assert.ok(
			sinceLock <= SQLD_RECOVERY_BOUND_MS,
			`the write committed ${sinceLock} ms after the transaction asked for the lock (${sinceRestore} ms after the outage)`,
		);
		assert.deepEqual(rows, [3], "the cut transaction rolled back and the write committed");
	},
	60_000,
);

test.skipIf(url === undefined || url === "")(
	"against sqld, when none of the client's closes reaches it, the write after the outage commits only once sqld frees the lock itself (#5114)",
	async () => {
		const { sinceLock, sinceRestore, reached, rows } = await cutAndWrite(true);
		assert.ok(!reached.includes("close"), `no close reached sqld: ${reached.join(", ")}`);
		assert.ok(
			sinceLock > SQLD_RECOVERY_BOUND_MS,
			`the write committed ${sinceLock} ms after the transaction asked for the lock (${sinceRestore} ms after the outage)`,
		);
		assert.deepEqual(rows, [3], "sqld rolled the cut transaction back when it freed the lock");
	},
	60_000,
);
