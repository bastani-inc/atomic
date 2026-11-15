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

const RECIPIENT = {
	id: "recipient-session",
	name: "recipient",
	cwd: "/recipient",
	model: "m",
	pid: 2,
	startedAt: 1,
	lastActivity: 1,
};

async function withFakeBroker(
	run: (broker: { sockets: net.Socket[]; confirmed: string[] }) => Promise<void>,
): Promise<void> {
	mkdirSync(getIntercomDirPath(), { recursive: true, mode: 0o700 });
	const sockets: net.Socket[] = [];
	const confirmed: string[] = [];
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		sockets.push(socket);
		socket.on(
			"data",
			createMessageReader(
				(frame) => {
					const { type, messageId } = frame as { type?: string; messageId?: string };
					if (type === "register" || type === "register_verified")
						writeMessage(socket, { type: "registered", sessionId: "asker-session", acknowledgesReceipt: true });
					if (type === "received" && messageId !== undefined) confirmed.push(messageId);
				},
				() => socket.destroy(),
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(getBrokerSocketPath(), resolve));
	try {
		await run({ sockets, confirmed });
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function failureOf(askId: string) {
	const reason = 'Session "recipient" ended before replying';
	return {
		type: "message",
		from: RECIPIENT,
		message: { id: `ended:${askId}`, timestamp: 1, replyTo: askId, replyError: reason, content: { text: reason } },
	};
}

const SESSION = { cwd: "/asker", model: "m", pid: process.pid, startedAt: 1, lastActivity: 1 };

test("an asker hears a second outcome with the same message id once, and confirms it again once saved (#5145)", async () => {
	await withFakeBroker(async ({ sockets, confirmed }) => {
		const client = new IntercomClient("asker", { connectTimeoutMs: 2_000, acknowledgesReceipt: true });
		client.on("error", () => {});
		const heard: string[] = [];
		client.on("message", (_from, message: { id: string }) => heard.push(message.id));
		await client.connect(SESSION);
		const broker = sockets[0]!;
		writeMessage(broker, failureOf("ask-1"));
		writeMessage(broker, failureOf("ask-1"));
		await vi.waitFor(() => assert.deepEqual(heard, ["ended:ask-1"]));
		client.acknowledgeReceived("ended:ask-1");
		await vi.waitFor(() => assert.deepEqual(confirmed, ["ended:ask-1"]));

		// Already saved: a later copy is confirmed again without being heard again.
		writeMessage(broker, failureOf("ask-1"));
		await vi.waitFor(() => assert.deepEqual(confirmed, ["ended:ask-1", "ended:ask-1"]));
		// A different outcome is still heard.
		writeMessage(broker, failureOf("ask-2"));
		await vi.waitFor(() => assert.deepEqual(heard, ["ended:ask-1", "ended:ask-2"]));
		await client.disconnect();
	});
});

test("an outcome an asker heard but never confirmed saved is heard again when its broker resends it on a new registration (#5145)", async () => {
	await withFakeBroker(async ({ sockets }) => {
		const client = new IntercomClient("asker", { connectTimeoutMs: 2_000, acknowledgesReceipt: true });
		client.on("error", () => {});
		const heard: string[] = [];
		client.on("message", (_from, message: { id: string }) => heard.push(message.id));
		await client.connect(SESSION);
		writeMessage(sockets[0]!, failureOf("ask-1"));
		await vi.waitFor(() => assert.deepEqual(heard, ["ended:ask-1"]));
		await client.disconnect();

		await client.connect(SESSION);
		writeMessage(sockets[1]!, failureOf("ask-1"));
		await vi.waitFor(() => assert.deepEqual(heard, ["ended:ask-1", "ended:ask-1"]));
		await client.disconnect();
	});
});
