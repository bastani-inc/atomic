import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, vi } from "vitest";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { startOutageProxy } from "../helpers/outage-proxy.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Statements outside a transaction reuse one Hrana stream against a real libSQL server (#5151), through its expiry and
 * through an outage. Runs when `ATOMIC_TEST_LIBSQL_URL` names a sqld (see test/helpers/storage-backends.ts), as CI's
 * storage conformance job sets.
 */

useTemporaryAgentDir();

const url = process.env.ATOMIC_TEST_LIBSQL_URL;
const withSqld = test.skipIf(url === undefined || url === "");
/** sqld expires a stream idle this long; waiting past it proves a statement meets a stream the server expired. */
const SQLD_STREAM_EXPIRY_MS = 10_000;

/** Counts the pipeline requests sent and those that continue a stream, by the baton their bodies carry. */
function countRequests(): { sent: number; continued: number } {
	const counts = { sent: 0, continued: 0 };
	const real = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.method === "POST" && /\/pipeline$/.test(new URL(request.url).pathname)) {
			counts.sent++;
			if (/"baton":"/.test(await request.clone().text())) counts.continued++;
		}
		return real(request);
	});
	return counts;
}

withSqld("against sqld, statements outside a transaction continue one stream (#5151)", async () => {
	const counts = countRequests();
	const database = await openLibsqlDatabase({ url: url! });
	const table = `reuse_${randomBytes(6).toString("hex")}`;
	try {
		await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
		const before = { ...counts };
		for (let n = 0; n < 20; n++) {
			await database.run(`INSERT INTO ${table} VALUES (?)`, n);
			await database.get(`SELECT COUNT(*) AS count FROM ${table}`);
		}
		assert.equal(counts.sent - before.sent, 40, "one request per statement");
		assert.equal(counts.continued - before.continued, 39, "every statement after the first continued its stream");
		const row = await database.get<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`);
		assert.equal(Number(row?.count), 20);
	} finally {
		await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
		await database.close();
		vi.unstubAllGlobals();
	}
});

withSqld(
	"against sqld, a write on a stream the server expired runs once on a new stream (#5151)",
	async () => {
		const database = await openLibsqlDatabase({ url: url! });
		const table = `expired_${randomBytes(6).toString("hex")}`;
		try {
			await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
			await database.run(`INSERT INTO ${table} VALUES (1)`);
			// Hold the adapter's clock so its own idle bound does not replace the stream first: the write then meets
			// the stream sqld expired.
			const now = performance.now();
			vi.spyOn(performance, "now").mockImplementation(() => now);
			await sleep(SQLD_STREAM_EXPIRY_MS + 2_000);
			await database.run(`INSERT INTO ${table} VALUES (2)`);
			vi.restoreAllMocks();
			const rows = await database.all<{ n: bigint }>(`SELECT n FROM ${table} ORDER BY n`);
			assert.deepEqual(
				rows.map((row) => Number(row.n)),
				[1, 2],
			);
		} finally {
			vi.restoreAllMocks();
			await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await database.close();
		}
	},
	30_000,
);

withSqld(
	"against sqld, a write on the reused stream cut by an outage is not sent again, and the next write after it commits once (#5151)",
	async () => {
		const proxy = await startOutageProxy(new URL(url!));
		const database = await openLibsqlDatabase({ url: proxy.url });
		const direct = await openLibsqlDatabase({ url: url! });
		const table = `outage_${randomBytes(6).toString("hex")}`;
		try {
			await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
			await database.run(`INSERT INTO ${table} VALUES (1)`);
			proxy.cut();
			await assert.rejects(database.run(`INSERT INTO ${table} VALUES (2)`), StorageTransientError);
			await assert.rejects(database.get(`SELECT COUNT(*) AS count FROM ${table}`), StorageTransientError);
			proxy.restore();
			await database.run(`INSERT INTO ${table} VALUES (3)`);
			const rows = await direct.all<{ n: bigint }>(`SELECT n FROM ${table} ORDER BY n`);
			const values = rows.map((row) => Number(row.n));
			// The cut write either reached sqld before the cut or never did: at most once, never twice.
			assert.ok(
				JSON.stringify(values) === "[1,3]" || JSON.stringify(values) === "[1,2,3]",
				`rows after the outage: ${JSON.stringify(values)}`,
			);
		} finally {
			proxy.restore();
			await direct.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await direct.close();
			await database.close();
			await proxy.close();
		}
	},
	60_000,
);
