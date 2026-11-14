import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "away-asks-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { HELD_FOR_AWAY_ASKER_TARGET } = await import("../../packages/intercom/broker/held-reply-targets.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;

/** Spawning, and restarting, the real broker child is the structural cost of this suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 10_000, interval: 20 };
/** Long enough for a frame the broker wrote to arrive, so its absence means none was written. */
const SETTLE_MS = 300;

let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await vi.waitFor(async () => {
		brokerFixture.assertRunning();
		const connected = await new Promise<boolean>((resolveConnected) => {
			const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
			socket.once("connect", () => {
				socket.destroy();
				resolveConnected(true);
			});
			socket.once("error", () => resolveConnected(false));
		});
		assert.ok(connected);
	}, WAIT);
}

async function restartBroker(): Promise<void> {
	const running = broker;
	if (running !== undefined && running.exitCode === null) {
		const exited = new Promise<void>((resolveExit) => running.once("exit", () => resolveExit()));
		running.kill("SIGTERM");
		await exited;
	}
	await startBroker();
}

/** A real client that records what arrives and confirms each save, as a session does. */
async function connect(
	name: string,
	options: { returnAddress?: string; preferredSessionId?: string } = {},
): Promise<{ client: Client; received: Message[] }> {
	const client = new IntercomClient(options.returnAddress ?? randomUUID(), {
		acknowledgesReceipt: true,
		...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
	});
	const received: Message[] = [];
	client.on("message", (_from: object, message: Message) => {
		received.push(message);
		client.acknowledgeReceived(message.id);
	});
	client.on("error", () => {});
	await client.connect({
		name,
		model: "test-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
	});
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, received };
}

function idOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

/** An asker asks, then its session closes (it can be resumed); the recipient's reply is held for it. */
async function askThenClose(label: string) {
	const returnAddress = randomUUID();
	const asker = await connect(`asker-${label}`, { returnAddress });
	const recipient = await connect(`recipient-${label}`);
	const askerId = idOf(asker.client);
	const questionId = randomUUID();
	const asked = await asker.client.send(`recipient-${label}`, {
		messageId: questionId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);
	await asker.client.disconnect({ resumable: true });
	const replyId = randomUUID();
	const reply = await recipient.client.send(askerId, {
		messageId: replyId,
		text: "port 8080",
		replyTo: questionId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
	assert.equal(reply.queued, true, JSON.stringify(reply));
	assert.equal(reply.target, HELD_FOR_AWAY_ASKER_TARGET);
	return { label, returnAddress, askerId, questionId, replyId, recipient };
}

beforeAll(startBroker, REAL_BROKER_TEST_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

test(
	"a reply held for a closed asker reaches only that asker, which no other session can claim or erase, after a broker restart (#4751)",
	async () => {
		const held = await askThenClose("claim");
		await held.recipient.client.disconnect({ resumable: true });
		// The broker restarts: it no longer remembers who held the asker's id before.
		await restartBroker();
		const impostor = await connect("impostor", { preferredSessionId: held.askerId });
		assert.equal(idOf(impostor.client), held.askerId, "another session took the away asker's id");
		await sleep(SETTLE_MS);
		assert.deepEqual(impostor.received, [], "a held reply goes only to the asker that proves itself");
		// Nor can it erase the held reply by claiming to have saved it, or by ending the asker's session.
		impostor.client.acknowledgeReceived(held.replyId);
		await impostor.client.disconnect();

		const asker = await connect(`asker-${held.label}`, {
			returnAddress: held.returnAddress,
			preferredSessionId: held.askerId,
		});
		// The asker's own session gets what was held for it, whatever Intercom id it registered under this time.
		await vi.waitFor(() => assert.equal(asker.received.length, 1), WAIT);
		assert.deepEqual(
			{ id: asker.received[0]?.id, replyTo: asker.received[0]?.replyTo },
			{ id: held.replyId, replyTo: held.questionId },
		);
		await asker.client.disconnect({ resumable: true });
		const again = await connect(`asker-${held.label}`, {
			returnAddress: held.returnAddress,
			preferredSessionId: held.askerId,
		});
		await sleep(SETTLE_MS);
		assert.deepEqual(again.received, [], "a saved held reply is delivered once");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an answered ask held for a closed asker does not also fail when its recipient then ends (#4751)",
	async () => {
		const held = await askThenClose("answered");
		// The recipient's session ends for good after it answered.
		await held.recipient.client.disconnect();
		const asker = await connect(`asker-${held.label}`, {
			returnAddress: held.returnAddress,
			preferredSessionId: held.askerId,
		});
		await vi.waitFor(() => assert.equal(asker.received.length, 1), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(
			asker.received.map((message) => ({ id: message.id, failed: message.replyError !== undefined })),
			[{ id: held.replyId, failed: false }],
			"the resumed asker gets only the answer",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
