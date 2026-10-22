import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { getBrokerSocketPath } from "../../packages/intercom/broker/paths.js";
import { isRecoverableIntercomDisconnect } from "../../packages/intercom/recoverable-disconnect.js";
import { makeDirectorySync, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const agentDir = makeTempDirectory("ic3862-client-");
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
makeDirectorySync(join(agentDir, "intercom"), { recursive: true });
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const clients: InstanceType<typeof IntercomClient>[] = [];
const sockets = new Set<net.Socket>();
let server: net.Server;
let answerHealth = false;
let refuseHealth = false;

let healthRequests = 0;
beforeAll(async () => {
	server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.on(
			"data",
			createMessageReader(
				(message) => {
					if (typeof message !== "object" || message === null || Array.isArray(message)) return;
					if (message.type === "register")
						writeMessage(socket, { type: "registered", sessionId: "silent-client" });
					if (message.type === "list_groups" && answerHealth) {
						writeMessage(socket, { type: "groups", requestId: message.requestId, groups: [] });
					}
					if (message.type === "list_groups") healthRequests += 1;
					if (message.type === "list_groups" && refuseHealth) {
						writeMessage(socket, { type: "registration_failed", reason: "route authorization refused" });
					}
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(process.platform, agentDir), resolve));
});

afterEach(async () => {
	for (const client of clients.splice(0)) await client.disconnect();
	for (const socket of sockets) socket.destroy();
	answerHealth = false;
	refuseHealth = false;
	healthRequests = 0;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
	removeTempDirectory(agentDir);
});

async function connect() {
	const client = new IntercomClient();
	clients.push(client);
	client.on("error", () => {});
	await client.connect({ cwd: agentDir, model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 });
	return client;
}

test("a silent connected broker invalidates the connection after a bounded health check (#3862)", async () => {
	const client = await connect();
	await assert.rejects(client.listSessions(), (error: Error) => {
		assert.equal(isRecoverableIntercomDisconnect(error), true);
		return true;
	});
	assert.equal(client.isConnected(), false);
});

test("a timed-out operation leaves a responsive broker connected (#3862)", async () => {
	answerHealth = true;
	const client = await connect();
	await assert.rejects(client.listSessions(), /List sessions timeout/u);
	assert.equal(client.isConnected(), true);
	assert.deepEqual(await client.listGroups(), []);
});

test("concurrent timeouts share one health probe on their connection (#3862)", async () => {
	const client = await connect();
	const results = await Promise.allSettled([client.listSessions(), client.listSessions(), client.joinGroup("test")]);
	assert.equal(
		results.every((result) => result.status === "rejected" && isRecoverableIntercomDisconnect(result.reason)),
		true,
	);
	assert.equal(healthRequests, 1);
	assert.equal(client.isConnected(), false);
});

test("a send timeout also invalidates a silent broker connection (#3862)", async () => {
	const client = await connect();
	await assert.rejects(client.send("peer", { text: "hello" }), (error: Error) =>
		isRecoverableIntercomDisconnect(error),
	);
	assert.equal(client.isConnected(), false);
});

test("a refusal received during a health check stays non-recoverable (#3862)", async () => {
	refuseHealth = true;
	const client = await connect();
	await assert.rejects(client.listSessions(), (error: Error) => {
		assert.equal(error.message, "route authorization refused");
		assert.equal(isRecoverableIntercomDisconnect(error), false);
		return true;
	});
	assert.equal(client.isConnected(), false);
});
