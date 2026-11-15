import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "held-reply-closed-registration-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { BROKER_PROTOCOL } = await import("../../packages/intercom/broker/protocol-version.js");
const { HELD_FOR_AWAY_ASKER_TARGET } = await import("../../packages/intercom/broker/held-reply-targets.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;

/** Spawning the real broker child is the structural cost of this suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 10_000, interval: 20 };
/** The fixture broker closes the socket of a session registering under this name right after writing `registered`. */
const CLOSES_ON_REGISTERED_NAME = "closes-on-registered";

function sessionInfo(name: string) {
	return {
		name,
		model: "test-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle" as const,
		startedAt: Date.now(),
		lastActivity: Date.now(),
	};
}

/** A client from before receipts existed: it never confirms saving what it receives. */
async function connectLegacy(name: string, returnAddress: string): Promise<{ client: Client; received: Message[] }> {
	const client = new IntercomClient(returnAddress);
	const received: Message[] = [];
	client.on("message", (_from: object, message: Message) => received.push(message));
	client.on("error", () => {});
	await client.connect(sessionInfo(name));
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, received };
}

beforeAll(async () => {
	const broker: ChildProcess = spawn(
		process.execPath,
		[
			getJitiCliPath(join(repoRoot, "packages/intercom")),
			join(repoRoot, "test/fixtures/intercom-broker-closes-on-registered.ts"),
		],
		{ env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir }, stdio: "ignore" },
	);
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
}, REAL_BROKER_TEST_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

test(
	"a reply held for a legacy asker whose socket closes during registration is kept for its next connection (#5149)",
	async () => {
		const returnAddress = randomUUID();
		const asker = await connectLegacy("asker", returnAddress);
		const recipient = await connectLegacy("recipient", randomUUID());
		const askerId = asker.client.sessionId;
		assert.ok(askerId);
		const questionId = randomUUID();
		const asked = await asker.client.send("recipient", {
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
		assert.equal(reply.target, HELD_FOR_AWAY_ASKER_TARGET, JSON.stringify(reply));

		// The asker comes back, but its socket closes while the broker completes its registration.
		const closing = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
		closing.on("error", () => {});
		// Read what arrives, so the broker closing the socket ends it.
		closing.resume();
		await new Promise<void>((resolveConnected) => closing.once("connect", () => resolveConnected()));
		const closed = new Promise<void>((resolveClosed) => closing.once("close", () => resolveClosed()));
		writeMessage(closing, {
			type: "register",
			session: sessionInfo(CLOSES_ON_REGISTERED_NAME),
			protocol: { ...BROKER_PROTOCOL },
			returnAddress,
		});
		await closed;

		const back = await connectLegacy("asker", returnAddress);
		await vi.waitFor(() => assert.ok(back.received.some((message) => message.id === replyId)), WAIT);
		assert.equal(back.received.find((message) => message.id === replyId)?.replyTo, questionId);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
