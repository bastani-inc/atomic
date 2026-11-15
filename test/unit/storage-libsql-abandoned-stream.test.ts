import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/index.js";
import { countRows, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { startOutageProxy } from "../helpers/outage-proxy.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();
const { server, open } = useFakeLibsqlServers();
const proxies: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const proxy of proxies.splice(0)) await proxy.close();
});

/**
 * A stream the server keeps far longer than any wait below: the write lock a cut stream holds is released only when
 * the client closes the stream, never because the stream expired meanwhile. Real sqld keeps an idle stream 10 s.
 */
const STREAM_TTL_MS = 60_000;
/** How soon a write after the outage must commit: well under the stream's lifetime and the request timeout. */
const RECOVERY_BOUND_MS = 5_000;

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} took longer than ${RECOVERY_BOUND_MS} ms`)),
			RECOVERY_BOUND_MS,
		);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

test("a stream cut while it holds the write lock is closed once the server is reachable, so the next write commits without waiting for the stream to expire (#5114)", async () => {
	const fake = await server({ streamTtlMs: STREAM_TTL_MS });
	const proxy = await startOutageProxy(new URL(fake.url));
	proxies.push(proxy);
	const database = await open(proxy.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			// The server now holds the write lock for this transaction's stream; the connection goes away.
			proxy.cut();
			await tx.run("INSERT INTO events VALUES (2)");
		}),
		(error: unknown) => error instanceof StorageTransientError && error.code === "connection-lost",
	);
	proxy.restore();
	await within(
		database.batch!([{ sql: "INSERT INTO events VALUES (3)", params: [] }], { priority: true }),
		"a priority write after the outage",
	);
	await within(database.run("INSERT INTO events VALUES (4)"), "a write after the outage");
	assert.deepEqual(
		[
			countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n < 3"),
			countRows(fake, "SELECT COUNT(*) AS count FROM events"),
		],
		[0, 2],
		"the cut transaction rolled back and the later writes committed",
	);
});
