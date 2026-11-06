import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "released-asker-reply-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;
type ReleasedChildReply = import("../../packages/intercom/broker/client.js").ReleasedChildReply;
const pendingAnswers = new Map<string, { resolve(message: Message): void; reject(error: Error): void }>();

const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const STALLED_OWNER_TEST_TIMEOUT_MS = 30_000;
const WAIT = { timeout: 10_000, interval: 20 };

let broker: ChildProcess | undefined;

async function connect(
	name: string,
	options: {
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
		returnAddress?: string;
		preferredSessionId?: string;
	} = {},
): Promise<Client> {
	const client = new IntercomClient(
		options.returnAddress ?? randomUUID(),
		options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId },
	);
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		},
		options.supervisor,
		options.ownerToken,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

function sessionIdOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

function recordMessages(client: Client): Message[] {
	const received: Message[] = [];
	client.on("message", (_from: object, message: Message) => received.push(message));
	return received;
}

function recordReplies(owner: Client): ReleasedChildReply[] {
	const replies: ReleasedChildReply[] = [];
	owner.on("released_child_reply", (notice: ReleasedChildReply) => {
		replies.push(notice);
		const pending = pendingAnswers.get(notice.replyTo);
		if (pending !== undefined) {
			pendingAnswers.delete(notice.replyTo);
			pending.resolve(notice.message);
		}
		owner.acknowledgeReleasedChildReply(notice.message.id, pending !== undefined);
	});
	return replies;
}

function outcome(promise: Promise<Message>): Promise<string> {
	return promise.then(
		(message) => `resolved:${message.content.text}`,
		(error: Error) => `rejected:${error.message}`,
	);
}

interface ReleasedAsk {
	readonly owner: Client;
	readonly childName: string;
	readonly childSessionId: string;
	readonly questionId: string;
	readonly wait: Promise<Message>;
	readonly call: AbortController;
}

async function waitUntilGone(observer: Client, childName: string): Promise<void> {
	await vi.waitFor(async () => {
		const sessions = await observer.listSessions();
		assert.equal(
			sessions.some((session) => session.name === childName),
			false,
		);
	}, WAIT);
}

async function releaseAsker(
	label: string,
	ask: (child: Client, questionId: string) => Promise<{ readonly delivered: boolean }>,
	replierOf: (owner: Client) => Promise<{ readonly sessionId: string; readonly received: Message[] }>,
	order: "disconnect-first" | "reserve-first",
	keepWait = true,
): Promise<ReleasedAsk> {
	const childName = `subagent-asker-${label}`;
	const owner = await connect(`owner-${label}`, { ownerToken: randomUUID() });
	const { capability, supervisorSessionId } = await owner.authorizeSupervisorChild(childName);
	const child = await connect(childName, { supervisor: { capability, supervisorSessionId } });
	const childSessionId = sessionIdOf(child);
	const replier = await replierOf(owner);
	const call = new AbortController();
	const questionId = randomUUID();
	const answer = Promise.withResolvers<Message>();
	void answer.promise.catch(() => undefined);
	if (keepWait) pendingAnswers.set(questionId, answer);
	else answer.reject(new Error("Session shutting down"));
	call.signal.addEventListener(
		"abort",
		() => {
			pendingAnswers.delete(questionId);
			answer.reject(new Error("Cancelled"));
		},
		{ once: true },
	);
	assert.equal((await ask(child, questionId)).delivered, true);
	await vi.waitFor(() => assert.ok(replier.received.some((message) => message.id === questionId)), WAIT);
	// The production owner persists the reply before acknowledging it; this broker fixture models that acknowledgement.
	if (order === "reserve-first") await owner.reserveReleasedChildren([{ childName, wake: true }]);
	await child.disconnect();
	await waitUntilGone(owner, childName);
	if (order === "disconnect-first") await owner.reserveReleasedChildren([{ childName, wake: true }]);
	return { owner, childName, childSessionId, questionId, wait: answer.promise, call };
}

function peerAsk(replierName: string) {
	return (child: Client, questionId: string) =>
		child.send(replierName, { messageId: questionId, text: "Which file holds the config?", expectsReply: true });
}

function peerReplier(name: string) {
	return async () => {
		const replier = await connect(name);
		return { sessionId: sessionIdOf(replier), received: recordMessages(replier), client: replier };
	};
}

function replyTo(replier: Client, released: ReleasedAsk, text: string) {
	return replier.send(released.childSessionId, {
		text,
		replyTo: released.questionId,
		requirePendingReply: true,
		expectedRecipientId: released.childSessionId,
	});
}

beforeAll(async () => {
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
});
afterAll(() => brokerFixture.cleanup());

for (const order of ["disconnect-first", "reserve-first"] as const) {
	test(
		`a released child's ask is routed to its owner exactly once (${order}) (#4326)`,
		async () => {
			const replierName = `replier-${order}`;
			let replierClient: Client | undefined;
			const released = await releaseAsker(
				`ask-${order}`,
				peerAsk(replierName),
				async () => {
					const made = await peerReplier(replierName)();
					replierClient = made.client;
					return made;
				},
				order,
			);
			assert.ok(replierClient);
			const replies = recordReplies(released.owner);
			const first = await replyTo(replierClient, released, "src/config.ts");
			assert.equal(first.delivered, true, first.reason);
			assert.equal(await outcome(released.wait), "resolved:src/config.ts");
			assert.equal(replies.length, 1);
			assert.deepEqual(
				{ childName: replies[0]?.childName, replyTo: replies[0]?.replyTo, text: replies[0]?.message.content.text },
				{ childName: released.childName, replyTo: released.questionId, text: "src/config.ts" },
			);
			assert.equal((await released.owner.brokerStatus())?.heldSends, 0, "the reply is not also held for the child");

			const second = await replyTo(replierClient, released, "a second answer");
			assert.equal(second.delivered, false);
			assert.equal(replies.length, 1, "a second reply never reaches the owner");
			assert.equal((await released.owner.brokerStatus())?.heldSends, 0);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

test(
	"a supervisor decision waiting in a released child is answered by the supervisor through the same path (#4326)",
	async () => {
		const owners: Client[] = [];
		const released = await releaseAsker(
			"decision",
			(child, questionId) => {
				const supervisorSessionId = child.supervisorSessionId;
				assert.ok(supervisorSessionId);
				return child.sendToSupervisor(supervisorSessionId, {
					messageId: questionId,
					text: "Approve the schema change?",
					expectsReply: true,
				});
			},
			async (owner) => {
				owners.push(owner);
				return { sessionId: sessionIdOf(owner), received: recordMessages(owner) };
			},
			"disconnect-first",
		);
		assert.equal(owners[0], released.owner);
		const replies = recordReplies(released.owner);
		const answer = await replyTo(released.owner, released, "Approved.");
		assert.equal(answer.delivered, true, answer.reason);
		assert.equal(await outcome(released.wait), "resolved:Approved.");
		assert.equal(replies.length, 1);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reply finds no route once the owner is gone or dropped the child, and is refused when no wait is left (#4326)",
	async () => {
		for (const ending of ["owner-gone", "dropped"] as const) {
			const replierName = `replier-${ending}`;
			let replierClient: Client | undefined;
			const released = await releaseAsker(
				ending,
				peerAsk(replierName),
				async () => {
					const made = await peerReplier(replierName)();
					replierClient = made.client;
					return made;
				},
				"reserve-first",
			);
			assert.ok(replierClient);
			const replies = recordReplies(released.owner);
			if (ending === "owner-gone") {
				await released.owner.disconnect();
				await waitUntilGone(replierClient, `owner-${ending}`);
			} else {
				await released.owner.dropReleasedChildren([released.childName]);
			}
			const refused = await replyTo(replierClient, released, "too late");
			assert.equal(refused.delivered, false, ending);
			assert.equal(replies.length, 0, ending);
			released.call.abort();
			assert.equal(await outcome(released.wait), "rejected:Cancelled", ending);
		}

		let replierClient: Client | undefined;
		const unwaited = await releaseAsker(
			"unwaited",
			peerAsk("replier-unwaited"),
			async () => {
				const made = await peerReplier("replier-unwaited")();
				replierClient = made.client;
				return made;
			},
			"disconnect-first",
			false,
		);
		assert.ok(replierClient);
		const replies = recordReplies(unwaited.owner);
		const refused = await replyTo(replierClient, unwaited, "nobody waits");
		assert.equal(refused.delivered, false);
		assert.match(refused.reason ?? "", /is released and no longer waiting for this reply/);
		assert.equal(replies.length, 1);
		assert.equal(await outcome(unwaited.wait), "rejected:Session shutting down");
		const retry = Promise.withResolvers<Message>();
		pendingAnswers.set(unwaited.questionId, retry);
		const accepted = await replyTo(replierClient, unwaited, "saved on retry");
		assert.equal(accepted.delivered, true, accepted.reason);
		assert.equal((await retry.promise).content.text, "saved on retry");
		assert.equal(replies.length, 2);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reply handed to an owner that leaves before confirming it is reported uncertain, not delivered (#4326)",
	async () => {
		let replierClient: Client | undefined;
		const released = await releaseAsker(
			"unconfirmed",
			peerAsk("replier-unconfirmed"),
			async () => {
				const made = await peerReplier("replier-unconfirmed")();
				replierClient = made.client;
				return made;
			},
			"reserve-first",
		);
		assert.ok(replierClient);
		const handed: ReleasedChildReply[] = [];
		released.owner.on("released_child_reply", (notice: ReleasedChildReply) => handed.push(notice));
		const reply = replyTo(replierClient, released, "unconfirmed answer");
		await vi.waitFor(() => assert.equal(handed.length, 1), WAIT);
		await released.owner.disconnect();
		const result = await reply;
		assert.equal(result.delivered, false);
		assert.match(result.reason ?? "", /uncertain/);
		released.call.abort();
		assert.equal(await outcome(released.wait), "rejected:Cancelled");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"two replies that carry one message id are never mixed up: the second is refused and the first still settles on its owner's confirmation (#4326)",
	async () => {
		const [first, second] = await Promise.all(
			(["conflict-a", "conflict-b"] as const).map(async (label) => {
				let replierClient: Client | undefined;
				const released = await releaseAsker(
					label,
					peerAsk(`replier-${label}`),
					async () => {
						const made = await peerReplier(`replier-${label}`)();
						replierClient = made.client;
						return made;
					},
					"reserve-first",
				);
				assert.ok(replierClient);
				return { released, replier: replierClient, handed: [] as ReleasedChildReply[] };
			}),
		);
		for (const side of [first, second]) {
			side.released.owner.on("released_child_reply", (notice: ReleasedChildReply) => side.handed.push(notice));
		}
		const sharedId = randomUUID();
		const answerOf = (side: typeof first, text: string, messageId: string) =>
			side.replier.send(side.released.childSessionId, {
				text,
				messageId,
				replyTo: side.released.questionId,
				requirePendingReply: true,
				expectedRecipientId: side.released.childSessionId,
			});

		const firstAnswer = answerOf(first, "for the first", sharedId);
		await vi.waitFor(() => assert.equal(first.handed.length, 1), WAIT);
		const refused = await answerOf(second, "for the second", sharedId);
		assert.equal(refused.delivered, false);
		assert.equal(refused.reasonCode, "message_id_conflict");
		assert.equal(second.handed.length, 0, "the refused reply never reaches its owner");

		first.released.owner.acknowledgeReleasedChildReply(sharedId, true);
		const settled = await firstAnswer;
		assert.equal(settled.delivered, true, settled.reason);

		const retried = answerOf(second, "for the second, again", randomUUID());
		await vi.waitFor(() => assert.equal(second.handed.length, 1), WAIT);
		assert.equal(second.handed[0]?.message.content.text, "for the second, again", "the second route was kept");
		second.released.owner.acknowledgeReleasedChildReply(second.handed[0]?.message.id ?? "", true);
		assert.equal((await retried).delivered, true);
		for (const side of [first, second]) side.released.call.abort();
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a reply whose owner never confirms it is reported uncertain before the sender's own wait ends, and a late confirmation changes nothing (#4326)",
	async () => {
		let replierClient: Client | undefined;
		const released = await releaseAsker(
			"stalled",
			peerAsk("replier-stalled"),
			async () => {
				const made = await peerReplier("replier-stalled")();
				replierClient = made.client;
				return made;
			},
			"reserve-first",
		);
		assert.ok(replierClient);
		const handed: ReleasedChildReply[] = [];
		released.owner.on("released_child_reply", (notice: ReleasedChildReply) => handed.push(notice));
		const result = await replyTo(replierClient, released, "saved slowly");
		assert.equal(handed.length, 1);
		assert.equal(result.delivered, false);
		assert.match(result.reason ?? "", /uncertain/);
		assert.equal(released.owner.acknowledgeReleasedChildReply(handed[0]?.message.id ?? "", true), true);
		assert.equal((await released.owner.brokerStatus())?.heldSends, 0, "a late confirmation leaves nothing behind");
		released.call.abort();
		assert.equal(await outcome(released.wait), "rejected:Cancelled");
	},
	STALLED_OWNER_TEST_TIMEOUT_MS,
);

test(
	"a reply whose sender disconnects before its owner confirms it keeps no handoff behind, and the sender can answer again after reconnecting (#4326)",
	async () => {
		const returnAddress = randomUUID();
		let replierClient: Client | undefined;
		const released = await releaseAsker(
			"sender-gone",
			peerAsk("replier-sender-gone"),
			async () => {
				replierClient = await connect("replier-sender-gone", { returnAddress });
				return { sessionId: sessionIdOf(replierClient), received: recordMessages(replierClient) };
			},
			"reserve-first",
		);
		assert.ok(replierClient);
		const replierSessionId = sessionIdOf(replierClient);
		const handed: ReleasedChildReply[] = [];
		released.owner.on("released_child_reply", (notice: ReleasedChildReply) => handed.push(notice));
		void replyTo(replierClient, released, "first try").catch(() => undefined);
		await vi.waitFor(() => assert.equal(handed.length, 1), WAIT);
		await replierClient.disconnect();
		await waitUntilGone(released.owner, "replier-sender-gone");
		released.owner.acknowledgeReleasedChildReply(handed[0]?.message.id ?? "", true);

		const back = await connect("replier-sender-gone", { returnAddress, preferredSessionId: replierSessionId });
		assert.equal(sessionIdOf(back), replierSessionId);
		const retry = replyTo(back, released, "second try");
		await vi.waitFor(() => assert.equal(handed.length, 2), WAIT);
		assert.equal(handed[1]?.message.content.text, "second try");
		released.owner.acknowledgeReleasedChildReply(handed[1]?.message.id ?? "", true);
		assert.equal((await retry).delivered, true);
		released.call.abort();
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
