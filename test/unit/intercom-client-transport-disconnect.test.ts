/**
 * Regression (PR #2820, Greptile P1): a transport error on an *already
 * registered* broker socket bypassed bounded recovery.
 *
 * `onSocketError` stored the raw transport error, and `onClose` then rejected
 * every pending request with it and emitted `disconnected` carrying it. The
 * recovery classifier recognizes only `IntercomClientDisconnectedError`, so an
 * established socket reset — the ordinary way a broker goes away — was treated
 * as a hard failure and skipped the warm-up/reconnect path that a clean close
 * already got.
 *
 * The fix normalizes a trusted post-registration transport disconnect into the
 * typed recoverable error while keeping the original transport error as
 * `cause`, and keeps every non-recoverable failure — protocol, registration,
 * configuration, explicit disconnect — exactly as actionable as before.
 *
 * These tests run the real `IntercomClient` against a real local broker socket.
 * The one place a value is synthesized (the `ECONNRESET` code) is called out at
 * its own test: on macOS and Linux a Unix-domain peer that goes away produces a
 * clean EOF, so literal `ECONNRESET` is the Windows/named-pipe and TCP flavor,
 * and provoking a kernel one here is not possible. The socket, its listeners
 * and the whole code path under test are real.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import {
	IntercomClientDisconnectedError,
	isRecoverableIntercomDisconnect,
} from "../../packages/intercom/recoverable-disconnect.js";

const agentDir = mkdtempSync(join(tmpdir(), "intercom-transport-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
// Imported after the agent directory override: the client resolves its socket path on load.
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;

const session = { cwd: "/tmp/transport", model: "test-model", pid: 11, startedAt: 1, lastActivity: 1 };

let server: net.Server;
let onConnection: (socket: net.Socket) => void = () => {};
const liveClients: Client[] = [];

/** A fake broker that answers `register` and then hands the socket to `after`. */
function acceptRegistration(after?: (socket: net.Socket) => void): (socket: net.Socket) => void {
	return (socket) => {
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if ((message as { type?: unknown }).type !== "register") return;
					writeMessage(socket, { type: "registered", sessionId: "fake-broker-session" });
					after?.(socket);
				},
				() => {},
			),
		);
		socket.on("error", () => {});
	};
}

function internals(client: Client): { socket: net.Socket | null } {
	return client as unknown as { socket: net.Socket | null };
}

/** Connect a real client and record every raw `error` and the `disconnected` payload. */
async function connectedClient(): Promise<{
	readonly client: Client;
	readonly rawErrors: Error[];
	disconnectPayload: unknown;
	readonly socket: net.Socket;
	readonly closed: Promise<void>;
}> {
	const client = new IntercomClient();
	liveClients.push(client);
	const rawErrors: Error[] = [];
	const record: {
		client: Client;
		rawErrors: Error[];
		disconnectPayload: unknown;
		socket: net.Socket;
		closed: Promise<void>;
	} = {
		client,
		rawErrors,
		disconnectPayload: undefined,
		socket: null as unknown as net.Socket,
		closed: Promise.resolve(),
	};
	client.on("error", (error: Error) => rawErrors.push(error));
	const disconnected = new Promise<void>((resolve) => {
		client.on("disconnected", (error: unknown) => {
			record.disconnectPayload = error;
			resolve();
		});
	});
	await client.connect({ ...session, name: "transport-client" });
	const socket = internals(client).socket;
	assert.ok(socket, "the client must hold its socket after connecting");
	record.socket = socket;
	record.closed = disconnected;
	return record;
}

beforeAll(async () => {
	server = net.createServer((socket) => onConnection(socket));
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

beforeEach(() => {
	onConnection = () => {};
});

afterEach(async () => {
	for (const client of liveClients.splice(0)) {
		try {
			await client.disconnect();
		} catch {
			// Already gone; the test under way is what asserts on that.
		}
	}
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	if (originalPiAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("a real post-registration transport error becomes a recoverable disconnect that keeps its cause", async () => {
	let brokerSide: net.Socket | undefined;
	onConnection = acceptRegistration((socket) => {
		brokerSide = socket;
	});
	const established = await connectedClient();
	assert.ok(brokerSide);

	// A genuinely pending request, so the rejection path is exercised, not just the event.
	const pending = established.client.send("peer-id", { text: "hello", messageId: "transport-1" });
	// Close the peer's file descriptor outright, then write. The kernel answers the
	// write on a socket whose peer is gone (EPIPE on a Unix domain socket; the write
	// may instead be refused as a write-after-end once the FIN has been processed).
	// Either way it is a real error raised by a real write on the client's own socket.
	brokerSide.destroy();
	established.socket.write(Buffer.alloc(64));

	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof IntercomClientDisconnectedError, `expected the typed error, got ${String(error)}`);
		assert.equal(isRecoverableIntercomDisconnect(error), true);
		assert.equal(error.message, "Client disconnected");
		const cause = error.cause;
		assert.ok(cause instanceof Error, "the original transport error must be preserved as cause");
		assert.equal(typeof (cause as NodeJS.ErrnoException).code, "string");
		// The same object the raw `error` channel carried: nothing was re-wrapped or lost.
		assert.equal(cause, established.rawErrors[0]);
		return true;
	});

	await established.closed;
	assert.equal(established.disconnectPayload, await pending.catch((error: unknown) => error));
	assert.equal(isRecoverableIntercomDisconnect(established.disconnectPayload), true);
	// The raw transport error still reaches `error` listeners for diagnosis.
	assert.equal(established.rawErrors.length >= 1, true);
	assert.equal(established.rawErrors[0] instanceof IntercomClientDisconnectedError, false);
});

test("an ECONNRESET on an established socket enters the recoverable path with its code intact", async () => {
	onConnection = acceptRegistration();
	const established = await connectedClient();

	const pending = established.client.send("peer-id", { text: "hello", messageId: "reset-1" });
	// Synthesized code, real socket and real listeners: a Unix-domain peer that goes
	// away yields a clean EOF on macOS/Linux, so a kernel-produced ECONNRESET is not
	// reachable here. What is under test is the client's classification of a
	// post-registration socket `'error'`, and that path is entered exactly as the
	// platform would enter it.
	const reset: NodeJS.ErrnoException = Object.assign(new Error("read ECONNRESET"), {
		code: "ECONNRESET",
		errno: -54,
		syscall: "read",
	});
	established.socket.emit("error", reset);
	established.socket.destroy();

	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof IntercomClientDisconnectedError);
		assert.equal(isRecoverableIntercomDisconnect(error), true);
		assert.equal(error.cause, reset);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ECONNRESET");
		return true;
	});
	await established.closed;
	assert.equal(established.disconnectPayload instanceof IntercomClientDisconnectedError, true);
	assert.equal((established.disconnectPayload as Error).cause, reset);
	assert.deepEqual(established.rawErrors, [reset]);
});

test("a protocol error stays non-recoverable even when a socket error follows it", async () => {
	let brokerSide: net.Socket | undefined;
	onConnection = acceptRegistration((socket) => {
		brokerSide = socket;
	});
	const established = await connectedClient();
	assert.ok(brokerSide);

	const pending = established.client.send("peer-id", { text: "hello", messageId: "protocol-1" });
	// The clobber hazard: `onReaderError` records the protocol error and then
	// destroys the socket, and a transport `'error'` can still arrive afterwards.
	// Normalizing that later error must not overwrite the protocol diagnosis.
	established.client.on("error", (error: Error) => {
		if (!error.message.startsWith("Intercom protocol error:")) return;
		established.socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
	});
	const framed = Buffer.alloc(4 + 1);
	framed.writeUInt32BE(1, 0);
	framed.write("{", 4, "utf8");
	brokerSide.write(framed);

	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /^Intercom protocol error: /u);
		assert.equal(isRecoverableIntercomDisconnect(error), false);
		return true;
	});
	await established.closed;
	assert.equal(isRecoverableIntercomDisconnect(established.disconnectPayload), false);
});

test("pre-registration failures stay non-recoverable", async () => {
	onConnection = (socket) => {
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if ((message as { type?: unknown }).type !== "register") return;
					writeMessage(socket, { type: "registration_failed", reason: "Invalid supervisor authorization" });
					socket.end();
				},
				() => {},
			),
		);
		socket.on("error", () => {});
	};
	const refused = new IntercomClient();
	await assert.rejects(refused.connect({ ...session, name: "refused" }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Invalid supervisor authorization");
		assert.equal(isRecoverableIntercomDisconnect(error), false);
		return true;
	});

	onConnection = (socket) => socket.destroy();
	const dropped = new IntercomClient();
	await assert.rejects(dropped.connect({ ...session, name: "dropped" }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(isRecoverableIntercomDisconnect(error), false);
		return true;
	});
});

test("plain errors cannot opt into recoverable classification by copying the marker", () => {
	const spoofed = Object.assign(new Error("Client disconnected"), { intercomRecoverableDisconnect: true });
	assert.equal(isRecoverableIntercomDisconnect(spoofed), false);
	assert.equal(isRecoverableIntercomDisconnect(new Error("wrapper", { cause: spoofed })), false);
});

test("an explicit disconnect() stays the quiet, unreported path", async () => {
	onConnection = acceptRegistration();
	const established = await connectedClient();
	const socket = established.socket;

	await established.client.disconnect();

	assert.equal(socket.destroyed || socket.writableEnded, true);
	assert.equal(established.disconnectPayload, undefined);
	assert.deepEqual(established.rawErrors, []);
});
