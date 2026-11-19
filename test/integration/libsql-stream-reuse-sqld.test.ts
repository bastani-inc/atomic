import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test, vi } from "vitest";
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
afterEach(() => {
	vi.unstubAllGlobals();
});

const url = process.env.ATOMIC_TEST_LIBSQL_URL;
const withSqld = test.skipIf(url === undefined || url === "");
/** sqld expires a stream idle this long; waiting past it proves a statement meets a stream the server expired. */
const SQLD_STREAM_EXPIRY_MS = 10_000;

/**
 * The code a pipeline answer failed its last request, the statement, with, if it failed it. sqld answers a write that
 * meets its checkpoint `SQLITE_BUSY` (#4817), and a statement it prepared while other connections changed the schema,
 * as other test files sharing the server do, `SQLITE_SCHEMA` (#5456). Either way it ran none of the statement and kept
 * the stream, and the adapter runs the statement again.
 */
function statementFailure(body: string): string | undefined {
	try {
		const { results } = JSON.parse(body) as { results?: { type?: string; error?: { code?: string } }[] };
		const last = results?.at(-1);
		return last?.type === "error" ? last.error?.code : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a pipeline request's last request, the statement, is an `INSERT`. */
function sendsInsert(body: string): boolean {
	try {
		const { requests } = JSON.parse(body) as { requests?: { stmt?: { sql?: string } }[] };
		return /^INSERT\b/.test(requests?.at(-1)?.stmt?.sql ?? "");
	} catch {
		return false;
	}
}

/**
 * Counts the pipeline requests sent, those that continue a stream, by the baton their bodies carry, those whose
 * statement the server answered busy, and those whose statement, a read or a write, it answered `SQLITE_SCHEMA`.
 */
function countRequests(): {
	sent: number;
	continued: number;
	busy: number;
	schemaChangedReads: number;
	schemaChangedWrites: number;
} {
	const counts = { sent: 0, continued: 0, busy: 0, schemaChangedReads: 0, schemaChangedWrites: 0 };
	const real = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.method !== "POST" || !/\/pipeline$/.test(new URL(request.url).pathname)) return real(request);
		counts.sent++;
		const body = await request.clone().text();
		if (/"baton":"/.test(body)) counts.continued++;
		const response = await real(request);
		const failure = statementFailure(await response.clone().text());
		if (failure === "SQLITE_BUSY") counts.busy++;
		else if (failure === "SQLITE_SCHEMA" && sendsInsert(body)) counts.schemaChangedWrites++;
		else if (failure === "SQLITE_SCHEMA") counts.schemaChangedReads++;
		return response;
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
		// A statement sqld answered busy, as it answers a write that meets its checkpoint, or a read it answered
		// `SQLITE_SCHEMA`, as it answers one it prepared while other connections changed the schema, is sent again on the
		// same stream: one more request, which continues the stream as well. A write it answered `SQLITE_SCHEMA` runs again
		// in a write transaction of its own (#5462), on a stream of its own: one more request, which continues no stream.
		const onStream = counts.busy - before.busy + counts.schemaChangedReads - before.schemaChangedReads;
		const inTransaction = counts.schemaChangedWrites - before.schemaChangedWrites;
		assert.equal(
			counts.sent - before.sent,
			40 + onStream + inTransaction,
			"one request per statement, and one per busy or SQLITE_SCHEMA answer",
		);
		assert.equal(
			counts.continued - before.continued,
			39 + onStream,
			"every request after the first continued its stream, but a write's rerun in a transaction of its own",
		);
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

withSqld(
	"against sqld, a kept stream sees a schema another connection changed, from its first statement after the change (#5151)",
	async () => {
		const kept = await openLibsqlDatabase({ url: url! });
		const other = await openLibsqlDatabase({ url: url! });
		const table = `schema_${randomBytes(6).toString("hex")}`;
		try {
			await other.exec(`CREATE TABLE ${table}(id INTEGER)`);
			await other.run(`INSERT INTO ${table} VALUES (1)`);
			assert.deepEqual(await kept.all(`SELECT * FROM ${table}`), [{ id: 1 }]);
			await other.exec(`ALTER TABLE ${table} ADD COLUMN status TEXT DEFAULT 'ready'`);
			assert.deepEqual(await kept.all(`SELECT * FROM ${table}`), [{ id: 1, status: "ready" }]);
			await other.exec(`DROP TABLE ${table}`);
			await other.exec(`CREATE TABLE ${table}(a INTEGER, b INTEGER, c INTEGER)`);
			await kept.run(`INSERT INTO ${table} VALUES (?, ?, ?)`, 1, 2, 3);
			assert.deepEqual(await other.all(`SELECT * FROM ${table}`), [{ a: 1, b: 2, c: 3 }]);
		} finally {
			await other.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await other.close();
			await kept.close();
		}
	},
);

withSqld(
	"against sqld at a ws: URL, statements, a write batch and a transaction all go over its WebSocket (#5151, #4768)",
	async () => {
		const server = new URL(url!);
		server.protocol = server.protocol === "http:" ? "ws:" : "wss:";
		let fetched = 0;
		const real = globalThis.fetch;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
			fetched++;
			return real(input, init);
		});
		const database = await openLibsqlDatabase({ url: server.href });
		const table = `ws_${randomBytes(6).toString("hex")}`;
		try {
			await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
			await database.run(`INSERT INTO ${table} VALUES (?)`, 1);
			assert.equal(
				Number((await database.get<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count),
				1,
			);
			await database.batch!(
				[
					{ sql: `INSERT INTO ${table} VALUES (?)`, params: [2] },
					{ sql: `INSERT INTO ${table} VALUES (?)`, params: [3] },
				],
				{ lockWaitMs: 30_000 },
			);
			await database.transaction((transaction) => transaction.run(`INSERT INTO ${table} VALUES (?)`, 4));
			const rows = await database.all<{ n: bigint }>(`SELECT n FROM ${table} ORDER BY n`);
			assert.deepEqual(
				rows.map((row) => Number(row.n)),
				[1, 2, 3, 4],
			);
			assert.equal(fetched, 0);
		} finally {
			await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await database.close();
			vi.unstubAllGlobals();
		}
	},
);
