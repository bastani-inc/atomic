import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "icm-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getBrokerSocketPath, getIntercomDirPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test("a client forgets the broker's ended-subagent capability when its connection closes (#4639)", async () => {
	mkdirSync(getIntercomDirPath(), { recursive: true, mode: 0o700 });
	const brokers: net.Socket[] = [];
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		brokers.push(socket);
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					const type = (frame as { type?: string }).type;
					if (type === "register" || type === "register_verified")
						writeMessage(socket, { type: "registered", sessionId: "fake-session", marksEndedChildren: true });
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(), resolve));
	try {
		const client = new IntercomClient("client-under-test", { connectTimeoutMs: 2_000 });
		client.on("error", () => {});
		const disconnected = new Promise<void>((resolve) => client.once("disconnected", () => resolve()));
		await client.connect({ cwd: "/client", model: "m", pid: process.pid, startedAt: 1, lastActivity: 1 });
		assert.equal(client["brokerMarksEndedChildren"], true);
		for (const socket of brokers) socket.destroy();
		await disconnected;
		await vi.waitFor(() => assert.equal(client.isConnected(), false));
		assert.equal(client["brokerMarksEndedChildren"], false);
		await client.markEndedChildren([{ childName: "subagent-worker-1", outcome: "completed" }]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
