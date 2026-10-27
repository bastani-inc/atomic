import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";

const agentDir = mkdtempSync(join(tmpdir(), "intercom-backlog-refusal-"));
const socketPath = getBrokerSocketPath(process.platform, agentDir);
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "intercom"), { recursive: true });
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

afterAll(() => {
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

/** A socket file nobody listens on: connecting to it is refused, as a full listen backlog refuses a connection. */
async function leaveStaleSocket(path: string): Promise<void> {
	const holder = spawn(
		process.execPath,
		["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"))`],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((resolveUp) => holder.stdout!.once("data", () => resolveUp()));
	holder.kill("SIGKILL");
	await new Promise((resolveExit) => holder.once("exit", resolveExit));
	assert.ok(existsSync(path), "the killed listener leaves its socket file behind");
}

/** Enough of a broker to register a client; counts the connections it accepted and the registrations it saw. */
const brokerSeen = { connections: 0, registrations: 0 };
function startBroker(path: string): net.Server {
	if (existsSync(path)) unlinkSync(path);
	const server = net.createServer((socket) => {
		brokerSeen.connections += 1;
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if ((message as { type?: string }).type === "register") brokerSeen.registrations += 1;
					if ((message as { type?: string }).type === "register")
						writeMessage(socket, { type: "registered", sessionId: "registered-after-refusal" });
				},
				() => socket.destroy(),
			),
		);
	});
	server.listen(path);
	return server;
}

test.skipIf(process.platform === "win32")(
	"a broker connection refused before it reaches the broker is retried instead of failing the session (#3904)",
	async () => {
		await leaveStaleSocket(socketPath);
		let attempts = 0;
		let broker: net.Server | undefined;
		const connect = net.connect;
		// The first attempt is refused; the broker accepts once that refusal has happened, as a drained backlog would.
		const spy = vi.spyOn(net, "connect").mockImplementation(((...args: Parameters<typeof net.connect>) => {
			const socket = connect(...args);
			attempts += 1;
			if (attempts === 1)
				socket.once("error", () => {
					broker = startBroker(socketPath);
				});
			return socket;
		}) as typeof net.connect);
		const client = new IntercomClient();
		client.on("error", () => {});
		try {
			await client.connect({
				name: "backlog",
				cwd: "/tmp",
				model: "test",
				pid: process.pid,
				startedAt: 1,
				lastActivity: 1,
			});
			assert.equal(client.sessionId, "registered-after-refusal");
			assert.ok(attempts >= 2, `connected in ${attempts} attempt(s)`);
		} finally {
			spy.mockRestore();
			await client.disconnect().catch(() => {});
			await new Promise<void>((resolveClose) => (broker ? broker.close(() => resolveClose()) : resolveClose()));
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a broker that keeps refusing still fails the connection after the bounded retries (#3904)",
	async () => {
		await leaveStaleSocket(socketPath);
		let attempts = 0;
		const connect = net.connect;
		const spy = vi.spyOn(net, "connect").mockImplementation(((...args: Parameters<typeof net.connect>) => {
			attempts += 1;
			return connect(...args);
		}) as typeof net.connect);
		const client = new IntercomClient();
		client.on("error", () => {});
		try {
			await assert.rejects(
				client.connect({
					name: "refused",
					cwd: "/tmp",
					model: "test",
					pid: process.pid,
					startedAt: 1,
					lastActivity: 1,
				}),
				(error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED",
			);
			assert.ok(attempts > 1 && attempts <= 10, `gave up after ${attempts} attempts`);
		} finally {
			spy.mockRestore();
			if (existsSync(socketPath)) unlinkSync(socketPath);
		}
	},
);

/** Longer than every retry delay the client could still have pending (6 jittered doublings from 25 ms). */
const ALL_RETRY_DELAYS_MS = 25 * 2 ** 7;
const SESSION = { name: "cancelled", cwd: "/tmp", model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 };

test.skipIf(process.platform === "win32")(
	"disconnect during a refused connection's retry delay cancels the retry: no later connection or registration (#3904)",
	async () => {
		await leaveStaleSocket(socketPath);
		brokerSeen.connections = 0;
		brokerSeen.registrations = 0;
		const refused = Promise.withResolvers<void>();
		const connect = net.connect;
		let attempts = 0;
		const spy = vi.spyOn(net, "connect").mockImplementation(((...args: Parameters<typeof net.connect>) => {
			const socket = connect(...args);
			attempts += 1;
			socket.once("error", () => refused.resolve());
			return socket;
		}) as typeof net.connect);
		const client = new IntercomClient();
		client.on("error", () => {});
		let broker: net.Server | undefined;
		try {
			const connecting = client.connect(SESSION);
			// The first attempt is refused; the client now waits to retry. The session shuts down meanwhile.
			await refused.promise;
			await client.disconnect();
			await assert.rejects(connecting, (error: Error) => error instanceof IntercomClientDisconnectedError);
			// The broker comes up afterwards: nothing may reach it.
			broker = startBroker(socketPath);
			await new Promise((resolveWait) => setTimeout(resolveWait, ALL_RETRY_DELAYS_MS));
			assert.equal(attempts, 1, "no connection was attempted after disconnect");
			assert.deepEqual(brokerSeen, { connections: 0, registrations: 0 });
			assert.equal(client.sessionId, null);
			assert.equal(client.isConnected(), false);
		} finally {
			spy.mockRestore();
			await client.disconnect().catch(() => {});
			await new Promise<void>((resolveClose) => (broker ? broker.close(() => resolveClose()) : resolveClose()));
		}
	},
);

test.skipIf(process.platform === "win32")(
	"disconnect while the broker connection is still opening closes it before it registers (#3904)",
	async () => {
		brokerSeen.connections = 0;
		brokerSeen.registrations = 0;
		const broker = startBroker(socketPath);
		await new Promise<void>((resolveListening) => broker.once("listening", () => resolveListening()));
		const client = new IntercomClient();
		client.on("error", () => {});
		try {
			const connecting = client.connect(SESSION);
			// The socket exists but has not connected yet: the session shuts down right away.
			await client.disconnect();
			await assert.rejects(connecting, (error: Error) => error instanceof IntercomClientDisconnectedError);
			await new Promise((resolveWait) => setTimeout(resolveWait, ALL_RETRY_DELAYS_MS));
			assert.equal(brokerSeen.registrations, 0, "the cancelled connection never registered");
			assert.equal(client.sessionId, null);
			assert.equal(client.isConnected(), false);
		} finally {
			await client.disconnect().catch(() => {});
			await new Promise<void>((resolveClose) => broker.close(() => resolveClose()));
		}
	},
);
