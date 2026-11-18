import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { inspect } from "node:util";
import { StorageTransientError } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";

/** How many runs the storage facade gives a call that keeps failing for a reason that passes. */
const TRANSIENT_ATTEMPTS = 5;

/** A message of the PostgreSQL wire protocol: its type byte, then its length and body. */
function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
	const header = Buffer.alloc(5);
	header.write(type, 0, "latin1");
	header.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([header, body]);
}

const ready = () => message("Z", Buffer.from("I", "latin1"));
const commandComplete = () => message("C", Buffer.from("OK\0", "latin1"));

/** A one-column text RowDescription, as for `SELECT current_setting('server_version_num') AS version`. */
function versionDescription(): Buffer {
	const name = Buffer.from("version\0", "latin1");
	const field = Buffer.alloc(18);
	field.writeInt32BE(0, 0);
	field.writeInt16BE(0, 4);
	field.writeInt32BE(25, 6);
	field.writeInt16BE(-1, 10);
	field.writeInt32BE(-1, 12);
	field.writeInt16BE(0, 16);
	return message("T", Buffer.concat([Buffer.from([0, 1]), name, field]));
}

/** The DataRow of a PostgreSQL 16 server's version number. */
function versionRow(): Buffer {
	const value = Buffer.from("160000", "latin1");
	const length = Buffer.alloc(4);
	length.writeInt32BE(value.length, 0);
	return message("D", Buffer.concat([Buffer.from([0, 1]), length, value]));
}

/** An ErrorResponse as a read replica, or a primary that is read-only for a while, sends it for a write. */
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

const servers: { server: Server; sockets: Set<Socket> }[] = [];

afterEach(async () => {
	for (const { server, sockets } of servers.splice(0)) {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

/**
 * A server that speaks just enough of the protocol to accept a login and answer statements. It refuses the first
 * `refused` requests (a simple query, or an extended-protocol request up to its Sync) with SQLSTATE 25006
 * (`read_only_sql_transaction`), and completes every later one without rows.
 */
async function startServer(refused: number): Promise<{ port: number; requests: () => number }> {
	let requests = 0;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = Buffer.alloc(0);
		let started = false;
		/** Whether the extended-protocol request under way is refused; decided at its first message. */
		let refusing: boolean | undefined;
		/** Whether the statement under way reads the server's version, the only one answered with a row. */
		let version = false;
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
				const text = buffer.subarray(5, length + 1).toString("utf8");
				buffer = buffer.subarray(length + 1);
				if (type === "X") {
					socket.end();
					return;
				}
				if (type === "Q") {
					const answer = text.includes("server_version_num")
						? Buffer.concat([versionDescription(), versionRow(), commandComplete()])
						: commandComplete();
					socket.write(Buffer.concat([requests++ < refused ? readOnlyError() : answer, ready()]));
					continue;
				}
				refusing ??= requests < refused;
				if (type === "P") version = text.includes("server_version_num");
				if (type === "S") {
					requests++;
					socket.write(Buffer.concat([refusing ? readOnlyError() : Buffer.alloc(0), ready()]));
					refusing = undefined;
				} else if (!refusing) {
					// Parse, Bind, Describe and Execute, each answered as it arrives; only the version query has a row.
					const answer = {
						P: message("1"),
						B: message("2"),
						D: version ? versionDescription() : message("n"),
						E: version ? Buffer.concat([versionRow(), commandComplete()]) : commandComplete(),
					}[type];
					if (answer !== undefined) socket.write(answer);
				}
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	servers.push({ server, sockets });
	return { port: address.port, requests: () => requests };
}

/** Opens the server at `port`, writes once, and closes it. */
async function writeOnce(port: number): Promise<void> {
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
}

test("a server that accepts reads only is retried as a failure that passes, then fails naming both causes", async () => {
	const { port, requests } = await startServer(Number.POSITIVE_INFINITY);
	await assert.rejects(
		() => writeOnce(port),
		(error: Error) => {
			assert.ok(error instanceof StorageTransientError, inspect(error, { depth: 6 }));
			assert.equal(error.code, "read-only-server");
			assert.equal(error.outcome, "not-applied");
			assert.equal(error.attempts, TRANSIENT_ATTEMPTS);
			assert.match(error.message, /accepts reads only \(SQLSTATE 25006\)/);
			assert.match(
				error.message,
				/read replica or read-only endpoint \(use the primary or the read\/write endpoint\)/,
			);
			assert.match(error.message, /read-only right now \(storage nearly full, or a failover in progress\)/);
			assert.equal((error.cause as { code?: string } | undefined)?.code, "25006", inspect(error.cause));
			return true;
		},
	);
	// Each run sent its requests again; none is sent once the runs are used up.
	const answered = requests();
	assert.ok(answered >= TRANSIENT_ATTEMPTS, `the server answered ${answered} requests`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(requests(), answered);
});

test("a write refused while a failover makes the server read-only for a moment succeeds when it is retried", async () => {
	const { port, requests } = await startServer(1);
	await writeOnce(port);
	assert.ok(requests() > 1, "the refused request was sent again");
});
