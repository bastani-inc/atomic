import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterAll, afterEach, beforeEach, describe, test, vi } from "vitest";

/**
 * A broker that retires can end a connection that is still registering. These tests pin what a client does about it:
 * name the loss so the recoverable-disconnect paths handle it, and spawn the replacement and register again.
 * The broker is a fake on the real socket path, so each case is deterministic rather than a race against a real exit.
 */

// A Unix socket path must fit in about 104 bytes, so the agent directory is short.
const agentDir = mkdtempSync(join(tmpdir(), "icr-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { createEventBus } = await import("../../packages/coding-agent/src/core/event-bus.js");
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerSocketPath, getIntercomDirPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { spawnBrokerIfNeeded } = await import("../../packages/intercom/broker/spawn.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { INTERCOM_RECOVERY_PEERS_EVENT } = await import("../../packages/intercom/session-recovery.js");
const { BROKER_READY_TIMEOUT_MS } = await import("../../packages/intercom/broker/startup-timeout.js");
const {
	BROKER_RETIRING_CODE,
	BROKER_RETIRING_REASON,
	IntercomBrokerRetiringError,
	isIntercomBrokerRetiring,
	isRecoverableIntercomDisconnect,
} = await import("../../packages/intercom/recoverable-disconnect.js");

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));

const servers: net.Server[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
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

type Frame = { type?: string; requestId?: string };
type OnRegister = (socket: net.Socket, server: net.Server, registrations: number) => void;

/** A broker on the real socket path that hands each `register` to `onRegister` and answers `list` with no sessions. */
async function fakeBroker(onRegister: OnRegister): Promise<net.Server> {
	mkdirSync(getIntercomDirPath(), { recursive: true, mode: 0o700 });
	let registrations = 0;
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					const message = frame as Frame;
					if (message.type === "register") onRegister(socket, server, ++registrations);
					if (message.type === "list")
						writeMessage(socket, { type: "sessions", requestId: message.requestId, sessions: [] });
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(), resolve));
	servers.push(server);
	return server;
}

const registered = (socket: net.Socket) => writeMessage(socket, { type: "registered", sessionId: "fake-session" });
const retiring = (socket: net.Socket) => {
	writeMessage(socket, { type: "registration_failed", reason: BROKER_RETIRING_REASON, code: BROKER_RETIRING_CODE });
	socket.end();
};

function registration() {
	const now = Date.now();
	return {
		name: "retiring-test",
		model: "retiring-test-model",
		cwd: agentDir,
		pid: process.pid,
		status: "idle",
		startedAt: now,
		lastActivity: now,
		group: "retiring-test",
		groups: ["retiring-test"],
	};
}

async function connectFailure(): Promise<unknown> {
	const client = new IntercomClient("retiring-test-address");
	try {
		await client.connect(registration());
	} catch (error) {
		return error;
	}
	await client.disconnect();
	throw new Error("the connection was expected to fail");
}

describe("a client that loses the race with a retiring broker", () => {
	test("is told so by the broker's typed refusal, which is a recoverable disconnect", async () => {
		await fakeBroker(retiring);

		const error = await connectFailure();

		assert.ok(error instanceof IntercomBrokerRetiringError, String(error));
		assert.equal(error.message, BROKER_RETIRING_REASON);
		assert.ok(isIntercomBrokerRetiring(error));
		assert.ok(isRecoverableIntercomDisconnect(error));
	});

	test("finds a broker that ended the connection and then went away recoverable, with the loss as its cause", async () => {
		await fakeBroker((socket, server) => {
			server.close();
			socket.destroy();
		});

		const error = await connectFailure();

		assert.ok(error instanceof IntercomBrokerRetiringError, String(error));
		assert.ok(isRecoverableIntercomDisconnect(error));
		assert.ok(error.cause instanceof Error);
		// Startup classification still reads the wording of what reaches `session_start`.
		assert.match(error.message, /broker went away before it registered this session/u);
	});

	test("finds a connection that no broker answers at all recoverable", async () => {
		const error = await connectFailure();

		assert.ok(error instanceof IntercomBrokerRetiringError, String(error));
		assert.ok(isRecoverableIntercomDisconnect(error));
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
	});

	test("keeps the failure a broker that is still answering caused, which no replacement can fix", async () => {
		await fakeBroker((socket) => socket.destroy());

		const error = await connectFailure();

		assert.ok(error instanceof Error);
		assert.equal(isRecoverableIntercomDisconnect(error), false, String(error));
		assert.match(error.message, /closed before registration|ECONNRESET/u);
	});

	test("keeps a refusal whose code it does not know as the plain error it has always been", async () => {
		await fakeBroker((socket) => {
			writeMessage(socket, {
				type: "registration_failed",
				reason: "Invalid supervisor authorization",
				code: "from_the_future",
			});
			socket.end();
		});

		const error = await connectFailure();

		assert.ok(error instanceof Error);
		assert.equal(isRecoverableIntercomDisconnect(error), false);
		assert.equal(error.message, "Invalid supervisor authorization");
	});
});

describe("a session that starts while its broker retires", () => {
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
	let events = createEventBus();

	beforeEach(() => {
		handlers.clear();
		events = createEventBus();
		vi.mocked(spawnBrokerIfNeeded).mockReset();
		vi.mocked(spawnBrokerIfNeeded).mockResolvedValue(undefined);
	});

	async function startSession(): Promise<() => Promise<void>> {
		const pi = {
			on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			async appendEntry() {},
			getSessionName: () => undefined,
			events,
		};
		intercomHeavy(pi as never);
		const ctx = {
			hasUI: false,
			cwd: process.cwd(),
			isIdle: () => true,
			ui: { notify() {} },
			sessionManager: { getSessionId: () => "retiring-startup", getEntries: () => [], getBranch: () => [] },
		} as unknown as ExtensionContext;
		const fire = async (name: string) => {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: "startup" } as never, ctx);
		};
		await fire("session_start");
		return () => fire("session_shutdown");
	}

	async function connectThroughExtension(): Promise<unknown[]> {
		const request: { completion?: Promise<unknown[]> } = {};
		events.emit(INTERCOM_RECOVERY_PEERS_EVENT, request);
		return (await request.completion) ?? [];
	}

	test("spawns the replacement broker and registers with it instead of failing", async () => {
		await fakeBroker((socket, _server, registrations) =>
			registrations === 1 ? retiring(socket) : registered(socket),
		);
		const shutdown = await startSession();
		try {
			assert.deepEqual(await connectThroughExtension(), []);
			// One spawn per attempt: the second attempt is the one that finds the replacement broker.
			assert.equal(vi.mocked(spawnBrokerIfNeeded).mock.calls.length, 2);
			// Every attempt waits for the broker for the configured budget, which defaults to the measured one.
			assert.deepEqual(
				vi.mocked(spawnBrokerIfNeeded).mock.calls.map((call) => call[2]),
				[BROKER_READY_TIMEOUT_MS, BROKER_READY_TIMEOUT_MS],
			);
		} finally {
			await shutdown();
		}
	});

	test("starts from a broker that went away the same way", async () => {
		await fakeBroker((socket, server, registrations) => {
			if (registrations > 1) return registered(socket);
			socket.destroy();
			// The first broker is gone; the replacement listens again once the client has spawned it.
			server.close();
			vi.mocked(spawnBrokerIfNeeded).mockImplementationOnce(async () => {
				await fakeBroker((replacement) => registered(replacement));
			});
		});
		const shutdown = await startSession();
		try {
			assert.deepEqual(await connectThroughExtension(), []);
			assert.equal(vi.mocked(spawnBrokerIfNeeded).mock.calls.length, 2);
		} finally {
			await shutdown();
		}
	});

	test("hands the failure on when a broker that still answers keeps closing the connection", async () => {
		await fakeBroker((socket) => socket.destroy());
		const shutdown = await startSession();
		try {
			await assert.rejects(connectThroughExtension, (error: unknown) => {
				assert.equal(isRecoverableIntercomDisconnect(error), false, String(error));
				return true;
			});
			// No replacement can help a broker that answers: the one start-up attempt is all there is.
			assert.equal(vi.mocked(spawnBrokerIfNeeded).mock.calls.length, 1);
		} finally {
			await shutdown();
		}
	});
});
