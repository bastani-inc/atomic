import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const { TwoBrokerHarness } = await import("../helpers/intercom-two-broker-harness.js");
const { isReleasedReplyAnsweredError } = await import("../../packages/intercom/broker/client.js");

type Harness = import("../helpers/intercom-two-broker-harness.js").TwoBrokerHarness;
type TwoBrokerClient = import("../helpers/intercom-two-broker-harness.js").TwoBrokerClient;
type ReceivedFrame = import("../helpers/intercom-two-broker-harness.js").ReceivedFrame;
type ReleasedChildReply = import("../../packages/intercom/broker/client.js").ReleasedChildReply;

/** Spawning two real broker processes, and restarting one, is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
const REAL_BROKERS_TEST_TIMEOUT_MS = 60_000;
/** A same-id retry after a restart waits out the sender's receipt wait (8 s, once forgiven) at most. */
const RESTART_REDELIVERY_TEST_TIMEOUT_MS = 90_000;
const WAIT = { timeout: 15_000, interval: 25 };
const RETRY_WAIT = { timeout: 45_000, interval: 500 };

let harness: Harness;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(() => harness?.cleanup(), REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

type Answer = "accept" | "withhold";

/** The owner side of #4326: it saves a released child's reply and answers the handoff, or never answers it. */
function recordHandoffs(owner: TwoBrokerClient, answer: Answer = "accept"): ReleasedChildReply[] {
	const handoffs: ReleasedChildReply[] = [];
	owner.client.on("released_child_reply", (notice: ReleasedChildReply) => {
		handoffs.push(notice);
		if (answer === "accept") owner.client.acknowledgeReleasedChildReply(notice, true);
	});
	return handoffs;
}

interface ReleasedAsker {
	readonly owner: TwoBrokerClient;
	readonly ownerToken: string;
	readonly ownerSessionId: string;
	readonly childName: string;
	readonly childSessionId: string;
	readonly replier: TwoBrokerClient;
	readonly questionId: string;
}

/**
 * The owner and its subagent on node A, the replier on node B. The subagent asks the replier across the nodes, its
 * owner reserves it released, and it disconnects, as a subagent released while it waits does.
 */
async function releaseAsker(): Promise<ReleasedAsker> {
	const ownerToken = randomUUID();
	const owner = await harness.connect("a", unique("owner"), { supervisorOwnerToken: ownerToken });
	const childName = unique("subagent-asker");
	const authorization = await owner.client.authorizeSupervisorChild(childName);
	const child = await harness.connect("a", childName, {
		supervisor: { capability: authorization.capability, supervisorSessionId: authorization.supervisorSessionId },
	});
	const replier = await harness.connect("b", unique("replier"));
	const questionId = randomUUID();
	const asked = await child.client.send(replier.sessionId, {
		messageId: questionId,
		text: "Which file holds the config?",
		expectsReply: true,
	});
	assert.equal(asked.delivered, true, JSON.stringify(asked));
	await vi.waitFor(() => assert.equal(replier.messagesWithId(questionId).length, 1), WAIT);
	await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
	const childSessionId = child.sessionId;
	const shared = await harness.openSharedStorage("a");
	await harness.disconnect(child);
	// The asker's broker drops the asker's shared ask routes as the last step of its departure.
	await vi.waitFor(async () => {
		const row = await shared.get<{ n: number }>(
			"SELECT COUNT(*) AS n FROM mn_intercom_pending_asks WHERE sender_session_id = ?",
			childSessionId,
		);
		assert.equal(Number(row?.n), 0);
	}, WAIT);
	return { owner, ownerToken, ownerSessionId: owner.sessionId, childName, childSessionId, replier, questionId };
}

function replyTo(released: ReleasedAsker, text: string, messageId?: string) {
	return released.replier.client.send(released.childSessionId, {
		text,
		replyTo: released.questionId,
		requirePendingReply: true,
		expectedRecipientId: released.childSessionId,
		...(messageId === undefined ? {} : { messageId }),
	});
}

/** Restart node A's broker in an orderly way, and reconnect the owner as the same host session. */
async function restartOwnerBroker(
	released: ReleasedAsker,
	answer: Answer,
): Promise<{ owner: TwoBrokerClient; handoffs: ReleasedChildReply[] }> {
	await harness.requestShutdown("a");
	await harness.stopBroker("a", "SIGTERM");
	await harness.startBroker("a");
	const owner = await harness.connect("a", released.owner.name, {
		returnAddress: released.owner.returnAddress,
		preferredSessionId: released.ownerSessionId,
		supervisorOwnerToken: released.ownerToken,
	});
	const handoffs = recordHandoffs(owner, answer);
	await owner.client.reserveReleasedChildren([{ childName: released.childName, wake: true }]);
	return { owner, handoffs };
}

test(
	"a reply through another node reaches the owner of the subagent released while it waited, once (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const released = await releaseAsker();
		const handoffs = recordHandoffs(released.owner);
		const result = await replyTo(released, "config.ts");
		assert.equal(result.delivered, true, JSON.stringify(result));
		assert.equal(handoffs.length, 1);
		const [handoff] = handoffs as [ReleasedChildReply];
		assert.equal(handoff.childName, released.childName);
		assert.equal(handoff.replyTo, released.questionId);
		assert.equal(handoff.message.id, result.id);
		assert.equal(handoff.message.content.text, "config.ts");
		assert.equal(handoff.from.id, released.replier.sessionId);
		assert.deepEqual(released.owner.messagesWithId(result.id), [], "the owner is handed the reply, not sent it");
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"a second reply is refused with a typed error, and a retry of the delivered one is not handed over again (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const released = await releaseAsker();
		const handoffs = recordHandoffs(released.owner);
		const first = await replyTo(released, "config.ts");
		assert.equal(first.delivered, true, JSON.stringify(first));
		const second = await replyTo(released, "no, settings.ts");
		assert.equal(second.delivered, false);
		assert.equal(second.reasonCode, "released_reply_answered");
		assert.ok(second.error !== undefined && isReleasedReplyAnsweredError(second.error), JSON.stringify(second));
		assert.equal(second.error.name, "ReleasedReplyAnsweredError");
		assert.equal(second.error.questionId, released.questionId);
		assert.equal(second.error.childName, released.childName);
		assert.equal(second.error.retryable, false);
		const retry = await replyTo(released, "config.ts", first.id);
		assert.equal(retry.delivered, true, JSON.stringify(retry));
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.deepEqual(
			handoffs.map((handoff) => handoff.message.id),
			[first.id],
			"the owner is handed exactly one reply",
		);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"a restart of the asker's broker between the release and the reply loses nothing (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const released = await releaseAsker();
		const before = recordHandoffs(released.owner);
		const { owner, handoffs } = await restartOwnerBroker(released, "accept");
		const result = await replyTo(released, "config.ts");
		assert.equal(result.delivered, true, JSON.stringify(result));
		assert.deepEqual(before, []);
		assert.deepEqual(
			handoffs.map((handoff) => [handoff.childName, handoff.replyTo, handoff.message.id]),
			[[released.childName, released.questionId, result.id]],
		);
		assert.deepEqual(owner.messagesWithId(result.id), []);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"a reply handed over just before the owner's broker restarts is handed over again and accepted once (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const released = await releaseAsker();
		const unanswered = recordHandoffs(released.owner, "withhold");
		const messageId = randomUUID();
		const pending = replyTo(released, "config.ts", messageId);
		await vi.waitFor(() => assert.equal(unanswered.length, 1), WAIT);
		const { handoffs } = await restartOwnerBroker(released, "accept");
		await vi.waitFor(() => assert.equal(handoffs.length, 1), WAIT);
		const first = await pending;
		if (!first.delivered) {
			await vi.waitFor(async () => {
				const retried = await replyTo(released, "config.ts", messageId);
				assert.equal(retried.delivered, true, JSON.stringify(retried));
			}, RETRY_WAIT);
		}
		const [lost] = unanswered as [ReleasedChildReply];
		const [accepted] = handoffs as [ReleasedChildReply];
		assert.equal(accepted.message.id, messageId);
		assert.equal(lost.message.id, messageId);
		assert.notEqual(accepted.handoffId, lost.handoffId, "the redelivery is a new handoff");
		assert.equal(handoffs.length, 1, "accepted exactly once");
	},
	RESTART_REDELIVERY_TEST_TIMEOUT_MS,
);

test(
	"an ask from another node to a subagent that is then released is answered once it wakes (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const ownerToken = randomUUID();
		const owner = await harness.connect("b", unique("owner"), { supervisorOwnerToken: ownerToken });
		const childName = unique("subagent-asked");
		const first = await owner.client.authorizeSupervisorChild(childName);
		const child = await harness.connect("b", childName, {
			supervisor: { capability: first.capability, supervisorSessionId: first.supervisorSessionId },
		});
		const asker = await harness.connect("a", unique("asker"));
		const questionId = randomUUID();
		const asked = await asker.client.send(child.sessionId, {
			messageId: questionId,
			text: "Which file holds the config?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, JSON.stringify(asked));
		await vi.waitFor(() => assert.equal(child.messagesWithId(questionId).length, 1), WAIT);
		await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
		const childSessionId = child.sessionId;
		await harness.disconnect(child);

		const second = await owner.client.authorizeSupervisorChild(childName);
		const woken = await harness.connect("b", childName, {
			supervisor: { capability: second.capability, supervisorSessionId: second.supervisorSessionId },
			returnAddress: child.returnAddress,
			preferredSessionId: childSessionId,
		});
		const answered = await woken.client.send(asker.sessionId, {
			text: "config.ts",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: asker.sessionId,
		});
		assert.equal(answered.delivered, true, JSON.stringify(answered));
		await vi.waitFor(() => assert.equal(asker.messagesWithId(answered.id).length, 1), WAIT);
		const [frame] = asker.messagesWithId(answered.id) as [ReceivedFrame];
		assert.equal(frame.message.replyTo, questionId);
		assert.equal(frame.message.content.text, "config.ts");
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an ask from another node follows a released subagent that wakes under a new session id (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const owner = await harness.connect("b", unique("owner"), { supervisorOwnerToken: randomUUID() });
		const childName = unique("subagent-renamed");
		const first = await owner.client.authorizeSupervisorChild(childName);
		const child = await harness.connect("b", childName, {
			supervisor: { capability: first.capability, supervisorSessionId: first.supervisorSessionId },
		});
		const asker = await harness.connect("a", unique("asker"));
		const questionId = randomUUID();
		const asked = await asker.client.send(child.sessionId, {
			messageId: questionId,
			text: "Ready?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, JSON.stringify(asked));
		await vi.waitFor(() => assert.equal(child.messagesWithId(questionId).length, 1), WAIT);
		await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
		const previousSessionId = child.sessionId;
		await harness.disconnect(child);
		const second = await owner.client.authorizeSupervisorChild(childName);
		const woken = await harness.connect("b", childName, {
			supervisor: { capability: second.capability, supervisorSessionId: second.supervisorSessionId },
		});
		assert.notEqual(woken.sessionId, previousSessionId);
		const answered = await woken.client.send(asker.sessionId, {
			text: "ready",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: asker.sessionId,
		});
		assert.equal(answered.delivered, true, JSON.stringify(answered));
		await vi.waitFor(() => assert.equal(asker.messagesWithId(answered.id).length, 1), WAIT);
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);

test(
	"an ask from another node to a session that leaves without being released ends with it, as before (#4386)",
	async ({ annotate }) => {
		if (!harness.multiNodeRouting) {
			await annotate("multi-node routing not advertised: nothing crosses brokers");
			return;
		}
		const target = await harness.connect("b", unique("plain-target"));
		const asker = await harness.connect("a", unique("asker"));
		const questionId = randomUUID();
		const asked = await asker.client.send(target.sessionId, {
			messageId: questionId,
			text: "Ready?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, JSON.stringify(asked));
		await vi.waitFor(() => assert.equal(target.messagesWithId(questionId).length, 1), WAIT);
		const targetSessionId = target.sessionId;
		await harness.disconnect(target);
		const back = await harness.connect("b", target.name, {
			returnAddress: target.returnAddress,
			preferredSessionId: targetSessionId,
		});
		assert.equal(back.sessionId, targetSessionId);
		const late = await back.client.send(asker.sessionId, {
			text: "ready",
			replyTo: questionId,
			requirePendingReply: true,
			expectedRecipientId: asker.sessionId,
		});
		assert.equal(late.delivered, false);
		assert.equal(late.reason, "Pending question route does not authorize this public reply");
	},
	REAL_BROKERS_TEST_TIMEOUT_MS,
);
