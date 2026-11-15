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

/** Every frame the client wrote before `marker` reached the broker by the time `marker` did: its writes are ordered. */
async function confirmedBefore(client: InstanceType<typeof IntercomClient>, confirmed: string[], marker: string) {
	client.acknowledgeReceived(marker);
	await vi.waitFor(() => assert.ok(confirmed.includes(marker)));
	return confirmed.splice(0).filter((id) => id !== marker);
}

/** Every frame the broker wrote before `marker` reached the client by the time `marker` did. */
async function heardBefore(broker: net.Socket, heard: string[], marker: string) {
	writeMessage(broker, {
		type: "message",
		from: RECIPIENT,
		message: { id: marker, timestamp: 1, content: { text: marker } },
	});
	await vi.waitFor(() => assert.ok(heard.includes(marker)));
	return heard.splice(0).filter((id) => id !== marker);
}

function asker(acknowledgesReceipt: boolean) {
	const client = new IntercomClient("asker", {
		connectTimeoutMs: 2_000,
		...(acknowledgesReceipt ? { acknowledgesReceipt: true as const } : {}),
	});
	client.on("error", () => {});
	const heard: string[] = [];
	client.on("message", (_from, message: { id: string }) => heard.push(message.id));
	return { client, heard };
}

test("an asker hears a second outcome with the same message id once, and confirms it again once saved (#5145)", async () => {
	await withFakeBroker(async ({ sockets, confirmed }) => {
		const { client, heard } = asker(true);
		await client.connect(SESSION);
		const broker = sockets[0]!;
		writeMessage(broker, failureOf("ask-1"));
		writeMessage(broker, failureOf("ask-1"));
		assert.deepEqual(await heardBefore(broker, heard, "m1"), ["ended:ask-1"]);
		assert.deepEqual(await confirmedBefore(client, confirmed, "c1"), [], "not confirmed before it is saved");

		client.acknowledgeReceived("ended:ask-1");
		// Already saved: a later copy is confirmed again without being heard again.
		writeMessage(broker, failureOf("ask-1"));
		assert.deepEqual(await heardBefore(broker, heard, "m2"), []);
		assert.deepEqual(await confirmedBefore(client, confirmed, "c2"), ["ended:ask-1", "ended:ask-1"]);
		// A different outcome is still heard.
		writeMessage(broker, failureOf("ask-2"));
		assert.deepEqual(await heardBefore(broker, heard, "m3"), ["ended:ask-2"]);
		await client.disconnect();
	});
});

test("an asker hears a message that answers no ask each time it is sent (#5145)", async () => {
	await withFakeBroker(async ({ sockets }) => {
		const { client, heard } = asker(true);
		await client.connect(SESSION);
		const plain = {
			type: "message",
			from: RECIPIENT,
			message: { id: "plain-1", timestamp: 1, content: { text: "hi" } },
		};
		writeMessage(sockets[0]!, plain);
		writeMessage(sockets[0]!, plain);
		assert.deepEqual(await heardBefore(sockets[0]!, heard, "m1"), ["plain-1", "plain-1"]);
		await client.disconnect();
	});
});

test("an outcome an asker heard but never confirmed saved is heard again when its broker resends it on a new registration, and a saved one is not (#5145)", async () => {
	await withFakeBroker(async ({ sockets, confirmed }) => {
		const { client, heard } = asker(true);
		await client.connect(SESSION);
		writeMessage(sockets[0]!, failureOf("unsaved"));
		writeMessage(sockets[0]!, failureOf("saved"));
		assert.deepEqual(await heardBefore(sockets[0]!, heard, "m1"), ["ended:unsaved", "ended:saved"]);
		client.acknowledgeReceived("ended:saved");
		await client.disconnect();

		await client.connect(SESSION);
		writeMessage(sockets[1]!, failureOf("unsaved"));
		writeMessage(sockets[1]!, failureOf("saved"));
		assert.deepEqual(await heardBefore(sockets[1]!, heard, "m2"), ["ended:unsaved"]);
		assert.deepEqual(await confirmedBefore(client, confirmed, "c1"), ["ended:saved", "ended:saved"]);
		await client.disconnect();
	});
});

test("a client that does not confirm saves hears an outcome once, also after it registers again (#5145)", async () => {
	await withFakeBroker(async ({ sockets }) => {
		const { client, heard } = asker(false);
		await client.connect(SESSION);
		writeMessage(sockets[0]!, failureOf("ask-1"));
		assert.deepEqual(await heardBefore(sockets[0]!, heard, "m1"), ["ended:ask-1"]);
		await client.disconnect();

		await client.connect(SESSION);
		writeMessage(sockets[1]!, failureOf("ask-1"));
		assert.deepEqual(await heardBefore(sockets[1]!, heard, "m2"), []);
		await client.disconnect();
	});
});

test("an asker remembers the latest 1000 outcomes it heard, forgetting the oldest first (#5145)", async () => {
	await withFakeBroker(async ({ sockets }) => {
		const { client, heard } = asker(true);
		await client.connect(SESSION);
		const broker = sockets[0]!;
		for (let index = 0; index < 1_000; index++) writeMessage(broker, failureOf(`ask-${index}`));
		assert.equal((await heardBefore(broker, heard, "m1")).length, 1_000);
		writeMessage(broker, failureOf("ask-0"));
		writeMessage(broker, failureOf("ask-1000"));
		writeMessage(broker, failureOf("ask-1"));
		writeMessage(broker, failureOf("ask-0"));
		assert.deepEqual(await heardBefore(broker, heard, "m2"), ["ended:ask-1000", "ended:ask-0"]);
		await client.disconnect();
	});
});
