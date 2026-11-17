import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/intercom/broker/framing.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";
import { TWO_BROKER_STORAGE_PREFIX, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const ARRIVAL_WAIT = { timeout: 15_000, interval: 25 };
const SETTLE_MS = 300;

let harness: TwoBrokerHarness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

test(
	"with multi-node routing, a reach policy is enforced across brokers, one way, and replies still cross it (#5352)",
	async () => {
		assert.ok(harness.multiNodeRouting, "the two brokers route across nodes");
		const [homeA, homeB, homeC] = [unique("doc-a"), unique("doc-b"), unique("doc-c")];
		const a = await harness.connect("a", unique("a"), { group: homeA, reachable: [homeB] });
		const b = await harness.connect("b", unique("b"), { group: homeB, reachable: [] });
		const c = await harness.connect("b", unique("c"), { group: homeC });

		await vi.waitFor(async () => {
			const listed = (await a.client.listSessions()).map((session) => session.id);
			assert.ok(listed.includes(b.sessionId), "A lists B on the other node");
			assert.ok(!listed.includes(c.sessionId));
		}, ARRIVAL_WAIT);
		assert.ok(!(await b.client.listSessions()).some((session) => session.id === a.sessionId));

		const toB = await a.client.send(b.sessionId, { text: "across nodes" });
		assert.equal(toB.delivered, true, JSON.stringify(toB));
		const toC = await a.client.send(c.sessionId, { text: "out of reach" });
		assert.equal(toC.delivered, false);
		assert.match(toC.reason ?? "", /outside this session's Intercom reach/);
		const fromB = await b.client.send(a.sessionId, { text: "unprompted" });
		assert.equal(fromB.delivered, false);

		const questionId = randomUUID();
		const asked = await a.client.send(b.sessionId, {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, JSON.stringify(asked));
		await vi.waitFor(() => assert.equal(b.messagesWithId(questionId).length, 1), ARRIVAL_WAIT);
		const reply = await b.client.send(a.sessionId, {
			text: "port 8080",
			replyTo: questionId,
			requirePendingReply: true,
		});
		assert.equal(reply.delivered, true, JSON.stringify(reply));

		await assert.rejects(a.client.joinGroup(homeC), /outside this session's Intercom reach/);
		await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
		assert.deepEqual(
			c.received.map((frame) => frame.message.content.text),
			[],
			"nothing reached the session outside A's reach",
		);
		assert.deepEqual(
			a.received.map((frame) => frame.message.content.text),
			["port 8080"],
			"only the reply reached A",
		);
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);

test(
	"with multi-node routing, a send to a starting or restoring subagent in a home subgroup is held across brokers (#5352)",
	async () => {
		const shared = await harness.openSharedStorage("a");
		const [homeA, homeB] = [unique("home_%_🚀-A"), unique("home-b")];
		const a = await harness.connect("a", unique("sender-a"), { group: homeA, reachable: [homeB] });
		const plain = await harness.connect("a", unique("plain-a"), { group: homeA });
		const supervisorA = await harness.connect("b", unique("sup-a"), {
			group: homeA,
			reachable: [],
			supervisorOwnerToken: randomUUID(),
		});
		const supervisorB = await harness.connect("b", unique("sup-b"), {
			group: homeB,
			reachable: [],
			supervisorOwnerToken: randomUUID(),
		});

		const startingName = `subagent-worker-${unique("start-sub")}-1`;
		const startingAuth = await supervisorA.client.authorizeSupervisorChild(startingName);
		await supervisorA.client.reserveRestoringRecipient(startingAuth.capability, {
			group: `${homeA}/team`,
			holdMs: 60_000,
		});

		const restoringName = `subagent-worker-${unique("restore-sub")}-1`;
		const restoringAuth = await supervisorA.client.authorizeSupervisorChild(restoringName);
		await supervisorA.client.reserveRestoringRecipient(restoringAuth.capability, {
			group: `${homeA}/restoring`,
			dormant: true,
		});

		const reachableChildName = `subagent-worker-${unique("reach-sub")}-1`;
		const reachableAuth = await supervisorB.client.authorizeSupervisorChild(reachableChildName);
		await supervisorB.client.reserveRestoringRecipient(reachableAuth.capability, { group: `${homeB}/team` });

		const nearPrefixChildName = `subagent-worker-${unique("near-prefix")}-1`;
		const nearPrefixAuth = await supervisorA.client.authorizeSupervisorChild(nearPrefixChildName);
		await supervisorA.client.reserveRestoringRecipient(nearPrefixAuth.capability, { group: `${homeA}-extra` });

		const wrongCaseChildName = `subagent-worker-${unique("wrong-case")}-1`;
		const wrongCaseAuth = await supervisorA.client.authorizeSupervisorChild(wrongCaseChildName);
		await supervisorA.client.reserveRestoringRecipient(wrongCaseAuth.capability, {
			group: `${homeA.toLowerCase()}/team`,
		});

		const wildcardChildName = `subagent-worker-${unique("wildcard")}-1`;
		const wildcardAuth = await supervisorA.client.authorizeSupervisorChild(wildcardChildName);
		await supervisorA.client.reserveRestoringRecipient(wildcardAuth.capability, {
			group: `${homeA.replaceAll("%", "X").replaceAll("_", "Y")}/team`,
		});

		const fromPlain = await plain.client.send(startingName, { text: "plain has no subgroup reach" });
		assert.equal(fromPlain.delivered, false);
		assert.match(fromPlain.reason ?? "", /Session not found/);

		for (const badTarget of [reachableChildName, nearPrefixChildName, wrongCaseChildName, wildcardChildName]) {
			const refused = await a.client.send(badTarget, { text: "outside home subgroup reach" });
			assert.equal(refused.delivered, false);
			assert.match(refused.reason ?? "", /Session not found/);
		}

		for (const [childName, group, auth, text] of [
			[startingName, `${homeA}/team`, startingAuth, "held for starting home subgroup child"],
			[restoringName, `${homeA}/restoring`, restoringAuth, "held for restoring home subgroup child"],
		] as const) {
			const messageId = randomUUID();
			const heldSend = a.client.send(childName, { messageId, text });
			await Promise.race([
				heldSend.then((result) =>
					assert.fail(`send to ${childName} settled before child connected: ${JSON.stringify(result)}`),
				),
				vi.waitFor(async () => {
					const row = await shared.get(
						`SELECT message_id FROM ${TWO_BROKER_STORAGE_PREFIX}intercom_held_sends WHERE message_id = ?`,
						messageId,
					);
					assert.equal(row?.message_id, messageId);
				}, ARRIVAL_WAIT),
			]);
			const child = await harness.connect("b", childName, {
				group,
				reachable: [],
				supervisor: auth,
			});
			const delivered = await heldSend;
			assert.equal(delivered.delivered, true, JSON.stringify(delivered));
			await vi.waitFor(
				() =>
					assert.deepEqual(
						child.received.map((frame) => frame.message.content.text),
						[text],
					),
				ARRIVAL_WAIT,
			);
		}
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);

async function wireSender(home: string, reachable: string[]) {
	const socket = net.connect(harness.socketPath("a"));
	const frames: BrokerMessage[] = [];
	const errors: Error[] = [];
	socket.on("error", (error) => errors.push(error));
	socket.on(
		"data",
		createMessageReader(
			(frame) => frames.push(frame as unknown as BrokerMessage),
			(error) => errors.push(error),
		),
	);
	const next = async (matches: (frame: BrokerMessage) => boolean): Promise<BrokerMessage> => {
		let found: BrokerMessage | undefined;
		await vi.waitFor(() => {
			assert.deepEqual(errors, []);
			found = frames.find(matches);
			assert.ok(found, "the broker answered the request");
		}, ARRIVAL_WAIT);
		return found!;
	};
	await new Promise<void>((resolveConnect, rejectConnect) => {
		socket.once("connect", resolveConnect);
		socket.once("error", rejectConnect);
	});
	const now = Date.now();
	writeMessage(socket, {
		type: "register",
		session: {
			name: unique("wire-sender"),
			cwd: harness.root,
			model: "test-model",
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			group: home,
			groups: [home],
		},
		protocol: { min: 4, max: 4 },
		reach: { home, reachable },
	});
	try {
		await next((frame) => frame.type === "registered");
	} catch (error) {
		socket.destroy();
		throw error;
	}
	return {
		socket,
		next,
		sendThenReach(to: string, messageId: string, groups: string[]) {
			const requestId = randomUUID();
			socket.cork();
			writeMessage(socket, {
				type: "send",
				to,
				message: { id: messageId, timestamp: Date.now(), content: { text: messageId } },
				awaitRestoringRecipient: true,
			});
			writeMessage(socket, { type: "set_reach", requestId, reachable: groups });
			socket.uncork();
			return next((frame) => frame.type === "reach_ack" && frame.requestId === requestId);
		},
	};
}

for (const node of ["a", "b"] as const)
	for (const initiallyReachable of [true, false])
		test(
			`a send to broker ${node} uses the reach read before a same-tick ${initiallyReachable ? "narrowing" : "widening"} (#5352)`,
			async () => {
				const [home, other] = [unique("receipt-home"), unique("receipt-other")];
				const recipient = await harness.connect(node, unique("recipient"), { group: other, reachable: [] });
				const sender = await wireSender(home, initiallyReachable ? [other] : []);
				try {
					const messageId = randomUUID();
					await sender.sendThenReach(recipient.sessionId, messageId, initiallyReachable ? [] : [other]);
					const outcome = await sender.next(
						(frame) =>
							(frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === messageId,
					);
					assert.equal(
						outcome.type,
						initiallyReachable ? "delivered" : "delivery_failed",
						JSON.stringify(outcome),
					);
					if (initiallyReachable) {
						assert.equal(recipient.messagesWithId(messageId).length, 1);
						const laterId = randomUUID();
						writeMessage(sender.socket, {
							type: "send",
							to: recipient.sessionId,
							message: { id: laterId, timestamp: Date.now(), content: { text: "after narrowing" } },
						});
						await sender.next((frame) => frame.type === "delivery_failed" && frame.messageId === laterId);
					} else {
						assert.equal(
							outcome.type === "delivery_failed" && /outside this session's Intercom reach/.test(outcome.reason),
							true,
						);
					}
					await new Promise((resolveSettle) => setTimeout(resolveSettle, SETTLE_MS));
					assert.equal(recipient.received.length, initiallyReachable ? 1 : 0);
				} finally {
					sender.socket.destroy();
				}
			},
			REAL_BROKERS_HOOK_TIMEOUT_MS,
		);

test(
	"a send held across brokers keeps its receipt-time reach after a same-tick narrowing (#5352)",
	async () => {
		const [home, other] = [unique("held-receipt-home"), unique("held-receipt-other")];
		const owner = await harness.connect("b", unique("held-owner"), {
			group: other,
			supervisorOwnerToken: randomUUID(),
		});
		const childName = `subagent-worker-${unique("held-child")}-1`;
		const auth = await owner.client.authorizeSupervisorChild(childName);
		await owner.client.reserveRestoringRecipient(auth.capability, { group: other, holdMs: 60_000 });
		const sender = await wireSender(home, [other]);
		try {
			const messageId = randomUUID();
			await sender.sendThenReach(childName, messageId, []);
			await sender
				.next(
					(frame) =>
						(frame.type === "send_held" || frame.type === "delivery_failed") && frame.messageId === messageId,
				)
				.then((frame) => assert.equal(frame.type, "send_held", JSON.stringify(frame)));
			const child = await harness.connect("b", childName, { group: other, reachable: [], supervisor: auth });
			const outcome = await sender.next(
				(frame) =>
					(frame.type === "delivered" || frame.type === "delivery_failed") && frame.messageId === messageId,
			);
			assert.equal(outcome.type, "delivered", JSON.stringify(outcome));
			assert.equal(child.messagesWithId(messageId).length, 1);
		} finally {
			sender.socket.destroy();
		}
	},
	REAL_BROKERS_HOOK_TIMEOUT_MS,
);
