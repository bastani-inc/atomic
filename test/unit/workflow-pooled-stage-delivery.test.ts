import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessage,
	RunSnapshot,
	StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import {
	createPooledStageDelivery,
	type PooledStageDeliveryOptions,
	pooledStageQueuedEntries,
} from "../../packages/workflows/src/workers/pooled-stage-delivery.js";
import { testRunId } from "../helpers/run-id.js";

const ROOT = testRunId("pooled-delivery-root");
const CHILD = testRunId("pooled-delivery-child");
const BOUNDARY = "boundary-stage";
const BOUNDARY_NAME = "workflow:reviewer";

type Sender = Parameters<Parameters<ReturnType<typeof createPooledStageDelivery>["deliverPending"]>[0]>[0];
type Delivered = Parameters<Parameters<ReturnType<typeof createPooledStageDelivery>["deliverPending"]>[0]>[1];

function entry(id: string, admissionOrder: number, overrides: Partial<PendingStageMessage> = {}): PendingStageMessage {
	return {
		id,
		runId: CHILD,
		stageKey: "agent",
		from: { id: "sender-id", name: "sender" },
		message: { id, timestamp: 1_725_000_000_000, content: { text: `body ${id}` } },
		queuedAt: "2026-11-02T00:00:00.000Z",
		admissionOrder,
		status: "queued",
		...overrides,
	};
}

function sticky(id: string, admissionOrder: number, target: string): PendingStageMessage {
	return entry(id, admissionOrder, {
		runId: ROOT,
		stageKey: `workflow:${ROOT}/${target}`,
		targetPath: `workflow:${ROOT}/${target}`,
		sticky: true,
	});
}

function stage(id: string, name: string): StageSnapshot {
	return { id, name, status: "running", parentIds: [], toolEvents: [] };
}

function childRun(): RunSnapshot {
	return {
		id: CHILD,
		name: "reviewer",
		inputs: {},
		status: "running",
		stages: [stage("agent-1", "agent")],
		toolNodes: [],
		startedAt: 0,
		parentRunId: ROOT,
		parentStageId: BOUNDARY,
		rootRunId: ROOT,
	};
}

function journal(messages: readonly PendingStageMessage[]) {
	const boundary = {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: "boundary-start:reviewer",
		name: BOUNDARY_NAME,
		replayKey: "reviewer",
		topology: { boundary: { child: { runId: CHILD } } },
	} as unknown as DurableCheckpoint;
	return {
		getWorkflow: (id: string) => (id === ROOT ? { pendingStageMessages: messages } : undefined),
		listCheckpoints: (id: string) => (id === ROOT ? [boundary] : []),
	} as unknown as Parameters<typeof pooledStageQueuedEntries>[0];
}

describe("pooled stage queued entries", () => {
	test("read the stage's exact and matching sticky entries from the root's journal in admission order", () => {
		const store = createStore();
		store.recordRunStart(childRun());
		const messages = [
			sticky("sticky-name-form", 1, `${BOUNDARY_NAME}/agent`),
			entry("exact", 2),
			sticky("sticky-id-form", 3, `${CHILD}/*`),
			sticky("sticky-other-stage", 4, `${BOUNDARY_NAME}/planner`),
			entry("exact-delivered", 5, { status: "delivered" }),
			entry("exact-other-run", 6, { runId: "other-run" }),
			sticky("sticky-everything", 7, "**"),
		];
		const queued = pooledStageQueuedEntries(journal(messages), store, ROOT, {
			runId: CHILD,
			stageId: "agent-1",
			stageName: "agent",
		});
		assert.deepEqual(
			queued.map((candidate) => candidate.id),
			["sticky-name-form", "exact", "sticky-id-form", "sticky-everything"],
		);
	});
});

function deliveryWith(overrides: Partial<PooledStageDeliveryOptions> = {}) {
	const forwarded: {
		recipient: Parameters<PooledStageDeliveryOptions["forward"]>[0];
		deliver: Parameters<PooledStageDeliveryOptions["forward"]>[1];
	}[] = [];
	const delivery = createPooledStageDelivery({
		routeCapability: "capability",
		queued: async () => [entry("first", 1), entry("second", 2)],
		// The root is too busy to answer.
		forward: (recipient, deliver) => {
			forwarded.push({ recipient, deliver });
			return new Promise(() => {});
		},
		fail: () => {},
		...overrides,
	});
	return { delivery, forwarded };
}

describe("pooled stage delivery", () => {
	test("delivers queued messages before the stage starts without waiting for the root", async () => {
		const { delivery, forwarded } = deliveryWith();
		const received: { readonly sender: Sender; readonly message: Delivered }[] = [];
		await delivery.deliverPending(
			(sender, message) => {
				received.push({ sender, message });
			},
			{ sessionId: "session-a", receivedMessageIds: [] },
		);
		assert.deepEqual(
			received.map(({ message }) => message.id),
			["first", "second"],
		);
		assert.equal(received[0]?.sender.name, "sender");
		assert.equal(delivery.ready("session-a"), undefined);
		// The root still drains, told what the session already holds so that it only records the receipts.
		assert.deepEqual(forwarded[0]?.recipient, { sessionId: "session-a", receivedMessageIds: ["first", "second"] });
	});

	test("delivers each message to a session once, whichever drain hands it over", async () => {
		const { delivery, forwarded } = deliveryWith();
		const received: string[] = [];
		const deliver = (_sender: Sender, message: Delivered) => {
			received.push(message.id);
		};
		await delivery.deliverPending(deliver, { sessionId: "session-a", receivedMessageIds: ["first"] });
		assert.deepEqual(received, ["second"]);
		// The root's drain hands over what the worker already delivered, and one message queued since.
		const transport = forwarded[0]!.deliver;
		await transport({ id: "sender-id", name: "sender", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 0 }, {
			id: "second",
			timestamp: 0,
			content: { text: "body second" },
		} as Delivered);
		await transport({ id: "sender-id", name: "sender", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 0 }, {
			id: "late",
			timestamp: 0,
			content: { text: "body late" },
		} as Delivered);
		// The second startup drain finds both already delivered.
		await delivery.deliverPending(deliver, { sessionId: "session-a", receivedMessageIds: [] });
		assert.deepEqual(received, ["second", "late"]);
		assert.deepEqual(forwarded[1]?.recipient.receivedMessageIds, ["first", "second", "late"]);
		// Another session of the stage holds none of them.
		await delivery.deliverPending(deliver, { sessionId: "session-b", receivedMessageIds: [] });
		assert.deepEqual(received, ["second", "late", "first", "second"]);
	});

	test("leaves what it cannot read or deliver to the root's drain", async () => {
		const unreadable = deliveryWith({
			queued: async () => {
				throw new Error("journal unavailable");
			},
		});
		const received: string[] = [];
		await unreadable.delivery.deliverPending(
			(_sender, message) => {
				received.push(message.id);
			},
			{ sessionId: "session-a", receivedMessageIds: [] },
		);
		assert.equal(received.length, 0);
		assert.deepEqual(unreadable.forwarded[0]?.recipient.receivedMessageIds, []);

		const refused = deliveryWith();
		let attempts = 0;
		await refused.delivery.deliverPending(
			(_sender, message) => {
				attempts++;
				if (message.id === "first" && attempts === 1) throw new Error("session busy");
				received.push(message.id);
			},
			{ sessionId: "session-a", receivedMessageIds: [] },
		);
		// Nothing after a failed message is delivered out of order; the root is not told the session holds it.
		assert.equal(received.length, 0);
		assert.deepEqual(refused.forwarded[0]?.recipient.receivedMessageIds, []);
		await refused.forwarded[0]!.deliver(
			{ id: "sender-id", name: "sender", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 0 },
			entry("first", 1).message as Delivered,
		);
		assert.deepEqual(received, ["first"]);
	});
});
