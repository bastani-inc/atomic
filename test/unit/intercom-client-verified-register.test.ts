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
const { isIntercomRoutingChangedError, isIntercomRoutingUnavailableError, isRetryableIntercomRoutingError } =
	await import("@bastani/atomic");

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

async function connectFailure(expectedAcrossMachines: boolean | undefined): Promise<unknown> {
	const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
	try {
		await client.connect(
			SESSION,
			undefined,
			undefined,
			undefined,
			undefined,
			expectedAcrossMachines === undefined ? undefined : { acrossMachines: expectedAcrossMachines },
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
				expected === undefined ? undefined : { acrossMachines: expected },
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
});
