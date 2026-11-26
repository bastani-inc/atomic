/**
 * Broker failover: a node's Intercom broker is killed, frozen, or cut off from the database while the other nodes keep
 * sending. Nothing sent is lost or delivered twice, and the other nodes keep routing between themselves meanwhile.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { sleep } from "../../helpers/runtime.js";
import { Cluster, type Node, type NodeClient } from "../harness/cluster.js";
import { distributedSkipReason, recordEvent } from "../harness/topology.js";
import { deliveredInOrder, type SentMessage, sendAll, sendSequence } from "../harness/traffic.js";

const SCENARIO = "failover";
const DELIVERY = { timeout: 120_000, interval: 100 };
/** How long a fault lasts while the other nodes keep sending. */
const FAULT_MS = 10_000;

describe.skipIf(distributedSkipReason !== undefined)("broker failover", () => {
	let cluster: Cluster;
	let a: Node;
	let b: Node;
	let c: Node;

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a", "b", "c"]);
		[a, b, c] = ["a", "b", "c"].map((name) => cluster.node(name)) as [Node, Node, Node];
		for (const node of [a, b, c]) await node.startBroker();
	});
	afterAll(async () => {
		await cluster?.cleanup();
	});
	beforeEach(async () => {
		for (const node of [a, b, c]) if (!node.brokerRunning()) await node.startBroker();
	});

	/** A session on `node` with an id and return address of its own, which it can register again with. */
	async function session(node: Node, label: string) {
		const identity = { id: randomUUID(), returnAddress: randomUUID(), name: `${label}-${randomUUID().slice(0, 6)}` };
		const client = await node.connect(identity.name, {
			preferredSessionId: identity.id,
			returnAddress: identity.returnAddress,
		});
		assert.equal(client.sessionId, identity.id);
		return {
			...identity,
			client,
			reconnect: (on: Node) =>
				on.connect(identity.name, { preferredSessionId: identity.id, returnAddress: identity.returnAddress }),
		};
	}

	test("messages sent while the recipient's broker is dead are queued, and arrive once, in order, after it restarts", async () => {
		const recipient = await session(b, "recipient");
		const sender = await a.connect(`sender-${randomUUID().slice(0, 6)}`);
		const before = await sendSequence(sender, recipient.id, recipient.name, 3, "before", () => recipient.client);
		await vi.waitFor(() => deliveredInOrder(recipient.client, before), DELIVERY);

		await b.killBroker();
		let back: NodeClient | undefined;
		// The sends wait, or are queued, while the broker is dead; it comes back a few seconds later.
		const sending = sendSequence(sender, recipient.id, recipient.name, 5, "during", () => back);
		await sleep(3_000);
		await b.startBroker();
		recordEvent(SCENARIO, { event: "broker-restarted", node: "b" });
		back = await recipient.reconnect(b);
		assert.equal(back.sessionId, recipient.id);
		const during = await sending;
		await vi.waitFor(() => deliveredInOrder(back!, during), DELIVERY);
		assert.ok(!recipient.client.received.some((frame) => during.some((message) => message.id === frame.message.id)));
	});

	test("while one broker is frozen, the other nodes keep routing, and the frozen one's messages arrive once it thaws", async () => {
		const peers = [
			await a.connect(`peer-a-${randomUUID().slice(0, 6)}`),
			await b.connect(`peer-b-${randomUUID().slice(0, 6)}`),
		];
		const frozenPeer = await c.connect(`peer-c-${randomUUID().slice(0, 6)}`);
		c.signalBroker("SIGSTOP");
		let toFrozen: SentMessage[] = [];
		try {
			const started = performance.now();
			const between = await sendAll(peers, peers, 5, `frozen-${randomUUID().slice(0, 6)}`);
			for (const peer of peers)
				await vi.waitFor(
					() =>
						deliveredInOrder(
							peer,
							between.filter((message) => message.to === peer.name),
						),
					DELIVERY,
				);
			assert.ok(performance.now() - started < FAULT_MS * 3, "routing between the other nodes stalled");
			toFrozen = await sendSequence(
				peers[0]!,
				frozenPeer.sessionId,
				frozenPeer.name,
				3,
				"to-frozen",
				() => frozenPeer,
			);
			await sleep(FAULT_MS);
		} finally {
			c.signalBroker("SIGCONT");
		}
		await vi.waitFor(() => deliveredInOrder(frozenPeer, toFrozen), DELIVERY);
	});

	test("a node cut off from the database catches up once the partition heals: what it sent and what was sent to it", async () => {
		const near = await a.connect(`near-${randomUUID().slice(0, 6)}`);
		const far = await b.connect(`far-${randomUUID().slice(0, 6)}`);
		b.partition();
		let toFar: SentMessage[] = [];
		// Sends from the cut-off node wait for their route; sends to it are queued in the database.
		const fromFar = sendSequence(far, near.sessionId, near.name, 3, "from-far", () => near);
		try {
			toFar = await sendSequence(near, far.sessionId, far.name, 3, "to-far", () => far);
			await sleep(FAULT_MS);
		} finally {
			b.heal();
		}
		const sent = await fromFar;
		await vi.waitFor(() => deliveredInOrder(far, toFar), DELIVERY);
		await vi.waitFor(() => deliveredInOrder(near, sent), DELIVERY);
	});
});
