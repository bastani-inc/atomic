import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PendingRecoveryDelivery } from "@bastani/atomic";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import type { SendResult } from "../../packages/intercom/broker/client.js";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { planIntercomRecoveryReplay } from "../../packages/intercom/session-recovery.js";
import { type ReceivedFrame, type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";

/** Spawning two real broker processes (and restarting them) is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
/** Headroom on top of the lease, claim and poll windows a cross-node recovery has to wait out. */
const RECOVERY_MARGIN_MS = 30_000;
const DELIVERY_WAIT_MS = 15_000;
const OFFLINE_QUEUED_TEST_TIMEOUT_MS =
	BROKER_LEASE_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS + RECOVERY_MARGIN_MS;
const BROKER_KILL_WAIT_MS = BROKER_LEASE_STALE_AFTER_MS + OUTBOX_CLAIM_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS;
const BROKER_KILL_TEST_TIMEOUT_MS = BROKER_KILL_WAIT_MS + RECOVERY_MARGIN_MS;
const LOST_WAKE_UP_WAIT_MS = 2 * OUTBOX_BACKUP_POLL_INTERVAL_MS;
const LOST_WAKE_UP_TEST_TIMEOUT_MS = LOST_WAKE_UP_WAIT_MS + RECOVERY_MARGIN_MS;
const VERBATIM_TEXT = "  cross-node\tparity\u0000 ünïcödé ✓  \n";
const ATTACHMENTS = [{ type: "snippet" as const, name: "a.ts", content: "const x = 1;\n", language: "ts" }];

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

async function waitForMessage(client: TwoBrokerClient, id: string, timeout = DELIVERY_WAIT_MS): Promise<ReceivedFrame> {
	return vi.waitFor(
		() => {
			const [frame] = client.messagesWithId(id);
			assert.ok(frame, `${client.name} has not received ${id}`);
			return frame;
		},
		{ timeout, interval: 25 },
	);
}

/** Without advertised routing, a session on the other broker is unknown and nothing crosses nodes. */
async function assertUnrouted(from: TwoBrokerClient, to: TwoBrokerClient): Promise<void> {
	const result = await from.client.send(to.sessionId, { text: "single-node probe" });
	assert.equal(result.delivered, false);
	assert.equal(result.queued, undefined);
	assert.equal(result.reason, "Session not found");
	assert.deepEqual(to.received, []);
}

/** The same-id retry is answered from the outbox row, so it settles once the row is delivered (spec §6). */
async function confirmDelivered(
	sender: TwoBrokerClient,
	to: string,
	text: string,
	messageId: string,
	timeout: number,
): Promise<void> {
	await vi.waitFor(
		async () => {
			const result = await sender.client.send(to, { text, messageId });
			assert.equal(result.delivered, true, JSON.stringify(result));
		},
		{ timeout, interval: 500 },
	);
}

function outcome(result: SendResult, target: TwoBrokerClient) {
	return {
		delivered: result.delivered,
		queued: result.queued === true,
		reasonCode: result.reasonCode,
		reason: result.reason?.replaceAll(target.sessionId, "<target>").replaceAll(target.name, "<target-name>"),
	};
}

/** What the recipient's card is built from, minus the per-send id and clock. */
function card(frame: ReceivedFrame) {
	return { from: frame.from, channel: frame.channel, message: { ...frame.message, id: "<id>", timestamp: 0 } };
}

function anonymousSender(frame: ReceivedFrame) {
	const { from, message } = card(frame);
	return {
		...card(frame),
		from: { ...from, id: "<sender>", name: "<sender>", startedAt: 0, lastActivity: 0 },
		message: { ...message, replyTo: "<ask>" },
	};
}

test(
	"harness self-test: two brokers on separate sockets each serve only their own clients and share one storage file",
	async () => {
		assert.notEqual(harness.socketPath("a"), harness.socketPath("b"));
		assert.notEqual(harness.agentDir("a"), harness.agentDir("b"));
		assert.ok(harness.brokerPid("a") !== undefined && harness.brokerPid("b") !== undefined);
		assert.notEqual(harness.brokerPid("a"), harness.brokerPid("b"));

		const onA = await harness.connect("a", unique("self-a"));
		const onB = await harness.connect("b", unique("self-b"));
		assert.ok((await onA.client.listSessions()).some((session) => session.id === onA.sessionId));
		assert.ok((await onB.client.listSessions()).some((session) => session.id === onB.sessionId));

		const fromA = await harness.openSharedStorage("a");
		const fromB = await harness.openSharedStorage("b");
		assert.deepEqual(fromA.descriptor, fromB.descriptor);
		assert.equal(fromA.descriptor.location, harness.sharedDatabasePath);
		await fromA.exec("CREATE TABLE IF NOT EXISTS harness_probe (node TEXT NOT NULL)");
		await fromA.run("INSERT INTO harness_probe VALUES (?)", "a");
		await fromB.run("INSERT INTO harness_probe VALUES (?)", "b");
		for (const database of [fromA, fromB]) {
			const rows = await database.all("SELECT node FROM harness_probe ORDER BY node");
			assert.deepEqual(
				rows.map((row) => row.node),
				["a", "b"],
			);
		}

		await harness.stopBroker("b", "SIGTERM");
		assert.equal(onB.disconnected, true);
		assert.equal(onA.disconnected, false);
		assert.equal(onA.client.isConnected(), true);
		assert.ok((await onA.client.listSessions()).some((session) => session.id === onA.sessionId));
		await harness.startBroker("b");
		assert.equal(harness.isBrokerRunning("b"), true);
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);

test("cross-node send delivers the exact frame and reports delivered after the recipient saves it", async ({
	annotate,
}) => {
	const sender = await harness.connect("a", unique("send-sender"));
	const recipient = await harness.connect("b", unique("send-recipient"));
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
		await assertUnrouted(sender, recipient);
		return;
	}
	const result = await sender.client.send(recipient.name, { text: VERBATIM_TEXT, attachments: ATTACHMENTS });
	assert.equal(result.delivered, true, JSON.stringify(result));
	const frame = await waitForMessage(recipient, result.id);
	assert.equal(recipient.messagesWithId(result.id).length, 1);
	assert.equal(frame.channel, undefined);
	assert.equal(frame.from.id, sender.sessionId);
	assert.equal(frame.message.content.text, VERBATIM_TEXT);
	assert.deepEqual(frame.message.content.attachments, ATTACHMENTS);
});

async function askAndReply(asker: TwoBrokerClient, replier: TwoBrokerClient) {
	const ask = await asker.client.send(replier.name, { text: "what is the status?", expectsReply: true });
	const askFrame = await waitForMessage(replier, ask.id);
	assert.equal(askFrame.message.expectsReply, true);
	const reply = await replier.client.send(asker.sessionId, {
		text: "all green",
		replyTo: ask.id,
		requirePendingReply: true,
	});
	const replyFrame = await waitForMessage(asker, reply.id);
	assert.equal(replyFrame.from.id, replier.sessionId);
	assert.equal(replyFrame.message.replyTo, ask.id);
	const repeated = await replier.client.send(asker.sessionId, {
		text: "all green again",
		replyTo: ask.id,
		requirePendingReply: true,
	});
	return {
		ask: outcome(ask, replier),
		askCard: card(askFrame),
		reply: outcome(reply, asker),
		replyCard: anonymousSender(replyFrame),
		repeatedReply: outcome(repeated, asker),
	};
}

test("cross-node ask and reply route back to the asker exactly as a local ask does", async ({ annotate }) => {
	const asker = await harness.connect("a", unique("ask-asker"));
	const local = await harness.connect("a", unique("ask-local"));
	const remote = await harness.connect("b", unique("ask-remote"));
	const localRun = await askAndReply(asker, local);
	assert.equal(localRun.ask.delivered, true);
	assert.equal(localRun.reply.delivered, true);
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
		await assertUnrouted(asker, remote);
		return;
	}
	assert.deepEqual(await askAndReply(asker, remote), localRun);
});

test("a supervisor send reaches a supervisor now hosted by the other broker on the supervisor channel", async ({
	annotate,
}) => {
	const supervisor = await harness.connect("a", unique("supervisor"), { supervisorOwnerToken: randomUUID() });
	const childName = unique("supervised-child");
	const authorization = await supervisor.client.authorizeSupervisorChild(childName);
	const child = await harness.connect("a", childName, { supervisor: authorization });
	const local = await child.client.sendToSupervisor(supervisor.sessionId, { text: VERBATIM_TEXT });
	assert.equal(local.delivered, true, JSON.stringify(local));
	const localFrame = await waitForMessage(supervisor, local.id);
	assert.equal(localFrame.channel, "supervisor");

	const supervisorId = supervisor.sessionId;
	await harness.disconnect(supervisor);
	const moved = await harness.connect("b", supervisor.name, {
		returnAddress: supervisor.returnAddress,
		preferredSessionId: supervisorId,
	});
	assert.equal(moved.sessionId, supervisorId);
	const remote = await child.client.sendToSupervisor(supervisorId, { text: VERBATIM_TEXT });
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
		assert.equal(remote.delivered, false);
		assert.equal(remote.queued, undefined);
		assert.deepEqual(moved.received, []);
		return;
	}
	assert.equal(remote.delivered, true, JSON.stringify(remote));
	assert.deepEqual(card(await waitForMessage(moved, remote.id)), card(localFrame));
});

test(
	"a send to a recipient whose broker is down is queued, then delivered when that broker starts again",
	async ({ annotate }) => {
		const sender = await harness.connect("a", unique("offline-sender"));
		const recipient = await harness.connect("b", unique("offline-recipient"));
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
			await assertUnrouted(sender, recipient);
			return;
		}
		const recipientId = recipient.sessionId;
		await harness.stopBroker("b", "SIGKILL");
		await sleep(BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const text = "held for an offline session";
		const queued = await sender.client.send(recipientId, { text });
		assert.equal(queued.delivered, false, JSON.stringify(queued));
		assert.equal(queued.queued, true, JSON.stringify(queued));
		assert.ok(queued.target);

		await harness.startBroker("b");
		const back = await harness.connect("b", recipient.name, {
			returnAddress: recipient.returnAddress,
			preferredSessionId: recipientId,
		});
		await waitForMessage(back, queued.id, OUTBOX_BACKUP_POLL_INTERVAL_MS + DELIVERY_WAIT_MS);
		await confirmDelivered(sender, recipientId, text, queued.id, DELIVERY_WAIT_MS);
		assert.equal(back.messagesWithId(queued.id).length, 1);
	},
	OFFLINE_QUEUED_TEST_TIMEOUT_MS,
);

test("a send to a session that quit cleanly is queued at once, then delivered when it reconnects", async ({
	annotate,
}) => {
	const sender = await harness.connect("a", unique("quit-sender"));
	const recipient = await harness.connect("b", unique("quit-recipient"));
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
		await assertUnrouted(sender, recipient);
		return;
	}
	const recipientId = recipient.sessionId;
	await harness.disconnect(recipient);
	const text = "queued for a session that quit";
	const queued = await sender.client.send(recipient.name, { text });
	assert.equal(queued.delivered, false, JSON.stringify(queued));
	assert.equal(queued.queued, true, JSON.stringify(queued));
	assert.equal(queued.target, "offline session");

	const back = await harness.connect("b", recipient.name, {
		returnAddress: recipient.returnAddress,
		preferredSessionId: recipientId,
	});
	await waitForMessage(back, queued.id);
	await confirmDelivered(sender, recipient.name, text, queued.id, DELIVERY_WAIT_MS);
	assert.equal(back.messagesWithId(queued.id).length, 1);

	const unknown = await sender.client.send(randomUUID(), { text });
	assert.equal(unknown.queued, undefined);
	assert.equal(unknown.reason, "Session not found");
});

test(
	"a message claimed by a broker that crashes before the recipient's ack is redelivered after restart",
	async ({ annotate }) => {
		const sender = await harness.connect("a", unique("crash-sender"));
		const recipient = await harness.connect("b", unique("crash-recipient"), { acknowledgeReceipts: false });
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
			await assertUnrouted(sender, recipient);
			return;
		}
		const recipientId = recipient.sessionId;
		const messageId = randomUUID();
		const text = "survives a broker crash";
		const firstAttempt = sender.client.send(recipient.name, { text, messageId }).then(
			(result) => result,
			(error: Error) => error,
		);
		await waitForMessage(recipient, messageId);
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b");
		const back = await harness.connect("b", recipient.name, {
			returnAddress: recipient.returnAddress,
			preferredSessionId: recipientId,
		});
		const redelivered = await waitForMessage(back, messageId, BROKER_KILL_WAIT_MS);
		assert.equal(redelivered.message.content.text, text);
		assert.equal(redelivered.from.id, sender.sessionId);
		await firstAttempt;
		await confirmDelivered(sender, recipient.name, text, messageId, DELIVERY_WAIT_MS);
		assert.equal(back.messagesWithId(messageId).length, 1);
	},
	BROKER_KILL_TEST_TIMEOUT_MS,
);

test(
	"with every wake-up hint lost, the backup poll still delivers the message and its outcome",
	async ({ annotate }) => {
		const sender = await harness.connect("a", unique("poll-sender"));
		const recipient = await harness.connect("b", unique("poll-recipient"));
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
			await assertUnrouted(sender, recipient);
			return;
		}
		const restoreWakeUps = await harness.dropWakeUps();
		try {
			const messageId = randomUUID();
			const text = "found by the backup poll";
			const firstAttempt = sender.client.send(recipient.name, { text, messageId }).then(
				(result) => result,
				(error: Error) => error,
			);
			await waitForMessage(recipient, messageId, OUTBOX_BACKUP_POLL_INTERVAL_MS + DELIVERY_WAIT_MS);
			await firstAttempt;
			await confirmDelivered(sender, recipient.name, text, messageId, LOST_WAKE_UP_WAIT_MS);
			assert.equal(recipient.messagesWithId(messageId).length, 1);
		} finally {
			await restoreWakeUps();
		}
	},
	LOST_WAKE_UP_TEST_TIMEOUT_MS,
);

test("cross-node delivery matches local delivery: same card, sender identity and group isolation", async ({
	annotate,
}) => {
	const sender = await harness.connect("a", unique("parity-sender"), { group: "parity" });
	const local = await harness.connect("a", unique("parity-local"), { group: "parity" });
	const remote = await harness.connect("b", unique("parity-remote"), { group: "parity" });
	const isolatedLocal = await harness.connect("a", unique("isolated-local"), { group: "elsewhere" });
	const isolatedRemote = await harness.connect("b", unique("isolated-remote"), { group: "elsewhere" });
	const options = { text: VERBATIM_TEXT, attachments: ATTACHMENTS };

	const toLocal = await sender.client.send(local.name, options);
	assert.equal(toLocal.delivered, true);
	const localFrame = await waitForMessage(local, toLocal.id);
	assert.equal(localFrame.from.id, sender.sessionId);
	const refusedLocal = await sender.client.send(isolatedLocal.sessionId, { text: "cross-group" });
	assert.equal(refusedLocal.delivered, false);
	assert.deepEqual(isolatedLocal.received, []);
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
		await assertUnrouted(sender, remote);
		return;
	}

	const toRemote = await sender.client.send(remote.name, options);
	assert.deepEqual(outcome(toRemote, remote), outcome(toLocal, local));
	assert.deepEqual(card(await waitForMessage(remote, toRemote.id)), card(localFrame));
	const refusedRemote = await sender.client.send(isolatedRemote.sessionId, { text: "cross-group" });
	assert.deepEqual(outcome(refusedRemote, isolatedRemote), outcome(refusedLocal, isolatedLocal));
	assert.deepEqual(isolatedRemote.received, []);
});

/** A message the recipient saved but had not shown when it restarted (#3761 recovery replay). */
function savedCard(frame: ReceivedFrame): PendingRecoveryDelivery {
	return {
		entryId: `entry-${frame.message.id}`,
		customType: "intercom_message",
		content: frame.message.content.text,
		details: { from: frame.from, message: frame.message, bodyText: frame.message.content.text },
		timestamp: new Date(frame.message.timestamp).toISOString(),
		stageAdmissionKey: `intercom:${frame.message.id}`,
		delivery: "steer",
	};
}

test("on resume, a saved message from a live sender on the other node replays exactly as one from a local sender", async ({
	annotate,
}) => {
	const group = unique("resume");
	const recipient = await harness.connect("b", unique("resume-recipient"), { group });
	const localSender = await harness.connect("b", unique("resume-local"), { group });
	const remoteSender = await harness.connect("a", unique("resume-remote"), { group });
	const isolated = await harness.connect("a", unique("resume-isolated"), { group: unique("elsewhere") });
	const fromLocal = await localSender.client.send(recipient.name, { text: "saved before the restart" });
	const localFrame = await waitForMessage(recipient, fromLocal.id);
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: asserted that nothing crosses brokers");
		await assertUnrouted(remoteSender, recipient);
		return;
	}
	const fromRemote = await remoteSender.client.send(recipient.name, { text: "saved before the restart" });
	const remoteFrame = await waitForMessage(recipient, fromRemote.id);

	const peers = await recipient.client.listSessions();
	assert.ok(
		peers.some((peer) => peer.id === remoteSender.sessionId),
		"a live remote sender is a listed peer",
	);
	assert.ok(!peers.some((peer) => peer.id === isolated.sessionId), "group isolation applies to remote sessions");
	const plan = planIntercomRecoveryReplay([savedCard(localFrame), savedCard(remoteFrame)], peers);
	assert.deepEqual(
		plan.decisions?.map((decision) => decision.action),
		["replay", "replay"],
	);
	assert.deepEqual(plan.notices ?? [], []);
});
