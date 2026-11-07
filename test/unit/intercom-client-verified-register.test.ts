import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, test } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "icv-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerSocketPath, getIntercomDirPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { BROKER_ROUTING_CHANGED_CODE, BROKER_ROUTING_CHANGED_REASON } = await import(
	"../../packages/intercom/recoverable-disconnect.js"
);
const {
	isIntercomBrokerProtocolError,
	isIntercomRoutingChangedError,
	isIntercomRoutingUnavailableError,
	isRetryableIntercomRoutingError,
} = await import("@bastani/atomic");
const { BROKER_PROTOCOL, LEGACY_BROKER_PROTOCOL } = await import("../../packages/intercom/broker/protocol-version.js");

const servers: net.Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

type Frame = Record<string, unknown> & { type?: string };

async function fakeBroker(onRegister: (socket: net.Socket, frame: Frame) => void): Promise<Frame[]> {
	mkdirSync(getIntercomDirPath(), { recursive: true, mode: 0o700 });
	const received: Frame[] = [];
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					const message = frame as Frame;
					received.push(message);
					if (message.type === "register" || message.type === "register_verified") onRegister(socket, message);
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(), resolve));
	servers.push(server);
	return received;
}

const SESSION = { cwd: "/client", model: "client-model", pid: process.pid, startedAt: 1, lastActivity: 1 };

async function connectFailure(expectedAcrossMachines: boolean | undefined, verify = true): Promise<unknown> {
	const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
	try {
		await client.connect(
			SESSION,
			undefined,
			undefined,
			undefined,
			undefined,
			expectedAcrossMachines === undefined ? undefined : { acrossMachines: expectedAcrossMachines, verify },
		);
	} catch (error) {
		return error;
	} finally {
		await client.disconnect().catch(() => {});
	}
	throw new Error("connect unexpectedly succeeded");
}

describe("registering with the routing a session verified (#4320)", () => {
	test("sends the verified opcode with the expected routing, and the plain opcode without one", async () => {
		const received = await fakeBroker((socket) =>
			writeMessage(socket, { type: "registered", sessionId: "fake-session" }),
		);
		for (const expected of [true, false, undefined]) {
			const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
			await client.connect(
				SESSION,
				undefined,
				undefined,
				undefined,
				undefined,
				expected === undefined ? undefined : { acrossMachines: expected, verify: true },
			);
			await client.disconnect();
		}
		const registrations = received.filter((frame) => frame.type === "register" || frame.type === "register_verified");
		assert.deepEqual(
			registrations.map((frame) => [frame.type, frame.expectedRouting]),
			[
				["register_verified", { acrossMachines: true }],
				["register_verified", { acrossMachines: false }],
				["register", undefined],
			],
		);
		assert.deepEqual(
			registrations.map((frame) => frame.protocol),
			[BROKER_PROTOCOL, BROKER_PROTOCOL, BROKER_PROTOCOL],
		);
	});

	test("a broker that closes a verified registration without answering is reported as unsupported at the register phase", async () => {
		const received = await fakeBroker((socket) => socket.destroy());

		const error = await connectFailure(false);

		assert.ok(isIntercomRoutingUnavailableError(error), String(error));
		assert.deepEqual([error.reason, error.phase, error.retryable], ["unsupported", "register", true]);
		assert.deepEqual(
			received.map((frame) => frame.type),
			["register_verified"],
		);
	});

	test("an unverified registration closed by a broker that still answers keeps the plain closed-connection error", async () => {
		await fakeBroker((socket) => socket.destroy());

		const error = await connectFailure(undefined);

		assert.ok(error instanceof Error);
		assert.equal(isIntercomRoutingUnavailableError(error), false);
	});

	test("a routing-changed refusal keeps the routing the session expected, whichever it was", async () => {
		await fakeBroker((socket) => {
			writeMessage(socket, {
				type: "registration_failed",
				reason: BROKER_ROUTING_CHANGED_REASON,
				code: BROKER_ROUTING_CHANGED_CODE,
			});
			socket.end();
		});

		for (const expected of [true, false]) {
			const error = await connectFailure(expected);
			assert.ok(isIntercomRoutingChangedError(error), String(error));
			assert.equal(error.expectedAcrossMachines, expected);
			assert.equal(isRetryableIntercomRoutingError(error), true);
		}
	});

	test("a routing-changed refusal of an unverified registration, from a broker of another version, expects single-machine routing", async () => {
		await fakeBroker((socket) => {
			writeMessage(socket, {
				type: "registration_failed",
				reason: BROKER_ROUTING_CHANGED_REASON,
				code: BROKER_ROUTING_CHANGED_CODE,
			});
			socket.end();
		});

		const error = await connectFailure(undefined);

		assert.ok(isIntercomRoutingChangedError(error), String(error));
		assert.equal(error.expectedAcrossMachines, false);
		assert.equal(isRetryableIntercomRoutingError(error), true);
	});

	test("the refusal code is the wire contract an older or newer broker also speaks", () => {
		assert.equal(BROKER_ROUTING_CHANGED_CODE, "broker_routing_changed");
	});

	test("a broker that closes an unverified registration without answering keeps the plain closed-connection error (#4538)", async () => {
		const received = await fakeBroker((socket) => socket.destroy());

		const error = await connectFailure(false, false);

		assert.ok(error instanceof Error);
		assert.equal(isIntercomRoutingUnavailableError(error), false);
		assert.deepEqual(
			received.map((frame) => [frame.type, frame.expectedRouting]),
			[["register", undefined]],
		);
	});
});

describe("registering unverified with a broker of protocol 1 (#4538)", () => {
	for (const expected of [false, true]) {
		test(`a session that expects ${expected ? "multi-node" : "single-machine"} routing is refused when the broker reports the other routing in registered`, async () => {
			await fakeBroker((socket) =>
				writeMessage(socket, {
					type: "registered",
					sessionId: "fake-session",
					multiNodeRouting: expected ? "off" : "on",
				}),
			);

			const error = await connectFailure(expected, false);

			assert.ok(isIntercomRoutingChangedError(error), String(error));
			assert.equal(error.expectedAcrossMachines, expected);
		});
	}

	test("a broker that reports the routing the session expected, or none, registers it", async () => {
		let registrations = 0;
		const received = await fakeBroker((socket) => {
			registrations += 1;
			writeMessage(socket, {
				type: "registered",
				sessionId: "fake-session",
				...(registrations === 1 ? {} : { multiNodeRouting: "off" }),
			});
		});
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
			await client.connect(SESSION, undefined, undefined, undefined, undefined, {
				acrossMachines: false,
				verify: false,
			});
			assert.equal(client.isConnected(), true);
			await client.disconnect();
		}
		assert.deepEqual(
			received.map((frame) => frame.type),
			["register", "unregister", "register", "unregister"],
		);
	});

	test("a request of protocol 2 is refused with the typed protocol error before anything is sent to a broker that advertises no range", async () => {
		const received = await fakeBroker((socket) =>
			writeMessage(socket, { type: "registered", sessionId: "fake-session" }),
		);
		const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
		await client.connect(SESSION, undefined, undefined, undefined, undefined, {
			acrossMachines: false,
			verify: false,
		});
		try {
			assert.deepEqual(client.brokerProtocol, LEGACY_BROKER_PROTOCOL);
			const attempts: ReadonlyArray<readonly [string, () => Promise<void> | boolean]> = [
				["reserve_released_children", () => client.reserveReleasedChildren([{ childName: "worker", wake: false }])],
				["drop_released_children", () => client.dropReleasedChildren(["worker"])],
				["acknowledge_released_child_wake", () => client.acknowledgeReleasedChildWake("worker")],
				[
					"released_child_reply_ack",
					() =>
						client.acknowledgeReleasedChildReply(
							{
								childName: "worker",
								handoffId: "handoff",
								replyTo: "question",
								from: { ...SESSION, id: "peer" },
								message: { id: "reply", timestamp: 1, content: { text: "done" } },
							},
							true,
						),
				],
			];
			for (const [feature, attempt] of attempts) {
				const error = await (async () => {
					try {
						await attempt();
					} catch (caught) {
						return caught;
					}
					throw new Error(`${feature} was sent`);
				})();
				assert.ok(isIntercomBrokerProtocolError(error), String(error));
				assert.deepEqual(
					[
						error.code,
						error.feature,
						error.brokerProtocolMin,
						error.brokerProtocolMax,
						error.requiredProtocol,
						error.retryable,
					],
					["broker-protocol-unsupported", feature, 1, 1, 2, false],
				);
			}
			assert.equal(client.isConnected(), true);
			assert.deepEqual(
				received.map((frame) => frame.type),
				["register"],
			);
		} finally {
			await client.disconnect();
		}
	});

	test("a broker that advertises protocol 2 receives the request, and its range is the client's", async () => {
		const received = await fakeBroker((socket) =>
			writeMessage(socket, { type: "registered", sessionId: "fake-session", protocol: { min: 1, max: 2 } }),
		);
		const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
		await client.connect(SESSION, undefined, undefined, undefined, undefined, {
			acrossMachines: false,
			verify: true,
		});
		try {
			assert.deepEqual(client.brokerProtocol, { min: 1, max: 2 });
			void client.dropReleasedChildren(["worker"]).catch(() => {});
			await new Promise((settle) => setTimeout(settle, 50));
			assert.deepEqual(
				received.map((frame) => frame.type),
				["register_verified", "drop_released_children"],
			);
		} finally {
			await client.disconnect();
		}
		assert.deepEqual(client.brokerProtocol, LEGACY_BROKER_PROTOCOL);
	});

	for (const protocol of [{ min: 2, max: 1 }, { min: 0, max: 2 }, { min: 1 }, "2"]) {
		test(`a registered frame with the malformed protocol ${JSON.stringify(protocol)} fails the connection`, async () => {
			await fakeBroker((socket) =>
				writeMessage(socket, { type: "registered", sessionId: "fake-session", protocol }),
			);

			const error = await connectFailure(false, true);

			assert.ok(error instanceof Error);
			assert.match(error.message, /Invalid registered message/);
		});
	}
});
