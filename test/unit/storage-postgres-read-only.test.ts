import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { inspect } from "node:util";
import { StorageConfigError } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";

/** A message of the PostgreSQL wire protocol: its type byte, then its length and body. */
function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
	const header = Buffer.alloc(5);
	header.write(type, 0, "latin1");
	header.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([header, body]);
}

const ready = () => message("Z", Buffer.from("I", "latin1"));

/** An ErrorResponse as a hot standby or a read-only endpoint sends it for a write. */
function readOnlyError(): Buffer {
	const fields = [
		["S", "ERROR"],
		["V", "ERROR"],
		["C", "25006"],
		["M", "cannot execute statement in a read-only transaction"],
	]
		.map(([code, value]) => `${code}${value}\0`)
		.join("");
	return message("E", Buffer.from(`${fields}\0`, "utf8"));
}

/**
 * A server that speaks just enough of the protocol to accept a login, then refuses every statement with SQLSTATE
 * 25006 (`read_only_sql_transaction`), as a read replica does for a write. It counts the requests it answered.
 */
async function startReadOnlyServer(): Promise<{ server: Server; port: number; requests: () => number }> {
	let requests = 0;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = Buffer.alloc(0);
		let started = false;
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (!started) {
					if (buffer.length < 8) return;
					const length = buffer.readInt32BE(0);
					if (buffer.length < length) return;
					const code = buffer.readInt32BE(4);
					buffer = buffer.subarray(length);
					// An SSLRequest gets "no TLS"; the startup message logs in at once.
					if (code === 80877103) {
						socket.write("N");
						continue;
					}
					started = true;
					const key = Buffer.alloc(8);
					key.writeInt32BE(1, 0);
					key.writeInt32BE(2, 4);
					socket.write(Buffer.concat([message("R", Buffer.from([0, 0, 0, 0])), message("K", key), ready()]));
					continue;
				}
				if (buffer.length < 5) return;
				const type = String.fromCharCode(buffer[0]!);
				const length = buffer.readInt32BE(1);
				if (buffer.length < length + 1) return;
				buffer = buffer.subarray(length + 1);
				if (type === "X") {
					socket.end();
					return;
				}
				// A simple query, or the Sync that ends an extended-protocol request, is answered with the refusal.
				if (type === "Q" || type === "S") {
					requests++;
					socket.write(Buffer.concat([readOnlyError(), ready()]));
				}
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	servers.push({ server, sockets });
	return { server, port: address.port, requests: () => requests };
}

const servers: { server: Server; sockets: Set<Socket> }[] = [];

afterEach(async () => {
	for (const { server, sockets } of servers.splice(0)) {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

/** The errors along `error`'s cause chain, outermost first. */
function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	for (let current = error; current instanceof Error; current = (current as Error).cause) chain.push(current);
	return chain;
}

test("a write refused by a read-only endpoint fails at once and says to use the read/write endpoint", async () => {
	const { port, requests } = await startReadOnlyServer();
	await assert.rejects(
		async () => {
			// Opening may already write, by preparing the schema; a write after it is refused the same way.
			const database = await openPostgresDatabase({
				url: `postgresql://atomic@127.0.0.1:${port}/atomic`,
				password: "unused",
				schema: "public",
			});
			try {
				await database.exec("CREATE TABLE items (id BIGINT)");
			} finally {
				await database.close();
			}
		},
		(error: Error) => {
			const refusal = causeChain(error).find((link) => link instanceof StorageConfigError);
			assert.ok(refusal instanceof StorageConfigError, inspect(error, { depth: 6 }));
			assert.equal(refusal.reason, "read-only-endpoint");
			assert.match(refusal.message, /accepts reads only/);
			assert.match(refusal.message, /read\/write endpoint/);
			assert.match(refusal.message, /25006/);
			return true;
		},
	);
	// Not a failure that passes: the statement is not sent again.
	const answered = requests();
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(requests(), answered);
	// One attempt: the open's statement is pipelined with its BEGIN and SET LOCAL, each ended by its own Sync.
	assert.ok(answered <= 3, `the server answered ${answered} requests for one refused statement`);
});
