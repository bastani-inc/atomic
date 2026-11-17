import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
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
			group: `${homeA.replace("%", "X").replace("_", "Y")}/team`,
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
