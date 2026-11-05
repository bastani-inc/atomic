import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	BROKER_CONTROL_TIMEOUT_MS,
	type ControlReply,
	controlRequest,
} from "../../packages/intercom/broker/control-request.js";
import { createMessageReader, type JsonWireValue, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath, getIntercomDirPath } from "../../packages/intercom/broker/paths.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const REQUEST_KINDS = [
	{ type: "broker_status", replyType: "broker_status" },
	{ type: "shutdown", replyType: "shutdown_ack" },
] as const;

/** The wire bytes `writeMessage` produces for one frame: the length-prefixed JSON a broker would send. */
function encode(frame: unknown): Buffer {
	const written: Buffer[] = [];
	writeMessage({ write: (bytes: Buffer) => written.push(bytes) } as never, frame);
	return Buffer.concat(written);
}

/** A well-formed length prefix around a payload that is not JSON. */
function malformedFrame(): Buffer {
	const payload = Buffer.from("{not json", "utf-8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

/** The frames a socket was asked to write, decoded with the real wire reader. */
function decodeWrites(writes: readonly Buffer[]): JsonWireValue[] {
	const frames: JsonWireValue[] = [];
	const read = createMessageReader(
		(frame) => frames.push(frame),
		(error) => {
			throw error;
		},
	);
	for (const chunk of writes) read(chunk);
	return frames;
}

/** Just the part of `net.Socket` that `controlRequest` drives: events in, writes and `destroy` out. */
class FakeSocket extends EventEmitter {
	readonly writes: Buffer[] = [];
	destroyed = false;
	write(chunk: Buffer): boolean {
		this.writes.push(chunk);
		return true;
	}
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

describe("controlRequest over a socket the test drives", () => {
	let socket: FakeSocket;

	beforeEach(() => {
		vi.useFakeTimers();
		socket = new FakeSocket();
		vi.spyOn(net, "connect").mockImplementation((() => socket) as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** Start a request; `outcome()` is what it resolved to so far, or `undefined` while it still waits. */
	function start(kind: (typeof REQUEST_KINDS)[number], timeoutMs = BROKER_CONTROL_TIMEOUT_MS) {
		let resolved: ControlReply | undefined;
		const request = controlRequest("private-socket", kind.type, kind.replyType, timeoutMs).then((reply) => {
			resolved = reply;
			return reply;
		});
		return {
			request,
			outcome: async (): Promise<ControlReply | undefined> => {
				await vi.advanceTimersByTimeAsync(0);
				return resolved;
			},
			connect(): string {
				socket.emit("connect");
				const sent = decodeWrites(socket.writes);
				assert.equal(sent.length, 1, "connecting sends exactly one request frame");
				const frame = sent[0];
				assert.ok(typeof frame === "object" && frame !== null && !Array.isArray(frame));
				assert.equal(frame.type, kind.type);
				assert.equal(typeof frame.requestId, "string");
				return frame.requestId as string;
			},
		};
	}

	for (const kind of REQUEST_KINDS) {
		describe(`a ${kind.type} request`, () => {
			test("sends its type and a fresh requestId once connected, and nothing before", async () => {
				const current = start(kind);
				assert.deepEqual(socket.writes, []);
				const requestId = current.connect();
				assert.notEqual(requestId, "");
				socket.emit("data", encode({ type: kind.replyType, requestId }));
				await current.request;
			});

			test("resolves with the reply frame that has the requested type and its own requestId", async () => {
				const current = start(kind);
				const requestId = current.connect();
				const reply = { type: kind.replyType, requestId, report: { pid: 1 } };
				socket.emit("data", encode(reply));
				assert.deepEqual(await current.request, { connected: true, reply });
				assert.equal(socket.destroyed, true, "the socket is released once answered");
			});

			test("ignores a frame of another type with the same requestId until the right frame arrives", async () => {
				const current = start(kind);
				const requestId = current.connect();
				const otherType = kind.replyType === "broker_status" ? "shutdown_ack" : "broker_status";
				socket.emit("data", encode({ type: otherType, requestId }));
				assert.equal(await current.outcome(), undefined, "a wrong-type frame does not answer the request");
				assert.equal(socket.destroyed, false);
				const reply = { type: kind.replyType, requestId };
				socket.emit("data", encode(reply));
				assert.deepEqual(await current.request, { connected: true, reply });
			});

			test("ignores a frame of the right type for another requestId until the right frame arrives", async () => {
				const current = start(kind);
				const requestId = current.connect();
				socket.emit("data", encode({ type: kind.replyType, requestId: `${requestId}-other` }));
				socket.emit("data", encode({ type: kind.replyType }));
				assert.equal(await current.outcome(), undefined, "a frame for another request does not answer this one");
				assert.equal(socket.destroyed, false);
				const reply = { type: kind.replyType, requestId, report: "mine" };
				socket.emit("data", encode(reply));
				assert.deepEqual(await current.request, { connected: true, reply });
			});

			for (const [label, frame] of [
				["null", null],
				["an array", [{ type: kind.replyType }]],
				["a string", "broker_status"],
				["a number", 7],
				["a boolean", true],
			] as const) {
				test(`ignores ${label} frames until a reply object arrives`, async () => {
					const current = start(kind);
					const requestId = current.connect();
					socket.emit("data", encode(frame));
					assert.equal(await current.outcome(), undefined, `${label} is not a reply and must not end the wait`);
					assert.equal(socket.destroyed, false);
					const reply = { type: kind.replyType, requestId };
					socket.emit("data", encode(reply));
					assert.deepEqual(await current.request, { connected: true, reply });
				});
			}
		});
	}

	test("a malformed frame on a socket that stays open ends the wait as connected without a reply, not as a timeout", async () => {
		const current = start(REQUEST_KINDS[0]);
		current.connect();
		socket.emit("data", malformedFrame());
		assert.deepStrictEqual(await current.outcome(), { connected: true });
		assert.equal(socket.destroyed, true, "the unusable connection is released");
	});

	test("a request that times out before the socket connects reports not connected, without the timed-out flag", async () => {
		const current = start(REQUEST_KINDS[0], 50);
		await vi.advanceTimersByTimeAsync(50);
		assert.deepStrictEqual(await current.request, { connected: false });
		assert.equal(socket.destroyed, true);
		assert.deepEqual(socket.writes, [], "nothing was sent to a broker that never connected");
	});

	test("a request that times out after connecting reports connected and timed out", async () => {
		const current = start(REQUEST_KINDS[0], 50);
		current.connect();
		await vi.advanceTimersByTimeAsync(50);
		assert.deepStrictEqual(await current.request, { connected: true, timedOut: true });
		assert.equal(socket.destroyed, true);
	});

	test("a connection error before the socket connects reports not connected", async () => {
		const current = start(REQUEST_KINDS[0]);
		socket.emit("error", new Error("connect ENOENT"));
		assert.deepStrictEqual(await current.outcome(), { connected: false });
		assert.equal(socket.destroyed, true);
	});

	test("a connection error after connecting reports connected without a reply", async () => {
		const current = start(REQUEST_KINDS[0]);
		current.connect();
		socket.emit("error", new Error("read ECONNRESET"));
		assert.deepStrictEqual(await current.outcome(), { connected: true });
	});

	test("a close before the socket connects reports not connected", async () => {
		const current = start(REQUEST_KINDS[0]);
		socket.emit("close");
		assert.deepStrictEqual(await current.outcome(), { connected: false });
	});

	test("a broker that closes after connecting without answering yields connected without a reply", async () => {
		const current = start(REQUEST_KINDS[0]);
		current.connect();
		socket.emit("close");
		assert.deepStrictEqual(await current.outcome(), { connected: true });
	});

	test("an error followed by the close it causes keeps the first outcome", async () => {
		const current = start(REQUEST_KINDS[0]);
		socket.emit("error", new Error("connect ECONNREFUSED"));
		socket.emit("close");
		assert.deepStrictEqual(await current.request, { connected: false });
	});
});

describe("controlRequest against a real private socket", () => {
	let agentDir: string;
	const servers: net.Server[] = [];

	beforeEach(() => {
		agentDir = makeTempDirectory("atomic-control-request-");
		mkdirSync(getIntercomDirPath(agentDir), { recursive: true });
	});

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
		removeTempDirectory(agentDir);
	});

	/** A broker stand-in on the socket path the real broker would use; `answer` runs once per received request frame. */
	async function listen(answer: (request: Record<string, JsonWireValue>, connection: net.Socket) => void) {
		const received: JsonWireValue[] = [];
		const server = net.createServer((connection) => {
			connection.on(
				"data",
				createMessageReader(
					(frame) => {
						received.push(frame);
						answer(frame as Record<string, JsonWireValue>, connection);
					},
					() => connection.destroy(),
				),
			);
			connection.on("error", () => {});
		});
		servers.push(server);
		const path = getBrokerSocketPath(process.platform, agentDir);
		await new Promise<void>((ready) => server.listen(path, ready));
		return { path, received };
	}

	for (const kind of REQUEST_KINDS) {
		test(`a ${kind.type} request reads its answer past unrelated frames on the wire`, async () => {
			const broker = await listen((request, connection) => {
				connection.write(encode(null));
				connection.write(encode([request]));
				connection.write(encode({ type: "unrelated", requestId: request.requestId }));
				connection.write(encode({ type: kind.replyType, requestId: "someone-else" }));
				connection.write(encode({ type: kind.replyType, requestId: request.requestId, report: "answer" }));
			});

			const answer = await controlRequest(broker.path, kind.type, kind.replyType, BROKER_CONTROL_TIMEOUT_MS);

			assert.equal(broker.received.length, 1);
			const request = broker.received[0] as Record<string, JsonWireValue>;
			assert.equal(request.type, kind.type);
			assert.equal(typeof request.requestId, "string");
			assert.deepEqual(answer, {
				connected: true,
				reply: { type: kind.replyType, requestId: request.requestId, report: "answer" },
			});
		});
	}

	test("a broker that sends a malformed frame and keeps the connection open ends the request without waiting", async () => {
		const broker = await listen((_request, connection) => {
			connection.write(malformedFrame());
		});
		assert.deepStrictEqual(
			await controlRequest(broker.path, "broker_status", "broker_status", BROKER_CONTROL_TIMEOUT_MS),
			{
				connected: true,
			},
		);
	});

	test("a socket path nothing listens on reports not connected", async () => {
		assert.deepStrictEqual(
			await controlRequest(
				getBrokerSocketPath(process.platform, agentDir),
				"broker_status",
				"broker_status",
				BROKER_CONTROL_TIMEOUT_MS,
			),
			{ connected: false },
		);
	});
});
