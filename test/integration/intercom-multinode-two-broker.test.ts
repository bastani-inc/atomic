import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PendingRecoveryDelivery } from "@bastani/atomic";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import type { SendResult } from "../../packages/intercom/broker/client.js";
import { OUTBOX_BACKUP_POLL_INTERVAL_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import { planIntercomRecoveryReplay } from "../../packages/intercom/session-recovery.js";
import {
	BROKER_START_ALLOWANCE_MS,
	type ReceivedFrame,
	type TwoBrokerClient,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";
import {
	assertUnrouted,
	confirmDelivered,
	DELIVERY_WAIT_MS,
	REAL_BROKERS_HOOK_TIMEOUT_MS,
	RECOVERY_MARGIN_MS,
	unique,
	waitForMessage,
} from "./intercom-multinode-two-broker-helpers.js";

/** A broker restart, then the scenario's own connections and checks. */
const BROKER_RESTART_TEST_TIMEOUT_MS = BROKER_START_ALLOWANCE_MS + 30_000;
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

test("a supervisor on the other broker answers its child in another group with a plain send, and reaches no one else", async ({
	annotate,
}) => {
	const supervisorGroup = unique("supervisor-group");
	const childGroup = unique("child-group");
	const supervisor = await harness.connect("a", unique("answering-supervisor"), {
		group: supervisorGroup,
		supervisorOwnerToken: randomUUID(),
	});
	const childName = unique("answered-child");
	const authorization = await supervisor.client.authorizeSupervisorChild(childName);
	const child = await harness.connect("a", childName, { group: childGroup, supervisor: authorization });
	const bystander = await harness.connect("a", unique("bystander"), { group: childGroup });
	const supervisorId = supervisor.sessionId;
	await harness.disconnect(supervisor);
	const moved = await harness.connect("b", supervisor.name, {
		group: supervisorGroup,
		returnAddress: supervisor.returnAddress,
		preferredSessionId: supervisorId,
	});
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: nothing crosses brokers");
		return;
	}
	const update = await child.client.sendToSupervisor(supervisorId, { text: "Halfway through" });
	assert.equal(update.delivered, true, JSON.stringify(update));
	await waitForMessage(moved, update.id);

	// The child's message reached the supervisor: the supervisor answers it across groups and brokers.
	const answer = await moved.client.send(child.name, { text: "Keep going" });
	assert.equal(answer.delivered, true, JSON.stringify(answer));
	assert.equal((await waitForMessage(child, answer.id)).message.content.text, "Keep going");
	// Nobody else in the child's group became reachable.
	const stray = await moved.client.send(bystander.sessionId, { text: "not for you" });
	assert.equal(stray.delivered, false);
	assert.equal(stray.queued, undefined);
	assert.deepEqual(bystander.received, []);
});

/** A supervisor on broker b whose child, in another group on broker a, has written to it across nodes. */
async function crossGroupPair(): Promise<{ child: TwoBrokerClient; supervisor: TwoBrokerClient }> {
	const supervisorGroup = unique("pair-supervisor-group");
	const first = await harness.connect("a", unique("pair-supervisor"), {
		group: supervisorGroup,
		supervisorOwnerToken: randomUUID(),
	});
	const childName = unique("pair-child");
	const authorization = await first.client.authorizeSupervisorChild(childName);
	const child = await harness.connect("a", childName, {
		group: unique("pair-child-group"),
		supervisor: authorization,
	});
	const supervisorId = first.sessionId;
	await harness.disconnect(first);
	const supervisor = await harness.connect("b", first.name, {
		group: supervisorGroup,
		returnAddress: first.returnAddress,
		preferredSessionId: supervisorId,
	});
	const report = await child.client.sendToSupervisor(supervisorId, { text: "progress" });
	assert.equal(report.delivered, true, JSON.stringify(report));
	await waitForMessage(supervisor, report.id);
	return { child, supervisor };
}

test("across brokers, a closed return path is refused by name with the reason it closed", async ({ annotate }) => {
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: nothing crosses brokers");
		return;
	}
	const { child, supervisor } = await crossGroupPair();
	for (let index = 0; index < 3; index++) {
		const answer = await supervisor.client.send(child.name, { text: `answer-${index}` });
		assert.equal(answer.delivered, true, JSON.stringify(answer));
	}
	const closed = await supervisor.client.send(child.name, { text: "one too many" });
	assert.equal(closed.delivered, false);
	assert.match(closed.reason ?? "", /return path has closed/, JSON.stringify(closed));
});

test("across brokers, a child that went offline is still answered by the name its message showed", async ({
	annotate,
}) => {
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: nothing crosses brokers");
		return;
	}
	const { child, supervisor } = await crossGroupPair();
	const childId = child.sessionId;
	await harness.disconnect(child);
	const byName = await supervisor.client.send(child.name, { text: "answer by name while offline" });
	assert.equal(byName.queued, true, JSON.stringify(byName));
	const byId = await supervisor.client.send(childId, { text: "answer by id while offline" });
	assert.equal(byId.queued, true, JSON.stringify(byId));
});

/**
 * How long a broker may take to decide, after a session of an identity ends for good, whether a registration of it is
 * still live on another broker: one read of the shared database.
 */
const DEPARTURE_DECISION_SETTLE_MS = 1_000;

test("across brokers, a duplicate of a live sender that ends for good leaves the sender's return path open", async ({
	annotate,
}) => {
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: nothing crosses brokers");
		return;
	}
	const senderGroup = unique("duplicated-sender-group");
	const responderGroup = unique("duplicate-responder-group");
	const sender = await harness.connect("a", unique("duplicated-sender"), {
		group: senderGroup,
		reachable: [responderGroup],
	});
	const responder = await harness.connect("b", unique("duplicate-responder"), { group: responderGroup });
	const opening = await sender.client.send(responder.sessionId, { text: "opening" });
	assert.equal(opening.delivered, true, JSON.stringify(opening));
	await waitForMessage(responder, opening.id);
	// A second registration of the sender's identity, on the responder's broker, ends for good; the sender stays live.
	const duplicate = await harness.connect("b", sender.name, {
		group: senderGroup,
		reachable: [responderGroup],
		returnAddress: sender.returnAddress,
	});
	await harness.disconnect(duplicate);
	await sleep(DEPARTURE_DECISION_SETTLE_MS);
	const answer = await responder.client.send(sender.name, { text: "for the live sender" });
	assert.equal(answer.delivered, true, JSON.stringify(answer));
	assert.equal((await waitForMessage(sender, answer.id)).message.content.text, "for the live sender");
});

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
	BROKER_RESTART_TEST_TIMEOUT_MS,
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

test("a remote sender's send and ask wake a released child on the owner's broker once, and arrive once each, in order (#4326)", async ({
	annotate,
}) => {
	const owner = await harness.connect("b", unique("released-owner"), { supervisorOwnerToken: randomUUID() });
	const sender = await harness.connect("a", unique("released-sender"));
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: a released child is reserved on one broker only");
		return;
	}
	const childName = unique("subagent-released");
	const wakes: Array<{ childName: string }> = [];
	owner.client.on("restoring_recipient_wake", (notice: { childName: string }) => wakes.push(notice));
	await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
	const shared = await harness.openSharedStorage("a");
	const count = async (table: string): Promise<number> =>
		Number((await shared.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n);
	await vi.waitFor(async () => assert.equal(await count("mn_intercom_restoring_reservations"), 1), {
		timeout: DELIVERY_WAIT_MS,
		interval: 25,
	});

	const sendId = randomUUID();
	const askId = randomUUID();
	const sends = Promise.all([
		sender.client.send(childName, { text: "first", messageId: sendId }),
		sender.client.send(childName, { text: "second", messageId: askId, expectsReply: true }),
	]);
	await vi.waitFor(async () => assert.equal(await count("mn_intercom_held_sends"), 2), {
		timeout: DELIVERY_WAIT_MS,
		interval: 25,
	});
	await vi.waitFor(() => assert.equal(wakes.length, 1), { timeout: DELIVERY_WAIT_MS, interval: 25 });
	assert.deepEqual(wakes, [{ childName }], "one wake notice for the hold that started empty");

	const authorization = await owner.client.authorizeSupervisorChild(childName);
	const child = await harness.connect("b", childName, {
		supervisor: { capability: authorization.capability, supervisorSessionId: authorization.supervisorSessionId },
	});
	const results = await sends;
	assert.deepEqual(
		results.map((result) => result.delivered),
		[true, true],
		JSON.stringify(results),
	);
	await waitForMessage(child, askId);
	assert.deepEqual(
		child.received.map((frame) => frame.message.id),
		[sendId, askId],
		"each held send arrives once, in the order it was sent",
	);
	assert.equal(wakes.length, 1);

	const nextId = randomUUID();
	const later = await sender.client.send(childName, { text: "after", messageId: nextId });
	assert.equal(later.delivered, true, JSON.stringify(later));
	await waitForMessage(child, nextId);
	assert.equal(wakes.length, 1, "a send to the live child wakes nothing");
});

test("a stage hosted on one broker is listed, asked and answered across nodes (#4642)", async ({ annotate }) => {
	const group = unique("workflow:hosted-run");
	const host = await harness.connect("a", unique("hosted-host"), { group });
	const asker = await harness.connect("b", unique("hosted-asker"), { group });
	if (!harness.multiNodeRouting) {
		await annotate("multi-node routing not advertised: nothing crosses brokers");
		return;
	}
	const stageName = unique("subagent-chat-hosted");
	const now = Date.now();
	const hostedMessages: { recipient: string; text: string; id: string }[] = [];
	host.client.on(
		"hosted_message",
		(recipient: string, _from: unknown, message: { id: string; content: { text: string } }) =>
			hostedMessages.push({ recipient, text: message.content.text, id: message.id }),
	);

	const [assigned] = await host.client.hostSessions([
		{
			key: "stage-0",
			session: {
				name: stageName,
				cwd: "/workspace",
				model: "faux/model",
				pid: process.pid,
				startedAt: now,
				lastActivity: now,
				status: "closed · reply: post-mortem only",
				replyCapability: "live",
				groups: [group],
				group,
			},
			returnAddress: `${stageName}:released-stage`,
		},
	]);
	assert.ok(assigned);
	const hostedId = assigned.sessionId;

	await vi.waitFor(
		async () => {
			const listed = await asker.client.listSessions(group);
			assert.ok(
				listed.some((session) => session.id === hostedId && session.name === stageName),
				"the other node lists the hosted stage",
			);
		},
		{ timeout: DELIVERY_WAIT_MS, interval: 100 },
	);

	const ask = await asker.client.send(stageName, { text: "which file?", expectsReply: true });
	assert.equal(ask.delivered, true, JSON.stringify(ask));
	await vi.waitFor(() => assert.equal(hostedMessages.length, 1), { timeout: DELIVERY_WAIT_MS, interval: 25 });
	assert.deepEqual(hostedMessages[0], { recipient: hostedId, text: "which file?", id: ask.id });
	assert.equal(host.messagesWithId(ask.id).length, 0, "the host's own message handler never sees the stage's ask");

	const reply = await host.client.send(asker.sessionId, {
		text: "the parser",
		replyTo: ask.id,
		requirePendingReply: true,
		hostedSender: hostedId,
	});
	assert.equal(reply.delivered, true, JSON.stringify(reply));
	const replyFrame = await waitForMessage(asker, reply.id);
	assert.equal(replyFrame.from.id, hostedId, "the reply comes from the stage, not from its host");
	assert.equal(replyFrame.message.replyTo, ask.id);

	await host.client.unhostSessions([hostedId]);
	await vi.waitFor(
		async () => {
			const listed = await asker.client.listSessions(group);
			assert.equal(
				listed.some((session) => session.id === hostedId),
				false,
				"removing the stage removes it on the other node",
			);
		},
		{ timeout: DELIVERY_WAIT_MS, interval: 100 },
	);
});
