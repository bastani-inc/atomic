/**
 * Faults one at a time, in the order the run's seed picked (`--faults`), while three nodes keep working: every node's
 * session sends Intercom messages to every other, and node A appends to a session entry by entry. After each fault is
 * undone and the cluster has recovered:
 *
 * - every message a broker accepted arrived, in the order its sender sent it, and no refused one arrived. A message
 *   arrives at most once per connection: the broker sends one again only to a later connection of the session, when it
 *   never learned that the earlier one saved it, and the session's inbox keeps one copy by its id;
 * - the session writer is making progress again;
 *
 * and at the end, every entry the store acknowledged to the writer is in the session, in order, read from another node.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { sleep } from "../../helpers/runtime.js";
import {
	Cluster,
	compose,
	type Node,
	type NodeRun,
	repoRoot,
	type Service,
	servicesHealthy,
} from "../harness/cluster.js";
import { distributedSkipReason, recordEvent, topology } from "../harness/topology.js";
import { deliveredInOrder, Peer, startTraffic } from "../harness/traffic.js";

const SCENARIO = "faults";
const sessionDriver = join(repoRoot, "test/distributed/node/session-node.ts");
/** How long each fault lasts. */
const FAULT_MS = 12_000;
/** Work done before a fault starts, and after the cluster recovered, before the checks. */
const SETTLE_MS = 3_000;
const DELIVERY = { timeout: 180_000, interval: 250 };
/** Node B's broker clock, ahead of real time by this much while `clock-skew` lasts. */
const CLOCK_SKEW_MS = 45_000;
/** The data disk's read and write rate while `disk-throttle` lasts. */
const THROTTLED_BYTES_PER_SECOND = 256 * 1024;
const WRITER_TIMEOUT_MS = 60 * 60 * 1000;

/** How many refused or uncertain sends gave each reason. */
function reasonCounts(outcomes: readonly { readonly reason?: string }[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const { reason } of outcomes) {
		const key = (reason ?? "no reason").slice(0, 160);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

interface Fault {
	readonly summary: string;
	inject(): Promise<void>;
	undo(): Promise<void>;
}

interface WriterAck {
	readonly event: string;
	readonly id?: string;
}

describe.skipIf(distributedSkipReason !== undefined || (topology?.faults.length ?? 0) === 0)("database faults", () => {
	let cluster: Cluster;
	let nodes: Record<"a" | "b" | "c", Node>;
	let peers: Peer[];
	let writerDir: string;
	let writer: { run: Promise<NodeRun<{ sessionId?: string; written?: number }>> };
	let sessionId: string;

	const acks = (): string[] => {
		const file = join(writerDir, "acks.jsonl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as WriterAck)
			.flatMap((ack) => (ack.event === "ack" && ack.id !== undefined ? [ack.id] : []));
	};

	const service = (action: "restart" | "pause" | "unpause", name: Service) => async () => {
		compose(action, name);
		recordEvent(SCENARIO, { fault: `${name}-${action}`, service: name });
	};
	const disk =
		(...args: string[]) =>
		async () => {
			compose("exec", "-T", "primary", "/adt/disk.sh", ...args);
			recordEvent(SCENARIO, { fault: `disk-${args[0]}`, service: "primary" });
		};

	const faults: Record<string, () => Fault> = {
		"pgbouncer-restart": () => ({
			summary: "PgBouncer crashes and starts again, dropping every client and pooled connection",
			// Killed, not stopped: on SIGTERM PgBouncer waits for every client to leave, which Atomic's pools never do.
			inject: async () => {
				compose("kill", "--signal", "SIGKILL", "pgbouncer");
				recordEvent(SCENARIO, { fault: "pgbouncer-killed", service: "pgbouncer" });
				compose("up", "--detach", "--wait", "pgbouncer");
			},
			undo: async () => {},
		}),
		"primary-restart": () => ({
			summary: "the primary restarts, dropping every connection and every wake-up listener",
			inject: service("restart", "primary"),
			undo: async () => {},
		}),
		"primary-pause": () => ({
			summary: "the primary freezes, holding every connection open without answering",
			inject: service("pause", "primary"),
			undo: service("unpause", "primary"),
		}),
		"node-partition": () => ({
			summary: "node B is cut off from PgBouncer and the primary",
			inject: async () => nodes.b.partition(),
			undo: async () => nodes.b.heal(),
		}),
		"link-latency": () => ({
			summary: "node B's links to the database add 250 ms each way",
			inject: async () => {
				nodes.b.queries.delay(250);
				nodes.b.wakeUps.delay(250);
				recordEvent(SCENARIO, { fault: "link-latency", node: "b", phase: "start" });
			},
			undo: async () => {
				nodes.b.queries.delay(0);
				nodes.b.wakeUps.delay(0);
				recordEvent(SCENARIO, { fault: "link-latency", node: "b", phase: "end" });
			},
		}),
		"broker-sigkill": () => ({
			summary: "node C's broker is killed; it starts again and its session registers again",
			inject: () => nodes.c.killBroker(),
			undo: () => nodes.c.startBroker(),
		}),
		"broker-sigstop": () => ({
			summary: "node A's broker freezes (SIGSTOP), then thaws",
			inject: async () => nodes.a.signalBroker("SIGSTOP"),
			undo: async () => nodes.a.signalBroker("SIGCONT"),
		}),
		"clock-skew": () => ({
			summary: `node B's broker runs with its clock ${CLOCK_SKEW_MS / 1000} s ahead`,
			inject: async () => {
				await nodes.b.killBroker();
				nodes.b.clockSkewMs = CLOCK_SKEW_MS;
				await nodes.b.startBroker();
				recordEvent(SCENARIO, { fault: "clock-skew", node: "b", phase: "start", skewMs: CLOCK_SKEW_MS });
			},
			undo: async () => {
				await nodes.b.killBroker();
				nodes.b.clockSkewMs = 0;
				await nodes.b.startBroker();
				recordEvent(SCENARIO, { fault: "clock-skew", node: "b", phase: "end" });
			},
		}),
		"disk-throttle": () => ({
			summary: `the primary's data disk slows to ${THROTTLED_BYTES_PER_SECOND / 1024} KB/s`,
			inject: disk("throttle", String(THROTTLED_BYTES_PER_SECOND)),
			undo: disk("unthrottle"),
		}),
		"disk-full": () => ({
			summary: "the primary's data disk fills up, then is freed",
			inject: disk("fill"),
			undo: async () => {
				try {
					await disk("unfill")();
				} catch (error) {
					// PostgreSQL stopped on the full disk, and its container with it. Starting the container again frees
					// the space first (postgres/start-postgres.sh), so the server recovers as it would after an operator did.
					recordEvent(SCENARIO, {
						fault: "disk-full",
						service: "primary",
						phase: "server-stopped",
						error: String(error),
					});
					compose("up", "--detach", "--wait", "primary");
				}
			},
		}),
	};

	beforeAll(async () => {
		cluster = await Cluster.start(SCENARIO, ["a", "b", "c"]);
		nodes = { a: cluster.node("a"), b: cluster.node("b"), c: cluster.node("c") };
		for (const node of Object.values(nodes)) await node.startBroker();
		const group = `faults-${cluster.prefix}`;
		peers = await Promise.all(Object.values(nodes).map((node) => Peer.connect(node, `peer-${node.name}`, group)));
		writerDir = join(nodes.a.root, "writer");
		mkdirSync(writerDir, { recursive: true });
		const started = nodes.a.run<{ sessionId?: string; written?: number }>(
			sessionDriver,
			"writer",
			{
				cwd: nodes.a.home,
				ackFile: join(writerDir, "acks.jsonl"),
				stopFile: join(writerDir, "stop"),
				intervalMs: 100,
			},
			{},
			WRITER_TIMEOUT_MS,
		);
		writer = started;
		sessionId = (await started.firstOutput()).sessionId!;
	});
	afterAll(async () => {
		if (writerDir !== undefined) writeFileSync(join(writerDir, "stop"), "");
		await cluster?.cleanup();
	});

	/** After a fault: every service healthy, every broker running and routing through the database again. */
	async function recovered(): Promise<void> {
		await servicesHealthy();
		for (const node of Object.values(nodes)) {
			if (!node.brokerRunning()) await node.startBroker();
			await node.waitForRouting();
		}
	}

	for (const name of topology?.faults ?? []) {
		test(`${name}: nothing accepted is lost or delivered twice, and the session writer carries on`, async () => {
			const fault = faults[name]!();
			const traffic = startTraffic(peers, name);
			await sleep(SETTLE_MS);
			const acksBefore = acks().length;
			recordEvent(SCENARIO, { fault: name, phase: "start", summary: fault.summary });
			await fault.inject();
			try {
				await sleep(FAULT_MS);
			} finally {
				await fault.undo();
				recordEvent(SCENARIO, { fault: name, phase: "end" });
			}
			await recovered();
			await sleep(SETTLE_MS);
			const result = await traffic.stop();
			recordEvent(SCENARIO, {
				event: "traffic",
				fault: name,
				accepted: result.accepted.length,
				refused: result.refused.length,
				uncertain: result.uncertain.length,
				reasons: reasonCounts([...result.refused, ...result.uncertain]),
			});
			assert.ok(result.accepted.length > 0, "no send was accepted");
			let repeats = 0;
			for (const peer of peers)
				repeats += await vi.waitFor(
					() =>
						deliveredInOrder(
							peer.received(),
							result.accepted.filter((message) => message.to === peer.name),
						),
					DELIVERY,
				);
			recordEvent(SCENARIO, { event: "repeats", fault: name, repeats });
			const refusedIds = new Set(result.refused.map((refusal) => refusal.id));
			for (const peer of peers)
				assert.ok(
					!peer.received().received.some((frame) => refusedIds.has(frame.message.id)),
					`${peer.name} got a message whose send was refused`,
				);
			await vi.waitFor(
				() => assert.ok(acks().length > acksBefore + 5, "the session writer is not making progress"),
				{
					timeout: 60_000,
					interval: 250,
				},
			);
		});
	}

	test("every entry the store acknowledged to the writer is in the session, in order, read from another node", async () => {
		writeFileSync(join(writerDir, "stop"), "");
		const ended = await writer.run;
		assert.equal(ended.code, 0, ended.stderr);
		const acknowledged = acks();
		assert.ok(acknowledged.length > 0);
		const read = await nodes.c.run<{ entryIds?: string[] }>(sessionDriver, "inspect", { sessionId }).run;
		assert.equal(read.code, 0, read.stderr);
		assert.deepEqual(read.output?.entryIds, acknowledged);
	});
});
