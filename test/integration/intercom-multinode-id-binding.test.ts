import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import { type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/**
 * With multi-node routing, an Intercom session id is bound to the return address of the session that registered it:
 * a broker grants that id back only to the same return address, and a reply addressed to the id reaches only that
 * session, wherever and whenever it returns.
 */

/** Spawning three real broker processes (and restarting one) is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 90_000;
const WAIT = { timeout: 20_000, interval: 25 };
/** How long a reply that must not reach a session is given to show up there. */
const SETTLE_MS = 1_500;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start({ nodes: ["a", "b", "c"] });
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

/** The asker on `askerNode` asks the recipient on node b; resolves once the recipient has the question. */
async function askAcrossNodes(askerNode: "a" | "c") {
	const group = unique("g");
	const asker = await harness.connect(askerNode, unique("asker"), { group });
	const recipient = await harness.connect("b", unique("recipient"), { group });
	const askId = randomUUID();
	const sent = await asker.client.send(recipient.sessionId, {
		messageId: askId,
		text: "question",
		expectsReply: true,
	});
	assert.equal(sent.delivered, true, sent.reason);
	await vi.waitFor(() => assert.equal(recipient.messagesWithId(askId).length, 1), WAIT);
	return { group, asker, askerId: asker.sessionId, recipient, askId };
}

async function goAway(client: TwoBrokerClient): Promise<void> {
	await client.client.disconnect({ resumable: true });
	client.disconnected = true;
}

function repliesTo(client: TwoBrokerClient, askId: string): string[] {
	return client.received.filter((frame) => frame.message.replyTo === askId).map((frame) => frame.message.content.text);
}

async function reply(recipient: TwoBrokerClient, askerId: string, askId: string) {
	return recipient.client.send(askerId, {
		text: "answer",
		replyTo: askId,
		requirePendingReply: true,
		expectedRecipientId: askerId,
	});
}

test(
	"a reclaimed id on a restarted broker is granted only to the same return address",
	async () => {
		assert.ok(harness.multiNodeRouting, "the brokers route across nodes");
		const { group, asker, askerId, recipient, askId } = await askAcrossNodes("a");
		await goAway(asker);
		await harness.stopBroker("a", "SIGKILL");
		await harness.startBroker("a");

		const other = await harness.connect("a", unique("other"), { group, preferredSessionId: askerId });
		assert.notEqual(other.sessionId, askerId, "a different return address is not granted the id");
		const answered = await reply(recipient, askerId, askId);
		assert.equal(answered.delivered || answered.queued !== undefined, true, answered.reason);
		await sleep(SETTLE_MS);
		assert.deepEqual(repliesTo(other, askId), []);

		const back = await harness.connect("a", asker.name, {
			group,
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
		});
		assert.equal(back.sessionId, askerId, "the session that registered the id resumes under it");
		await vi.waitFor(() => assert.deepEqual(repliesTo(back, askId), ["answer"]), WAIT);
		assert.deepEqual(repliesTo(other, askId), []);
	},
	TEST_TIMEOUT_MS,
);

test(
	"an id is granted on a broker that never hosted it only to the same return address",
	async () => {
		assert.ok(harness.multiNodeRouting, "the brokers route across nodes");
		const { group, asker, askerId, recipient, askId } = await askAcrossNodes("a");
		await goAway(asker);

		const other = await harness.connect("c", unique("other"), { group, preferredSessionId: askerId });
		assert.notEqual(other.sessionId, askerId, "a different return address is not granted the id");
		const answered = await reply(recipient, askerId, askId);
		assert.equal(answered.delivered || answered.queued !== undefined, true, answered.reason);
		await sleep(SETTLE_MS);
		assert.deepEqual(repliesTo(other, askId), []);

		// The session that registered the id resumes under it on a broker that never hosted it.
		const back = await harness.connect("c", asker.name, {
			group,
			returnAddress: asker.returnAddress,
			preferredSessionId: askerId,
		});
		assert.equal(back.sessionId, askerId);
		await vi.waitFor(() => assert.deepEqual(repliesTo(back, askId), ["answer"]), WAIT);
		assert.deepEqual(repliesTo(other, askId), []);
	},
	TEST_TIMEOUT_MS,
);

/** A raw connection to `node`'s broker that records the frame types it is sent and whether it closed. */
async function rawConnection(node: "a" | "c") {
	const socket = net.connect(harness.socketPath(node));
	const frames: string[] = [];
	let closed = false;
	socket.on(
		"data",
		createMessageReader(
			(frame) => {
				if (typeof frame === "object" && frame !== null && !Array.isArray(frame) && typeof frame.type === "string")
					frames.push(frame.type);
			},
			() => socket.destroy(),
		),
	);
	socket.on("error", () => {});
	socket.on("close", () => {
		closed = true;
	});
	await new Promise<void>((resolveConnect) => socket.once("connect", () => resolveConnect()));
	const register = (returnAddress: string, preferredSessionId: string) =>
		writeMessage(socket, {
			type: "register",
			session: {
				name: unique("raw"),
				cwd: harness.root,
				model: "raw",
				pid: process.pid,
				startedAt: 1,
				lastActivity: 1,
			},
			returnAddress,
			preferredSessionId,
		});
	return { socket, frames, register, closed: () => closed };
}

test(
	"a connection that closes while its requested id is being claimed leaves the id to the session it is bound to",
	async () => {
		assert.ok(harness.multiNodeRouting, "the brokers route across nodes");
		const group = unique("g");
		const original = await harness.connect("a", unique("original"), { group });
		const id = original.sessionId;
		await goAway(original);
		const raw = await rawConnection("a");
		raw.register(original.returnAddress, id);
		raw.socket.destroy();
		await sleep(SETTLE_MS);

		const back = await harness.connect("a", original.name, {
			group,
			returnAddress: original.returnAddress,
			preferredSessionId: id,
		});
		assert.equal(back.sessionId, id);
	},
	TEST_TIMEOUT_MS,
);
