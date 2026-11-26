/**
 * Session handoff: an Intercom session that moves from one node's broker to another's keeps its id, and every message
 * sent to it from other nodes, before, during and after the move, arrives once and in order on one of its connections.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS, type IntercomIdHandoff } from "../../../packages/intercom/broker/client.js";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../../packages/intercom/broker/multinode-state-store.js";
import { sleep } from "../../helpers/runtime.js";
import { Cluster, type NodeClient } from "../harness/cluster.js";
import { distributedSkipReason, recordEvent } from "../harness/topology.js";
import { deliveredInOrder, type SentMessage, sendSequence } from "../harness/traffic.js";

const SCENARIO = "handoff";
const DELIVERY = { timeout: 90_000, interval: 100 };
const MESSAGES = 12;

/** Every message the connections of one session received, in the order they arrived, each with its connection's number. */
function merged(name: string, ...connections: NodeClient[]): NodeClient {
	const received = connections
		.flatMap((connection, index) => connection.received.map((frame) => ({ ...frame, connection: index })))
		.sort((left, right) => left.at - right.at);
	return { name, received } as unknown as NodeClient;
}

describe.skipIf(distributedSkipReason !== undefined)("session handoff between nodes", () => {
	let cluster: Cluster;

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a", "b", "c"]);
		for (const node of cluster.nodes.values()) await node.startBroker();
	});
	afterAll(async () => {
		await cluster?.cleanup();
	});

	test("a session that leaves node A and registers on node C keeps its id, and gets every message once, in order", async () => {
		const [a, b, c] = ["a", "b", "c"].map((name) => cluster.node(name));
		const moving = { id: randomUUID(), returnAddress: randomUUID(), name: `moving-${randomUUID().slice(0, 6)}` };
		const first = await a!.connect(moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
		});
		assert.equal(first.sessionId, moving.id);
		const senders = [await b!.connect("sender-b"), await c!.connect("sender-c")];
		let second: NodeClient | undefined;
		const receiver = () => merged(moving.name, first, ...(second === undefined ? [] : [second]));

		const sending = Promise.all(
			senders.map((sender) =>
				(async () => {
					const sent: SentMessage[] = [];
					for (let k = 1; k <= MESSAGES; k++) {
						sent.push(...(await sendSequence(sender, moving.id, moving.name, 1, `move ${k}`, receiver)));
						await sleep(150);
					}
					return sent;
				})(),
			),
		);
		await sleep(600);
		await a!.disconnect(first);
		recordEvent(SCENARIO, { event: "left", node: "a" });
		await sleep(600);
		second = await c!.connect(moving.name, { preferredSessionId: moving.id, returnAddress: moving.returnAddress });
		recordEvent(SCENARIO, { event: "arrived", node: "c" });
		assert.equal(second.sessionId, moving.id, "the session kept its id on the node it moved to");
		const sent = (await sending).flat();
		await vi.waitFor(() => deliveredInOrderByText(receiver(), sent), DELIVERY);
	});

	test("a session whose node stops answering moves to another node, takes its id back once the hold lapses, and misses nothing", async () => {
		const [a, b, c] = ["a", "b", "c"].map((name) => cluster.node(name));
		const moving = { id: randomUUID(), returnAddress: randomUUID(), name: `stranded-${randomUUID().slice(0, 6)}` };
		const first = await a!.connect(moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
		});
		assert.equal(first.sessionId, moving.id);
		const sender = await c!.connect("sender-c-2");
		const before = await sendSequence(sender, moving.id, moving.name, 3, "before", () => first);
		await vi.waitFor(() => deliveredInOrder(first, before), DELIVERY);

		// Node A's broker stops answering while it holds the session's id, as a machine that hangs does.
		a!.signalBroker("SIGSTOP");
		const stoppedAt = performance.now();
		let moved: NodeClient | undefined;
		let back: NodeClient | undefined;
		const receiver = () =>
			merged(moving.name, first, ...(moved === undefined ? [] : [moved]), ...(back === undefined ? [] : [back]));
		let sent: SentMessage[] = [];
		try {
			await sleep(500);
			moved = await b!.connect(moving.name, {
				preferredSessionId: moving.id,
				returnAddress: moving.returnAddress,
				connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
				takesIdHandoff: true,
			});
			const registeredBack = new Promise<NodeClient>((resolve, reject) =>
				moved!.client.once("id_handoff", (idHandoff: IntercomIdHandoff) => {
					b!
						.connect(moving.name, {
							returnAddress: moving.returnAddress,
							connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
							takesIdHandoff: true,
							idHandoff,
						})
						.then((client) => {
							back = client;
							resolve(client);
						}, reject);
				}),
			);
			// While the stopped broker still holds the id, the session has a fresh one, which reaches it; from 5 s after the
			// stop, as in the single-machine test of this move, so does its id.
			const fresh = moved.sessionId;
			assert.notEqual(fresh, moving.id);
			const toFresh = await sendSequence(sender, fresh, moving.name, 3, "to-fresh", receiver);
			await sleep(Math.max(0, stoppedAt + 5_000 - performance.now()));
			const toId = await sendSequence(sender, moving.id, moving.name, 3, "to-id", receiver);
			const during = [...toFresh, ...toId];
			const returned = await Promise.race([
				registeredBack,
				sleep(BROKER_LEASE_STALE_AFTER_MS * 3).then(() => {
					throw new Error("the moved session never got its id back");
				}),
			]);
			assert.equal(returned.sessionId, moving.id, "the session has its own id again");
			const after = await sendSequence(sender, moving.id, moving.name, 3, "after", receiver);
			const alias = await sendSequence(sender, fresh, moving.name, 2, "alias", receiver);
			sent = [...during, ...after, ...alias];
			await vi.waitFor(() => deliveredInOrderByText(receiver(), sent), DELIVERY);
		} finally {
			a!.signalBroker("SIGCONT");
		}
		// The broker that comes back delivers nothing a second time.
		await sleep(5_000);
		deliveredInOrderByText(receiver(), sent);
	});
});

/**
 * As `deliveredInOrder`, for messages each sent as a sequence of one (the k of each is in its tag): the order checked is
 * the order they were sent in, per sender.
 */
function deliveredInOrderByText(receiver: NodeClient, sent: readonly SentMessage[]): number {
	const renumbered = new Map<string, number>();
	const ordered = sent.map((message) => {
		const k = (renumbered.get(message.from) ?? 0) + 1;
		renumbered.set(message.from, k);
		return { ...message, k };
	});
	return deliveredInOrder(receiver, ordered);
}
