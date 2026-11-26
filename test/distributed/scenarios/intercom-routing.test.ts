/**
 * Multi-node Intercom routing: one broker per node, each its own process with its own agent directory, all routing
 * through the shared database behind PgBouncer, with their wake-up connections straight to the primary (listenUrl).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { queryIntercomBroker } from "../../../packages/intercom/broker/control.js";
import { WAKE_UP_LISTENING_POLL_INTERVAL_MS } from "../../../packages/intercom/broker/database-wake-up-bus.js";
import { bouncerConsole, Cluster, type NodeClient } from "../harness/cluster.js";
import { distributedSkipReason, recordEvent, topology } from "../harness/topology.js";
import { deliveredInOrder, listeners, nodeNames, sendAll } from "../harness/traffic.js";

const SCENARIO = "routing";
const MESSAGES_PER_PAIR = 10;
const DELIVERY_TIMEOUT_MS = 60_000;

describe.skipIf(distributedSkipReason !== undefined)("Intercom routing across nodes", () => {
	let cluster: Cluster;
	const clients = new Map<string, NodeClient>();
	const group = `routing-${randomUUID().slice(0, 8)}`;

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, nodeNames(topology!.nodes));
		for (const node of cluster.nodes.values()) await node.startBroker();
		for (const node of cluster.nodes.values())
			clients.set(node.name, await node.connect(`peer-${node.name}`, { group }));
	});
	afterAll(async () => {
		await cluster?.cleanup();
	});

	test("every broker sees the others, sends its queries through PgBouncer and listens on the primary directly", async () => {
		const names = [...cluster.nodes.keys()];
		for (const node of cluster.nodes.values()) {
			const status = await queryIntercomBroker(node.agentDir);
			assert.ok(status.state === "running");
			assert.equal(status.report.multiNode.status, "on");
			assert.ok(node.queries.connections > 0, `${node.name} sent no query through PgBouncer`);
			assert.ok(node.wakeUps.connections > 0, `${node.name} opened no wake-up connection to the primary`);
		}
		await vi.waitFor(() => assert.ok(listeners() >= names.length, `${listeners()} brokers listen`), {
			timeout: 30_000,
			interval: 250,
		});
		const clients = bouncerConsole("SHOW CLIENTS");
		assert.doesNotMatch(clients, /atomic-listen/, "no wake-up connection goes through PgBouncer");
	});

	test("messages between every pair of nodes arrive once and in order, woken by notifications, not the poll", async () => {
		const senders = [...clients.values()];
		const sent = await sendAll(senders, senders, MESSAGES_PER_PAIR, `pairs-${randomUUID().slice(0, 6)}`);
		for (const receiver of senders) {
			const expected = sent.filter((message) => message.to === receiver.name);
			await vi.waitFor(() => deliveredInOrder(receiver, expected), { timeout: DELIVERY_TIMEOUT_MS, interval: 100 });
		}
		const latencies = sent.map((message) => message.latencyMs()).sort((a, b) => a - b);
		const median = latencies[Math.floor(latencies.length / 2)]!;
		recordEvent(SCENARIO, {
			event: "latency",
			messages: latencies.length,
			medianMs: median,
			maxMs: latencies.at(-1),
		});
		assert.ok(
			median < WAKE_UP_LISTENING_POLL_INTERVAL_MS / 3,
			`the median delivery took ${median} ms: wake-ups are not arriving by notification`,
		);
	});

	test("while one node's wake-up connection is cut, messages to it still arrive, and it listens again once healed", async () => {
		const target = [...cluster.nodes.values()].at(-1)!;
		const receiver = clients.get(target.name)!;
		const others = [...clients.values()].filter((client) => client !== receiver);
		target.wakeUps.partition();
		target.wakeUps.reset();
		recordEvent(SCENARIO, { fault: "wake-up-link-cut", node: target.name, phase: "start" });
		try {
			const sent = await sendAll(others, [receiver], 5, `cut-${randomUUID().slice(0, 6)}`);
			await vi.waitFor(() => deliveredInOrder(receiver, sent), { timeout: DELIVERY_TIMEOUT_MS, interval: 100 });
		} finally {
			target.wakeUps.heal();
			recordEvent(SCENARIO, { fault: "wake-up-link-cut", node: target.name, phase: "end" });
		}
		await vi.waitFor(() => assert.ok(listeners() >= cluster.nodes.size, `${listeners()} brokers listen`), {
			timeout: 120_000,
			interval: 500,
		});
		const after = await sendAll(others, [receiver], 3, `healed-${randomUUID().slice(0, 6)}`);
		await vi.waitFor(() => deliveredInOrder(receiver, after), { timeout: DELIVERY_TIMEOUT_MS, interval: 100 });
	});
});
