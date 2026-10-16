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
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
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
