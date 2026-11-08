import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import {
	createWorkflowPendingStageDelivery,
	WorkflowPendingStageDeliveryFailedError,
} from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { classifyWorkflowFailure } from "../../packages/workflows/src/shared/workflow-failures.js";
import {
	createPooledStageDelivery,
	createWorkerStageDelivery,
	type PooledStageDeliveryOptions,
} from "../../packages/workflows/src/workers/pooled-stage-delivery.js";
import { RemoteStageInbox } from "../../packages/workflows/src/workers/remote-stage-inbox.js";
import { sleep } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
vi.mock("../../packages/intercom/broker/broker-routing.js", () => ({
	queryBrokerRouting: async () => ({ acrossMachines: false, hasSharedStorage: false, protocol: { min: 1, max: 2 } }),
}));
afterEach(() => {
	vi.restoreAllMocks();
	setDurableBackend(undefined);
});

test("admits targeted and sticky instructions to replacement sessions without broker warm-up (#3628)", async () => {
	const runId = "36280000-0000-4000-8000-000000000001";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	store.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [
			{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [] },
			{ id: "later", name: "later", status: "pending", parentIds: [], toolEvents: [] },
		],
	});
	const enqueue = async (id: string, sticky = false) => {
		const input = {
			runId,
			stageKey: sticky ? `workflow:${runId}/**` : "review",
			targetPath: `workflow:${runId}/${sticky ? "**" : "review"}`,
			from: { id: "planner", name: "planner", group },
			message: { id, timestamp: 1, content: { text: id } },
			queuedAt: new Date().toISOString(),
		};
		const queued = sticky
			? await store.queueStickyStageMessage(input, group, group, backend)
			: await store.queueStageMessage(input, group, group, backend);
		assert.equal(queued?.ok, true);
	};
	await enqueue("sticky", true);
	const connect = vi
		.spyOn(IntercomClient.prototype, "connect")
		.mockRejectedValue(new IntercomClientDisconnectedError())
		.mockImplementationOnce(async () => {
			await enqueue("during-registration");
		});
	vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	const delivery = createWorkflowPendingStageDelivery(store, runId, "review", "review");
	for (const [sessionId, stageId] of [
		["primary", "review"],
		["fallback", "review"],
		["future", "later"],
	] as const) {
		if (sessionId === "fallback") await enqueue("targeted");
		const pendingStageDelivery =
			stageId === "review" ? delivery : createWorkflowPendingStageDelivery(store, runId, stageId, stageId);
		const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
		const admitted: string[] = [];
		const branch: Array<{ type: "custom_message"; customType: string; details: { message: { id: string } } }> = [];
		const pi = {
			on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			appendEntry() {},
			getSessionName: () => undefined,
			events: createEventBus(),
			sendMessage(message: { customType: string; details: { message: { id: string } } }) {
				admitted.push(message.details.message.id);
				branch.push({ type: "custom_message", ...message });
			},
		};
		intercomHeavy(pi as never);
		const ctx = {
			hasUI: false,
			cwd: process.cwd(),
			isIdle: () => true,
			ui: { notify() {} },
			sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
			orchestrationContext: {
				kind: "workflow-stage",
				workflowRunId: runId,
				workflowStageId: stageId,
				workflowStageName: stageId,
				intercomGroup: group,
				pendingStageDelivery,
			},
		};
		const fire = async (name: string) => {
			for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx as never);
		};
		try {
			if (sessionId === "primary") await fire("session_start");
			else await assert.rejects(fire("session_start"), IntercomClientDisconnectedError);
			assert.deepEqual(
				admitted,
				sessionId === "primary"
					? ["sticky", "during-registration"]
					: sessionId === "fallback"
						? ["sticky", "targeted"]
						: ["sticky"],
			);
			await pendingStageDelivery.ready(sessionId);
			if (sessionId === "primary")
				pendingStageDelivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));
		} finally {
			await fire("session_shutdown");
		}
	}
	assert.equal(connect.mock.calls.length, 3);
	const entries = store.runs()[0]?.pendingStageMessages;
	assert.equal(entries?.find((entry) => entry.message.id === "targeted")?.status, "delivered");
	assert.equal(entries?.find((entry) => entry.message.id === "sticky")?.status, "queued");
});

for (const sticky of [false, true]) {
	for (const readyBeforeFailure of [false, true]) {
		test(`blocks resumably for ${sticky ? "sticky" : "targeted"} instructions queued during final failed registration with readiness ${readyBeforeFailure ? "before" : "after"} failure (#3628)`, async () => {
			const runId = "36280000-0000-4000-8000-000000000002";
			const group = `workflow:${runId}`;
			const store = createStore();
			const backend = await createMemoryTestBackend();
			bindStoreDurableBackend(store, backend);
			await backend.commitWorkflowRegistration({
				workflowId: runId,
				name: "flow",
				inputs: {},
				status: "running",
				createdAt: 1,
			});
			store.recordRunStart({
				id: runId,
				name: "flow",
				inputs: {},
				status: "running",
				startedAt: 1,
				toolNodes: [],
				stages: [{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [] }],
			});
			vi.spyOn(IntercomClient.prototype, "connect").mockResolvedValue();
			vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockImplementation(async () => {
				const input = {
					runId,
					stageKey: sticky ? `workflow:${runId}/**` : "review",
					targetPath: `workflow:${runId}/${sticky ? "**" : "review"}`,
					from: { id: "planner", name: "planner", group },
					message: { id: "late-instruction", timestamp: 1, content: { text: "Keep this instruction" } },
					queuedAt: new Date().toISOString(),
				};
				const queued = sticky
					? await store.queueStickyStageMessage(input, group, group, backend)
					: await store.queueStageMessage(input, group, group, backend);
				assert.equal(queued?.ok, true);
				throw new IntercomClientDisconnectedError();
			});
			vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
			const delivery = createWorkflowPendingStageDelivery(store, runId, "review", "review");
			const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
			const admitted: string[] = [];
			intercomHeavy({
				on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
					handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				},
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				appendEntry() {},
				getSessionName: () => undefined,
				events: createEventBus(),
				sendMessage(message: { details: { message: { id: string } } }) {
					admitted.push(message.details.message.id);
				},
			} as never);
			const ctx = {
				hasUI: false,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: { notify() {} },
				sessionManager: { getSessionId: () => "fallback", getBranch: () => [] },
				orchestrationContext: {
					kind: "workflow-stage",
					workflowRunId: runId,
					workflowStageId: "review",
					workflowStageName: "review",
					intercomGroup: group,
					pendingStageDelivery: delivery,
				},
			};
			const fire = async (name: string) => {
				for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx as never);
			};
			try {
				await assert.rejects(fire("session_start"), IntercomClientDisconnectedError);
				const parked = readyBeforeFailure ? delivery.ready("fallback") : undefined;
				delivery.fail(new Error("Intercom could not reach the broker after 5 warm-up attempts."));
				const outcome = await Promise.race([
					Promise.resolve(parked ?? delivery.ready("fallback")).then(
						() => "ready",
						(error: Error) => error,
					),
					Promise.resolve().then(() => "still pending"),
				]);
				assert.ok(outcome instanceof WorkflowPendingStageDeliveryFailedError, String(outcome));
				assert.equal(classifyWorkflowFailure(outcome).disposition, "active_blocked");
				assert.equal(classifyWorkflowFailure(outcome).resumable, true);
				assert.deepEqual(admitted, []);
				assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.status, "queued");
			} finally {
				await fire("session_shutdown");
			}
		});
	}
}

test("a sticky message the broker could not forward to a disconnected stage is delivered once it reconnects", async () => {
	const runId = "39580000-0000-4000-8000-000000000001";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	store.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [] }],
	});
	const enqueue = async (id: string) => {
		const queued = await store.queueStickyStageMessage(
			{
				runId,
				stageKey: `workflow:${runId}/**`,
				targetPath: `workflow:${runId}/**`,
				from: { id: "planner", name: "planner", group },
				message: { id, timestamp: 1, content: { text: id } },
				queuedAt: new Date().toISOString(),
			},
			group,
			group,
			backend,
		);
		assert.equal(queued?.ok, true);
	};
	const clients: IntercomClient[] = [];
	const connect = vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (
		this: IntercomClient,
	) {
		clients.push(this);
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(function (this: IntercomClient) {
		return clients.at(-1) === this;
	});
	vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	const delivery = createWorkflowPendingStageDelivery(store, runId, "review", "review");
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
	const admitted: string[] = [];
	const branch: Array<{ type: "custom_message"; customType: string; details: { message: { id: string } } }> = [];
	intercomHeavy({
		on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
		sendMessage(message: { customType: string; details: { message: { id: string } } }) {
			admitted.push(message.details.message.id);
			branch.push({ type: "custom_message", ...message });
		},
	} as never);
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "stage-session", getBranch: () => branch },
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: runId,
			workflowStageId: "review",
			workflowStageName: "review",
			intercomGroup: group,
			pendingStageDelivery: delivery,
		},
	};
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx as never);
	};
	try {
		await enqueue("before-start");
		await fire("session_start");
		assert.deepEqual(admitted, ["before-start"]);
		// The stage drops its broker connection; a sticky send queued meanwhile reaches no live session.
		const dropped = clients.at(-1)!;
		clients.push(undefined as never);
		dropped.emit("disconnected", new Error("socket closed"));
		await enqueue("while-disconnected");
		for (let waited = 0; connect.mock.calls.length < 2 && waited < 5_000; waited += 25) await sleep(25);
		for (let waited = 0; admitted.length < 2 && waited < 2_000; waited += 25) await sleep(25);
		assert.equal(connect.mock.calls.length, 2, "the stage reconnected");
		assert.deepEqual(
			admitted,
			["before-start", "while-disconnected"],
			"the reconnect drain delivers the missed message once",
		);
		const entry = store
			.runs()[0]
			?.pendingStageMessages?.find((candidate) => candidate.message.id === "while-disconnected");
		assert.ok(
			entry?.deliveries?.some((record) => record.sessionId === "stage-session" && record.admission === "context"),
		);
		dropped.emit("disconnected", new Error("ignored: stale client"));
		await sleep(50);
		assert.deepEqual(admitted, ["before-start", "while-disconnected"]);
	} finally {
		await fire("session_shutdown");
	}
});

test("a reconnect during the stage's second startup drain still delivers a message queued while disconnected", async () => {
	const runId = "39580000-0000-4000-8000-000000000003";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	store.recordRunStart({
		id: runId,
		name: "flow",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [] }],
	});
	const enqueue = async (id: string) => {
		const queued = await store.queueStickyStageMessage(
			{
				runId,
				stageKey: `workflow:${runId}/**`,
				targetPath: `workflow:${runId}/**`,
				from: { id: "planner", name: "planner", group },
				message: { id, timestamp: 1, content: { text: id } },
				queuedAt: new Date().toISOString(),
			},
			group,
			group,
			backend,
		);
		assert.equal(queued?.ok, true);
	};
	const clients: (IntercomClient | undefined)[] = [];
	const connect = vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (
		this: IntercomClient,
	) {
		// The first registration races a sticky send, so the second startup drain has a receipt to commit.
		if (clients.length === 0) await enqueue("during-registration");
		clients.push(this);
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(function (this: IntercomClient) {
		return clients.at(-1) === this;
	});
	vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	// Hold the second startup drain at its receipt commit, after it took its queue snapshot.
	const commitEntered = Promise.withResolvers<void>();
	const releaseCommit = Promise.withResolvers<void>();
	let commits = 0;
	const delivery = createWorkflowPendingStageDelivery(store, runId, "review", "review", async (action) => {
		commits += 1;
		if (commits === 1) {
			commitEntered.resolve();
			await releaseCommit.promise;
		}
		return action();
	});
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
	const admitted: string[] = [];
	const branch: Array<{ type: "custom_message"; customType: string; details: { message: { id: string } } }> = [];
	intercomHeavy({
		on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
		sendMessage(message: { customType: string; details: { message: { id: string } } }) {
			admitted.push(message.details.message.id);
			branch.push({ type: "custom_message", ...message });
		},
	} as never);
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "stage-session", getBranch: () => branch },
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: runId,
			workflowStageId: "review",
			workflowStageName: "review",
			intercomGroup: group,
			pendingStageDelivery: delivery,
		},
	};
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx as never);
	};
	const contextReceipts = (id: string) =>
		store
			.runs()[0]
			?.pendingStageMessages?.find((entry) => entry.message.id === id)
			?.deliveries?.filter((record) => record.sessionId === "stage-session" && record.admission === "context")
			.length ?? 0;
	let startup: Promise<void> | undefined;
	try {
		startup = fire("session_start");
		await commitEntered.promise;
		assert.deepEqual(admitted, ["during-registration"]);
		// While the second startup drain waits on its receipt, the stage drops its connection, a sticky send
		// reaches no live session, and the stage reconnects.
		const dropped = clients.at(-1)!;
		clients.push(undefined);
		dropped.emit("disconnected", new Error("socket closed"));
		await enqueue("while-disconnected");
		for (let waited = 0; connect.mock.calls.length < 2 && waited < 5_000; waited += 25) await sleep(25);
		assert.equal(connect.mock.calls.length, 2, "the stage reconnected during the startup drain");
		releaseCommit.resolve();
		await startup;
		for (let waited = 0; contextReceipts("while-disconnected") === 0 && waited < 2_000; waited += 25) await sleep(25);
		await sleep(50);
		assert.deepEqual(admitted, ["during-registration", "while-disconnected"], "each message is admitted once");
		assert.equal(contextReceipts("during-registration"), 1);
		assert.equal(contextReceipts("while-disconnected"), 1);
	} finally {
		releaseCommit.resolve();
		await startup?.catch(() => {});
		await fire("session_shutdown");
	}
});

test("a message a pooled stage's root drain hands over after startup keeps its delivery mode and live framing", async () => {
	const runId = "39580000-0000-4000-8000-000000000004";
	const group = `workflow:${runId}`;
	vi.spyOn(IntercomClient.prototype, "connect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "isConnected").mockReturnValue(true);
	const register = vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	const connects: string[] = [];
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	const sender = { id: "planner", name: "planner", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 0 };
	// The root is busy: its drains answer only when the test hands their messages over.
	const rootDrains: Parameters<PooledStageDeliveryOptions["forward"]>[1][] = [];
	const delivery = createPooledStageDelivery({
		routeCapability: "capability",
		queued: async () => [
			{
				id: "before-start",
				runId,
				stageKey: "review",
				from: sender,
				message: { id: "before-start", timestamp: 1, content: { text: "before-start" } },
				queuedAt: new Date(1).toISOString(),
				admissionOrder: 1,
				status: "queued",
			},
		],
		forward: async (_recipient, deliver) => {
			rootDrains.push(deliver);
		},
		fail: () => {},
	});
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
	const sent: { content: string; id: string; options: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
	const branch: Array<{ type: "custom_message"; customType: string; details: { message: { id: string } } }> = [];
	intercomHeavy(
		{
			on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			appendEntry() {},
			getSessionName: () => undefined,
			events: createEventBus(),
			sendMessage(
				message: { content: string; customType: string; details: { message: { id: string } } },
				options: { triggerTurn?: boolean; deliverAs?: string },
			) {
				sent.push({ content: message.content, id: message.details.message.id, options });
				branch.push({ type: "custom_message", ...message });
			},
		} as never,
		{
			beforeConnectAttempt: (reason) => {
				connects.push(reason);
			},
		},
	);
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "stage-session", getBranch: () => branch },
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: runId,
			workflowStageId: "review",
			workflowStageName: "review",
			intercomGroup: group,
			pendingStageDelivery: delivery,
		},
	};
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx as never);
	};
	try {
		await fire("session_start");
		assert.deepEqual(
			sent.map(({ id }) => id),
			["before-start"],
		);
		assert.match(sent[0]!.content, /Messages received before you started/);
		// The stage has started. The root catches up and hands over a follow-up queued after the worker read the journal.
		assert.ok(rootDrains.length > 0);
		await rootDrains.at(-1)!(sender, {
			id: "late",
			timestamp: 2,
			content: { text: "late follow-up" },
			delivery: "followUp",
		} as Parameters<(typeof rootDrains)[number]>[1]);
		const late = sent.find(({ id }) => id === "late");
		assert.ok(late, "the late message reached the session");
		assert.doesNotMatch(late.content, /Messages received before you started/);
		assert.equal(late.options.deliverAs, "followUp");
		assert.equal(late.options.triggerTurn, true);
		// A stage on the root's host registers its live route once, under the capability its delivery holds (#4391).
		assert.deepEqual(
			register.mock.calls.map(([run, , capability]) => [run, capability]),
			[[runId, "capability"]],
		);
		assert.deepEqual(connects, ["startup"], "it connects at startup to register it");
	} finally {
		await fire("session_shutdown");
	}
});

test("a stage on a host where its run's route is not announced registers no route, and takes its messages through its inbox once (#4391)", async () => {
	const runId = "43910000-0000-4000-8000-000000000001";
	const group = `workflow:${runId}`;
	const connect = vi.spyOn(IntercomClient.prototype, "connect").mockResolvedValue();
	const register = vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	const sender = { id: "planner", name: "planner", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: 0 };
	const inbox = new RemoteStageInbox();
	const stage = { runId, stageId: "review", stageName: "review" };
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "child",
		inputs: {},
		status: "running",
		startedAt: 0,
		stages: [{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [] }],
		toolNodes: [],
	});
	const asked: string[] = [];
	const delivery = await createWorkerStageDelivery({
		stage,
		inbox,
		store,
		request: async () => {
			asked.push("route");
			return "capability";
		},
		forward: async () => {
			asked.push("forward");
		},
		queued: async () => [
			{
				id: "before-start",
				runId,
				stageKey: "review",
				from: sender,
				message: { id: "before-start", timestamp: 1, content: { text: "before-start" } },
				queuedAt: new Date(1).toISOString(),
				admissionOrder: 1,
				status: "queued",
			},
		],
		fail: () => {},
	});
	assert.equal(delivery.routeCapability, undefined, "no route capability on a host that does not run the root");
	assert.deepEqual(asked, [], "the root's route is not asked for");
	assert.equal(delivery.ready("stage-session"), undefined, "the stage's startup waits for nothing");
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => void | Promise<void>>>();
	const sent: { content: string; id: string; options: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
	const branch: Array<{
		type: "custom_message";
		customType: string;
		details: { message: { id: string }; stageQueued?: true };
	}> = [];
	intercomHeavy({
		on(name: string, handler: (event: never, ctx: ExtensionContext) => void | Promise<void>) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getSessionName: () => undefined,
		events: createEventBus(),
		sendMessage(
			message: { content: string; customType: string; details: { message: { id: string } } },
			options: { triggerTurn?: boolean; deliverAs?: string },
		) {
			sent.push({ content: message.content, id: message.details.message.id, options });
			branch.push({ type: "custom_message", ...message });
		},
	} as never);
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "stage-session", getBranch: () => branch },
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: runId,
			workflowStageId: "review",
			workflowStageName: "review",
			intercomGroup: group,
			pendingStageDelivery: delivery,
		},
	};
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({} as never, ctx as never);
	};
	try {
		await fire("session_start");
		assert.equal(connect.mock.calls.length, 0, "the stage connects to no broker to register a route at startup");
		assert.equal(register.mock.calls.length, 0, "and registers no live route");
		assert.deepEqual(
			sent.map(({ id }) => id),
			["before-start"],
		);
		assert.match(sent[0]!.content, /Messages received before you started/);
		assert.deepEqual(
			store.run(runId)?.stages[0]?.intercomReceipts,
			{ sessionId: "stage-session", messageIds: ["before-start"] },
			"the stage records what its session took under the session the root addresses it by (#4505)",
		);
		// The root's later message reaches the session through the inbox, live, once; the one it already holds is not sent again.
		const late = {
			id: "late",
			timestamp: 2,
			content: { text: "late follow-up" },
			delivery: "followUp",
		} as Parameters<Parameters<typeof inbox.register>[2]>[1];
		assert.deepEqual(await inbox.deliver(stage, "stage-session", sender, late), {});
		assert.deepEqual(await inbox.deliver(stage, "stage-session", sender, late), {});
		assert.deepEqual(
			await inbox.deliver(stage, "stage-session", sender, {
				id: "before-start",
				timestamp: 1,
				content: { text: "before-start" },
			}),
			{},
		);
		assert.deepEqual(
			sent.map(({ id }) => id),
			["before-start", "late"],
		);
		assert.deepEqual(asked, [], "no root drain is asked for: the root drains through the stage's input queue");
		assert.deepEqual(
			branch.map((entry) => [entry.details.message.id, entry.details.stageQueued]),
			[
				["before-start", true],
				["late", true],
			],
			"each card the stage's queue handed over says so, for a session recovery to replay it",
		);
		const live = sent[1]!;
		assert.doesNotMatch(live.content, /Messages received before you started/);
		assert.equal(live.options.deliverAs, "followUp");
		assert.equal(live.options.triggerTurn, true);
		// Once the session's Intercom runtime ended, a message handed over fails typed: the stage's host keeps it queued.
		await fire("session_shutdown");
		const retired = await inbox.deliver(stage, "stage-session", sender, {
			id: "after-shutdown",
			timestamp: 3,
			content: { text: "after shutdown" },
		});
		assert.deepEqual(
			[retired.refusal, retired.error?.name, retired.error?.code],
			[undefined, "IntercomRuntimeInactiveError", "intercom_unavailable"],
		);
		assert.equal(sent.length, 2);
	} finally {
		await fire("session_shutdown");
	}
});
