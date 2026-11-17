import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";

/** Spawning two real broker processes is the structural cost of this suite. */
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
