import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { inspect } from "node:util";
import { StorageConfigError, StorageTransientError } from "@bastani/atomic/storage";
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
const commandComplete = (tag = "OK") => message("C", Buffer.from(`${tag}\0`, "latin1"));

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

function versionRow(): Buffer {
	const value = Buffer.from("160000", "latin1");
	const length = Buffer.alloc(4);
	length.writeInt32BE(value.length, 0);
	return message("D", Buffer.concat([Buffer.from([0, 1]), length, value]));
}

function lockNotAvailableError(): Buffer {
	const fields = [
		["S", "ERROR"],
		["V", "ERROR"],
		["C", "55P03"],
		["M", "canceling statement due to lock timeout"],
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
 * Minimal PostgreSQL wire server that records every simple query text (`Q`) and optionally refuses `BEGIN` queries
 * with SQLSTATE `55P03` (`lock_not_available`).
 */
async function startServer(options: { refuseLock?: boolean } = {}): Promise<{ port: number; queries: string[] }> {
	const queries: string[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let buffer = Buffer.alloc(0);
		let started = false;
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
				const text = buffer
					.subarray(5, length + 1)
					.toString("utf8")
					.replace(/\0+$/, "");
				buffer = buffer.subarray(length + 1);
				if (type === "X") {
					socket.end();
					return;
				}
				if (type === "Q") {
					queries.push(text);
					if (options.refuseLock && text.startsWith("BEGIN;")) {
						socket.write(Buffer.concat([lockNotAvailableError(), ready()]));
						continue;
					}
					const tag = text.trim().toUpperCase() === "COMMIT" ? "COMMIT" : "OK";
					const answer = text.includes("server_version_num")
						? Buffer.concat([versionDescription(), versionRow(), commandComplete()])
						: commandComplete(tag);
					socket.write(Buffer.concat([answer, ready()]));
					continue;
				}
				if (type === "P") version = text.includes("server_version_num");
				if (type === "S") {
					socket.write(ready());
				} else {
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
	return { port: address.port, queries };
}

test("Postgres maps lockWaitMs: 0 to SET LOCAL lock_timeout = 1 instead of failing or disabling lock_timeout", async () => {
	const { port, queries } = await startServer();
	const database = await openPostgresDatabase({
		url: `postgresql://atomic@127.0.0.1:${port}/atomic`,
		password: "unused",
		schema: "public",
		readerMaxConnections: 0,
	});
	try {
		await database.transaction(async () => {}, { lockWaitMs: 0 });
		const zeroBegin = queries.find((sql) => sql.startsWith("BEGIN;"));
		assert.ok(zeroBegin, `expected BEGIN query, saw: ${inspect(queries)}`);
		assert.match(zeroBegin, /SET LOCAL lock_timeout = 1;/);
		assert.doesNotMatch(zeroBegin, /SET LOCAL lock_timeout = 0;/);

		queries.length = 0;
		await database.transaction(async () => {}, { lockWaitMs: 250 });
		const positiveBegin = queries.find((sql) => sql.startsWith("BEGIN;"));
		assert.ok(positiveBegin, `expected BEGIN query, saw: ${inspect(queries)}`);
		assert.match(positiveBegin, /SET LOCAL lock_timeout = 250;/);

		queries.length = 0;
		for (const invalid of [-1, 1.5, Number.NaN]) {
			await assert.rejects(
				() => database.transaction(async () => {}, { lockWaitMs: invalid }),
				(error: unknown) => {
					const config =
						error instanceof StorageConfigError
							? error
							: error instanceof Error && error.cause instanceof StorageConfigError
								? error.cause
								: undefined;
					assert.ok(config, inspect(error));
					assert.equal(config.field, "lockWaitMs");
					assert.equal(config.reason, "non-negative-integer-required");
					return true;
				},
			);
		}
		assert.equal(queries.length, 0, "invalid lockWaitMs fails before sending BEGIN");
	} finally {
		await database.close();
	}
});

test("Postgres reports a lock_timeout refusal under lockWaitMs: 0 as a not-applied lock-conflict transient error", async () => {
	const { port } = await startServer({ refuseLock: true });
	const database = await openPostgresDatabase({
		url: `postgresql://atomic@127.0.0.1:${port}/atomic`,
		password: "unused",
		schema: "public",
		readerMaxConnections: 0,
	});
	try {
		await assert.rejects(
			() => database.transaction(async () => {}, { lockWaitMs: 0 }),
			(error: unknown) => {
				assert.ok(error instanceof StorageTransientError, inspect(error));
				assert.equal(error.code, "lock-conflict");
				assert.equal(error.outcome, "not-applied");
				assert.equal(error.attempts, 1);
				return true;
			},
		);
	} finally {
		await database.close();
	}
});
