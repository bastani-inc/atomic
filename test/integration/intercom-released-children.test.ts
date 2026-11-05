import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "released-children-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient, ReleasedChildReservationError, UnknownReleasedChildError } = await import(
	"../../packages/intercom/broker/client.js"
);

type Client = InstanceType<typeof IntercomClient>;
interface WakeNotice {
	readonly childName: string;
	readonly capability?: string;
}
interface RawRequests {
	restoringRecipientRequest(frame: { type: string; children: Array<Record<string, string | boolean>> }): Promise<void>;
}

const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const SETTLE_MS = 300;
const FRAME_OVERFLOW_CHILDREN = 1_200;

let broker: ChildProcess | undefined;

async function connect(
	name: string,
	options: {
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
		messages?: string[];
		returnAddress?: string;
		preferredSessionId?: string;
		group?: string;
	} = {},
): Promise<Client> {
	const client = new IntercomClient(
		options.returnAddress ?? randomUUID(),
		options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId },
	);
	if (options.messages !== undefined) recordMessages(client, options.messages);
	const group = options.group ?? "default";
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
			groups: [group],
		},
		options.supervisor,
		options.ownerToken,
		undefined,
		group,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

function recordWakes(owner: Client): WakeNotice[] {
	const notices: WakeNotice[] = [];
	owner.on("restoring_recipient_wake", (notice: WakeNotice) => notices.push(notice));
	return notices;
}

function recordMessages(child: Client, received: string[]): void {
	child.on("message", (_from: object, message: { id: string }) => received.push(message.id));
}

async function heldSends(client: Client): Promise<number | undefined> {
	return (await client.brokerStatus())?.heldSends;
}

async function waitForHeld(client: Client, count: number): Promise<void> {
	await vi.waitFor(async () => assert.equal(await heldSends(client), count), { timeout: 10_000, interval: 20 });
}

beforeAll(async () => {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await vi.waitFor(
		async () => {
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
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => brokerFixture.cleanup());

test(
	"reserved by name in frames, a released child is woken once per hold and gets each send once, in order, when it registers (#4326)",
	async () => {
		const owner = await connect("batch-owner");
		const notices = recordWakes(owner);
		const childName = "subagent-batch-1";
		const siblings = Array.from({ length: FRAME_OVERFLOW_CHILDREN }, (_, index) => ({
			childName: `subagent-batch-sibling-${index}`,
			wake: true,
		}));
		await owner.reserveReleasedChildren([...siblings, { childName, wake: true }]);
		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		const status = await owner.brokerStatus();
		assert.equal(status?.reservations, FRAME_OVERFLOW_CHILDREN + 1);

		const sender = await connect("batch-sender");
		const sends = [
			sender.send(childName, { text: "one" }),
			sender.send(childName, { text: "two", expectsReply: true }),
			sender.send(childName, { text: "three" }),
		];
		const results = Promise.all(sends);
		await waitForHeld(owner, 3);
		assert.deepEqual(notices, [{ childName }], "one wake notice for the hold that started empty, by name only");
		await owner.acknowledgeReleasedChildWake(childName);

		const received: string[] = [];
		await connect(childName, { messages: received });
		const delivered = await results;
		assert.deepEqual(
			delivered.map((result) => result.delivered),
			[true, true, true],
		);
		await vi.waitFor(() => assert.equal(received.length, 3), { timeout: 10_000, interval: 20 });
		assert.deepEqual(
			received,
			delivered.map((result) => result.id),
			"each send arrives once, in the order it was sent",
		);
		await sleep(SETTLE_MS);
		assert.equal(received.length, 3);
		assert.equal(await heldSends(owner), 0);
		assert.equal((await owner.brokerStatus())?.reservations, FRAME_OVERFLOW_CHILDREN);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a frame with an invalid child is refused as a whole with a typed error naming the child, at the client and at the broker (#4326)",
	async () => {
		const owner = await connect("invalid-owner");
		const before = (await owner.brokerStatus())?.reservations ?? 0;
		const clientSide = await owner
			.reserveReleasedChildren([
				{ childName: "subagent-valid-1", wake: true },
				{ childName: "subagent-bad-alias-1", aliases: ["a-name"], wake: true },
			])
			.then(
				() => undefined,
				(error: Error) => error,
			);
		assert.ok(clientSide instanceof ReleasedChildReservationError);
		assert.equal(clientSide.code, "invalid_alias");
		assert.equal(clientSide.childName, "subagent-bad-alias-1");

		const brokerSide = await (owner as unknown as RawRequests)
			.restoringRecipientRequest({
				type: "reserve_released_children",
				children: [
					{ childName: "subagent-valid-2", wake: true },
					{ childName: "subagent-bad-wake-1", wake: "yes" },
				],
			})
			.then(
				() => undefined,
				(error: Error) => error,
			);
		assert.ok(brokerSide instanceof ReleasedChildReservationError);
		assert.equal(brokerSide.code, "invalid_frame");
		assert.equal(brokerSide.childName, "subagent-bad-wake-1");
		assert.equal((await owner.brokerStatus())?.reservations, before, "nothing from a refused frame is reserved");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"acknowledging the wake of a child nobody reserved is unknown, and of another owner's child is not_owner (#4326)",
	async () => {
		const owner = await connect("ack-owner");
		const other = await connect("ack-other");
		await owner.reserveReleasedChildren([{ childName: "subagent-ack-1", wake: true }]);
		const rejectionOf = (client: Client, childName: string) =>
			client.acknowledgeReleasedChildWake(childName).then(
				() => undefined,
				(rejection: Error) => rejection,
			);
		const unknown = await rejectionOf(owner, "subagent-never-reserved-1");
		assert.ok(unknown instanceof UnknownReleasedChildError);
		assert.equal(unknown.code, "unknown_released_child");
		assert.equal(unknown.childName, "subagent-never-reserved-1");
		const foreign = await rejectionOf(other, "subagent-ack-1");
		assert.ok(foreign instanceof ReleasedChildReservationError);
		assert.equal(foreign.code, "not_owner");
		assert.equal(foreign.childName, "subagent-ack-1");
		await owner.acknowledgeReleasedChildWake("subagent-ack-1");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"another session cannot take over, drop or acknowledge an owner's released child, and the owner keeps it after reconnecting as itself (#4326)",
	async () => {
		const childName = "subagent-owned-1";
		const returnAddress = randomUUID();
		const owner = await connect("owned-owner", { ownerToken: randomUUID(), returnAddress });
		const ownerSessionId = owner.sessionId;
		assert.ok(ownerSessionId);
		await owner.authorizeSupervisorChild(childName);
		const ownerWakes = recordWakes(owner);
		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		const intruder = await connect("owned-intruder", { ownerToken: randomUUID() });
		const intruderWakes = recordWakes(intruder);
		const sender = await connect("owned-sender");
		const firstSend = sender.send(childName, { text: "one" });
		await waitForHeld(owner, 1);
		assert.deepEqual(ownerWakes, [{ childName }]);
		const before = await owner.brokerStatus();

		const refusalOf = (attempt: Promise<void>) =>
			attempt.then(
				() => undefined,
				(rejection: Error) => rejection,
			);
		const attempts = [
			() =>
				intruder.reserveReleasedChildren([
					{ childName: "subagent-owned-free-1", wake: true },
					{ childName, wake: true },
				]),
			() => intruder.dropReleasedChildren(["subagent-owned-free-1", childName], { gone: "taken" }),
			() => intruder.acknowledgeReleasedChildWake(childName),
		];
		for (const attempt of attempts) {
			const error = await refusalOf(attempt());
			assert.ok(error instanceof ReleasedChildReservationError);
			assert.equal(error.code, "not_owner");
			assert.equal(error.childName, childName);
		}
		const after = await owner.brokerStatus();
		assert.equal(after?.reservations, before?.reservations, "nothing from a refused frame is reserved");
		assert.equal(after?.heldSends, 1);
		assert.deepEqual(intruderWakes, []);

		await owner.disconnect();
		assert.equal((await firstSend).delivered, false);
		const inGap = await refusalOf(intruder.reserveReleasedChildren([{ childName, wake: true }]));
		assert.ok(inGap instanceof ReleasedChildReservationError);
		assert.equal(inGap.code, "not_owner");

		const back = await connect("owned-owner", {
			ownerToken: randomUUID(),
			returnAddress,
			preferredSessionId: ownerSessionId,
		});
		assert.equal(back.sessionId, ownerSessionId);
		const backWakes = recordWakes(back);
		await back.reserveReleasedChildren([{ childName, wake: true }]);
		const secondSend = sender.send(childName, { text: "two" });
		await waitForHeld(back, 1);
		assert.deepEqual(backWakes, [{ childName }]);
		await back.acknowledgeReleasedChildWake(childName);
		await back.dropReleasedChildren([childName], { refusal: "the owner ended it" });
		const second = await secondSend;
		assert.equal(second.delivered, false);
		assert.match(second.reason ?? "", /the owner ended it/);
		assert.deepEqual(intruderWakes, []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"only a workflow group the owner is not in is refused, whole and typed; auto-group children reserve and re-reserve after a reconnect (#4326)",
	async () => {
		const returnAddress = randomUUID();
		const owner = await connect("grouped-owner", { returnAddress });
		const ownerSessionId = owner.sessionId;
		assert.ok(ownerSessionId);
		const before = (await owner.brokerStatus())?.reservations ?? 0;
		const autoGroup = randomUUID();
		const refused = await owner
			.reserveReleasedChildren([
				{ childName: "subagent-grouped-auto-1", group: autoGroup, wake: true },
				{ childName: "subagent-grouped-workflow-1", group: "workflow:run-elsewhere/stage", wake: true },
			])
			.then(
				() => undefined,
				(rejection: Error) => rejection,
			);
		assert.ok(refused instanceof ReleasedChildReservationError);
		assert.equal(refused.code, "group_not_allowed");
		assert.equal(refused.childName, "subagent-grouped-workflow-1");
		assert.equal((await owner.brokerStatus())?.reservations, before, "nothing from a refused frame is reserved");

		const frame = [
			{ childName: "subagent-grouped-auto-1", group: autoGroup, wake: true },
			{ childName: "subagent-grouped-auto-2", group: autoGroup, wake: false },
			{ childName: "subagent-grouped-team-1", group: "team-a", wake: true },
		];
		await owner.reserveReleasedChildren(frame);
		assert.equal((await owner.brokerStatus())?.reservations, before + frame.length);
		const ownerWakes = recordWakes(owner);
		const sibling = await connect("grouped-sibling", { group: autoGroup });
		const held = sibling.send("subagent-grouped-auto-1", { text: "from a sibling" });
		await waitForHeld(owner, 1);
		assert.deepEqual(ownerWakes, [{ childName: "subagent-grouped-auto-1" }]);

		await owner.disconnect();
		assert.equal((await held).delivered, false);
		const back = await connect("grouped-owner", { returnAddress, preferredSessionId: ownerSessionId });
		await back.reserveReleasedChildren(frame);
		assert.equal((await back.brokerStatus())?.reservations, before + frame.length);

		const stage = await connect("grouped-stage", { group: "workflow:run-grouped" });
		await stage.reserveReleasedChildren([
			{ childName: "subagent-grouped-stage-1", group: "workflow:run-grouped", wake: true },
		]);
		assert.equal((await stage.brokerStatus())?.reservations, before + frame.length + 1);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a parked released child holds sends without waking its owner until the owner reserves it with wake (#4326)",
	async () => {
		const owner = await connect("parked-owner");
		const notices = recordWakes(owner);
		const childName = "subagent-parked-1";
		await owner.reserveReleasedChildren([{ childName, wake: false }]);
		const sender = await connect("parked-sender");
		const result = sender.send(childName, { text: "hello" });
		await waitForHeld(owner, 1);
		await owner.brokerStatus();
		assert.deepEqual(notices, []);

		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		await vi.waitFor(() => assert.deepEqual(notices, [{ childName }]), { timeout: 10_000, interval: 20 });
		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		await owner.brokerStatus();
		assert.equal(notices.length, 1);

		await owner.dropReleasedChildren([childName], { refusal: "resumed elsewhere" });
		const settled = await result;
		assert.equal(settled.delivered, false);
		assert.match(settled.reason ?? "", /resumed elsewhere/);
		assert.equal(await heldSends(owner), 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"dropping a released child as gone refuses held and later sends, and a disconnecting owner frees its reservations (#4326)",
	async () => {
		const owner = await connect("drop-owner");
		const childName = "subagent-drop-1";
		await owner.reserveReleasedChildren([
			{ childName, wake: false },
			{ childName: "subagent-drop-2", wake: false },
		]);
		const sender = await connect("drop-sender");
		const held = sender.send(childName, { text: "anyone?" });
		await waitForHeld(owner, 1);
		await owner.dropReleasedChildren([childName], { gone: "its session file was deleted" });
		const first = await held;
		assert.equal(first.delivered, false);
		assert.match(first.reason ?? "", /is gone: its session file was deleted/);
		const later = await sender.send(childName, { text: "again" });
		assert.match(later.reason ?? "", /is gone/);

		const parked = sender.send("subagent-drop-2", { text: "hold me" });
		await waitForHeld(sender, 1);
		await owner.disconnect();
		const freed = await parked;
		assert.equal(freed.delivered, false);
		assert.equal(await heldSends(sender), 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a restoring supervisor reserving a released child under its own capability takes over its held sends (#4326)",
	async () => {
		const launcher = await connect("takeover-launcher");
		const childName = "subagent-takeover-1";
		await launcher.reserveReleasedChildren([{ childName, wake: true }]);
		const sender = await connect("takeover-sender");
		const results = Promise.all([sender.send(childName, { text: "one" }), sender.send(childName, { text: "two" })]);
		await waitForHeld(launcher, 2);

		const supervisor = await connect("takeover-supervisor", { ownerToken: randomUUID() });
		const { capability, supervisorSessionId } = await supervisor.authorizeSupervisorChild(childName);
		await supervisor.reserveRestoringRecipient(capability);
		assert.equal((await supervisor.brokerStatus())?.heldSends, 2);

		const received: string[] = [];
		await connect(childName, { supervisor: { capability, supervisorSessionId }, messages: received });
		const delivered = await results;
		await vi.waitFor(() => assert.equal(received.length, 2), { timeout: 10_000, interval: 20 });
		assert.deepEqual(
			received,
			delivered.map((result) => result.id),
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an ask open to a released child survives release and receives one reply after the child reconnects (#4326)",
	async () => {
		const owner = await connect("incoming-owner", { ownerToken: randomUUID() });
		const asker = await connect("incoming-asker");
		const childName = "subagent-incoming-question";
		const firstAuthorization = await owner.authorizeSupervisorChild(childName);
		const child = await connect(childName, { supervisor: firstAuthorization });
		const originalId = child.sessionId;
		assert.ok(originalId);
		const received: string[] = [];
		const disconnected: string[] = [];
		const rebound: Array<{ replyTo: string; previousSessionId: string; sessionId: string }> = [];
		asker.on("message", (_from: object, message: { id: string }) => received.push(message.id));
		asker.on("peer_disconnected", (notice: { replyTo: string }) => disconnected.push(notice.replyTo));
		asker.on("peer_rebound", (notice: { replyTo: string; previousSessionId: string; sessionId: string }) =>
			rebound.push(notice),
		);
		const question = await asker.send(childName, { text: "question", expectsReply: true });
		assert.equal(question.delivered, true);
		await owner.reserveReleasedChildren([{ childName, wake: false }]);
		await child.disconnect();
		await vi.waitFor(async () =>
			assert.equal(
				(await owner.listSessions()).some((session) => session.id === originalId),
				false,
			),
		);
		assert.deepEqual(disconnected, []);
		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		const authorization = await owner.authorizeSupervisorChild(childName);
		const restored = await connect(childName, { supervisor: authorization });
		assert.ok(restored.sessionId);
		await vi.waitFor(() =>
			assert.deepEqual(rebound, [
				{ replyTo: question.id, previousSessionId: originalId, sessionId: restored.sessionId },
			]),
		);
		const reply = await restored.send(asker.sessionId!, {
			text: "answer",
			replyTo: question.id,
			requirePendingReply: true,
		});
		assert.equal(reply.delivered, true, reply.reason);
		await vi.waitFor(() => assert.deepEqual(received, [reply.id]));
		const duplicate = await restored.send(asker.sessionId!, {
			text: "again",
			replyTo: question.id,
			requirePendingReply: true,
		});
		assert.equal(duplicate.delivered, false);
		assert.deepEqual(received, [reply.id]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"dropping a released child's reservation fails its open ask with peer_disconnected (#4326)",
	async () => {
		const owner = await connect("drop-question-owner", { ownerToken: randomUUID() });
		const asker = await connect("drop-question-asker");
		const childName = "subagent-dropped-question";
		const authorization = await owner.authorizeSupervisorChild(childName);
		const child = await connect(childName, { supervisor: authorization });
		const originalId = child.sessionId;
		const notices: Array<{ replyTo: string; peerSessionId: string }> = [];
		asker.on("peer_disconnected", (notice: { replyTo: string; peerSessionId: string }) => notices.push(notice));
		const question = await asker.send(childName, { text: "question", expectsReply: true });
		assert.equal(question.delivered, true);
		await owner.reserveReleasedChildren([{ childName, wake: true }]);
		await child.disconnect();
		await vi.waitFor(async () =>
			assert.equal(
				(await owner.listSessions()).some((session) => session.id === originalId),
				false,
			),
		);
		assert.equal(notices.length, 0);
		await owner.dropReleasedChildren([childName], { gone: "gone" });
		await vi.waitFor(() => assert.equal(notices.length, 1));
		assert.deepEqual(
			{ replyTo: notices[0]?.replyTo, peerSessionId: notices[0]?.peerSessionId },
			{ replyTo: question.id, peerSessionId: originalId },
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
