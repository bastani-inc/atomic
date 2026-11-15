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
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "ask-failure-receipts-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type Client = InstanceType<typeof IntercomClient>;
type Message = import("../../packages/intercom/types.js").Message;
type ReleasedChildReply = import("../../packages/intercom/broker/client.js").ReleasedChildReply;

/** Spawning the real broker child is the structural cost of this suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 10_000, interval: 20 };
/** Long enough for a frame the broker wrote to arrive, so its absence means none was written. */
const SETTLE_MS = 300;

let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
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
}

interface Session {
	readonly client: Client;
	/** Every message that arrived, whether or not it was confirmed. */
	readonly received: Message[];
	/** Asks whose recipient the broker said disconnected (the notice an old client gets). */
	readonly peerGone: string[];
}

/**
 * A real client. `confirms`: it confirms each save, as a session does; without it, it receives frames but never
 * confirms one, as an asker that crashes before saving. `acknowledgesReceipt: false` is a client from before #3761.
 */
async function connect(
	name: string,
	options: {
		returnAddress: string;
		preferredSessionId?: string;
		confirms?: boolean;
		acknowledgesReceipt?: boolean;
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
	},
): Promise<Session> {
	const client = new IntercomClient(options.returnAddress, {
		...(options.acknowledgesReceipt === false ? {} : { acknowledgesReceipt: true }),
		...(options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId }),
	});
	const received: Message[] = [];
	const peerGone: string[] = [];
	client.on("message", (_from: object, message: Message) => {
		received.push(message);
		if (options.confirms !== false && options.acknowledgesReceipt !== false) client.acknowledgeReceived(message.id);
	});
	client.on("peer_disconnected", (notice: { replyTo: string }) => peerGone.push(notice.replyTo));
	client.on("error", () => {});
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
		},
		options.supervisor,
		options.ownerToken,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, received, peerGone };
}

function idOf(client: Client): string {
	const id = client.sessionId;
	assert.ok(id);
	return id;
}

/** The failures of `questionId` that reached the session, however they arrived. */
function failuresOf(session: Session, questionId: string): string[] {
	return [
		...session.received
			.filter((message) => message.replyTo === questionId && message.replyError !== undefined)
			.map((message) => message.id),
		...session.peerGone.filter((replyTo) => replyTo === questionId).map(() => "peer_disconnected"),
	];
}

/** How a connected recipient stops being able to answer. */
const RECIPIENT_FAILURES = [
	{ how: "ends", reason: /ended before replying/, fail: (client: Client) => client.disconnect() },
	{
		how: "becomes terminal",
		reason: /./,
		fail: async (client: Client) => {
			client.updatePresence({ replyCapability: "terminal" });
		},
	},
] as const;

/** An asker asks a connected recipient, which then fails the ask while the asker is connected. */
async function askThenFail(
	label: string,
	asker: { confirms?: boolean; acknowledgesReceipt?: boolean },
	fail: (client: Client) => Promise<void>,
) {
	const askerAddress = { name: `asker-${label}`, returnAddress: randomUUID() };
	const first = await connect(askerAddress.name, { ...askerAddress, ...asker });
	const askerId = idOf(first.client);
	const recipient = await connect(`recipient-${label}`, { returnAddress: randomUUID() });
	const questionId = randomUUID();
	const asked = await first.client.send(`recipient-${label}`, {
		messageId: questionId,
		text: "which port?",
		expectsReply: true,
	});
	assert.equal(asked.delivered, true, asked.reason);
	await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);
	await fail(recipient.client);
	await vi.waitFor(() => assert.equal(failuresOf(first, questionId).length, 1), WAIT);
	return { askerAddress, askerId, first, questionId };
}

beforeAll(startBroker, REAL_BROKER_TEST_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

for (const { how, reason, fail } of RECIPIENT_FAILURES) {
	test(
		`an asker that drops before saving the failure of an ask whose recipient ${how} gets it again once it is back, once (#5004)`,
		async () => {
			const label = `unsaved-${how.replace(/\W/g, "-")}-5004`;
			const { askerAddress, askerId, first, questionId } = await askThenFail(label, { confirms: false }, fail);
			const [failureId] = failuresOf(first, questionId);
			assert.notEqual(failureId, "peer_disconnected", "a receipt-confirming asker is sent a failure it can confirm");

			// The asker crashes before saving it: its connection drops without confirming, and its session comes back.
			await first.client.disconnect({ resumable: true });
			await sleep(SETTLE_MS);
			const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			assert.equal(idOf(back.client), askerId);
			await vi.waitFor(() => assert.deepEqual(failuresOf(back, questionId), [failureId]), WAIT);
			assert.match(back.received.find((message) => message.id === failureId)?.replyError ?? "", reason);

			// Saved this time: it is not sent again.
			await back.client.disconnect({ resumable: true });
			await sleep(SETTLE_MS);
			const again = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			await sleep(SETTLE_MS);
			assert.deepEqual(failuresOf(again, questionId), [], "a saved failure is delivered once");
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);

	test(
		`an asker that saved the failure of an ask whose recipient ${how} is not sent it again (#5004)`,
		async () => {
			const label = `saved-${how.replace(/\W/g, "-")}-5004`;
			const { askerAddress, askerId, first, questionId } = await askThenFail(label, {}, fail);
			await sleep(SETTLE_MS);
			await first.client.disconnect({ resumable: true });
			await sleep(SETTLE_MS);
			const back = await connect(askerAddress.name, { ...askerAddress, preferredSessionId: askerId });
			await sleep(SETTLE_MS);
			assert.deepEqual(failuresOf(back, questionId), []);
		},
		REAL_BROKER_TEST_TIMEOUT_MS,
	);
}

test(
	"an asker that does not confirm saves gets the recipient-ended notice it always got, once (#5004)",
	async () => {
		const label = "old-client-5004";
		const { askerAddress, askerId, first, questionId } = await askThenFail(
			label,
			{ acknowledgesReceipt: false },
			(client) => client.disconnect(),
		);
		assert.deepEqual(failuresOf(first, questionId), ["peer_disconnected"]);
		await first.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const back = await connect(askerAddress.name, {
			...askerAddress,
			preferredSessionId: askerId,
			acknowledgesReceipt: false,
		});
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(back, questionId), []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a woken released subagent that drops before saving its held failed ask gets it again once it is back, once (#5004)",
	async () => {
		const childName = "subagent-unsaved-failure-5004";
		const owner = await connect("owner-unsaved-failure-5004", {
			returnAddress: randomUUID(),
			ownerToken: randomUUID(),
		});
		const child = { name: childName, returnAddress: randomUUID() };
		const childFirst = await connect(childName, {
			...child,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		const childId = idOf(childFirst.client);
		const recipient = await connect("recipient-unsaved-failure-5004", { returnAddress: randomUUID() });
		const questionId = randomUUID();
		const asked = await childFirst.client.send("recipient-unsaved-failure-5004", {
			messageId: questionId,
			text: "which port?",
			expectsReply: true,
		});
		assert.equal(asked.delivered, true, asked.reason);
		await vi.waitFor(() => assert.ok(recipient.received.some((message) => message.id === questionId)), WAIT);

		// The child is released; its owner hands the failure back to it when the recipient ends, and wakes it.
		await owner.client.reserveReleasedChildren([{ childName, wake: true }]);
		await childFirst.client.disconnect();
		owner.client.on("released_child_reply", (notice: ReleasedChildReply) => {
			owner.client.acknowledgeReleasedChildReply(notice, false, true);
		});
		const wakes: string[] = [];
		owner.client.on("restoring_recipient_wake", (notice: { childName: string }) => wakes.push(notice.childName));
		await recipient.client.disconnect();
		await vi.waitFor(() => assert.deepEqual(wakes, [childName]), WAIT);

		// The woken child gets the failure, then dies before saving it.
		const woken = await connect(childName, {
			...child,
			preferredSessionId: childId,
			confirms: false,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		await vi.waitFor(() => assert.equal(failuresOf(woken, questionId).length, 1), WAIT);
		const [failureId] = failuresOf(woken, questionId);
		await woken.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);

		// Back again, it gets the failure once more; saved this time, never again.
		const back = await connect(childName, {
			...child,
			preferredSessionId: childId,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		await vi.waitFor(() => assert.deepEqual(failuresOf(back, questionId), [failureId]), WAIT);
		assert.match(
			back.received.find((message) => message.id === failureId)?.replyError ?? "",
			/ended before replying/,
		);
		await back.client.disconnect({ resumable: true });
		await sleep(SETTLE_MS);
		const again = await connect(childName, {
			...child,
			preferredSessionId: childId,
			supervisor: await owner.client.authorizeSupervisorChild(childName),
		});
		await sleep(SETTLE_MS);
		assert.deepEqual(failuresOf(again, questionId), [], "a saved failure is delivered once");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
