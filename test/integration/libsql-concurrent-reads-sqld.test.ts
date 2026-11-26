import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/**
 * Reads overlapping on a real libSQL server (#6565), through a proxy that delays every packet each way, as a server
 * far from the client does. Runs when `ATOMIC_TEST_LIBSQL_URL` names a sqld (see test/helpers/storage-backends.ts).
 */

useTemporaryAgentDir();

const url = process.env.ATOMIC_TEST_LIBSQL_URL;
const withSqld = test.skipIf(url === undefined || url === "");
/** The delay the proxy adds each way, so a round trip takes twice as long. */
const ONE_WAY_MS = 40;
/** The reads made at once. */
const READS = 8;

/**
 * A TCP proxy to `target` that delays every chunk `delayMs` each way, keeping each direction's order, and counts the
 * connections it accepts.
 */
async function latencyProxy(
	target: URL,
	delayMs: number,
): Promise<{ url: string; readonly accepted: number; close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	let accepted = 0;
	const forward = (from: Socket, to: Socket) => {
		from.on("data", (chunk) => setTimeout(() => to.destroyed || to.write(chunk), delayMs));
		from.on("end", () => setTimeout(() => to.end(), delayMs));
		from.on("error", () => to.destroy());
		from.on("close", () => setTimeout(() => to.destroy(), delayMs));
	};
	const server: Server = createServer((client) => {
		accepted++;
		const upstream = connect(Number(target.port || 80), target.hostname);
		for (const socket of [client, upstream]) {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		}
		forward(client, upstream);
		forward(upstream, client);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}`,
		get accepted() {
			return accepted;
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** How long `READS` read-only transactions, each two reads, take when made at once on `database`. */
async function readsAtOnce(database: SqliteDatabase, table: string): Promise<number> {
	const started = performance.now();
	const counts = await Promise.all(
		Array.from({ length: READS }, () =>
			database.transaction(
				async (tx) => {
					const before = await tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
					const after = await tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
					assert.deepEqual(after, before, "a read-only transaction reads one snapshot");
					return Number(before?.n);
				},
				{ readOnly: true },
			),
		),
	);
	assert.ok(counts.every((count) => count === counts[0]));
	return performance.now() - started;
}

withSqld(
	"read-only transactions made at once overlap on the server, so they take about as long as one (#6565)",
	{ timeout: 120_000 },
	async () => {
		const proxy = await latencyProxy(new URL(url as string), ONE_WAY_MS);
		const table = `reads_${randomBytes(4).toString("hex")}`;
		const overlapping = await openLibsqlDatabase({ url: proxy.url });
		const oneAtATime = await openLibsqlDatabase({ url: proxy.url, concurrency: 1 });
		try {
			await overlapping.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
			await overlapping.run(`INSERT INTO ${table} VALUES (1)`);
			// Warm both clients' connections, so neither pays for opening one in the timed rounds.
			await readsAtOnce(overlapping, table);
			await readsAtOnce(oneAtATime, table);
			const together = await readsAtOnce(overlapping, table);
			const inTurn = await readsAtOnce(oneAtATime, table);
			assert.ok(
				together * 2 < inTurn,
				`${READS} reads at once took ${Math.round(together)} ms, one at a time ${Math.round(inTurn)} ms`,
			);
		} finally {
			await overlapping.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await Promise.all([overlapping.close(), oneAtATime.close()]);
			await proxy.close();
		}
	},
);

withSqld(
	"writes keep their turn among overlapping reads, and a read after an awaited write sees it (#6565)",
	{ timeout: 120_000 },
	async () => {
		const table = `writes_${randomBytes(4).toString("hex")}`;
		const database = await openLibsqlDatabase({ url: url as string });
		try {
			await database.exec(`CREATE TABLE ${table}(seq INTEGER PRIMARY KEY, writer INTEGER NOT NULL)`);
			const appends = 12;
			// Each append reads the last seq and writes the next one: overlapping writers would take the same seq.
			const append = (writer: number) =>
				database.transaction(
					async (tx) => {
						const last = await tx.get<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM ${table}`);
						await tx.run(`INSERT INTO ${table} VALUES (?, ?)`, Number(last?.seq ?? 0) + 1, writer);
					},
					{ concurrency: { kind: "serial", domain: `writer-${writer % 3}` } },
				);
			const reads = (count: number) =>
				Array.from({ length: count }, () =>
					database.transaction((tx) => tx.all(`SELECT seq FROM ${table}`), { readOnly: true }),
				);
			await Promise.all([
				...Array.from({ length: appends }, (_, writer) => append(writer)),
				...reads(appends),
				...Array.from({ length: appends }, () => database.all(`SELECT COUNT(*) AS n FROM ${table}`)),
			]);
			const rows = await database.all<{ seq: number }>(`SELECT seq FROM ${table} ORDER BY seq`);
			assert.deepEqual(
				rows.map((row) => Number(row.seq)),
				Array.from({ length: appends }, (_, index) => index + 1),
			);
			for (let round = 0; round < 5; round++) {
				await database.run(`INSERT INTO ${table} VALUES (?, ?)`, appends + 1 + round, -1);
				const [seen] = await Promise.all([
					database.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`),
					...reads(3),
				]);
				assert.equal(Number(seen?.n), appends + 1 + round);
			}
		} finally {
			await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await database.close();
		}
	},
);

withSqld(
	"lone reads made at once share one request and one connection, each reading its own statement's snapshot (#6560)",
	{ timeout: 120_000 },
	async () => {
		const proxy = await latencyProxy(new URL(url as string), ONE_WAY_MS);
		const table = `merged_${randomBytes(4).toString("hex")}`;
		const database = await openLibsqlDatabase({ url: proxy.url });
		const real = globalThis.fetch;
		let requests = 0;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			return real(input, init);
		});
		try {
			await database.exec(`CREATE TABLE ${table}(n INTEGER NOT NULL)`);
			await database.run(`INSERT INTO ${table} VALUES (1)`);
			await database.all(`SELECT n FROM ${table}`);
			const connections = proxy.accepted;
			requests = 0;
			const read = await Promise.all(
				Array.from({ length: READS }, (_, index) =>
					database.get<{ n: number; index: number }>(`SELECT n, ? AS "index" FROM ${table}`, index),
				),
			);
			assert.deepEqual(
				read.map((row) => [Number(row?.n), Number(row?.index)]),
				Array.from({ length: READS }, (_, index) => [1, index]),
			);
			// Before, every read past the first opened a stream of its own: 8 requests, and on a client whose connections
			// were all busy, 7 new connections. Now the first takes the reused stream and the others go in one request.
			assert.ok(requests <= 2, `${requests} requests`);
			assert.ok(proxy.accepted - connections <= 1, `${proxy.accepted - connections} new connections`);
			// Each read is a statement of its own: reads made after a write was answered all see it.
			for (let round = 2; round <= 4; round++) {
				await database.run(`INSERT INTO ${table} VALUES (?)`, round);
				const counts = await Promise.all(
					Array.from({ length: READS }, () => database.get<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)),
				);
				assert.deepEqual(
					counts.map((row) => Number(row?.c)),
					Array.from({ length: READS }, () => round),
				);
			}
			// A read that fails fails alone: the others in its request are answered.
			const mixed = await Promise.allSettled([
				database.all(`SELECT n FROM ${table}`),
				database.all(`SELECT n FROM ${table}_missing`),
				database.all(`SELECT n FROM ${table} ORDER BY n`),
			]);
			assert.equal(mixed[0]?.status, "fulfilled");
			assert.equal(mixed[1]?.status, "rejected");
			assert.deepEqual(
				mixed[2]?.status === "fulfilled" ? mixed[2].value.map((row) => Number(row.n)) : undefined,
				[1, 2, 3, 4],
			);
		} finally {
			vi.unstubAllGlobals();
			await database.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
			await database.close();
			await proxy.close();
		}
	},
);
