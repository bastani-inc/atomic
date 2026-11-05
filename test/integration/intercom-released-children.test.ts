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
	options: { ownerToken?: string; supervisor?: { capability: string; supervisorSessionId: string } } = {},
): Promise<Client> {
	const client = new IntercomClient(randomUUID());
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

function recordWakes(owner: Client): WakeNotice[] {
	const notices: WakeNotice[] = [];
	owner.on("restoring_recipient_wake", (notice: WakeNotice) => notices.push(notice));
	return notices;
}

function recordMessages(child: Client): string[] {
	const received: string[] = [];
	child.on("message", (_from: object, message: { id: string }) => received.push(message.id));
	return received;
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

		const child = await connect(childName);
		const received = recordMessages(child);
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
	"acknowledging the wake of a child this connection did not reserve is a typed refusal (#4326)",
	async () => {
		const owner = await connect("ack-owner");
		const other = await connect("ack-other");
		await owner.reserveReleasedChildren([{ childName: "subagent-ack-1", wake: true }]);
		for (const [client, childName] of [
			[owner, "subagent-never-reserved-1"],
			[other, "subagent-ack-1"],
		] as const) {
			const error = await client.acknowledgeReleasedChildWake(childName).then(
				() => undefined,
				(rejection: Error) => rejection,
			);
			assert.ok(error instanceof UnknownReleasedChildError);
			assert.equal(error.code, "unknown_released_child");
			assert.equal(error.childName, childName);
		}
		await owner.acknowledgeReleasedChildWake("subagent-ack-1");
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

		const child = await connect(childName, { supervisor: { capability, supervisorSessionId } });
		const received = recordMessages(child);
		const delivered = await results;
		await vi.waitFor(() => assert.equal(received.length, 2), { timeout: 10_000, interval: 20 });
		assert.deepEqual(
			received,
			delivered.map((result) => result.id),
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
