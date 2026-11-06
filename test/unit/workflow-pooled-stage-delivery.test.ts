import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
	AgentSessionAdapter,
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
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
	unregisterWhenClosed,
	type WorkerStageAdapterPorts,
	workerStageAdapter,
} from "../../packages/workflows/src/workers/pooled-stage-delivery.js";
import { RemoteStageInbox } from "../../packages/workflows/src/workers/remote-stage-inbox.js";
import { intercomMessageOutcome } from "../../packages/workflows/src/workers/stage-input-receipts.js";
import { countRunListScans, holdFinishedRuns } from "../helpers/finished-runs.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { makeMockSession } from "./stage-runner-helpers.js";

useTemporaryAgentDir();

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

/** `stage`, for a test whose stage identity takes its name. */
const stageSnapshot = stage;

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
	const store = createStore();
	store.recordRunStart({ ...childRun(), stages: [stageSnapshot("agent", "agent")] });
	const forwarded: string[] = [];
	const options = {
		stage,
		store,
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
	assert.equal(
		store.run(CHILD)?.stages[0]?.intercomReceipts,
		undefined,
		"the root's drain records the receipts the worker forwards (#4505)",
	);
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
		store.run(CHILD)?.stages[0]?.intercomReceipts,
		{ sessionId: "session-b", messageIds: ["first"] },
		"the stage's publications carry what its session took to the root instead (#4505)",
	);
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

test("a stage on another host records each session's messages on the stage once, and nothing for a session that took none (#4505)", async () => {
	const store = createStore();
	store.recordRunStart({ ...childRun(), stages: [stageSnapshot("other", "other"), stageSnapshot("agent", "agent")] });
	let published = 0;
	store.subscribeInvalidation(() => {
		published++;
	});
	const inbox = new RemoteStageInbox();
	let queued = [entry("first", 1), entry("second", 2)];
	const delivery = await createWorkerStageDelivery({
		stage: { runId: CHILD, stageId: "agent", stageName: "agent" },
		inbox,
		store,
		request: async () => "capability",
		queued: async () => queued,
		forward: async () => {},
		fail: () => {},
	});
	const receipts = () => store.run(CHILD)?.stages.map((stage) => stage.intercomReceipts);
	const sender = { id: "sender-id", name: "sender" } as Sender;
	await delivery.deliverPending(() => {}, { sessionId: "session-a", receivedMessageIds: [] });
	assert.deepEqual(receipts(), [undefined, { sessionId: "session-a", messageIds: ["first", "second"] }]);
	assert.equal(published, 1, "the stage changed, so it is published");
	// The session's second startup drain finds nothing new: the stage is not published again.
	await delivery.deliverPending(() => {}, { sessionId: "session-a", receivedMessageIds: [] });
	assert.equal(published, 1);
	// A message the root's drain handed over through the inbox is recorded with the session's next drain.
	assert.deepEqual(
		await inbox.deliver(
			{ runId: CHILD, stageId: "agent" },
			"session-a",
			sender,
			entry("late", 3).message as Delivered,
		),
		{},
	);
	await delivery.deliverPending(() => {}, { sessionId: "session-a", receivedMessageIds: [] });
	assert.deepEqual(receipts()?.[1], { sessionId: "session-a", messageIds: ["first", "second", "late"] });
	assert.equal(published, 2);
	// A session that took nothing leaves the earlier session's record; one that took something replaces it.
	queued = [];
	await delivery.deliverPending(() => {}, { sessionId: "session-b", receivedMessageIds: [] });
	assert.deepEqual(receipts()?.[1], { sessionId: "session-a", messageIds: ["first", "second", "late"] });
	assert.equal(published, 2);
	queued = [entry("second", 2)];
	await delivery.deliverPending(() => {}, { sessionId: "session-c", receivedMessageIds: [] });
	assert.deepEqual(receipts(), [undefined, { sessionId: "session-c", messageIds: ["second"] }]);
	assert.equal(published, 3);
	// A stage the attempt's store does not hold records nothing.
	const missing = await createWorkerStageDelivery({
		stage: { runId: CHILD, stageId: "missing", stageName: "missing" },
		inbox,
		store,
		request: async () => "capability",
		queued: async () => [entry("first", 1)],
		forward: async () => {},
		fail: () => {},
	});
	await missing.deliverPending(() => {}, { sessionId: "session-d", receivedMessageIds: [] });
	assert.equal(published, 3);
	assert.deepEqual(receipts(), [undefined, { sessionId: "session-c", messageIds: ["second"] }]);
	assert.deepEqual(
		await inbox.deliver(
			{ runId: CHILD, stageId: "missing" },
			"session-d",
			sender,
			entry("late", 3).message as Delivered,
		),
		{},
		"its session's sink is handed over all the same",
	);
});

/** A stage session as a worker's adapter creates it, closing as `close` does. */
function workerSession(sessionId: string, close: () => Promise<void> = async () => {}) {
	return { sessionId, dispose: close } as unknown as StageSessionRuntime;
}

test("a closed stage session's sink is gone from its attempt's inbox; a replacement's stays (#4505)", async () => {
	const stage = { runId: CHILD, stageId: "agent", stageName: "agent" };
	const store = createStore();
	store.recordRunStart({ ...childRun(), stages: [stageSnapshot("agent", "agent")] });
	const inbox = new RemoteStageInbox();
	// Each session of the stage gets its own pending-stage delivery, as a worker's adapter creates it.
	const remoteDelivery = () =>
		createWorkerStageDelivery({
			stage,
			inbox,
			store,
			request: async () => "capability",
			queued: async () => [],
			forward: async () => {},
			fail: () => {},
		});
	const received: string[] = [];
	const sink = (session: string) => (_sender: Sender, message: Delivered) => {
		received.push(`${session}:${message.id}`);
	};
	const sender = { id: "sender-id", name: "sender" } as Sender;
	const message = (id: string) => entry(id, 1).message as Delivered;
	const delivery = await remoteDelivery();
	await delivery.deliverPending(sink("session-a"), { sessionId: "session-a", receivedMessageIds: [] });
	const closed: string[] = [];
	const session = workerSession("session-a", async () => {
		closed.push("session-a");
	});
	const created = { session };
	assert.equal(
		unregisterWhenClosed(created, inbox, stage, delivery),
		created,
		"the adapter's result is returned as it is",
	);
	assert.equal(created.session, session, "and its session is the same session");
	assert.deepEqual(await inbox.deliver(stage, "session-a", sender, message("before-close")), {});
	await session.dispose();
	assert.deepEqual(closed, ["session-a"], "the session itself closes");
	const afterClose = await inbox.deliver(stage, "session-a", sender, message("after-close"));
	assert.deepEqual(
		[afterClose.refusal, afterClose.error?.name, afterClose.error?.code],
		[undefined, "WorkflowInfrastructureError", "intercom_unavailable"],
	);
	assert.equal(
		intercomMessageOutcome(afterClose),
		"defer",
		"the stage's host keeps the message for the session's return",
	);
	assert.deepEqual(received, ["session-a:before-close"], "the closed session's sink is no longer called");
	// A session that fails to close still drops its sink, and its failure is its caller's.
	const failingDelivery = await remoteDelivery();
	await failingDelivery.deliverPending(sink("session-b"), { sessionId: "session-b", receivedMessageIds: [] });
	const failing = workerSession("session-b", async () => {
		throw new Error("shutdown failed");
	});
	unregisterWhenClosed(failing, inbox, stage, failingDelivery);
	await assert.rejects(async () => failing.dispose(), /shutdown failed/);
	assert.equal(
		(await inbox.deliver(stage, "session-b", sender, message("after-failure"))).error?.code,
		"intercom_unavailable",
	);
	// An earlier session that closes after the stage's next session took over leaves that session's sink.
	const earlier = workerSession("session-c");
	const earlierDelivery = await remoteDelivery();
	await earlierDelivery.deliverPending(sink("session-c"), { sessionId: "session-c", receivedMessageIds: [] });
	unregisterWhenClosed(earlier, inbox, stage, earlierDelivery);
	await (await remoteDelivery()).deliverPending(sink("session-d"), { sessionId: "session-d", receivedMessageIds: [] });
	await earlier.dispose();
	assert.deepEqual(await inbox.deliver(stage, "session-d", sender, message("to-replacement")), {});
	// So does one whose next session resumed its session id, as a model fallback's does.
	const retired = workerSession("session-e");
	const retiredDelivery = await remoteDelivery();
	await retiredDelivery.deliverPending(sink("session-e"), { sessionId: "session-e", receivedMessageIds: [] });
	unregisterWhenClosed(retired, inbox, stage, retiredDelivery);
	await (await remoteDelivery()).deliverPending(sink("session-e resumed"), {
		sessionId: "session-e",
		receivedMessageIds: [],
	});
	await retired.dispose();
	assert.deepEqual(await inbox.deliver(stage, "session-e", sender, message("to-resumed")), {});
	assert.deepEqual(received, ["session-a:before-close", "session-d:to-replacement", "session-e resumed:to-resumed"]);
	// Without an inbox, the root's host, the session is left as it is.
	const local = workerSession("session-f");
	const dispose = local.dispose;
	assert.equal(unregisterWhenClosed(local, undefined, stage, delivery), local);
	assert.equal(local.dispose, dispose);
});

/** A stage's own pending-stage delivery, which a worker replaces with its own; it counts the failures it is told. */
function stageDelivery(failures: Error[]) {
	return {
		deliverPending: async () => {
			throw new Error("a worker's stage takes its messages through the worker's delivery");
		},
		ready: () => undefined,
		fail: (reason: Error) => {
			failures.push(reason);
		},
	};
}

/** The options a stage runner creates a pooled stage's session with: its session manager and pending-stage delivery. */
function sessionOptions(sessionId: string | undefined, failures: Error[] = []): StageSessionCreateOptions {
	return {
		...(sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } }),
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: CHILD,
			workflowStageId: "agent-1",
			workflowStageName: "agent",
			constraints: { disableWorkflowTool: true },
			pendingStageDelivery: stageDelivery(failures),
		},
	} as never as StageSessionCreateOptions;
}

const META = { runId: CHILD, stageId: "agent-1", stageName: "agent" };

/**
 * A base adapter whose sessions start as Intercom's extension starts one: the stage's pending-stage delivery drains into
 * `sink` before `create` returns. Its sessions come back bare or in a create result, as `shape` says.
 */
function startingAdapter(shape: "runtime" | "result", sink: (sender: Sender, message: Delivered) => void) {
	const created: { options: StageSessionCreateOptions; session: StageSessionRuntime }[] = [];
	const closed: string[] = [];
	const base: AgentSessionAdapter = {
		async create(options) {
			const sessionId = options.sessionManager?.getSessionId() ?? "session-unmanaged";
			await options.orchestrationContext?.pendingStageDelivery?.deliverPending(sink, {
				sessionId,
				receivedMessageIds: [],
			});
			const session = workerSession(sessionId, async () => {
				closed.push(sessionId);
			});
			created.push({ options, session });
			return shape === "result" ? { session } : session;
		},
	};
	return { base, created, closed };
}

/** A worker's ports for one attempt of the child, over a root journal that queued `messages`. */
function workerPorts(base: AgentSessionAdapter, overrides: Partial<WorkerStageAdapterPorts> = {}) {
	const store = createStore();
	store.recordRunStart(childRun());
	const requests: unknown[] = [];
	const caughtUp: string[] = [];
	const ports: WorkerStageAdapterPorts = {
		base,
		store,
		inbox: new RemoteStageInbox(),
		shared: { host: "host-b", routes: false },
		request: async (message) => {
			requests.push(message);
			return "capability";
		},
		published: () => undefined,
		journal: Object.assign(journal([entry("first", 1)]), {
			catchUpWorkflow: async (root: string) => {
				caughtUp.push(root);
			},
		}),
		root: ROOT,
		...overrides,
	};
	return { ports, store, requests, caughtUp };
}

test("a worker's stage session on another host takes its queued messages, publishes them, and leaves the inbox when it closes (#4505)", async () => {
	for (const shape of ["runtime", "result"] as const) {
		const received: string[] = [];
		const { base, created, closed } = startingAdapter(shape, (_sender, message) => {
			received.push(message.id);
		});
		const { ports, store, requests, caughtUp } = workerPorts(base);
		const failures: Error[] = [];
		const result = await workerStageAdapter(ports).create(sessionOptions("session-a", failures), META);
		const session = created[0]!.session;
		assert.equal("session" in result ? result.session : result, session, `${shape}: the base's own session`);
		assert.deepEqual(requests, [{ kind: "stage-workspace", runId: CHILD, stageId: "agent-1" }], shape);
		assert.deepEqual(caughtUp, [ROOT], "the root's journal is read up to date first");
		assert.deepEqual(received, ["first"], "the session took its queued message before its first turn");
		const stage = store.run(CHILD)?.stages[0];
		assert.deepEqual(
			[stage?.sessionId, stage?.intercomReceipts],
			["session-a", { sessionId: "session-a", messageIds: ["first"] }],
		);
		const delivery = created[0]!.options.orchestrationContext?.pendingStageDelivery;
		assert.equal(delivery?.routeCapability, undefined, "no route is asked of the root's host");
		const failure = new Error("the root ended the attempt");
		delivery?.fail(failure);
		assert.deepEqual(failures, [failure], "a failure the root reports reaches the stage's own delivery");
		const identity = { runId: CHILD, stageId: "agent-1" };
		const sender = { id: "sender-id", name: "sender" } as Sender;
		assert.deepEqual(
			await ports.inbox!.deliver(identity, "session-a", sender, entry("late", 2).message as Delivered),
			{},
		);
		await session.dispose();
		assert.deepEqual(closed, ["session-a"]);
		const afterClose = await ports.inbox!.deliver(
			identity,
			"session-a",
			sender,
			entry("later", 3).message as Delivered,
		);
		assert.equal(afterClose.error?.code, "intercom_unavailable", `${shape}: the closed session's sink is gone`);
		assert.deepEqual(received, ["first", "late"]);
	}
});

test("a stage whose model fallback replaces its reopened session keeps taking the root's messages after the retired session closes (#4505)", async () => {
	// The stage reopens its saved session, whose model fails again; the fallback walk restarts the chain, and every
	// session it creates resumes the saved session id. Each one starts as Intercom's extension starts one.
	const sessionStore = new MemorySessionStore();
	await sessionStore.create(
		{ id: "saved-session", version: 4, createdAt: new Date().toISOString(), cwd: process.cwd() },
		[],
	);
	const created: string[] = [];
	const received: string[] = [];
	const closed: string[] = [];
	const base: AgentSessionAdapter = {
		async create(options) {
			const index = created.length;
			const sessionId = options.sessionManager?.getSessionId() ?? "session-unmanaged";
			created.push(`${index}:${String(options.model)}:${sessionId}`);
			await options.orchestrationContext?.pendingStageDelivery?.deliverPending(
				(_sender, message) => {
					received.push(`${index}:${message.id}`);
				},
				{ sessionId, receivedMessageIds: [] },
			);
			const { session } = makeMockSession({
				sessionId,
				// The reopened session restores its saved model, the chain's fallback; the restarted chain tries both.
				model: { provider: "anthropic", id: index === 1 ? "model-a" : "model-b" } as StageSessionRuntime["model"],
				async prompt() {
					if (index < 2) throw new Error("rate limit exceeded");
					return "answered";
				},
				dispose() {
					closed.push(`${index}`);
				},
			});
			return session;
		},
	};
	const { ports } = workerPorts(base);
	const context = createStageContext({
		runId: CHILD,
		stageId: "agent-1",
		stageName: "agent",
		stageOptions: { model: "anthropic/model-a", fallbackModels: ["anthropic/model-b"], sessionStore },
		adapters: { agentSession: workerStageAdapter(ports) },
		pendingStageDelivery: stageDelivery([]),
	});
	await context.__ensureSessionFromId("saved-session");
	await context.prompt("follow up");
	assert.deepEqual(created, [
		"0:undefined:saved-session",
		"1:anthropic/model-a:saved-session",
		"2:anthropic/model-b:saved-session",
	]);
	for (let turn = 0; turn < 12 && closed.length < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(closed, ["0", "1"], "the fallback walk closed the sessions it retired");
	const sender = { id: "sender-id", name: "sender" } as Sender;
	assert.deepEqual(
		await ports.inbox!.deliver(
			{ runId: CHILD, stageId: "agent-1" },
			"saved-session",
			sender,
			entry("live", 2).message as Delivered,
		),
		{},
		"the live session still takes the root's message",
	);
	assert.deepEqual(received.at(-1), "2:live");
	await context.__dispose();
});

test("a worker's stage session on the root's host forwards to the root, and a stage without Intercom is the base's own (#4505)", async () => {
	const received: string[] = [];
	const { base, created, closed } = startingAdapter("result", (_sender, message) => {
		received.push(message.id);
	});
	// The root's host, in a pool that is not shared: no inbox and no workspace record.
	const publication = Promise.withResolvers<void>();
	let published: Promise<void> | undefined = publication.promise;
	const { ports, store, requests } = workerPorts(base, {
		inbox: undefined,
		shared: undefined,
		published: () => published,
	});
	const adapter = workerStageAdapter(ports);
	const creating = adapter.create(sessionOptions(undefined), META);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(created.length, 0, "a stage's session waits for the attempt's publication in flight");
	published = undefined;
	publication.resolve();
	const result = await creating;
	const session = "session" in result ? result.session : result;
	assert.deepEqual(requests, [
		{ kind: "route", runId: CHILD },
		{
			kind: "delivery",
			runId: CHILD,
			stageId: "agent-1",
			stageName: "agent",
			recipient: { sessionId: "session-unmanaged", receivedMessageIds: ["first"] },
		},
	]);
	assert.equal(created[0]!.options.orchestrationContext?.pendingStageDelivery?.routeCapability, "capability");
	const stage = store.run(CHILD)?.stages[0];
	assert.deepEqual([stage?.sessionId, stage?.intercomReceipts], [undefined, undefined]);
	assert.deepEqual(received, ["first"]);
	await session.dispose();
	assert.deepEqual(closed, ["session-unmanaged"], "its session closes as the base's own");
	// A stage without a pending-stage delivery gets the base's session for its own options.
	const plain = { cwd: "/stage" } as StageSessionCreateOptions;
	const bare = await adapter.create(plain, META);
	assert.equal(created[1]!.options, plain);
	assert.equal("session" in bare ? bare.session : bare, created[1]!.session);
	assert.equal(requests.length, 2, "nothing more is asked of the root");
	await assert.rejects(adapter.create(plain), /Worker stage identity is required/);
});
