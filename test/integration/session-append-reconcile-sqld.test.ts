import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/**
 * A session on a real libSQL server (sqld) whose COMMIT response is lost once (#4970): the server applies the append,
 * the connection then breaks, and the storage layer reports the outcome as unknown. Runs only when a server is named,
 * for example one started with
 *   docker run -d -p 127.0.0.1:8080:8080 -e SQLD_CHECKPOINT_INTERVAL_S=60 ghcr.io/tursodatabase/libsql-server:v0.24.33
 * and `ATOMIC_TEST_LIBSQL_URL=http://127.0.0.1:8080`. The test works under a table prefix of its own.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;

/**
 * An HTTP proxy in front of the server. While armed, the next request that carries a COMMIT is forwarded, its whole
 * response is read from the server (so the commit is applied), and the client's connection is then destroyed, or
 * answered with a gateway's HTTP 502, instead.
 */
async function startProxy(target: URL): Promise<{
	url: string;
	dropNextCommit(answer?: "destroy" | "502"): void;
	dropped(): number;
	close(): Promise<void>;
}> {
	let armed: "destroy" | "502" | undefined;
	let dropped = 0;
	const server: Server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = Buffer.concat(chunks);
			const drop = armed !== undefined && /"COMMIT"/i.test(body.toString("utf8")) ? armed : undefined;
			if (drop) armed = undefined;
			const upstream = request(
				{
					host: target.hostname,
					port: target.port,
					method: incoming.method,
					path: incoming.url,
					headers: { ...incoming.headers, host: target.host },
				},
				(response) => {
					const answer: Buffer[] = [];
					response.on("data", (chunk: Buffer) => answer.push(chunk));
					response.on("end", () => {
						if (drop) dropped++;
						if (drop === "destroy") return void incoming.socket.destroy();
						if (drop === "502") {
							outgoing.writeHead(502, { "content-type": "text/html" });
							return void outgoing.end("<html><body>502 Bad Gateway</body></html>");
						}
						outgoing.writeHead(response.statusCode ?? 502, response.headers);
						outgoing.end(Buffer.concat(answer));
					});
				},
			);
			upstream.on("error", () => incoming.socket.destroy());
			upstream.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		dropNextCommit: (answer = "destroy") => {
			armed = answer;
		},
		dropped: () => dropped,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

describe.skipIf(serverUrl === undefined)("a lost COMMIT response on a libSQL server (#4970)", () => {
	let proxy: Awaited<ReturnType<typeof startProxy>>;
	let database: SqliteDatabase;
	let store: SqlSessionStore;
	let direct: SqliteDatabase;
	let directStore: SqlSessionStore;
	const prefix = `reconcile_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;

	beforeAll(async () => {
		proxy = await startProxy(new URL(serverUrl!));
		database = await openLibsqlDatabase({ url: proxy.url });
		store = await SqlSessionStore.open(database, { prefix });
		direct = await openLibsqlDatabase({ url: serverUrl! });
		directStore = await SqlSessionStore.open(direct, { prefix });
	});
	afterAll(async () => {
		await store?.close();
		await database?.close();
		await directStore?.close();
		await direct?.close();
		await proxy?.close();
	});

	for (const answer of ["destroy", "502"] as const) {
		const how = answer === "destroy" ? "was lost" : "was a gateway's 502";
		test(`the append whose COMMIT response ${how} is recognised as persisted and later appends succeed (#4970)`, async () => {
			const manager = await SessionManager.create(store, "/project");
			await manager.appendMessage(message("one"));

			const dropped = proxy.dropped();
			proxy.dropNextCommit(answer);
			await manager.appendMessage(message("two"));
			assert.equal(proxy.dropped(), dropped + 1);
			await manager.appendMessage(message("three"));
			await manager.appendMessage(message("four"));

			const stored = await directStore.load(manager.getSessionId());
			const texts = (entries: readonly SessionEntry[]) =>
				entries.flatMap((entry) =>
					entry.type === "message" && "content" in entry.message ? [entry.message.content] : [],
				);
			assert.deepEqual(texts(stored.entries), ["one", "two", "three", "four"]);
			assert.deepEqual(stored.entries, manager.getEntries());
			assert.deepEqual(
				manager.getBranch().map((entry) => entry.id),
				stored.entries.map((entry) => entry.id),
			);
			await directStore.delete(manager.getSessionId());
		});
	}
});
