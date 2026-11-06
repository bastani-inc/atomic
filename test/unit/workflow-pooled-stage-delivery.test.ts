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
	createWorkerStageDelivery,
	type PooledStageDeliveryOptions,
	pooledStageQueuedEntries,
	remoteStageInbox,
} from "../../packages/workflows/src/workers/pooled-stage-delivery.js";
import { RemoteStageInbox } from "../../packages/workflows/src/workers/remote-stage-inbox.js";
import { countRunListScans, holdFinishedRuns } from "../helpers/finished-runs.js";
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

	test("read a nested stage's entries in admission order through its boundaries without reading the other runs the attempt's store holds (#4190)", () => {
		const real = createStore();
		const finished = holdFinishedRuns(real, 5_000);
		const GRAND = testRunId("pooled-delivery-grand");
		real.recordRunStart({
			...childRun(),
			stages: [stage("agent-1", "agent"), stage("inner-boundary", "workflow:inner")],
		});
		real.recordRunStart({
			...childRun(),
			id: GRAND,
			name: "inner",
			stages: [stage("deep-1", "deep")],
			parentRunId: CHILD,
			parentStageId: "inner-boundary",
		});
		const { store, scans } = countRunListScans(real);
		finished.reads = 0;
		const messages = [
			entry("exact-late", 6, { runId: GRAND, stageKey: "deep" }),
			sticky("sticky-name-form", 4, `${BOUNDARY_NAME}/workflow:inner/deep`),
			entry("exact-early", 1, { runId: GRAND, stageKey: "deep-1" }),
			sticky("sticky-id-form", 2, `${CHILD}/${GRAND}/*`),
			sticky("sticky-child-stage", 3, `${BOUNDARY_NAME}/agent`),
			sticky("sticky-other-boundary", 5, `${BOUNDARY_NAME}/workflow:outer/deep`),
			entry("exact-child-run", 7, { stageKey: "deep" }),
			sticky("sticky-everything", 8, "**"),
		];
		const queued = pooledStageQueuedEntries(journal(messages), store, ROOT, {
			runId: GRAND,
			stageId: "deep-1",
			stageName: "deep",
		});
		assert.deepEqual(
			queued.map((candidate) => candidate.id),
			["exact-early", "sticky-id-form", "sticky-name-form", "exact-late", "sticky-everything"],
		);
		assert.deepEqual(
			[finished.reads, scans.reads],
			[0, 0],
			`finished-run reads and run-list accesses for one drain: ${finished.reads}, ${scans.reads}`,
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

	test("a root drain that answers after a later drain began hands over through the later drain's sink", async () => {
		const { delivery, forwarded } = deliveryWith({ queued: async () => [] });
		const startup: string[] = [];
		const live: string[] = [];
		await delivery.deliverPending(
			(_sender, message) => {
				startup.push(message.id);
			},
			{ sessionId: "session-a", receivedMessageIds: [] },
		);
		// A reconnect drains the started stage again, with a sink that delivers live.
		await delivery.deliverPending(
			(_sender, message) => {
				live.push(message.id);
			},
			{ sessionId: "session-a", receivedMessageIds: [] },
		);
		await forwarded[0]!.deliver(
			{ id: "sender-id", name: "sender", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 0 },
			entry("late", 3).message as Delivered,
		);
		assert.equal(startup.length, 0);
		assert.deepEqual(live, ["late"]);
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

test("a pooled worker's stage on the root's host holds the root's route; one on another host holds none and hands its sink to its inbox (#4391)", async () => {
	const stage = { runId: CHILD, stageId: "agent", stageName: "agent" };
	const forwarded: string[] = [];
	const options = {
		stage,
		queued: async () => [entry("first", 1)],
		forward: async (recipient: { readonly sessionId: string }) => {
			forwarded.push(recipient.sessionId);
		},
		fail: () => {},
	};
	const requests: unknown[] = [];
	const routed = await createWorkerStageDelivery({
		...options,
		inbox: undefined,
		request: async (message) => {
			requests.push(message);
			return "capability";
		},
	});
	assert.equal(routed.routeCapability, "capability");
	assert.deepEqual(requests, [{ kind: "route", runId: CHILD }], "the root's route for the stage's run");
	await routed.deliverPending(() => {}, { sessionId: "session-a", receivedMessageIds: [] });
	assert.deepEqual(forwarded, ["session-a"], "the root's host drains it as well");
	for (const capability of [undefined, 7])
		await assert.rejects(
			createWorkerStageDelivery({ ...options, inbox: undefined, request: async () => capability }),
			/Worker root route is unavailable/,
		);
	const inbox = new RemoteStageInbox();
	let routeAsked = false;
	const remote = await createWorkerStageDelivery({
		...options,
		inbox,
		request: async () => {
			routeAsked = true;
			return "capability";
		},
	});
	assert.equal(routeAsked, false);
	assert.equal("routeCapability" in remote, false, "it holds no route");
	const received: string[] = [];
	await remote.deliverPending(
		(_sender, message) => {
			received.push(message.id);
		},
		{ sessionId: "session-b", receivedMessageIds: [] },
	);
	assert.deepEqual(forwarded, ["session-a"], "no root drain is asked for on another host");
	assert.deepEqual(
		await inbox.deliver(
			stage,
			"session-b",
			{ id: "sender-id", name: "sender" } as Sender,
			entry("late", 2).message as Delivered,
		),
		{},
	);
	assert.deepEqual(received, ["first", "late"], "the root's later message reaches the session through its inbox");
	assert.ok(remoteStageInbox({ host: "host-b", routes: false }) instanceof RemoteStageInbox);
	assert.equal(remoteStageInbox({ host: "root-host", routes: true }), undefined, "the root's host holds live routes");
	assert.equal(remoteStageInbox(undefined), undefined, "so does a pool that is not shared");
});
