/**
 * A started workflow stage re-runs its pending-stage drain after it reconnects to the broker, so a sticky
 * message the broker could not forward while it was disconnected still arrives (#3958). The recovered
 * message must behave exactly like the live copy it replaces: an `interrupt` cancels the stage's active
 * operation, and an ask becomes the stage's reply context.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { IntercomClient, type SendOptions } from "../../packages/intercom/broker/client.js";
import intercomHeavy from "../../packages/intercom/index-heavy.js";
import type { IntercomExtensionTestOverrides } from "../../packages/intercom/intercom-test-seams.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStickyStageMessageInput } from "../../packages/workflows/src/shared/store-types.js";
import { createDispatchCounter } from "../helpers/intercom-interrupt-probe.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

vi.mock("../../packages/intercom/broker/spawn.js", () => ({ spawnBrokerIfNeeded: vi.fn() }));
afterEach(() => {
	vi.restoreAllMocks();
	setDurableBackend(undefined);
});

type Inbound = Parameters<NonNullable<IntercomExtensionTestOverrides["captureInboundHandler"]>>[0];

const RUN_ID = "39580000-0000-4000-8000-000000000002";
const GROUP = `workflow:${RUN_ID}`;
const STAGE = "recovery-stage";

function peer(id: string): SessionInfo {
	return { id, name: id, cwd: "/peer", pid: 1, model: "faux", startedAt: 1, lastActivity: 1, group: GROUP };
}

type ToolDefinition = Parameters<Parameters<typeof intercomHeavy>[0]["registerTool"]>[0];

async function stage(tools: AgentTool[]) {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	store.recordRunStart({
		id: RUN_ID,
		name: "flow",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: STAGE, name: STAGE, status: "running", parentIds: [], toolEvents: [] }],
	});
	const clients: (IntercomClient | undefined)[] = [];
	const connects = vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (
		this: IntercomClient,
	) {
		clients.push(this);
	});
	vi.spyOn(IntercomClient.prototype, "isConnected").mockImplementation(function (this: IntercomClient) {
		return clients.at(-1) === this;
	});
	vi.spyOn(IntercomClient.prototype, "registerLiveWorkflowStageRoute").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "disconnect").mockResolvedValue();
	vi.spyOn(IntercomClient.prototype, "updatePresence").mockReturnValue(true);
	vi.spyOn(IntercomClient.prototype, "acknowledgeReceived").mockReturnValue();
	const sent: { to: string; options: SendOptions }[] = [];
	vi.spyOn(IntercomClient.prototype, "send").mockImplementation(async (to: string, options: SendOptions) => {
		sent.push({ to, options });
		return { id: `sent-${sent.length}`, delivered: true };
	});
	const boundary = new WorkflowStageAdmissionBoundary();
	let inbound!: Inbound;
	let ctx!: ExtensionContext;
	let intercomTool: ToolDefinition | undefined;
	// The real `intercom` tool name is reserved for the bundled extension, so the model reaches the tested
	// extension's own tool through this probe, with the stage's own context.
	const replyProbe: AgentTool = {
		name: "reply_probe",
		label: "Reply probe",
		description: "Calls the stage's intercom tool",
		parameters: Type.Object({ message: Type.String() }),
		async execute(id, args, signal) {
			if (intercomTool === undefined) throw new Error("intercom tool was not registered");
			return (await intercomTool.execute(
				id,
				{ action: "reply", message: (args as { message: string }).message } as never,
				signal,
				undefined,
				ctx as never,
			)) as never;
		},
	};
	const h = await createHarness({
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: RUN_ID,
			workflowStageId: STAGE,
			workflowStageName: STAGE,
			constraints: { disableWorkflowTool: true },
			intercomGroup: GROUP,
			messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
			pendingStageDelivery: createWorkflowPendingStageDelivery(store, RUN_ID, STAGE, STAGE),
		},
		tools: [...tools, replyProbe],
		extensionFactories: [
			(pi) => {
				const capturing = new Proxy(pi, {
					get(target, key) {
						if (key === "registerTool")
							return (definition: ToolDefinition) => {
								if (definition.name === "intercom") intercomTool = definition;
								return target.registerTool(definition);
							};
						const value = Reflect.get(target, key);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				intercomHeavy(capturing, {
					captureInboundHandler: (handler) => {
						inbound = handler;
					},
				});
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
	});
	await h.session.bindExtensions({ mode: "print" });
	return {
		...h,
		store,
		sent,
		deliverLive: (message: Message, from: SessionInfo) => inbound(ctx, from, message),
		/** Drops the stage's broker connection, queues a sticky message it cannot receive live, and waits for the reconnect. */
		async recoverAfterReconnect(message: Message, from: SessionInfo) {
			const dropped = clients.at(-1)!;
			clients.push(undefined);
			dropped.emit("disconnected", new Error("socket closed"));
			const input = {
				runId: RUN_ID,
				stageKey: `${GROUP}/**`,
				targetPath: `${GROUP}/**`,
				from,
				message,
				queuedAt: new Date().toISOString(),
			} as PendingStickyStageMessageInput;
			assert.equal((await store.queueStickyStageMessage(input, GROUP, GROUP, backend))?.ok, true);
			const before = connects.mock.calls.length;
			await vi.waitFor(() => assert.ok(connects.mock.calls.length > before, "the stage reconnects"), {
				timeout: 5_000,
			});
		},
		cards: (id: string) =>
			h.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "intercom_message" &&
						(entry.details as { message?: { id?: string } } | undefined)?.message?.id === id,
				),
		contextReceipts: (id: string) =>
			store
				.runs()[0]
				?.pendingStageMessages?.find((entry) => entry.message.id === id)
				?.deliveries?.filter((delivery) => delivery.admission === "context").length ?? 0,
		async close(execution?: Promise<void>) {
			void h.session.abort().catch(() => {});
			boundary.seal();
			await execution?.catch(() => {});
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h.session.pauseQueuedMessages();
			h.cleanup();
		},
	};
}

test("a recovered interrupt cancels the stage's running tool, as the live message would", async () => {
	const record = { calls: 0, completed: 0, signal: undefined as AbortSignal | undefined };
	const started = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "long_work",
		label: "Long work",
		description: "Runs until cancelled",
		parameters: Type.Object({}),
		async execute(_id, _args, signal) {
			record.calls += 1;
			record.signal = signal;
			started.resolve();
			await Promise.race([
				cleanup.promise,
				new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
			]);
			if (!signal?.aborted) record.completed += 1;
			return {
				content: [{ type: "text" as const, text: signal?.aborted ? "cancelled" : "completed" }],
				details: {},
			};
		},
	};
	const h = await stage([tool]);
	const seen: string[] = [];
	const dispatches = createDispatchCounter([
		() => fauxAssistantMessage(fauxToolCall("long_work", {}), { stopReason: "toolUse" }),
		(context) => {
			seen.push(
				...context.messages.filter((m) => getMessageText(m).includes("PRIORITY")).map((m) => getMessageText(m)),
			);
			return fauxAssistantMessage("amended result");
		},
	]);
	h.setResponses(dispatches.steps(4));
	const execution = h.session.prompt("original task");
	try {
		await started.promise;
		await h.recoverAfterReconnect(
			{
				id: "recovered-interrupt",
				timestamp: Date.now(),
				delivery: "interrupt",
				content: { text: "PRIORITY stop" },
			},
			peer("interrupting-peer"),
		);
		await vi.waitFor(() => assert.equal(record.signal?.aborted, true, "the recovered interrupt cancels the tool"), {
			timeout: 5_000,
		});
		await execution;
		assert.equal(record.completed, 0);
		assert.equal(record.calls, 1, "the cancelled tool call is not replayed");
		assert.equal(dispatches.counts.valid, 2, "exactly one valid model dispatch after cancellation");
		assert.equal(seen.length, 1, "the amended turn sees the message once");
		assert.equal(getMessageText(h.session.messages.at(-1)), "amended result");
		assert.equal(h.cards("recovered-interrupt").length, 1, "one card, no double delivery");
		await vi.waitFor(() => assert.equal(h.contextReceipts("recovered-interrupt"), 1));
	} finally {
		cleanup.resolve();
		await h.close(execution);
	}
});

test("a recovered ask is the stage's reply context, not an older ask", async () => {
	const h = await stage([]);
	h.setResponses([
		fauxAssistantMessage("task done"),
		fauxAssistantMessage("noted the older ask"),
		fauxAssistantMessage(fauxToolCall("reply_probe", { message: "recovered answer" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("replied"),
	]);
	try {
		await h.session.prompt("original task");
		await h.deliverLive(
			{ id: "older-ask", timestamp: Date.now(), expectsReply: true, content: { text: "older question" } },
			peer("older-sender"),
		);
		await vi.waitFor(() => assert.equal(getMessageText(h.session.messages.at(-1)), "noted the older ask"));
		await h.recoverAfterReconnect(
			{ id: "recovered-ask", timestamp: Date.now(), expectsReply: true, content: { text: "recovered question" } },
			peer("recovered-sender"),
		);
		await vi.waitFor(() => assert.equal(getMessageText(h.session.messages.at(-1)), "replied"), { timeout: 5_000 });
		const replies = h.sent.filter((entry) => entry.options.text === "recovered answer");
		assert.equal(replies.length, 1, "exactly one reply was sent");
		assert.equal(replies[0]?.to, "recovered-sender", "the reply reaches the recovered message's sender");
		assert.equal(replies[0]?.options.replyTo, "recovered-ask");
		assert.equal(h.cards("recovered-ask").length, 1, "one card, no double delivery");
		await vi.waitFor(() => assert.equal(h.contextReceipts("recovered-ask"), 1));
	} finally {
		await h.close();
	}
});
