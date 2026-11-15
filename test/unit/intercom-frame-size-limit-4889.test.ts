import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "intercom-frame-limit-")));
brokerFixture.overrideAgentDir();
const { createMessageReader, INTERCOM_MAX_FRAME_BYTES, writeMessage } = await import(
	"../../packages/intercom/broker/framing.js"
);
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");

/** The suite spawns a real broker child under jiti. */
const BROKER_START_TIMEOUT_MS = 10_000;
const SOCKET_CLOSE_TIMEOUT_MS = 5_000;

beforeAll(() => brokerFixture.startSourceBroker(BROKER_START_TIMEOUT_MS), BROKER_START_TIMEOUT_MS * 2);
afterAll(() => brokerFixture.cleanup());

function frameHeader(length: number): Buffer {
	const header = Buffer.alloc(4);
	header.writeUInt32BE(length, 0);
	return header;
}

async function connect(): Promise<net.Socket> {
	const socket = net.createConnection(getBrokerSocketPath());
	socket.on("error", () => {});
	await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
	return socket;
}

test("the frame reader rejects a frame declared above the maximum frame size and reads nothing after it (#4889)", () => {
	const errors: Error[] = [];
	const messages: unknown[] = [];
	const read = createMessageReader(
		(message) => messages.push(message),
		(error) => errors.push(error),
	);
	read(frameHeader(INTERCOM_MAX_FRAME_BYTES + 1));
	const payload = Buffer.from(JSON.stringify({ type: "list" }), "utf-8");
	read(Buffer.concat([frameHeader(payload.length), payload]));
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /exceeds the maximum Intercom frame size/);
	assert.deepEqual(messages, []);
});

test("the frame reader accepts a frame of exactly the maximum declared size (#4889)", () => {
	const errors: Error[] = [];
	const read = createMessageReader(
		() => {},
		(error) => errors.push(error),
	);
	read(frameHeader(INTERCOM_MAX_FRAME_BYTES));
	assert.deepEqual(errors, []);
});

test("the broker closes a connection that declares an oversize frame and keeps serving others (#4889)", async () => {
	const peer = await connect();
	const closed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
	peer.write(frameHeader(0xffff_ffff));
	await Promise.race([
		closed,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("broker kept the oversize-frame connection open")), SOCKET_CLOSE_TIMEOUT_MS),
		),
	]);

	const healthy = await connect();
	try {
		const registered = new Promise<string>((resolve) => {
			healthy.on(
				"data",
				createMessageReader(
					(message) => {
						if (typeof message === "object" && message !== null && !Array.isArray(message)) {
							if (message.type === "registered" && typeof message.sessionId === "string")
								resolve(message.sessionId);
						}
					},
					() => {},
				),
			);
		});
		writeMessage(healthy, {
			type: "register",
			session: { cwd: "/tmp/frame-limit", model: "test-model", pid: 1, startedAt: 1, lastActivity: 1 },
		});
		assert.ok((await registered).length > 0);
	} finally {
		healthy.destroy();
	}
});
