import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

/**
 * A restart relaunches a subagent that asked its owner a question in its earlier run. Whether a reply to that question
 * still reaches the relaunched subagent depends on how the restart went: which of the owner and the subagent left the
 * broker first, and whether the owner reserved the subagent as released. The broker answers, without routing or changing
 * anything, how it would take such a reply now, and its answer agrees with what the reply then gets.
 */

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "reply-routes-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { UNAUTHORIZED_REPLY_REASON } = await import("../../packages/intercom/broker/delivery-failure-reason.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;

/** Each scenario connects, disconnects and reconnects several real sessions to a real broker. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 10_000, interval: 20 };
const BROKER_START_WAIT_MS = 90_000;
const BROKER_START_HOOK_TIMEOUT_MS = BROKER_START_WAIT_MS + 5_000;

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

async function waitUntilGone(observer: Client, name: string): Promise<void> {
	await vi.waitFor(async () => {
		const sessions = await observer.listSessions();
		assert.equal(
			sessions.some((session) => session.name === name),
			false,
		);
	}, WAIT);
}

beforeAll(async () => {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await brokerFixture.holdSession(getBrokerSocketPath(process.platform, brokerFixture.agentDir), BROKER_START_WAIT_MS);
}, BROKER_START_HOOK_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

type Reservation = "none" | "restoring" | "released";

const scenarios: ReadonlyArray<readonly [boolean, Reservation, "refused" | "deliver"]> = [
	[false, "none", "refused"],
	[false, "restoring", "refused"],
	[false, "released", "deliver"],
	[true, "none", "deliver"],
	[true, "restoring", "deliver"],
	[true, "released", "deliver"],
];

for (const [ownerFirst, reservation, expected] of scenarios) {
	test(
		`the broker tells how it would take a reply to a relaunched subagent's earlier ask, and the reply agrees (${ownerFirst ? "owner" : "subagent"} left first, ${reservation} reservation)`,
		async () => {
			const tag = `${reservation}-${ownerFirst ? "owner" : "child"}-first`;
			const ownerToken = randomUUID();
			const ownerAddress = randomUUID();
			const childAddress = randomUUID();
			const ownerName = `owner-${tag}`;
			const childName = `subagent-asker-${tag}`;
			const owner = await connect(ownerName, { ownerToken, returnAddress: ownerAddress });
			const ownerId = sessionIdOf(owner);
			const child = await connect(childName, {
				supervisor: await owner.authorizeSupervisorChild(childName),
				returnAddress: childAddress,
			});
			const childId = sessionIdOf(child);
			const questionId = randomUUID();
			const asked = recordMessages(owner);
			assert.equal(
				(await child.send(ownerName, { messageId: questionId, text: "Which file?", expectsReply: true })).delivered,
				true,
			);
			await vi.waitFor(() => assert.equal(asked.length, 1), WAIT);

			// The restart: both leave, in one order or the other.
			if (ownerFirst) {
				await owner.disconnect({ resumable: true });
				await child.disconnect();
			} else {
				await child.disconnect();
				await waitUntilGone(owner, childName);
				await owner.disconnect({ resumable: true });
			}
			const restarted = await connect(ownerName, {
				ownerToken,
				returnAddress: ownerAddress,
				preferredSessionId: ownerId,
			});
			assert.equal(sessionIdOf(restarted), ownerId);
			const grant = await restarted.authorizeSupervisorChild(childName);
			if (reservation === "restoring")
				await restarted.reserveRestoringRecipient(grant.capability, { aliases: [childId] });
			if (reservation === "released") await restarted.reserveReleasedChildren([{ childName, wake: true }]);
			const relaunched = await connect(childName, {
				supervisor: grant,
				returnAddress: childAddress,
				preferredSessionId: childId,
			});
			assert.equal(sessionIdOf(relaunched), childId);
			const answers = recordMessages(relaunched);

			// Asked twice: the question routes, holds and changes nothing.
			assert.deepEqual(await restarted.replyRoutes([{ replyTo: questionId, to: childId }]), [expected]);
			assert.deepEqual(await restarted.replyRoutes([{ replyTo: questionId, to: childId }]), [expected]);

			const reply = await restarted.send(childId, {
				replyTo: questionId,
				text: "the earlier answer",
				requirePendingReply: true,
				expectedRecipientId: childId,
			});
			if (expected === "refused") {
				assert.deepEqual([reply.delivered, reply.reason], [false, UNAUTHORIZED_REPLY_REASON]);
			} else {
				assert.equal(reply.delivered, true, reply.reason);
				await vi.waitFor(
					() =>
						assert.deepEqual(
							answers.map((message) => message.replyTo),
							[questionId],
						),
					WAIT,
				);
			}
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

test(
	"the broker cannot tell about a reply to a session that is not connected, and refuses one to a question it never routed",
	async () => {
		const replier = await connect("replier-unknown");
		const peer = await connect("peer-unknown");
		const verdicts = await replier.replyRoutes([
			{ replyTo: randomUUID(), to: randomUUID() },
			{ replyTo: randomUUID(), to: sessionIdOf(peer) },
		]);
		assert.deepEqual(verdicts, ["unknown", "refused"]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a session asks about more replies than one frame holds, in several frames, and stays connected",
	async () => {
		const { REPLY_ROUTES_FRAME_MAX } = await import("../../packages/intercom/broker/reply-routes.js");
		const replier = await connect("replier-many");
		const peer = await connect("peer-many");
		const count = REPLY_ROUTES_FRAME_MAX * 2 + 3;
		const verdicts = await replier.replyRoutes(
			Array.from({ length: count }, () => ({ replyTo: randomUUID(), to: sessionIdOf(peer) })),
		);
		assert.equal(verdicts.length, count);
		assert.ok(verdicts.every((verdict) => verdict === "refused"));
		assert.equal(replier.isConnected(), true);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
