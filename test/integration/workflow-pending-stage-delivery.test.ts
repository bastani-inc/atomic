import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, CreateAgentSessionOptions } from "@bastani/atomic";
import { Type } from "typebox";
import { afterAll, beforeAll, test, vi } from "vitest";
import type { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.ts";
import { isRecoverableIntercomDisconnect } from "../../packages/intercom/recoverable-disconnect.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createMockSdk } from "../unit/durable-dbos-backend-helpers.js";

const RUN_ID = "4ac72924-c452-4e5f-9e63-2435722109f7";
const GROUP = `workflow:${RUN_ID}`;
const TARGET = `workflow:${RUN_ID}/reviewer`;
const BROKER_FRAME_TIMEOUT_MS = 5_000;
const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const STORE_EVENT_TIMEOUT_MS = 5_000;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "pending-stage-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { createMessageReader, writeMessage } = await import("../../packages/intercom/broker/framing.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { default: intercom } = await import("../../packages/intercom/index.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { SessionManager } = await import("../../packages/coding-agent/src/core/session-manager-core.ts");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { InMemoryDurableBackend } = await import("../../packages/workflows/src/durable/backend.js");
const { DbosDurableBackend } = await import("../../packages/workflows/src/durable/dbos-backend.js");
const { setDurableBackend } = await import("../../packages/workflows/src/durable/factory.js");
const { WorkflowStageAdmissionBoundary: StageAdmissionBoundary } = await import(
	"../../packages/coding-agent/src/core/workflow-stage-admission.ts"
);
const { registerPendingStageIntercomBridge, settleUndeliverablePendingStageMessages } = await import(
	"../../packages/workflows/src/extension/pending-stage-intercom.js"
);
const { workflow } = await import("../../packages/workflows/src/authoring/workflow.js");
const { buildRuntimeAdapters } = await import("../../packages/workflows/src/extension/wiring.js");
const { run } = await import("../../packages/workflows/src/runs/foreground/executor.js");
const { createWorkflowPendingStageDelivery } = await import(
	"../../packages/workflows/src/runs/foreground/pending-stage-delivery.js"
);
const { createStore } = await import("../../packages/workflows/src/shared/store.js");

interface TestContext {
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	model: { id: string };
	orchestrationContext: {
		intercomGroup: string;
		kind?: "workflow-stage";
		workflowRunId?: string;
		workflowStageId?: string;
		workflowStageName?: string;
		pendingStageDelivery?: ReturnType<typeof createWorkflowPendingStageDelivery>;
		lateMessageRouter?: NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["lateMessageRouter"];
		messageAdmission?: {
			readonly boundary: WorkflowStageAdmissionBoundary;
			readonly extensionState: Map<string, object>;
			isOpen(): boolean;
		};
	};
	sessionManager: { getSessionId(): string; getBranch(): [] };
	ui: {
		confirm(): Promise<boolean>;
		notify(): void;
	};
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: {
		delivered?: boolean;
		position?: number;
		queued?: boolean;
		notInKnownSet?: true;
		group?: string;
		runId?: string;
		stageKey?: string;
		messageId?: string;
		refusal?: string;
	};
	isError: boolean;
}

interface InjectedMessage {
	customType?: string;
	content?: string;
	details?: {
		from?: { id?: string; name?: string };
		message?: { id?: string; timestamp?: number; replyTo?: string; replyError?: string };
	};
}

interface InjectedMessageOptions {
	deliverAs?: "followUp";
	stageAdmissionKey?: string;
	triggerTurn?: boolean;
}

interface CapturedTool {
	name: string;
	execute?: (
		toolCallId: string,
		params: { action: string; group?: string; message?: string; to?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: TestContext,
	) => Promise<ToolResult>;
}

type LifecycleHandler = (event: Record<string, object | string>, ctx: TestContext) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

function extensionFixture(
	sessionId: string,
	initialName: string,
	pendingStageDelivery?: ReturnType<typeof createWorkflowPendingStageDelivery>,
	intercomGroup = GROUP,
	orchestrationContext?: TestContext["orchestrationContext"],
) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const eventCompletions = new Map<string, Promise<void>>();
	const eventCompletionWaiters = new Map<
		string,
		Array<{ resolve(completion: Promise<void>): void; reject(error: Error): void }>
	>();
	const tools = new Map<string, CapturedTool>();
	const injectedMessages: InjectedMessage[] = [];
	const injectedOptions: Array<InjectedMessageOptions | undefined> = [];
	const injectedWaiters: Array<{ count: number; resolve(): void }> = [];
	const resolveInjectedWaiters = (): void => {
		for (let index = injectedWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = injectedWaiters[index]!;
			if (injectedMessages.length < waiter.count) continue;
			injectedWaiters.splice(index, 1);
			waiter.resolve();
		}
	};
	let sessionName = initialName;
	let activeTools: string[] = [];
	const context: TestContext = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext:
			orchestrationContext ??
			(pendingStageDelivery
				? {
						intercomGroup,
						kind: "workflow-stage",
						workflowRunId: RUN_ID,
						workflowStageId: "reviewer-id",
						workflowStageName: "reviewer",
						pendingStageDelivery,
					}
				: { intercomGroup }),
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: {
			confirm: async () => true,
			notify() {},
		},
	};
	const recordInjected = (messages: readonly InjectedMessage[], options: InjectedMessageOptions | undefined): void => {
		injectedMessages.push(...messages);
		injectedOptions.push(...messages.map(() => options));
		resolveInjectedWaiters();
	};
	const admitInjected = async (
		messages: readonly InjectedMessage[],
		options: InjectedMessageOptions | undefined,
	): Promise<void> => {
		const boundary = context.orchestrationContext.messageAdmission?.boundary;
		if (boundary === undefined || options?.stageAdmissionKey === undefined) {
			recordInjected(messages, options);
			return;
		}
		await boundary.admit(
			options.stageAdmissionKey,
			() => recordInjected(messages, options),
			() => {
				throw new Error("workflow stage admission was sealed before pre-start delivery");
			},
		).completion;
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			const handlers = lifecycleHandlers.get(name) ?? [];
			handlers.push(handler);
			lifecycleHandlers.set(name, handlers);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		async sendMessage(message: InjectedMessage, options?: InjectedMessageOptions) {
			await admitInjected([message], options);
		},
		async sendMessages(messages: InjectedMessage[], options?: InjectedMessageOptions) {
			await admitInjected(messages, options);
		},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
		},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(name: string, handler: EventHandler) {
				const handlers = eventHandlers.get(name) ?? [];
				handlers.push(handler);
				eventHandlers.set(name, handlers);
				return () =>
					eventHandlers.set(
						name,
						(eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of eventHandlers.get(name) ?? []) void handler(payload);
				const completion = (payload as { completion?: Promise<void> }).completion;
				if (completion === undefined) return;
				eventCompletions.set(name, completion);
				for (const waiter of eventCompletionWaiters.get(name) ?? []) waiter.resolve(completion);
				eventCompletionWaiters.delete(name);
			},
		},
	};
	const fire = async (name: string, event: Record<string, object | string>): Promise<void> => {
		for (const handler of lifecycleHandlers.get(name) ?? []) await handler(event, context);
	};
	return {
		context,
		pi,
		injectedMessages,
		injectedOptions,
		tools,
		fire,
		waitForInjectedCount(count: number): Promise<void> {
			if (injectedMessages.length >= count) return Promise.resolve();
			return new Promise((resolveWaiter) => injectedWaiters.push({ count, resolve: resolveWaiter }));
		},
		async waitForEventCompletion(name: string): Promise<void> {
			const existing = eventCompletions.get(name);
			if (existing !== undefined) return await existing;
			const completion = await new Promise<Promise<void>>((resolveCompletion, reject) => {
				const waiters = eventCompletionWaiters.get(name) ?? [];
				const waiter = { resolve: resolveCompletion, reject };
				waiters.push(waiter);
				eventCompletionWaiters.set(name, waiters);
				setTimeout(() => {
					const active = eventCompletionWaiters.get(name) ?? [];
					if (!active.includes(waiter)) return;
					eventCompletionWaiters.set(
						name,
						active.filter((candidate) => candidate !== waiter),
					);
					reject(new Error(`Timed out waiting for event completion ${name}`));
				}, STORE_EVENT_TIMEOUT_MS);
			});
			await completion;
		},
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

async function waitForBroker(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const finish = (error?: Error): void => {
			clearTimeout(timer);
			child.stdout?.off("data", onStdout);
			child.off("exit", onExit);
			if (error === undefined) resolveReady();
			else rejectReady(error);
		};
		const onStdout = (chunk: Buffer | string): void => {
			stdout += chunk.toString();
			if (stdout.includes("Intercom broker started")) finish();
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			finish(new Error(`Intercom broker exited before readiness (code=${String(code)}, signal=${String(signal)})`));
		};
		const timer = setTimeout(
			() => finish(new Error(`Intercom broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`)),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", onStdout);
		child.once("exit", onExit);
	});
}

async function executeIntercom(
	fixture: ReturnType<typeof extensionFixture>,
	params: { action: string; group?: string; message?: string; to?: string },
	signal?: AbortSignal,
): Promise<ToolResult> {
	const execute = fixture.tools.get("intercom")?.execute;
	assert.ok(execute);
	return execute("test-call", params, signal, undefined, fixture.context);
}

function waitForStoreState(activeStore: ReturnType<typeof createStore>, predicate: () => boolean): Promise<void> {
	if (predicate()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let unsubscribe = (): void => {};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("Timed out waiting for store state"));
		}, STORE_EVENT_TIMEOUT_MS);
		unsubscribe = activeStore.subscribeInvalidation(() => {
			if (!predicate()) return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

interface BrokerFrameWaiter {
	readonly type?: BrokerMessage["type"];
	readonly matches: (message: BrokerMessage) => boolean;
	readonly resolve: (message: BrokerMessage) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

class RawBrokerClient {
	readonly socket = net.createConnection(getBrokerSocketPath());
	readonly received: BrokerMessage[] = [];
	private readonly consumed = new Set<number>();
	private readonly waiters = new Set<BrokerFrameWaiter>();

	constructor() {
		this.socket.on(
			"data",
			createMessageReader(
				(message) => {
					this.received.push(message as BrokerMessage);
					this.resolveWaiters();
				},
				(error) => this.socket.destroy(error),
			),
		);
		this.socket.on("error", (error) => this.rejectWaiters(error));
		this.socket.on("close", () => this.rejectWaiters(new Error("Broker client closed")));
	}

	async register(name: string, group: string): Promise<void> {
		if (this.socket.connecting) await new Promise<void>((resolve) => this.socket.once("connect", resolve));
		writeMessage(this.socket, {
			type: "register",
			session: { name, group, cwd: repoRoot, model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
		});
		await this.next("registered");
	}

	send(message: unknown): void {
		writeMessage(this.socket, message as never);
	}

	async next<T extends BrokerMessage["type"]>(
		type: T,
		matches: (message: Extract<BrokerMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<BrokerMessage, { type: T }>> {
		const buffered = this.consume(type, (message) => matches(message as Extract<BrokerMessage, { type: T }>));
		if (buffered !== undefined) return buffered as Extract<BrokerMessage, { type: T }>;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for broker frame ${type}`));
			}, BROKER_FRAME_TIMEOUT_MS);
			const waiter: BrokerFrameWaiter = {
				type,
				matches: (message) => matches(message as Extract<BrokerMessage, { type: T }>),
				resolve: (message) => resolve(message as Extract<BrokerMessage, { type: T }>),
				reject,
				timer,
			};
			this.waiters.add(waiter);
			this.resolveWaiters();
		});
	}

	async nextDeliveryAcknowledgment(
		messageId: string,
	): Promise<Extract<BrokerMessage, { type: "delivered" | "queued" | "delivery_failed" }>> {
		const matches = (message: BrokerMessage): boolean =>
			(message.type === "delivered" || message.type === "queued" || message.type === "delivery_failed") &&
			message.messageId === messageId;
		const buffered = this.consume(undefined, matches);
		if (buffered !== undefined) {
			return buffered as Extract<BrokerMessage, { type: "delivered" | "queued" | "delivery_failed" }>;
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`Timed out waiting for broker delivery acknowledgment ${messageId}`));
			}, BROKER_FRAME_TIMEOUT_MS);
			const waiter: BrokerFrameWaiter = {
				matches,
				resolve: (message) =>
					resolve(message as Extract<BrokerMessage, { type: "delivered" | "queued" | "delivery_failed" }>),
				reject,
				timer,
			};
			this.waiters.add(waiter);
			this.resolveWaiters();
		});
	}

	async close(): Promise<void> {
		if (this.socket.destroyed) return;
		await new Promise<void>((resolve) => {
			this.socket.once("close", resolve);
			this.socket.destroy();
		});
	}

	private consume(
		type: BrokerMessage["type"] | undefined,
		matches: (message: BrokerMessage) => boolean,
	): BrokerMessage | undefined {
		const index = this.received.findIndex(
			(message, candidate) =>
				!this.consumed.has(candidate) && (type === undefined || message.type === type) && matches(message),
		);
		if (index < 0) return undefined;
		this.consumed.add(index);
		return this.received[index];
	}

	private resolveWaiters(): void {
		for (const waiter of this.waiters) {
			const message = this.consume(waiter.type, waiter.matches);
			if (message === undefined) continue;
			this.waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(message);
		}
	}

	private rejectWaiters(error: Error): void {
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.waiters.clear();
	}
}

const rawClients = new Set<RawBrokerClient>();
let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	assert.equal(broker, undefined, "broker fixture must be stopped before restart");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitForBroker(broker);
}

async function stopBroker(): Promise<void> {
	const activeBroker = broker;
	if (activeBroker === undefined) return;
	broker = undefined;
	if (activeBroker.exitCode !== null) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Broker did not exit within ${BROKER_SHUTDOWN_TIMEOUT_MS}ms after SIGTERM`)),
			BROKER_SHUTDOWN_TIMEOUT_MS,
		);
		activeBroker.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		if (!activeBroker.kill("SIGTERM")) {
			clearTimeout(timer);
			reject(new Error("Broker rejected SIGTERM"));
		}
	});
}

beforeAll(startBroker);

afterAll(async () => {
	await Promise.all([...rawClients].map((client) => client.close()));
	await stopBroker();
	setDurableBackend(undefined);
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("public Intercom list reports closed workflow generations instead of idle reply capability", async () => {
	for (const hasRouter of [false, true]) {
		const boundary = new StageAdmissionBoundary();
		const target = extensionFixture(`closed-stage-${hasRouter}`, `closed-stage-${hasRouter}`, undefined, GROUP, {
			kind: "workflow-stage",
			workflowRunId: RUN_ID,
			workflowStageId: `closed-${hasRouter}`,
			workflowStageName: "retained reviewer",
			intercomGroup: GROUP,
			messageAdmission: { boundary, extensionState: new Map(), isOpen: () => boundary.isOpen() },
			...(hasRouter ? { lateMessageRouter: { routeMessage() {}, routeMessages() {} } } : {}),
		});
		const observer = vi.spyOn(IntercomClient.prototype, "updatePresence");
		intercomHeavy(target.pi as never);
		try {
			await target.start();
			const live = await executeIntercom(target, { action: "list" });
			assert.equal(live.isError, false);
			assert.match(live.content[0]?.text ?? "", /idle/);
			observer.mockClear();
			await boundary.close();
			const expected = hasRouter ? "closed · reply: post-mortem only" : "closed · reply: unavailable";
			assert.ok(
				observer.mock.calls.some(([updates]) => updates.status === expected),
				"close must publish presence without another model turn or tool call",
			);
			const closed = await executeIntercom(target, { action: "list" });
			assert.equal(closed.isError, false);
			assert.ok(closed.content[0]?.text.includes(expected), closed.content[0]?.text);
			if (!hasRouter) {
				const sender = extensionFixture("closed-stage-observer", "closed-stage-observer", undefined, GROUP);
				intercomHeavy(sender.pi as never);
				try {
					await sender.start();
					const reply = await executeIntercom(
						sender,
						{
							action: "ask",
							to: "closed-stage-false",
							message: "can you reply?",
						},
						AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
					);
					assert.equal(reply.isError, true);
					assert.match(reply.content[0]?.text ?? "", /closed and cannot reply.*post-mortem.*Contact a live stage/);
					assert.equal(target.injectedMessages.length, 0, "unavailable generation must not start a turn");
				} finally {
					await sender.shutdown();
				}
			}
		} finally {
			await target.shutdown();
			observer.mockRestore();
		}
	}
});

test("the real two-session route owner is hidden and rejects ordinary messages while its agent stays reachable", async () => {
	const runId = "88888888-1111-4111-8111-111111111111";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("recipient-owner", "recipient-owner", undefined, "default");
	const sender = extensionFixture("recipient-sender", "recipient-sender", undefined, group);
	const raw = new RawBrokerClient();
	rawClients.add(raw);
	const registrations: Array<{ id: string; name?: string; status?: string }> = [];
	// Observe real production registrations without replacing the broker transport.
	const connect = IntercomClient.prototype.connect;
	const observer = vi.spyOn(IntercomClient.prototype, "connect").mockImplementation(async function (
		this: InstanceType<typeof IntercomClient>,
		...args
	) {
		await connect.apply(this, args);
		registrations.push({ id: this.sessionId!, name: args[0].name, status: args[0].status });
	});
	intercom(owner.pi as never);
	intercom(sender.pi as never);
	let disposeBridge = (): void => {};
	try {
		await owner.start();
		await executeIntercom(owner, { action: "status" });
		await owner.fire("agent_start", {});
		// The dedicated route connection copies its owner's lifecycle status.
		await owner.fire("tool_execution_start", { type: "tool_execution_start", toolName: "workflow" });
		store.recordRunStart({
			id: runId,
			name: "recipient-flow",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
		});
		backend.registerWorkflow({
			workflowId: runId,
			name: "recipient-flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.start();
		await raw.register("recipient-observer", group);
		const route = registrations.find((entry) => entry.name === undefined);
		assert.ok(route, "actual ensurePendingStageRouteClient created a dedicated unnamed connection");
		assert.equal(route.status, "tool:workflow");
		raw.send({ type: "list", requestId: "recipient-directory" });
		const directory = await raw.next("sessions");
		const outcomes: string[] = [];
		for (const expectsReply of [false, true]) {
			const id = `recipient-control-${expectsReply}`;
			raw.send({
				type: "send",
				to: route.id,
				message: { id, timestamp: 1, expectsReply, content: { text: "do not deliver" } },
			});
			outcomes.push((await raw.nextDeliveryAcknowledgment(id)).type);
		}
		assert.deepEqual(
			{ visible: directory.sessions.some((session) => session.id === route.id), outcomes },
			{ visible: false, outcomes: ["delivery_failed", "delivery_failed"] },
			"internal route owner must be hidden and refuse both send and ask",
		);
		assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
		// More refusals than the default ask capacity prove these leave no lasting waiter.
		for (let index = 0; index < 8; index++) {
			const refused = await executeIntercom(
				sender,
				{ action: "ask", to: route.id, message: "not an agent" },
				AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
			);
			assert.equal(refused.isError, true);
			assert.match(refused.content[0]!.text, /Session not found|non-agent/);
		}
		await executeIntercom(sender, { action: "join", group: "default" });
		const listed = await executeIntercom(sender, { action: "list" });
		assert.match(listed.content[0]!.text, /recipient-owner/);
		assert.match(listed.content[0]!.text, /tool:workflow/);
		const sent = await executeIntercom(sender, { action: "send", to: "recipient-owner", message: "  live agent\n" });
		assert.equal(sent.details.delivered, true);
		await owner.waitForInjectedCount(1);
		const ask = executeIntercom(
			sender,
			{ action: "ask", to: "recipient-owner", message: "live question" },
			AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
		);
		await owner.waitForInjectedCount(2);
		assert.equal((await executeIntercom(owner, { action: "reply", message: "live answer" })).details.delivered, true);
		assert.match((await ask).content[0]!.text, /live answer/);
		const queued = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${runId}/reviewer`,
			message: "pending route still works",
		});
		assert.equal(queued.details.queued, true);
	} finally {
		disposeBridge();
		observer.mockRestore();
		await sender.shutdown();
		await owner.shutdown();
		await raw.close();
		setDurableBackend(undefined);
	}
});

test("control purpose survives presence and membership changes without discovery events or counts", async () => {
	const group = "recipient-purpose-group";
	const observer = new RawBrokerClient();
	const control = new RawBrokerClient();
	rawClients.add(observer);
	rawClients.add(control);
	try {
		await observer.register("purpose-observer", group);
		control.send({
			type: "register",
			session: {
				recipientPurpose: "control",
				name: "control-name",
				group,
				cwd: repoRoot,
				model: "test",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
			},
		});
		const controlId = (await control.next("registered")).sessionId;
		control.send({
			type: "presence",
			recipientPurpose: "agent",
			name: "renamed-control",
			status: "idle",
			requestId: "control-presence",
		});
		await control.next("presence_ack");
		control.send({ type: "join_group", group: "control-only", requestId: "control-join" });
		await control.next("membership_ack");
		observer.send({ type: "list_groups", requestId: "purpose-groups" });
		const groups = await observer.next("groups");
		assert.deepEqual(
			groups.groups.filter((entry) => entry.group === group || entry.group === "control-only"),
			[{ group, sessionCount: 1, member: true }],
		);
		for (const to of [controlId, "RENAMED-CONTROL"]) {
			for (const expectsReply of [false, true]) {
				const id = `control-${to}-${expectsReply}`;
				observer.send({
					type: "send",
					to,
					message: { id, timestamp: 1, expectsReply, content: { text: "no delivery" } },
				});
				assert.equal((await observer.nextDeliveryAcknowledgment(id)).type, "delivery_failed");
			}
		}
		control.send({ type: "list", requestId: "control-barrier" });
		await control.next("sessions");
		assert.equal(
			control.received.some((frame) => frame.type === "message"),
			false,
		);
		await control.close();
		observer.send({ type: "list", requestId: "observer-barrier" });
		await observer.next("sessions");
		assert.deepEqual(
			observer.received.filter((frame) =>
				frame.type === "session_joined" || frame.type === "presence_update"
					? frame.session.id === controlId
					: frame.type === "session_left"
						? frame.sessionId === controlId
						: frame.type === "peer_disconnected",
			),
			[],
		);
	} finally {
		await control.close();
		await observer.close();
	}
});

test("control connections cannot acquire live workflow recipient aliases", async () => {
	const runId = "88888888-2222-4222-8222-222222222222";
	const group = `workflow:${runId}`;
	const control = new IntercomClient();
	control.on("error", () => {});
	try {
		await control.connect({
			recipientPurpose: "control",
			group,
			cwd: repoRoot,
			model: "test",
			pid: 1,
			startedAt: 1,
			lastActivity: 1,
		});
		control.registerPendingStageRoute(runId, group, "control-alias-capability");
		await control.listDirectory();
		// The broker refuses the unauthorized alias claim and ends the connection; the
		// pipelined request settles with that refusal, which is never a recoverable
		// transport disconnect, so callers see an actionable authorization failure.
		await assert.rejects(
			control.registerLiveWorkflowStageRoute(runId, ["tool-id", "tool-name"], "control-alias-capability"),
			(error: unknown) => error instanceof Error && !isRecoverableIntercomDisconnect(error),
		);
		assert.equal(control.isConnected(), false);
	} finally {
		await control.disconnect();
	}
});

test("a legacy route-ineligible roster row does not prevent a genuine agent from becoming live", async () => {
	// R2: routeEligible controls pending discovery, not the recipient's identity.
	const runId = "88888888-5555-4555-8555-555555555555";
	const group = `workflow:${runId}`;
	const owner = new IntercomClient();
	const agent = new IntercomClient();
	const nonAgentRoute = new IntercomClient();
	const registration = { group, cwd: repoRoot, model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
	const received: string[] = [];
	agent.on("message", (_from, message) => received.push(message.content.text));
	owner.on("pending_stage_message", (request) => {
		owner.respondPendingStageMessage(request.requestId, { outcome: "forward", target: request.target });
	});
	try {
		await owner.connect({ ...registration, name: "legacy-roster-owner" });
		await agent.connect({
			...registration,
			name: "legacy-roster-agent",
			recipientPurpose: "agent",
			status: "tool:workflow",
		});
		owner.registerPendingStageRoute(runId, group, "legacy-roster-capability", [
			{
				stageId: "stage-id",
				stageName: "stage-name",
				target: `${group}/stage-id`,
				lifecycle: "pending",
				routeEligible: false,
				group,
			},
			{
				stageId: "tool-id",
				stageName: "tool-name",
				target: `${group}/tool-id`,
				lifecycle: "pending",
				routeEligible: true,
				recipientPurpose: "control",
				group,
			},
		]);
		assert.deepEqual((await owner.listDirectory()).workflowStages, []);
		await agent.registerLiveWorkflowStageRoute(runId, ["stage-id", "stage-name"], "legacy-roster-capability");
		for (const key of ["stage-id", "stage-name"]) {
			const sent = await owner.send(`${group}/${key}`, { text: key });
			assert.equal(sent.delivered, true, sent.reason);
		}
		await agent.listDirectory();
		assert.deepEqual(received, ["stage-id", "stage-name"]);
		assert.equal(
			(await owner.listSessions()).some((row) => row.id === agent.sessionId),
			true,
		);
		await nonAgentRoute.connect({ ...registration, name: "not-a-tool-agent", recipientPurpose: "agent" });
		await assert.rejects(
			nonAgentRoute.registerLiveWorkflowStageRoute(runId, ["tool-id"], "legacy-roster-capability"),
			(error: unknown) => error instanceof Error && !isRecoverableIntercomDisconnect(error),
		);
		assert.equal(nonAgentRoute.isConnected(), false);
	} finally {
		await nonAgentRoute.disconnect();
		await agent.disconnect();
		await owner.disconnect();
	}
});

test("ctx.ui run prompts and synthetic prompt stages are hidden and broker-refused across nested and retained states", async () => {
	const rootId = "65555555-1111-4111-8111-111111111111";
	const childId = "65555555-2222-4222-8222-222222222222";
	const group = `workflow:${rootId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("prompt-owner", "prompt-owner", undefined, "default");
	const sender = extensionFixture("prompt-sender", "prompt-sender", undefined, group);
	const raw = new RawBrokerClient();
	rawClients.add(raw);
	intercom(owner.pi as never);
	intercom(sender.pi as never);
	let disposeBridge = (): void => {};
	let ownerCalls = 0;
	const footprint = { id: "hil-stage-input", kind: "input" as const, message: "Value?", createdAt: 1 };
	// Executor prompt nodes retain the prompt replay identity even after persistence
	// drops transient prompt UI fields. Real stage prompts can also have footprints.
	const promptStage = {
		id: "synthetic-input-id",
		name: "input",
		replayKey: "prompt:input:descriptor:callsite",
		status: "running" as const,
		parentIds: [],
		toolEvents: [],
		promptFootprint: footprint,
		attachable: true,
	};
	const customStage = {
		...promptStage,
		id: "synthetic-custom-id",
		name: "custom",
		replayKey: "prompt:custom:descriptor:callsite",
		promptFootprint: { ...footprint, id: "hil-custom", kind: "custom" as const },
	};
	const restoredStage = {
		id: "restored-prompt-id",
		name: "editor",
		replayKey: "prompt:editor:descriptor:callsite",
		status: "completed" as const,
		parentIds: [],
		toolEvents: [],
		replayed: true,
	};
	const agentStage = {
		id: "real-agent-id",
		name: "review Ω",
		replayKey: "stage:review",
		status: "running" as const,
		parentIds: [],
		toolEvents: [],
		pendingStageDeliveryAvailable: true,
	};
	const prefixes = ["outer", "boundary-id", childId, `${rootId}/outer`, `${childId}/${rootId}/boundary-id`];
	const stageKeys = [
		promptStage.id,
		promptStage.name,
		footprint.id,
		customStage.id,
		customStage.name,
		"hil-custom",
		restoredStage.id,
		restoredStage.name,
	];
	const nestedTargets = prefixes.flatMap((prefix) => stageKeys.map((key) => `${group}/${prefix}/${key}`));
	try {
		await owner.start();
		await executeIntercom(owner, { action: "status" });
		const completions: Promise<void>[] = [];
		owner.pi.events.on("atomic:workflow-pending-stage-route", (payload) => {
			const completion = (payload as { completion?: Promise<void> }).completion;
			assert.ok(completion, "production extension must own registration");
			completions.push(completion);
		});
		owner.pi.events.on("atomic:workflow-pending-stage-message", () => {
			ownerCalls++;
		});
		store.recordRunStart({
			id: rootId,
			name: "prompt-root",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [
				{
					id: "boundary-id",
					name: "outer",
					replayKey: "boundary-id",
					status: "running",
					parentIds: [],
					toolEvents: [],
					workflowChildRun: { runId: childId, alias: "outer", workflow: "child" },
				},
			],
			possibleStages: [
				...nestedTargets.map((target) => target.slice(group.length + 1)),
				"confirm",
				"future-agent",
				"outer/*",
				"**",
			],
		});
		store.recordRunStart({
			id: childId,
			name: "prompt-child",
			rootRunId: rootId,
			parentRunId: rootId,
			parentStageId: "boundary-id",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [promptStage, customStage, restoredStage, agentStage],
		});
		backend.registerWorkflow({
			workflowId: rootId,
			name: "prompt-root",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		const { buildBackgroundUIAdapter } = await import(
			"../../packages/workflows/src/extension/background-ui-adapter.js"
		);
		const answer = buildBackgroundUIAdapter(store, rootId).confirm("Proceed?");
		const runPrompt = store.runs().find((run) => run.id === rootId)?.pendingPrompt;
		assert.ok(runPrompt);
		assert.equal(store.recordStagePendingPrompt(childId, promptStage.id, footprint), true);
		assert.equal(store.recordStageAwaitingInput(childId, customStage.id, true), true);
		assert.equal(
			store.recordStagePendingPrompt(childId, agentStage.id, { ...footprint, id: "real-agent-question" }),
			true,
		);
		disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
		await Promise.all(completions);
		await sender.start();
		await raw.register("prompt-observer", group);
		const runTargets = [`${group}/${runPrompt.id}`, `${group}/${runPrompt.kind}`];
		const allTargets = [...runTargets, ...nestedTargets];
		for (const phase of ["awaiting_input", "completed"]) {
			if (phase === "completed") {
				assert.equal(store.resolveStagePendingPrompt(childId, promptStage.id, footprint.id, "answer"), true);
				store.recordStageEnd(childId, { ...promptStage, status: "completed", endedAt: 2 });
				store.recordStageEnd(childId, { ...customStage, status: "completed", endedAt: 2 });
				await Promise.all(completions);
			}
			for (const to of allTargets) {
				for (const expectsReply of [false, true]) {
					const id = `${phase}-${to}-${expectsReply}`;
					raw.send({
						type: "send",
						to,
						message: { id, timestamp: 0, expectsReply, content: { text: "  do not queue\n" } },
					});
					const ack = await raw.nextDeliveryAcknowledgment(id);
					assert.equal(ack.type, "delivery_failed", `${phase}: ${to}`);
					if (ack.type === "delivery_failed") assert.match(ack.reason, /non-agent/);
					assert.equal(ownerCalls, 0, `no owner dispatch: ${to}`);
				}
			}
			raw.send({ type: "list", requestId: `prompt-directory-${phase}` });
			const directory = await raw.next("sessions");
			assert.deepEqual(
				directory.workflowFutureStages?.filter((row) => allTargets.includes(row.target)),
				[],
			);
			assert.equal(
				directory.workflowStages?.some((row) => stageKeys.includes(row.stageId)),
				false,
			);
			assert.equal(
				directory.workflowStages?.some((row) => row.stageId === agentStage.id),
				true,
			);
			assert.deepEqual(
				store.runs().flatMap((run) => run.pendingStageMessages ?? []),
				[],
			);
		}
		// More than the default waiter capacity: none can survive these refusals.
		for (let index = 0; index < 8; index++) {
			const refused = await executeIntercom(
				sender,
				{ action: "ask", to: allTargets[index], message: "no model here" },
				AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
			);
			assert.equal(refused.isError, true);
			assert.match(refused.content[0]!.text, /non-agent|Session not found/);
		}
		assert.equal(ownerCalls, 0);
		// The owner fallback must agree, including retained prompt IDs and aliases.
		for (const target of allTargets) {
			const event: {
				handled: boolean;
				from: { id: string; group: string };
				runId: string;
				target: string;
				message: { id: string; timestamp: number; content: { text: string } };
				completion?: Promise<{ outcome: string }>;
			} = {
				handled: false,
				from: { id: "prompt-fallback", group },
				runId: rootId,
				target,
				message: { id: `fallback-${target}`, timestamp: 0, content: { text: "no fallback" } },
			};
			owner.pi.events.emit("atomic:workflow-pending-stage-message", event);
			assert.equal(event.handled, true);
			assert.equal((await event.completion)?.outcome, "refused", target);
		}
		assert.deepEqual(
			store.runs().flatMap((run) => run.pendingStageMessages ?? []),
			[],
		);
		// Complete the genuine agent's human-input wait; its footprint remains,
		// but it still owns the same pending delivery capability and stage identity.
		assert.equal(store.resolveStagePendingPrompt(childId, agentStage.id, "real-agent-question", "continue"), true);
		await Promise.all(completions);
		for (const prefix of prefixes) {
			const queued = await executeIntercom(sender, {
				action: "send",
				to: `${group}/${prefix}/${agentStage.name}`,
				message: "  agent only\n",
			});
			assert.equal(queued.details.queued, true, queued.content[0]?.text);
		}
		const agentEntries = store.runs().find((run) => run.id === childId)?.pendingStageMessages;
		assert.equal(agentEntries?.length, prefixes.length);
		assert.equal(
			agentEntries?.every(
				(entry) => entry.stageKey === agentStage.id && entry.message.content.text === "  agent only\n",
			),
			true,
		);
		for (const key of ["future-agent", "outer/*", "**"]) {
			assert.equal(
				(await executeIntercom(sender, { action: "send", to: `${group}/${key}`, message: "future agent" })).details
					.queued,
				true,
			);
		}
		assert.equal(store.resolvePendingPrompt(rootId, runPrompt.id, true), true);
		assert.equal(await answer, true);
		await Promise.all(completions);
		assert.equal(store.runs().find((run) => run.id === rootId)?.pendingPrompt, undefined);
		// A real model session can be awaiting input even with no model display text.
		owner.context.model.id = "";
		await executeIntercom(sender, { action: "join", group: "default" });
		const ask = executeIntercom(
			sender,
			{ action: "ask", to: "prompt-owner", message: "real agent?" },
			AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
		);
		await owner.waitForInjectedCount(1);
		assert.equal((await executeIntercom(owner, { action: "reply", message: "real answer" })).details.delivered, true);
		assert.equal((await ask).isError, false);
	} finally {
		disposeBridge();
		await sender.shutdown();
		await owner.shutdown();
		await raw.close();
		setDurableBackend(undefined);
	}
});

// PR #2895 / Greptile 3945411533: TypeScript unions do not validate raw/version-skewed clients.
test.each(["agnt", "", null, 7, true, [], {}].map((recipientPurpose) => ({ recipientPurpose })))(
	"rejects invalid registration recipientPurpose $recipientPurpose on the wire",
	async ({ recipientPurpose }) => {
		const raw = new RawBrokerClient();
		rawClients.add(raw);
		try {
			const registered = raw.next("registered").then(
				() => true,
				(error: Error) => {
					if (!raw.socket.destroyed) throw error;
					return false;
				},
			);
			raw.send({
				type: "register",
				session: {
					name: "bad-purpose",
					group: GROUP,
					cwd: repoRoot,
					model: "test",
					pid: 1,
					startedAt: 0,
					lastActivity: 0,
					recipientPurpose,
				},
			});
			assert.equal(await registered, false, "malformed purpose must not be silently admitted as a control");
			assert.equal(raw.socket.destroyed, true);
		} finally {
			await raw.close();
		}
	},
);

test.each(["agnt", "", null, 7, true, [], {}].map((recipientPurpose) => ({ recipientPurpose })))(
	"rejects invalid roster recipientPurpose $recipientPurpose on the wire",
	async ({ recipientPurpose }) => {
		// PR #2895 / Greptile 3945411533: reject the entire malformed roster before installing it.
		const raw = new RawBrokerClient();
		rawClients.add(raw);
		try {
			await raw.register("bad-roster-owner", GROUP);
			raw.send({
				type: "register_pending_stage_route",
				runId: RUN_ID,
				group: GROUP,
				capability: "purpose-capability",
				stages: [
					{
						stageId: "bad-purpose",
						stageName: "bad-purpose",
						target: `${GROUP}/bad-purpose`,
						group: GROUP,
						lifecycle: "pending",
						routeEligible: true,
						recipientPurpose,
					},
				],
			});
			raw.send({ type: "list", requestId: "roster-fence" });
			const result = await Promise.race([raw.next("registration_failed"), raw.next("sessions")]);
			assert.equal(result.type, "registration_failed", "malformed purpose must not be accepted by a roster fence");
			if (result.type === "registration_failed") assert.equal(result.reason, "Invalid workflow-stage roster");
		} finally {
			await raw.close();
		}
	},
);

test.each([undefined, "agent", "control"] as const)(
	"accepts recipientPurpose %s and preserves legacy wire behavior",
	async (recipientPurpose) => {
		// PR #2895 / Greptile 3945411533: omission is an agent, and purpose is immutable after registration.
		const raw = new RawBrokerClient();
		rawClients.add(raw);
		const observer = new IntercomClient();
		try {
			raw.send({
				type: "register",
				session: {
					name: "purpose-peer",
					group: GROUP,
					cwd: repoRoot,
					model: "test",
					pid: 1,
					startedAt: 0,
					lastActivity: 0,
					...(recipientPurpose === undefined ? {} : { recipientPurpose }),
				},
			});
			const { sessionId } = await raw.next("registered");
			await observer.connect({
				name: "purpose-observer",
				group: GROUP,
				cwd: repoRoot,
				model: "test",
				pid: 1,
				startedAt: 0,
				lastActivity: 0,
			});
			raw.send({ type: "presence", recipientPurpose: recipientPurpose === "control" ? "agent" : "control" });
			raw.send({
				type: "register_pending_stage_route",
				runId: RUN_ID,
				group: GROUP,
				capability: "valid-purpose-capability",
				stages: [
					{
						stageId: "purpose-stage",
						stageName: "purpose-stage",
						target: `${GROUP}/purpose-stage`,
						group: GROUP,
						lifecycle: "pending",
						routeEligible: true,
						...(recipientPurpose === undefined ? {} : { recipientPurpose }),
					},
				],
			});
			raw.send({ type: "list", requestId: "valid-purpose-fence" });
			const directory = await raw.next("sessions", (frame) => frame.requestId === "valid-purpose-fence");
			const isAgent = recipientPurpose !== "control";
			assert.equal(
				directory.sessions.some((session) => session.id === sessionId),
				isAgent,
			);
			assert.equal(
				directory.workflowStages?.some((stage) => stage.stageId === "purpose-stage"),
				isAgent,
			);
			for (const expectsReply of [false, true]) {
				const sent = await observer.send(sessionId, { text: "purpose check", expectsReply });
				assert.equal(sent.delivered, isAgent);
				if (isAgent) {
					const received = await raw.next("message");
					assert.equal(received.message.expectsReply, expectsReply);
				} else assert.match(sent.reason ?? "", /non-agent/);
			}
		} finally {
			await raw.close();
			await observer.disconnect();
		}
	},
);

test("parent wire metadata validates every field and retains the last valid edge on omission or malformed replay", async () => {
	// PR #2895 / Greptile 3945411537: a concrete wire type must not admit malformed parent metadata.
	const childId = "66666666-4444-4444-8444-444444444444";
	const owner = new RawBrokerClient();
	const sender = new RawBrokerClient();
	rawClients.add(owner);
	rawClients.add(sender);
	try {
		await owner.register("parent-wire-owner", GROUP);
		await sender.register("parent-wire-sender", GROUP);
		owner.send({
			type: "register_pending_stage_route",
			runId: RUN_ID,
			group: GROUP,
			capability: "parent-wire-capability",
			stages: [],
		});
		const announce = async (parent: object | string | number | boolean | null | undefined) => {
			owner.send({
				type: "register_pending_stage_route",
				runId: childId,
				group: GROUP,
				capability: "child-wire-capability",
				stages: [
					{
						stageId: "tool-node",
						stageName: "tool-node",
						target: `${GROUP}/${childId}/tool-node`,
						group: GROUP,
						lifecycle: "pending",
						routeEligible: false,
						recipientPurpose: "control",
					},
				],
				...(parent === undefined ? {} : { parent }),
			});
			owner.send({ type: "list", requestId: "parent-fence" });
			await owner.next("sessions", (frame) => frame.requestId === "parent-fence");
		};
		let sequence = 0;
		const check = async (boundary: string, knownNonAgent: boolean) => {
			const id = `parent-wire-${++sequence}`;
			sender.send({
				type: "send",
				to: `${GROUP}/${boundary}/tool-node`,
				message: { id, timestamp: 0, content: { text: "check edge" } },
			});
			if (!knownNonAgent) {
				const pending = await owner.next("pending_stage_message", (frame) => frame.message.id === id);
				owner.send({
					type: "pending_stage_message_result",
					requestId: pending.requestId,
					outcome: "refused",
					reason: "unresolved parent edge",
				});
			}
			const response = await sender.nextDeliveryAcknowledgment(id);
			assert.equal(response.type, "delivery_failed");
			if (response.type === "delivery_failed")
				assert.match(response.reason, knownNonAgent ? /non-agent/ : /unresolved parent edge/);
		};
		await announce({ runId: RUN_ID, stageKeys: ["boundary", "boundary-id"] });
		await check("boundary-id", true);
		for (const malformed of [
			undefined,
			null,
			"bad",
			7,
			true,
			[],
			{},
			{ runId: 7, stageKeys: ["poison"] },
			{ runId: RUN_ID, stageKeys: "poison" },
			{ runId: RUN_ID, stageKeys: ["poison", 7] },
			{ runId: RUN_ID },
			{ stageKeys: ["poison"] },
		]) {
			await announce(malformed);
			await check("boundary", true);
			await check("poison", false);
		}
	} finally {
		await sender.close();
		await owner.close();
	}
});

// PR #2895 / Greptile 3945411528: a name collision is not evidence that every match is a nonagent.
test.each(["tool", "prompt"] as const)(
	"duplicate agents retain their routing policy beside a same-name %s",
	async (kind) => {
		const runId = "66666666-3333-4333-8333-333333333333";
		const group = `workflow:${runId}`;
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const owner = extensionFixture("ambiguity-owner", "ambiguity-owner", undefined, "default");
		const sender = extensionFixture("ambiguity-sender", "ambiguity-sender", undefined, group);
		const agents = [new IntercomClient(), new IntercomClient()];
		intercom(owner.pi as never);
		intercom(sender.pi as never);
		const stages = ["agent-one", "agent-two"].map((id) => ({
			id,
			name: "shared",
			status: "running" as const,
			sessionId: `sdk-${id}`,
			parentIds: [],
			toolEvents: [],
			pendingStageDeliveryAvailable: true,
		}));
		store.recordRunStart({
			id: runId,
			name: "ambiguity",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [
				...stages,
				...(kind === "prompt"
					? [
							{
								id: "prompt-shared",
								name: "shared",
								replayKey: "prompt:shared:callsite",
								status: "completed" as const,
								parentIds: [],
								toolEvents: [],
							},
						]
					: []),
			],
			...(kind === "tool"
				? {
						toolNodes: [
							{
								kind: "tool" as const,
								id: "tool-shared",
								name: "shared",
								argsHash: "hash",
								ordinal: 0,
								parentIds: [],
								status: "completed" as const,
								attachable: false as const,
							},
						],
					}
				: {}),
		});
		backend.registerWorkflow({ workflowId: runId, name: "ambiguity", inputs: {}, status: "running", createdAt: 1 });
		let dispose = (): void => {};
		try {
			await owner.start();
			await sender.start();
			dispose = registerPendingStageIntercomBridge(owner.pi as never, store);
			await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
			const messages: string[] = [];
			for (const [index, agent] of agents.entries()) {
				const stage = stages[index]!;
				agent.on("message", (_from, message) => messages.push(message.content.text));
				await agent.connect({
					name: stage.id,
					group,
					cwd: repoRoot,
					model: "test",
					pid: 1,
					startedAt: 0,
					lastActivity: 0,
				});
				await agent.registerLiveWorkflowStageRoute(
					runId,
					[stage.id],
					createWorkflowPendingStageDelivery(store, runId, stage.id, stage.name).routeCapability,
				);
			}
			const ask = await executeIntercom(sender, { action: "ask", to: `${group}/shared`, message: "which agent?" });
			assert.equal(ask.isError, true);
			assert.match(ask.content[0]!.text, /ambiguous.*multiple live workflow stages/);
			assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
			// Ordinary name sends retain the existing sticky fan-out policy; asks must not guess.
			const sent = await executeIntercom(sender, { action: "send", to: `${group}/shared`, message: "both agents" });
			assert.equal(sent.isError, false, sent.content[0]?.text);
			assert.equal(sent.details.queued, true);
			for (const agent of agents) await agent.listDirectory();
			assert.deepEqual(messages, ["both agents", "both agents"]);
		} finally {
			dispose();
			for (const agent of agents) await agent.disconnect();
			await sender.shutdown();
			await owner.shutdown();
			setDurableBackend(undefined);
		}
	},
);

test("live agent aliases survive same-name tools when pending capability disappears or the agent completes", async () => {
	const runId = "66666666-1111-4111-8111-111111111111";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("alias-transition-owner", "alias-transition-owner", undefined, group);
	const sender = extensionFixture("alias-transition-sender", "alias-transition-sender", undefined, group);
	const agent = new IntercomClient();
	const asker = new RawBrokerClient();
	rawClients.add(asker);
	const received: string[] = [];
	agent.on("message", (from, message) => {
		received.push(message.content.text);
		if (message.expectsReply)
			void agent.send(from.id, {
				text: "still an agent",
				replyTo: message.id,
				...(message.content.text === "failure" ? { replyError: "retained conversation unavailable" } : {}),
			});
	});
	intercom(owner.pi as never);
	intercom(sender.pi as never);
	let disposeBridge = (): void => {};
	const snapshot = (pendingStageDeliveryAvailable: boolean) => ({
		id: runId,
		name: "alias-transitions",
		inputs: {},
		status: "running" as const,
		startedAt: 1,
		stages: [
			{
				id: "agent-id",
				name: "same",
				status: "running" as const,
				sessionId: "sdk-agent",
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable,
			},
		],
		toolNodes: [
			{
				kind: "tool" as const,
				id: "tool:same",
				name: "same",
				argsHash: "hash",
				ordinal: 0,
				parentIds: [],
				status: "running" as const,
				attachable: false as const,
			},
		],
	});
	try {
		await owner.start();
		await executeIntercom(owner, { action: "status" });
		const completions: Promise<void>[] = [];
		owner.pi.events.on("atomic:workflow-pending-stage-route", (payload) => {
			const completion = (payload as { completion?: Promise<void> }).completion;
			assert.ok(completion);
			completions.push(completion);
		});
		store.recordRunStart(snapshot(true));
		backend.registerWorkflow({
			workflowId: runId,
			name: "alias-transitions",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
		await Promise.all(completions);
		await sender.start();
		await asker.register("alias-transition-asker", group);
		await agent.connect({
			name: "real-awaiting-agent",
			group,
			cwd: repoRoot,
			model: "",
			pid: 1,
			startedAt: 0,
			lastActivity: 0,
			status: "awaiting_input",
			recipientPurpose: "agent",
		});
		const { workflowPendingStageRouteCapability } = await import(
			"../../packages/workflows/src/shared/pending-stage-route-capability.js"
		);
		await agent.registerLiveWorkflowStageRoute(
			runId,
			["agent-id", "same"],
			workflowPendingStageRouteCapability(store, runId),
		);
		for (const phase of ["running", "no-pending-capability", "completed"]) {
			if (phase === "no-pending-capability") {
				// PR #2895: replace the fixture snapshot; recordRunStart is append-only.
				store.clear();
				store.recordRunStart(snapshot(false));
			}
			assert.equal(store.runs().length, 1);
			if (phase === "completed")
				store.recordStageEnd(runId, { ...snapshot(true).stages[0]!, status: "completed", endedAt: 2 });
			await Promise.all(completions);
			for (const key of ["agent-id", "same"]) {
				const sent = await executeIntercom(sender, {
					action: "send",
					to: `${group}/${key}`,
					message: ` ${phase}\n`,
				});
				assert.equal(sent.details.delivered, true, `${phase}/${key}: ${sent.content[0]?.text}`);
				const questionId = `${phase}-${key}`;
				asker.send({
					type: "send",
					to: `${group}/${key}`,
					message: {
						id: questionId,
						timestamp: 0,
						expectsReply: true,
						content: { text: "answer?" },
					},
				});
				assert.equal((await asker.nextDeliveryAcknowledgment(questionId)).type, "delivered", `${phase}/${key}`);
				const reply = await asker.next("message", (frame) => frame.message.replyTo === questionId);
				assert.equal(reply.from.id, agent.sessionId);
				assert.equal(reply.message.content.text, "still an agent");
				const publicReply = await executeIntercom(
					sender,
					{
						action: "ask",
						to: `${group}/${key}`,
						message: "public exact answer?",
					},
					AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
				);
				assert.equal(publicReply.isError, false, `${phase}/${key}: ${publicReply.content[0]?.text}`);
				assert.match(publicReply.content[0]?.text ?? "", /still an agent/);
				const failedReply = await executeIntercom(
					sender,
					{
						action: "ask",
						to: `${group}/${key}`,
						message: "failure",
					},
					AbortSignal.timeout(BROKER_FRAME_TIMEOUT_MS),
				);
				assert.equal(failedReply.isError, true);
				assert.equal(failedReply.content[0]?.text, "Failed: retained conversation unavailable");
			}
			const refused = await executeIntercom(sender, {
				action: "send",
				to: `${group}/tool:same`,
				message: "not the tool",
			});
			assert.equal(refused.isError, true);
		}
		await agent.listDirectory();
		assert.equal(received.length, 24);
		assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
	} finally {
		disposeBridge();
		await agent.disconnect();
		await asker.close();
		await sender.shutdown();
		await owner.shutdown();
		setDurableBackend(undefined);
	}
});

test.each([
	["tool", "completed"],
	["tool", "no-cap"],
	["prompt", "completed"],
	["prompt", "no-cap"],
] as const)(
	"a genuine agent reconnects beside a same-name %s after %s, including owner/broker replay",
	async (kind, transition) => {
		const runId = "66666666-2222-4222-8222-222222222222";
		const group = `workflow:${runId}`;
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const fixtures: ReturnType<typeof extensionFixture>[] = [];
		const makeOwner = () => {
			const owner = extensionFixture("reactivation-owner", "reactivation-owner", undefined, "default");
			fixtures.push(owner);
			intercom(owner.pi as never);
			return owner;
		};
		const makeAgent = () => {
			const pending = createWorkflowPendingStageDelivery(store, runId, "agent-id", "input");
			const agent = extensionFixture("reactivation-agent", "reactivation-agent", pending, group, {
				intercomGroup: group,
				kind: "workflow-stage",
				workflowRunId: runId,
				workflowStageId: "agent-id",
				workflowStageName: "input",
				pendingStageDelivery: pending,
			});
			fixtures.push(agent);
			intercom(agent.pi as never);
			return agent;
		};
		const snapshot = (changed: boolean) => ({
			id: runId,
			name: "reactivation",
			inputs: {},
			status: "running" as const,
			startedAt: 1,
			stages: [
				{
					id: "agent-id",
					name: "input",
					replayKey: "stage:input",
					status: changed && transition === "completed" ? ("completed" as const) : ("running" as const),
					sessionId: "sdk-agent",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: !(changed && transition === "no-cap"),
				},
				{
					id: "shared-group-agent",
					name: "model-less",
					status: "running" as const,
					intercomGroup: "default",
					pendingStageDeliveryAvailable: false,
					parentIds: [],
					toolEvents: [],
				},
				...(kind === "prompt"
					? ["input", "model-less"].map((name) => ({
							id: `prompt-${name}`,
							name,
							replayKey: `prompt:${name}:descriptor:callsite`,
							status: "completed" as const,
							parentIds: [],
							toolEvents: [],
						}))
					: []),
			],
			...(kind === "tool"
				? {
						toolNodes: ["input", "model-less"].map((name) => ({
							kind: "tool" as const,
							id: `tool-${name}`,
							name,
							argsHash: "hash",
							ordinal: 0,
							parentIds: [],
							status: "completed" as const,
							attachable: false as const,
						})),
					}
				: {}),
		});
		let owner = makeOwner();
		let observer = new IntercomClient();
		let asker = new RawBrokerClient();
		rawClients.add(asker);
		let disposeBridge = (): void => {};
		// PR #2895: force the Windows ordering where another socket's list overtakes
		// a one-way roster update. Only a request on the route socket is a wire fence.
		const pendingWrites = new Map<InstanceType<typeof IntercomClient>, Array<() => void>>();
		const registerRoute = IntercomClient.prototype.registerPendingStageRoute;
		const listDirectory = IntercomClient.prototype.listDirectory;
		let holdRouteUpdates = false;
		const routeSpy = vi.spyOn(IntercomClient.prototype, "registerPendingStageRoute").mockImplementation(function (
			this: InstanceType<typeof IntercomClient>,
			...args
		) {
			if (!holdRouteUpdates || args[0] !== runId) return registerRoute.apply(this, args);
			const writes = pendingWrites.get(this) ?? [];
			writes.push(() => registerRoute.apply(this, args));
			pendingWrites.set(this, writes);
		});
		const listSpy = vi.spyOn(IntercomClient.prototype, "listDirectory").mockImplementation(function (
			this: InstanceType<typeof IntercomClient>,
			...args
		) {
			const writes = pendingWrites.get(this) ?? [];
			pendingWrites.delete(this);
			for (const write of writes) write();
			return listDirectory.apply(this, args);
		});
		let negativeOwnerCalls = 0;
		const startOwner = async () => {
			await owner.start();
			assert.equal((await executeIntercom(owner, { action: "status" })).isError, false);
			owner.pi.events.on("atomic:workflow-pending-stage-message", (payload) => {
				const target = (payload as { target?: string }).target;
				if (target?.includes(`${kind}-`) || target?.endsWith("/model-less")) negativeOwnerCalls++;
			});
			disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
			await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
			await observer.connect({
				name: "reactivation-observer",
				group,
				cwd: repoRoot,
				model: "",
				pid: 1,
				startedAt: 0,
				lastActivity: 0,
			});
			await asker.register("reactivation-asker", group);
		};
		const assertEndpoints = async (agent: ReturnType<typeof makeAgent>, phase: string) => {
			const directory = await observer.listDirectory();
			assert.ok(directory.sessions.some((session) => session.name === "reactivation-agent"));
			assert.deepEqual(
				directory.workflowStages,
				[],
				"identity-only agents and model-less nodes stay out of the roster",
			);
			for (const key of [`${kind}-input`, `${kind}-model-less`, "model-less"]) {
				for (const expectsReply of [false, true]) {
					const result = await observer.send(`${group}/${key}`, { text: "not an agent", expectsReply });
					assert.equal(result.delivered, false, `${phase}/${key}`);
					assert.match(result.reason ?? "", /non-agent/);
				}
			}
			assert.equal(negativeOwnerCalls, 0);
			for (const key of ["agent-id", "input"]) {
				let count = agent.injectedMessages.length;
				assert.equal((await observer.send(`${group}/${key}`, { text: ` ${phase}/${key}\n` })).delivered, true);
				await agent.waitForInjectedCount(++count);
				const id = `${kind}-${transition}-${phase}-${key}`;
				asker.send({
					type: "send",
					to: `${group}/${key}`,
					message: { id, timestamp: 0, expectsReply: true, content: { text: "reply?" } },
				});
				assert.equal((await asker.nextDeliveryAcknowledgment(id)).type, "delivered");
				await agent.waitForInjectedCount(++count);
				assert.equal(
					(await executeIntercom(agent, { action: "reply", message: "still a genuine agent" })).details.delivered,
					true,
				);
				const reply = await asker.next("message", (frame) => frame.message.replyTo === id);
				assert.equal(reply.from.name, "reactivation-agent");
			}
			assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
		};
		try {
			store.recordRunStart(snapshot(false));
			backend.registerWorkflow({
				workflowId: runId,
				name: "reactivation",
				inputs: {},
				status: "running",
				createdAt: 1,
			});
			await startOwner();
			const first = makeAgent();
			await first.start();
			assert.equal((await observer.send(`${group}/input`, { text: "before transition" })).delivered, true);
			await first.waitForInjectedCount(1);
			holdRouteUpdates = true;
			if (transition === "completed")
				store.recordStageEnd(runId, { ...snapshot(true).stages[0]!, status: "completed", endedAt: 2 });
			else {
				// recordRunStart appends, it does not replace a retained run snapshot.
				store.clear();
				store.recordRunStart(snapshot(true));
			}
			assert.equal(store.runs().length, 1, "one authoritative snapshot must survive owner/broker replay");
			await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
			await assertEndpoints(first, "still-connected");
			await first.shutdown();
			await observer.listDirectory();
			const second = makeAgent();
			await second.start();
			assert.equal((await executeIntercom(second, { action: "status" })).isError, false);
			await assertEndpoints(second, "reconnected");
			// Fresh owner and broker must rebuild identity from the retained store, not stale aliases.
			await second.shutdown();
			disposeBridge();
			await owner.shutdown();
			await observer.disconnect();
			await asker.close();
			await stopBroker();
			await startBroker();
			owner = makeOwner();
			observer = new IntercomClient();
			asker = new RawBrokerClient();
			rawClients.add(asker);
			await startOwner();
			const replayed = makeAgent();
			await replayed.start();
			await assertEndpoints(replayed, "replayed");
		} finally {
			disposeBridge();
			routeSpy.mockRestore();
			listSpy.mockRestore();
			pendingWrites.clear();
			for (const fixture of fixtures.toReversed()) await fixture.shutdown();
			await observer.disconnect();
			await asker.close();
			setDurableBackend(undefined);
			if (broker === undefined) await startBroker();
		}
	},
);

test("nested known tools are broker-refused through every supported boundary and run-id spelling", async () => {
	// R1: negative recipients must use the same path grammar as genuine stages.
	const rootId = "77777777-1111-4111-8111-111111111111";
	const childId = "77777777-2222-4222-8222-222222222222";
	const grandId = "77777777-3333-4333-8333-333333333333";
	const group = `workflow:${rootId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("nested-purpose-owner", "nested-purpose-owner", undefined, "default");
	const sender = new RawBrokerClient();
	rawClients.add(sender);
	intercom(owner.pi as never);
	let disposeBridge = (): void => {};
	let pendingProtocolRequests = 0;
	const prefixes = [
		"outer/inner",
		"boundary-one/inner",
		"outer/boundary-two",
		"boundary-one/boundary-two",
		`${childId}/inner`,
		`outer/${grandId}`,
		`${childId}/${grandId}`,
		grandId,
		`${rootId}/boundary-one/${grandId}`,
		`${grandId}/${rootId}/outer/inner`,
	];
	const toolTargets = prefixes.flatMap((prefix) =>
		["tool:prepare", "prepare"].map((key) => `${group}/${prefix}/${key}`),
	);
	try {
		await owner.start();
		await executeIntercom(owner, { action: "status" });
		const routeCompletions: Promise<void>[] = [];
		owner.pi.events.on("atomic:workflow-pending-stage-route", (payload) => {
			const completion = (payload as { completion?: Promise<void> }).completion;
			assert.ok(completion, "real Intercom wrapper must own route registration");
			routeCompletions.push(completion);
		});
		owner.pi.events.on("atomic:workflow-pending-stage-message", () => {
			pendingProtocolRequests++;
		});
		const boundary = (id: string, name: string, runId: string) => ({
			id,
			name,
			status: "running" as const,
			parentIds: [],
			toolEvents: [],
			replayKey: id,
			workflowChildRun: { runId, alias: name, workflow: name },
		});
		store.recordRunStart({
			id: rootId,
			name: "root",
			inputs: {},
			status: "running",
			startedAt: 1,
			stages: [boundary("boundary-one", "outer", childId)],
			possibleStages: [
				...toolTargets.map((target) => target.slice(group.length + 1)),
				"future-agent",
				"outer/*",
				"**",
			],
		});
		store.recordRunStart({
			id: childId,
			name: "child",
			inputs: {},
			status: "running",
			startedAt: 1,
			parentRunId: rootId,
			parentStageId: "boundary-one",
			rootRunId: rootId,
			stages: [boundary("boundary-two", "inner", grandId)],
		});
		store.recordRunStart({
			id: grandId,
			name: "grand",
			inputs: {},
			status: "running",
			startedAt: 1,
			parentRunId: childId,
			parentStageId: "boundary-two",
			rootRunId: rootId,
			stages: [
				{
					id: "agent-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			toolNodes: [
				{
					kind: "tool",
					id: "tool:prepare",
					name: "prepare",
					argsHash: "hash",
					ordinal: 0,
					parentIds: [],
					status: "running",
					attachable: false,
				},
			],
		});
		backend.registerWorkflow({ workflowId: rootId, name: "root", inputs: {}, status: "running", createdAt: 1 });
		disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
		await Promise.all(routeCompletions);
		await sender.register("nested-purpose-sender", group);
		for (const to of toolTargets) {
			for (const expectsReply of [false, true]) {
				const id = `nested-tool-${to}-${expectsReply}`;
				sender.send({
					type: "send",
					to,
					message: { id, timestamp: 1, expectsReply, content: { text: "not a future agent" } },
				});
				assert.equal((await sender.nextDeliveryAcknowledgment(id)).type, "delivery_failed", to);
				assert.equal(pendingProtocolRequests, 0, `broker must refuse before owner dispatch: ${to}`);
			}
		}
		assert.deepEqual(
			store.runs().flatMap((run) => run.pendingStageMessages ?? []),
			[],
		);
		sender.send({ type: "list", requestId: "nested-tool-directory" });
		const directory = await sender.next("sessions");
		// Exercise the owner fallback too, independently of the broker's early refusal.
		for (const to of toolTargets) {
			const payload: {
				handled: boolean;
				from: { id: string; group: string };
				runId: string;
				target: string;
				message: { id: string; timestamp: number; content: { text: string } };
				completion?: Promise<{ outcome: string }>;
			} = {
				handled: false,
				from: { id: "bridge-probe", group },
				runId: rootId,
				target: to,
				message: { id: `fallback-${to}`, timestamp: 1, content: { text: "no tool fallback" } },
			};
			owner.pi.events.emit("atomic:workflow-pending-stage-message", payload);
			assert.equal(payload.handled, true);
			assert.equal((await payload.completion)?.outcome, "refused", to);
		}
		assert.deepEqual(
			store.runs().flatMap((run) => run.pendingStageMessages ?? []),
			[],
		);
		assert.equal(
			directory.workflowStages?.some((row) => row.stageId === "tool:prepare"),
			false,
		);
		assert.deepEqual(
			directory.workflowFutureStages?.filter((row) => toolTargets.includes(row.target)),
			[],
		);
		for (const prefix of prefixes) {
			const id = `nested-agent-${prefix}`;
			sender.send({
				type: "send",
				to: `${group}/${prefix}/reviewer`,
				message: { id, timestamp: 1, content: { text: "genuine pending agent" } },
			});
			assert.equal((await sender.nextDeliveryAcknowledgment(id)).type, "queued", prefix);
			const entry = store
				.runs()
				.find((run) => run.id === grandId)
				?.pendingStageMessages?.find((message) => message.message.id === id);
			assert.equal(
				entry?.stageKey,
				"agent-id",
				"accepted aliases must still resolve to the actual agent, not speculative futures",
			);
		}
		for (const suffix of ["future-agent", "outer/*", "**"]) {
			const id = `nested-future-${suffix}`;
			sender.send({
				type: "send",
				to: `${group}/${suffix}`,
				message: { id, timestamp: 1, content: { text: "future agents only" } },
			});
			assert.equal((await sender.nextDeliveryAcknowledgment(id)).type, "queued");
		}
	} finally {
		disposeBridge();
		await owner.shutdown();
		await sender.close();
		setDurableBackend(undefined);
	}
});

test("supervisor capabilities and notification reconnect aliases cannot bypass control recipient policy", async () => {
	const runId = "88888888-4444-4444-8444-444444444444";
	const group = `workflow:${runId}`;
	const owner = new IntercomClient();
	const control = new IntercomClient("control-return-address");
	const sender = new IntercomClient();
	const received: string[] = [];
	control.on("message", () => received.push("message"));
	control.on("pending_stage_notification", () => received.push("notification"));
	const registration = { group, cwd: repoRoot, model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
	try {
		await owner.connect({ ...registration, name: "notification-owner", recipientPurpose: "control" });
		await control.connect(
			{ ...registration, name: "notification-control", recipientPurpose: "control" },
			undefined,
			"control-owner-token",
		);
		const authorization = await control.authorizeSupervisorChild("authorized-agent");
		await sender.connect(
			{ ...registration, group: "other-group", name: "authorized-agent", recipientPurpose: "agent" },
			authorization,
		);
		for (const expectsReply of [false, true]) {
			const result = await sender.sendToSupervisor(control.sessionId!, { text: "cannot bypass", expectsReply });
			assert.equal(result.delivered, false);
			assert.match(result.reason!, /non-agent/);
		}
		owner.registerPendingStageRoute(runId, group, "notification-capability");
		await owner.listDirectory();
		for (const [to, name, returnAddress] of [
			[control.sessionId!, undefined, undefined],
			["departed-id", "notification-control", undefined],
			["departed-id", undefined, "control-return-address"],
		]) {
			const result = await owner.sendPendingStageNotification(
				runId,
				"notification-capability",
				to!,
				name,
				{ text: "no notification to controls" },
				returnAddress,
			);
			assert.equal(result.delivered, false);
		}
		await control.listDirectory();
		assert.deepEqual(received, []);
	} finally {
		await sender.disconnect();
		await control.disconnect();
		await owner.disconnect();
	}
});

test("materialized ctx.tool IDs and names never become speculative future-agent queues", async () => {
	const runId = "88888888-3333-4333-8333-333333333333";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("tool-node-owner", "tool-node-owner", undefined, "default");
	const sender = new RawBrokerClient();
	rawClients.add(sender);
	intercom(owner.pi as never);
	let disposeBridge = (): void => {};
	let pendingProtocolRequests = 0;
	owner.pi.events.on("atomic:workflow-pending-stage-message", () => {
		pendingProtocolRequests++;
	});
	try {
		await owner.start();
		store.recordRunStart({
			id: runId,
			name: "tool-node-flow",
			inputs: {},
			status: "running",
			startedAt: 1,
			possibleStages: ["prepare", "reviewer-*"],
			stages: [],
			toolNodes: [
				{
					kind: "tool",
					id: "tool:prepare",
					name: "prepare",
					argsHash: "hash",
					ordinal: 0,
					parentIds: [],
					status: "running",
					attachable: false,
				},
			],
		});
		backend.registerWorkflow({
			workflowId: runId,
			name: "tool-node-flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.register("tool-node-sender", group);
		for (const stageKey of ["tool:prepare", "prepare"]) {
			for (const expectsReply of [false, true]) {
				const id = `tool-node-${stageKey}-${expectsReply}`;
				sender.send({
					type: "send",
					to: `workflow:${runId}/${stageKey}`,
					message: { id, timestamp: 1, expectsReply, content: { text: "must not queue for a tool" } },
				});
				assert.equal((await sender.nextDeliveryAcknowledgment(id)).type, "delivery_failed");
			}
		}
		assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
		assert.equal(
			pendingProtocolRequests,
			0,
			"broker must reject known tool targets before invoking the durable route owner",
		);
		sender.send({ type: "list", requestId: "tool-node-directory" });
		const directory = await sender.next("sessions");
		assert.deepEqual(directory.workflowStages, []);
		assert.equal(
			directory.workflowFutureStages?.some((entry) => entry.target.endsWith("/prepare")),
			false,
		);
		sender.send({
			type: "send",
			to: `workflow:${runId}/future-agent`,
			message: { id: "tool-node-future", timestamp: 1, content: { text: "future agents still queue" } },
		});
		assert.equal((await sender.nextDeliveryAcknowledgment("tool-node-future")).type, "queued");
		for (const pattern of ["*", "**"]) {
			const id = `tool-node-pattern-${pattern}`;
			sender.send({
				type: "send",
				to: `workflow:${runId}/${pattern}`,
				message: { id, timestamp: 1, content: { text: "future agents only" } },
			});
			assert.equal((await sender.nextDeliveryAcknowledgment(id)).type, "queued");
			assert.deepEqual(
				store.runs()[0]?.pendingStageMessages?.find((entry) => entry.message.id === id)?.deliveries ?? [],
				[],
			);
		}
	} finally {
		disposeBridge();
		await owner.shutdown();
		await sender.close();
		setDurableBackend(undefined);
	}
});

test("the production owner route preserves pending delivery through tool restrictions", async () => {
	const scenarios = [
		{
			name: "no-tools",
			runId: "23bb9cf2-354e-475a-8c6f-a4c42306bb03",
			options: { noTools: "all" },
			acceptsPending: true,
		},
		{
			name: "read-only",
			runId: "d10852aa-3f68-46f8-baa7-f7bad2b50b9d",
			options: { tools: ["read"] },
			acceptsPending: true,
		},
		{
			name: "excluded-intercom",
			runId: "3a601bed-fafa-43a7-a68e-587df2c0174a",
			options: { excludedTools: ["intercom"] },
			acceptsPending: true,
		},
		{
			name: "explicit-isolated-group",
			runId: "dc107fa8-bf94-4cbc-8e56-7768db6ff10d",
			options: { tools: ["intercom"], group: "isolated-reviewers" },
			acceptsPending: true,
		},
		{
			name: "automatic-isolated-group",
			runId: "dc107fa9-bf94-4cbc-8e56-7768db6ff10d",
			options: { tools: ["intercom"], group: true },
			acceptsPending: true,
		},
		{
			name: "explicit-default-escape",
			runId: "f87f3f73-0f31-491b-a487-6955cc163dc4",
			options: { tools: ["intercom"], group: "default" },
			acceptsPending: false,
		},
		{
			name: "default-tools",
			runId: "0bbd30b6-cd4e-49b8-9172-1896dff2bcc1",
			options: undefined,
			acceptsPending: true,
		},
		{
			name: "explicit-intercom",
			runId: "41e61e3c-bc02-4d75-a641-d7563df34d46",
			options: { tools: ["intercom"] },
			acceptsPending: true,
		},
	] as const;

	for (const scenario of scenarios) {
		const group = `workflow:${scenario.runId}`;
		const store = createStore();
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: scenario.runId,
			name: scenario.name,
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		setDurableBackend(backend);
		const owner = extensionFixture(`${scenario.name}-owner`, `${scenario.name}-owner`, undefined, "default");
		intercomHeavy(owner.pi as never);
		const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
		const raw = new RawBrokerClient();
		rawClients.add(raw);
		const stageRegistered = Promise.withResolvers<void>();
		const releaseRun = Promise.withResolvers<void>();
		const definition = workflow({
			name: scenario.name,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				if (scenario.options === undefined) ctx.stage("reviewer");
				else ctx.stage("reviewer", scenario.options as never);
				stageRegistered.resolve();
				await releaseRun.promise;
				return ctx.exit({ status: "skipped", reason: "test complete" });
			},
		});
		let runPromise: ReturnType<typeof run> | undefined;
		try {
			await owner.start();
			runPromise = run(definition, {}, { runId: scenario.runId, store });
			await stageRegistered.promise;
			await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
			await raw.register(`${scenario.name}-sender`, group);
			const messageId = `${scenario.name}-message`;
			raw.send({
				type: "send",
				to: `workflow:${scenario.runId}/reviewer`,
				message: { id: messageId, timestamp: 1, content: { text: scenario.name } },
			});
			const acknowledgment = await raw.nextDeliveryAcknowledgment(messageId);
			if (scenario.acceptsPending) {
				assert.deepEqual(acknowledgment, {
					type: "queued",
					messageId,
					target: `workflow:${scenario.runId}/reviewer`,
					position: 1,
				});
				assert.equal(store.pendingStageMessagesFor(scenario.runId, "reviewer").length, 1);
				assert.equal(backend.getWorkflow(scenario.runId)?.pendingStageMessages?.length, 1);
			} else {
				assert.deepEqual(acknowledgment, {
					type: "delivery_failed",
					messageId,
					reason: `Workflow stage workflow:${scenario.runId}/reviewer cannot receive Intercom messages before startup`,
				});
				assert.deepEqual(store.runs()[0]?.pendingStageMessages ?? [], []);
				assert.deepEqual(backend.getWorkflow(scenario.runId)?.pendingStageMessages, []);
			}
		} finally {
			releaseRun.resolve();
			if (runPromise !== undefined) await runPromise;
			disposeBridge();
			await owner.shutdown();
			await raw.close();
			rawClients.delete(raw);
		}
	}
});

// Regression coverage for #2784.
test("an invocation controls pending and live delivery into an owned isolated stage", async () => {
	const runId = "7d8db053-d87c-49da-9487-9dc06c41aa74";
	const workflowGroup = `workflow:${runId}`;
	const isolatedGroup = `${workflowGroup}/isolated-reviewers`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: runId, name: "isolated-live", inputs: {}, status: "running", createdAt: 1 });
	setDurableBackend(backend);
	const owner = extensionFixture("isolated-owner-session", "isolated-owner", undefined, "default");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	const peer = extensionFixture("isolated-peer-session", "isolated-peer", undefined, isolatedGroup);
	intercomHeavy(peer.pi as never);
	const workflowSender = extensionFixture(
		"workflow-group-sender-session",
		"workflow-group-sender",
		undefined,
		"default",
	);
	intercomHeavy(workflowSender.pi as never);
	const stageRegistered = Promise.withResolvers<void>();
	const releaseStageInitialization = Promise.withResolvers<void>();
	const stageReadyForInvocationAsk = Promise.withResolvers<void>();
	const releaseStageAfterInvocationReply = Promise.withResolvers<void>();
	let stageFixture: ReturnType<typeof extensionFixture> | undefined;
	let stageContext: TestContext["orchestrationContext"] | undefined;
	const adapters = {
		agentSession: {
			async create(options: CreateAgentSessionOptions) {
				const rawContext = options.orchestrationContext;
				assert.equal(rawContext?.kind, "workflow-stage");
				const orchestrationContext = rawContext as TestContext["orchestrationContext"];
				stageContext = orchestrationContext;
				const fixture = extensionFixture(
					"isolated-stage-session",
					"isolated-stage",
					orchestrationContext.pendingStageDelivery,
					isolatedGroup,
					orchestrationContext,
				);
				stageFixture = fixture;
				intercomHeavy(fixture.pi as never);
				await fixture.start();
				let stopped = false;
				const shutdown = async (): Promise<void> => {
					if (stopped) return;
					stopped = true;
					await fixture.shutdown();
				};
				const session: StageSessionRuntime = {
					async prompt() {
						assert.match(
							fixture.injectedMessages[0]?.content ?? "",
							/queued invocation control/,
							"#2784: queued delivery must be present before the future stage's first model turn",
						);
						const stageList = await executeIntercom(fixture, { action: "list" });
						assert.equal(stageList.isError, false);
						assert.match(stageList.content[0]?.text ?? "", /^- `[^`]+` \[[^\n]+\].* name: isolated-peer$/m);
						assert.doesNotMatch(stageList.content[0]?.text ?? "", /isolated-owner/);
						const peerList = await executeIntercom(peer, { action: "list" });
						assert.match(peerList.content[0]?.text ?? "", /^- `[^`]+` \[[^\n]+\].* name: isolated-stage$/m);

						const sent = await executeIntercom(fixture, {
							action: "send",
							to: "isolated-peer",
							message: "ordinary isolated send",
						});
						assert.equal(sent.details.delivered, true);
						await peer.waitForInjectedCount(1);

						const asked = executeIntercom(fixture, {
							action: "ask",
							to: "isolated-peer",
							message: "ordinary isolated ask",
						});
						await peer.waitForInjectedCount(2);
						const reply = await executeIntercom(peer, { action: "reply", message: "isolated answer" });
						assert.equal(reply.details.delivered, true);
						assert.match((await asked).content[0]?.text ?? "", /isolated answer/);
						stageReadyForInvocationAsk.resolve();
						await releaseStageAfterInvocationReply.promise;
						return "isolated live intercom remained usable";
					},
					async steer() {},
					async followUp() {},
					subscribe: () => () => {},
					sessionFile: join(agentDir, "isolated-stage-session.jsonl"),
					sessionId: "isolated-stage-session",
					async setModel() {},
					setThinkingLevel() {},
					cycleModel: async () => undefined,
					cycleThinkingLevel: () => undefined,
					agent: { waitForIdle: async () => {} } as never,
					model: { provider: "test", id: "model" } as AgentSession["model"],
					thinkingLevel: "medium",
					messages: [],
					isStreaming: false,
					navigateTree: async () => ({ cancelled: false }),
					compact: async () => ({}) as never,
					abortCompaction() {},
					async abort() {},
					dispose: shutdown,
					getLastAssistantText: () => "isolated live intercom remained usable",
				};
				return { session };
			},
		},
	};
	const definition = workflow({
		name: "isolated-live",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const reviewer = ctx.stage("reviewer", {
				tools: ["intercom"],
				group: isolatedGroup,
				model: "test/model",
				settingsManager: {
					getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
				},
			} as never);
			stageRegistered.resolve();
			await releaseStageInitialization.promise;
			return { result: String(await reviewer.prompt("use ordinary isolated Intercom")) };
		},
	});
	let runPromise: ReturnType<typeof run> | undefined;
	try {
		await owner.start();
		await peer.start();
		await workflowSender.start();
		const joined = await executeIntercom(workflowSender, { action: "join", group: workflowGroup });
		assert.equal(joined.isError, false);
		assert.match(joined.content[0]?.text ?? "", new RegExp(workflowGroup));
		const peerStarted = await executeIntercom(peer, { action: "list" });
		assert.equal(peerStarted.details.group, isolatedGroup);
		runPromise = run(definition, {}, { runId, store, adapters });
		await stageRegistered.promise;
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		const queued = await executeIntercom(workflowSender, {
			action: "send",
			to: `workflow:${runId}/reviewer`,
			message: "queued invocation control",
		});
		assert.equal(queued.isError, false);
		assert.equal(queued.details.queued, true);
		assert.ok(queued.details.messageId);
		assert.equal(store.runs()[0]?.stages[0]?.intercomGroup, isolatedGroup);
		assert.equal(store.pendingStageMessagesFor(runId, "reviewer").length, 1);
		assert.equal(backend.getWorkflow(runId)?.pendingStageMessages?.length, 1);
		// PR #3018: list rows lead with the canonical target, not a trailing target label.
		const stageTarget = `workflow:${runId}/${store.runs()[0]?.stages[0]?.id}`;
		const pendingRow = `- \`${stageTarget}\` [PENDING] workflow stage: `;
		let rosterText = "";
		for (let attempt = 0; attempt < 20 && !rosterText.includes(pendingRow); attempt += 1) {
			const listed = await executeIntercom(workflowSender, { action: "list" });
			assert.equal(listed.isError, false);
			rosterText = listed.content[0]?.text ?? "";
			if (!rosterText.includes(pendingRow)) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(rosterText.includes(pendingRow), rosterText);

		releaseStageInitialization.resolve();
		await stageReadyForInvocationAsk.promise;
		const asked = executeIntercom(workflowSender, {
			action: "ask",
			to: stageTarget,
			message: "reply across invocation control",
		});
		assert.ok(stageFixture);
		await stageFixture.waitForInjectedCount(2);
		const invocationReply = await executeIntercom(stageFixture, {
			action: "reply",
			message: "correlated isolated-stage answer",
		});
		assert.equal(invocationReply.details.delivered, true);
		const correlatedReply = await asked;
		assert.equal(correlatedReply.isError, false);
		assert.match(correlatedReply.content[0]?.text ?? "", /correlated isolated-stage answer/);
		assert.equal(workflowSender.injectedMessages.length, 0, "the correlated answer must settle the ask waiter");
		releaseStageAfterInvocationReply.resolve();
		const result = await runPromise;
		assert.equal(result.status, "completed", JSON.stringify(result, undefined, 2));
		assert.equal(result.result?.result, "isolated live intercom remained usable");
		assert.equal(stageContext?.intercomGroup, isolatedGroup);
		assert.ok(stageContext?.pendingStageDelivery);
		assert.ok(stageFixture);
		assert.equal(peer.injectedMessages.length, 2);
	} finally {
		releaseStageInitialization.resolve();
		releaseStageAfterInvocationReply.resolve();
		if (runPromise !== undefined) await runPromise;
		if (stageFixture !== undefined) await stageFixture.shutdown();
		await workflowSender.shutdown();
		disposeBridge();
		await peer.shutdown();
		await owner.shutdown();
	}
});

test("one composite workflow-stage target transitions atomically from durable queueing to live delivery", async () => {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("owner-runtime-session", "workflow-owner", undefined, "default");
	const sender = extensionFixture("sender-runtime-session", "stage-a");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	intercom(sender.pi as never);
	let reviewer: ReturnType<typeof extensionFixture> | undefined;

	try {
		await owner.start();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
				{ id: "completed-id", name: "completed-stage", status: "completed", parentIds: [], toolEvents: [] },
				{
					id: "late-id",
					name: "late-stage",
					status: "running",
					sessionId: "former-live-session",
					parentIds: [],
					toolEvents: [],
				},
				{
					id: "closed-id",
					name: "closed-stage",
					status: "completed",
					sessionFile: "/tmp/closed-stage.jsonl",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: 1,
		});
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.start();

		// Slice 3 (D3/D4): an unresolved path target is accepted speculatively as a sticky
		// entry in the root run's durable bucket and acknowledged with notInKnownSet.
		const unknown = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${RUN_ID}/unknown-stage`,
			message: "This target does not exist.",
		});
		assert.match(unknown.content[0]?.text ?? "", /queued/i);
		assert.match(unknown.content[0]?.text ?? "", /not in the workflow's known stage set/);
		assert.equal(unknown.details.delivered, false);
		assert.equal(unknown.details.queued, true);
		assert.equal(unknown.details.notInKnownSet, true);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.sticky, true);
		assert.equal(store.runs()[0]?.pendingStageMessages?.[0]?.targetPath, `workflow:${RUN_ID}/unknown-stage`);

		// A future-stage target refuses the ask through the sticky flow; materialized
		// stages that cannot take pre-start delivery keep today's unknown failure.
		const futureAskFailure = await executeIntercom(sender, {
			action: "ask",
			to: `workflow:${RUN_ID}/unknown-stage`,
			message: "Lifecycle validation for unknown-stage",
		});
		assert.equal(futureAskFailure.details.refusal, "pending_stage_ask_unsupported");
		for (const stageKey of ["completed-stage", "late-stage", "closed-stage"]) {
			const ordinaryAskFailure = await executeIntercom(sender, {
				action: "ask",
				to: `workflow:${RUN_ID}/${stageKey}`,
				message: `Lifecycle validation for ${stageKey}`,
			});
			assert.match(ordinaryAskFailure.content[0]?.text ?? "", /Session not found/);
			assert.equal(ordinaryAskFailure.details.refusal, undefined);
		}

		const ask = await executeIntercom(sender, {
			action: "ask",
			to: TARGET,
			message: "Can you reply before starting?",
		});
		assert.match(ask.content[0]?.text ?? "", /Use send/);
		assert.equal(ask.details.refusal, "pending_stage_ask_unsupported");
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "reviewer"), []);

		const workflowSessions = await executeIntercom(sender, { action: "list" });
		assert.equal(
			workflowSessions.content.some(({ text }) => text.includes("workflow-owner")),
			false,
		);
		const ordinaryOwnerSend = await executeIntercom(sender, {
			action: "send",
			to: "workflow-owner",
			message: "Must not use the route-registration membership window.",
		});
		assert.match(ordinaryOwnerSend.content[0]?.text ?? "", /Session not found/);
		assert.equal(ordinaryOwnerSend.details.delivered, false);

		const result = await executeIntercom(sender, {
			action: "send",
			to: TARGET,
			message: "Scope changed: preserve raw amendments.",
		});
		assert.match(result.content[0]?.text ?? "", /queued/i);
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, {
			messageId: result.details.messageId,
			delivered: false,
			queued: true,
			target: TARGET,
			position: 1,
		});
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer").length, 1);
		assert.equal(store.pendingStageMessagesFor(RUN_ID, "reviewer")[0]?.id, result.details.messageId);

		const pendingStageDelivery = createWorkflowPendingStageDelivery(store, RUN_ID, "reviewer-id", "reviewer");
		let signalDrainEntered!: () => void;
		let releaseDrain!: () => void;
		const drainEntered = new Promise<void>((resolveEntered) => {
			signalDrainEntered = resolveEntered;
		});
		const drainRelease = new Promise<void>((resolveRelease) => {
			releaseDrain = resolveRelease;
		});
		const heldPendingStageDelivery: ReturnType<typeof createWorkflowPendingStageDelivery> = {
			routeCapability: pendingStageDelivery.routeCapability,
			async deliverPending(deliver) {
				signalDrainEntered();
				await drainRelease;
				await pendingStageDelivery.deliverPending(deliver);
			},
			ready: () => pendingStageDelivery.ready(),
			fail: (reason) => pendingStageDelivery.fail(reason),
		};
		let forwardedPendingStageDelivery: ReturnType<typeof createWorkflowPendingStageDelivery> | undefined;
		const stageAdapters = buildRuntimeAdapters(
			{},
			{
				createAgentSession: async (options) => {
					forwardedPendingStageDelivery = options?.orchestrationContext?.pendingStageDelivery;
					reviewer = extensionFixture("reviewer-runtime-session", "reviewer", heldPendingStageDelivery);
					intercom(reviewer.pi as never);
					return {
						session: {
							bindExtensions: () => reviewer?.start(),
						} as never,
					};
				},
			},
		);
		const reviewerStart = stageAdapters.agentSession?.create(
			{
				orchestrationContext: {
					kind: "workflow-stage",
					workflowRunId: RUN_ID,
					workflowStageId: "reviewer-id",
					workflowStageName: "reviewer",
					constraints: { disableWorkflowTool: true },
					intercomGroup: GROUP,
					pendingStageDelivery,
				},
			} as never,
			{
				runId: RUN_ID,
				stageId: "reviewer-id",
				stageName: "reviewer",
				executionMode: "non_interactive",
			},
		);
		assert.ok(reviewerStart);
		await drainEntered;

		const transition = await executeIntercom(sender, {
			action: "send",
			to: TARGET,
			message: "Transition message while pending delivery is draining.",
		});
		releaseDrain();
		await reviewerStart;
		assert.equal(forwardedPendingStageDelivery, pendingStageDelivery);
		assert.ok(reviewer);
		assert.equal(transition.isError, false);
		assert.equal(transition.details.delivered, true);
		assert.equal(transition.details.queued, undefined);

		assert.equal(reviewer.injectedMessages.length, 2);
		const pendingMessageIndex = reviewer.injectedMessages.findIndex(({ content }) =>
			content?.includes("Scope changed: preserve raw amendments."),
		);
		assert.notEqual(pendingMessageIndex, -1);
		assert.equal(reviewer.injectedOptions[pendingMessageIndex]?.triggerTurn, undefined);
		assert.equal(reviewer.injectedOptions[pendingMessageIndex]?.deliverAs, undefined);
		assert.equal(reviewer.injectedMessages[pendingMessageIndex]?.customType, "intercom_message");
		assert.match(reviewer.injectedMessages[pendingMessageIndex]?.content ?? "", /^\*\*📨 From stage-a\*\*/);
		assert.match(
			reviewer.injectedMessages[pendingMessageIndex]?.content ?? "",
			/Messages received before you started/,
		);
		assert.equal(
			reviewer.injectedMessages.filter(({ content }) => content?.includes("Scope changed: preserve raw amendments."))
				.length,
			1,
		);
		assert.equal(
			reviewer.injectedMessages.filter(({ content }) =>
				content?.includes("Transition message while pending delivery is draining."),
			).length,
			1,
		);
		assert.equal(reviewer.injectedMessages[pendingMessageIndex]?.details?.from?.name, "stage-a");
		assert.equal(Boolean(reviewer.injectedMessages[pendingMessageIndex]?.details?.from?.id), true);
		const sentAt = reviewer.injectedMessages[pendingMessageIndex]?.details?.message?.timestamp;
		assert.ok(typeof sentAt === "number");
		assert.equal(
			(reviewer.injectedMessages[pendingMessageIndex]?.content ?? "").includes(
				`Sent: ${new Date(sentAt).toISOString()}`,
			),
			true,
		);
		const durableEntries = store.runs()[0]?.pendingStageMessages ?? [];
		assert.equal(durableEntries.length, 2);
		assert.equal(durableEntries.find((entry) => entry.sticky === true)?.status, "queued");
		assert.equal(durableEntries.find((entry) => entry.stageId === "reviewer-id")?.status, "delivered");

		const live = await executeIntercom(sender, {
			action: "send",
			to: TARGET,
			message: "Live message after initialization.",
		});
		assert.equal(live.isError, false);
		assert.equal(live.details.delivered, true);
		assert.equal(live.details.queued, undefined);
		await reviewer.waitForInjectedCount(3);
		assert.equal(
			reviewer.injectedMessages.filter(({ content }) => content?.includes("Live message after initialization."))
				.length,
			1,
		);
		assert.equal(store.runs()[0]?.pendingStageMessages?.length, 2);

		// A second unresolved send for the same target joins the same sticky queue with
		// the next position; exact lookups stay empty (D3).
		const unknownAfterInitialization = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${RUN_ID}/unknown-stage`,
			message: "This target still does not exist.",
		});
		assert.equal(unknownAfterInitialization.isError, false);
		assert.equal(unknownAfterInitialization.details.queued, true);
		assert.equal(unknownAfterInitialization.details.position, 2);
		assert.equal(store.runs()[0]?.pendingStageMessages?.length, 3);
		assert.deepEqual(store.pendingStageMessagesFor(RUN_ID, "unknown-stage"), []);
	} finally {
		if (reviewer !== undefined) await reviewer.shutdown();
		disposeBridge();
		await sender.shutdown();
		await owner.shutdown();
	}
});

// Route republication used to fire on every store invalidation, so churn that leaves the
// route projection untouched still cost a broker round trip whose same-socket
// `listSessions()` barrier could expire on its own timer. A burst of route-neutral churn
// must leave durable queueing, stage startup, and live delivery externally unchanged, and
// must not produce a pending-stage-route relay failure.
// Regression for #2990.
test("route-neutral store churn preserves durable queueing and live delivery for a starting stage", async () => {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const idTarget = `${group}/reviewer-id`;
	const nameTarget = `${group}/reviewer`;
	const stageSessionId = "burst-reviewer-session";
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("burst-owner-session", "burst-owner", undefined, "default");
	const sender = extensionFixture("burst-sender-session", "burst-sender", undefined, group);
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	intercom(sender.pi as never);
	let stage: ReturnType<typeof extensionFixture> | undefined;
	const relayFailures: string[] = [];
	const forwardConsoleError = console.error.bind(console);
	// Forwarding spy: real failures still reach the reporter, they are only observed here.
	const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
		if (typeof args[0] === "string" && args[0].includes("atomic:workflow-pending-stage-route")) {
			relayFailures.push(args.map((value) => (value instanceof Error ? value.message : String(value))).join(" "));
		}
		forwardConsoleError(...args);
	});

	try {
		await owner.start();
		backend.registerWorkflow({ workflowId: runId, name: "burst", inputs: {}, status: "running", createdAt: 1 });
		store.recordRunStart({
			id: runId,
			name: "burst",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					// Started but not yet hosting a session: the projection advertises this
					// pre-start identity as `lifecycle: "pending"`.
					status: "running",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
		});
		// Attachment is not part of the route projection, so none of these invalidations
		// is a real routing change.
		for (let index = 0; index < 1000; index += 1) store.recordStageAttached(runId, "reviewer-id", index % 2 === 0);
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");

		await sender.start();
		const pendingList = await executeIntercom(sender, { action: "list" });
		assert.equal(pendingList.isError, false);
		assert.equal(
			(pendingList.content[0]?.text ?? "").includes(`- \`${idTarget}\` [PENDING] workflow stage: reviewer`),
			true,
			pendingList.content[0]?.text,
		);

		const queued = await executeIntercom(sender, { action: "send", to: nameTarget, message: "queued-before-start" });
		assert.equal(queued.isError, false);
		assert.equal(queued.details.queued, true);
		assert.equal(queued.details.delivered, false);
		assert.equal(store.pendingStageMessagesFor(runId, "reviewer").length, 1);
		assert.equal(store.pendingStageMessagesFor(runId, "reviewer")[0]?.id, queued.details.messageId);

		const pendingStageDelivery = createWorkflowPendingStageDelivery(store, runId, "reviewer-id", "reviewer");
		stage = extensionFixture(stageSessionId, "reviewer", pendingStageDelivery, group, {
			intercomGroup: group,
			kind: "workflow-stage",
			workflowRunId: runId,
			workflowStageId: "reviewer-id",
			workflowStageName: "reviewer",
			pendingStageDelivery,
		});
		intercom(stage.pi as never);
		await stage.start();
		store.recordStageSession(runId, "reviewer-id", { sessionId: stageSessionId });
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");

		await stage.waitForInjectedCount(1);
		assert.equal(stage.injectedMessages.filter(({ content }) => content?.includes("queued-before-start")).length, 1);
		const drained = store.runs().find((entry) => entry.id === runId)?.pendingStageMessages ?? [];
		assert.equal(drained.length, 1);
		assert.equal(drained[0]?.stageId, "reviewer-id");
		assert.equal(drained[0]?.status, "delivered");

		for (const [to, marker] of [
			[idTarget, "live-by-id"],
			[nameTarget, "live-by-name"],
		] as const) {
			const live = await executeIntercom(sender, { action: "send", to, message: marker });
			assert.equal(live.isError, false, live.content[0]?.text);
			assert.equal(live.details.delivered, true);
			assert.equal(live.details.queued, undefined);
		}
		await stage.waitForInjectedCount(3);
		for (const marker of ["live-by-id", "live-by-name"]) {
			assert.equal(stage.injectedMessages.filter(({ content }) => content?.includes(marker)).length, 1);
		}
		assert.equal(store.runs().find((entry) => entry.id === runId)?.stages[0]?.status, "running");
		assert.deepEqual(relayFailures, []);
	} finally {
		consoleError.mockRestore();
		if (stage !== undefined) await stage.shutdown();
		await sender.shutdown();
		await owner.shutdown();
		disposeBridge();
	}
});

test("a durable pending admission survives a real stage-session fallback attempt exactly once", async () => {
	const messageId = "2717-stage-attempt-restart-message";
	const admissionId = `intercom:${messageId}`;
	const replayKey = "stage:reviewer:1";
	const attemptSessionIds = ["2717-reviewer-attempt-1", "2717-reviewer-attempt-2"] as const;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({
		workflowId: RUN_ID,
		name: "attempt-restart",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	setDurableBackend(backend);
	const owner = extensionFixture("attempt-restart-owner", "attempt-restart-owner", undefined, "default");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	const sender = new RawBrokerClient();
	rawClients.add(sender);
	const releaseStageInitialization = Promise.withResolvers<void>();
	const stageRegistered = Promise.withResolvers<void>();
	const lifecycle: string[] = [];
	const attempts: Array<{
		readonly fixture: ReturnType<typeof extensionFixture>;
		readonly model: string;
		readonly orchestrationContext: TestContext["orchestrationContext"];
		readonly sessionId: string;
		readonly shutdown: () => Promise<void>;
	}> = [];
	const adapters = {
		agentSession: {
			async create(options: CreateAgentSessionOptions) {
				const rawContext = options.orchestrationContext;
				assert.equal(rawContext?.kind, "workflow-stage");
				const orchestrationContext = rawContext as TestContext["orchestrationContext"];
				const pendingStageDelivery = orchestrationContext.pendingStageDelivery;
				assert.ok(pendingStageDelivery, "stage attempt did not receive production pending delivery");
				if (orchestrationContext.messageAdmission === undefined) {
					const boundary = new StageAdmissionBoundary();
					orchestrationContext.messageAdmission = {
						boundary,
						extensionState: new Map(),
						isOpen: () => boundary.isOpen(),
					};
				}
				const modelValue = options.model;
				const model =
					typeof modelValue === "string"
						? modelValue
						: `${String(modelValue?.provider)}/${String(modelValue?.id)}`;
				const sessionId = attemptSessionIds[attempts.length];
				assert.ok(sessionId, `unexpected stage attempt ${attempts.length + 1}`);
				const fixture = extensionFixture(sessionId, "reviewer", pendingStageDelivery, GROUP, orchestrationContext);
				if (attempts.length === 0) {
					fixture.pi.sendMessage = async () => {
						throw new Error("503 service unavailable before external pending-stage admission");
					};
				}
				intercomHeavy(fixture.pi as never);
				let stopped = false;
				const shutdown = async (): Promise<void> => {
					if (stopped) return;
					stopped = true;
					await fixture.shutdown();
				};
				attempts.push({ fixture, model, orchestrationContext, sessionId, shutdown });
				try {
					await fixture.start();
				} catch (error) {
					await shutdown();
					throw error;
				}
				if (fixture.injectedMessages.length > 0) lifecycle.push(`admission:${sessionId}`);
				const messages: AgentSession["messages"] = [];
				const session: StageSessionRuntime & {
					readonly orchestrationContext: TestContext["orchestrationContext"];
					readonly state: object;
					readonly sessionManager: TestContext["sessionManager"];
					readonly modelRuntime: object;
					getContextUsage(): undefined;
				} = {
					async prompt() {
						lifecycle.push(`task:${sessionId}`);
						return "fallback attempt completed";
					},
					async steer() {},
					async followUp() {},
					subscribe: () => () => {},
					sessionFile: join(agentDir, `${sessionId}.jsonl`),
					sessionId,
					async setModel() {},
					setThinkingLevel() {},
					cycleModel: async () => undefined,
					cycleThinkingLevel: () => undefined,
					agent: { waitForIdle: async () => {} } as never,
					model: {
						provider: model.split("/")[0] ?? "test",
						id: model.split("/")[1] ?? model,
					} as AgentSession["model"],
					thinkingLevel: "medium",
					messages,
					isStreaming: false,
					navigateTree: async () => ({ cancelled: false }),
					compact: async () => ({}) as never,
					abortCompaction() {},
					async abort() {},
					dispose: shutdown,
					getLastAssistantText: () => "fallback attempt completed",
					orchestrationContext,
					state: {},
					sessionManager: fixture.context.sessionManager,
					modelRuntime: {},
					getContextUsage: () => undefined,
				};
				return { session };
			},
		},
	};
	const definition = workflow({
		name: "attempt-restart",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			const reviewer = ctx.stage("reviewer", {
				tools: ["intercom"],
				model: "anthropic/primary",
				fallbackModels: ["openai/fallback"],
				settingsManager: {
					getRetrySettings: () => ({ enabled: false, maxRetries: 0, baseDelayMs: 0 }),
				},
			} as never);
			stageRegistered.resolve();
			await releaseStageInitialization.promise;
			return { result: String(await reviewer.prompt("attempt 2 first model task")) };
		},
	});
	let runPromise: ReturnType<typeof run> | undefined;

	try {
		await owner.start();
		runPromise = run(definition, {}, { runId: RUN_ID, store, adapters });
		await stageRegistered.promise;
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.register("attempt-restart-sender", GROUP);
		sender.send({
			type: "send",
			to: TARGET,
			message: {
				id: messageId,
				timestamp: 9_000_000_000_000_000,
				content: { text: "preserve this admission across the stage attempt restart" },
			},
		});
		const queued = await sender.next("queued", (frame) => frame.messageId === messageId);
		assert.equal(queued.position, 1);
		const queuedEntry = store.pendingStageMessagesFor(RUN_ID, "reviewer")[0];
		assert.equal(queuedEntry?.id, messageId);
		assert.equal(queuedEntry?.stageReplayKey, replayKey);
		assert.equal(queuedEntry?.status, "queued");

		releaseStageInitialization.resolve();
		const result = await runPromise;
		assert.equal(result.status, "completed", JSON.stringify(result, undefined, 2));
		assert.deepEqual(
			attempts.map(({ model, sessionId }) => ({ model, sessionId })),
			[
				{ model: "anthropic/primary", sessionId: attemptSessionIds[0] },
				{ model: "openai/fallback", sessionId: attemptSessionIds[1] },
			],
		);
		assert.notEqual(attempts[0]?.sessionId, attempts[1]?.sessionId);
		assert.equal(new Set(attempts.map(({ orchestrationContext }) => orchestrationContext.workflowStageId)).size, 1);
		assert.equal(queuedEntry?.stageId, attempts[1]?.orchestrationContext.workflowStageId);
		assert.deepEqual(lifecycle, [`admission:${attemptSessionIds[1]}`, `task:${attemptSessionIds[1]}`]);
		assert.equal(attempts[0]?.fixture.injectedMessages.length, 0);
		assert.equal(attempts[1]?.fixture.injectedMessages.length, 1);
		const visible = attempts.flatMap(({ fixture }) => fixture.injectedMessages);
		assert.notStrictEqual(attempts[0]?.orchestrationContext, attempts[1]?.orchestrationContext);
		assert.notStrictEqual(
			attempts[0]?.orchestrationContext.messageAdmission?.boundary,
			attempts[1]?.orchestrationContext.messageAdmission?.boundary,
		);
		assert.equal(visible.length, 1);
		assert.equal(visible[0]?.details?.message?.id, messageId);
		assert.equal(visible[0]?.details?.from?.id, queuedEntry?.from.id);
		assert.equal(visible[0]?.details?.from?.name, "attempt-restart-sender");
		assert.match(visible[0]?.content ?? "", /Sent: 9000000000000000/);
		assert.equal(attempts[1]?.fixture.injectedOptions[0]?.stageAdmissionKey, admissionId);
		const durableEntry = backend.getWorkflow(RUN_ID)?.pendingStageMessages?.[0];
		assert.deepEqual(
			durableEntry && {
				id: durableEntry.id,
				stageId: durableEntry.stageId,
				stageReplayKey: durableEntry.stageReplayKey,
				status: durableEntry.status,
				timestamp: durableEntry.message.timestamp,
			},
			{
				id: messageId,
				stageId: attempts[1]?.orchestrationContext.workflowStageId,
				stageReplayKey: replayKey,
				status: "delivered",
				timestamp: 9_000_000_000_000_000,
			},
		);
		assert.equal(store.runs().find((candidate) => candidate.id === RUN_ID)?.status, "completed");
		assert.deepEqual(
			result.stages[0]?.modelAttempts?.map((attempt) => ({ model: attempt.model, success: attempt.success })),
			[
				{ model: "anthropic/primary", success: false },
				{ model: "openai/fallback", success: true },
			],
		);
	} finally {
		releaseStageInitialization.resolve();
		try {
			if (runPromise !== undefined) await runPromise;
		} finally {
			await Promise.all(attempts.map(({ shutdown }) => shutdown()));
			await sender.close();
			rawClients.delete(sender);
			disposeBridge();
			await owner.shutdown();
		}
	}
});

test("an identical durable delivered retry is acknowledged as delivered through a fresh owner route", async () => {
	const runId = "d75641e7-3df3-4d46-9107-4e61e3cbc021";
	const group = `workflow:${runId}`;
	const message = { id: "durable-delivered-retry", timestamp: 1_787_860_000_001, content: { text: "exactly once" } };
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "delivered-retry-writer" });
	writer.registerWorkflow({ workflowId: runId, name: "delivered-retry", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "delivered-retry",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "reviewer-id",
				name: "reviewer",
				status: "pending",
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable: true,
			},
		],
		startedAt: 1,
	});
	const firstOwner = extensionFixture("delivered-retry-owner-1", "delivered-retry-owner-1", undefined, "default");
	intercomHeavy(firstOwner.pi as never);
	let disposeFirstBridge = (): void => {};
	const raw = new RawBrokerClient();
	rawClients.add(raw);
	let secondOwner: ReturnType<typeof extensionFixture> | undefined;
	let disposeSecondBridge = (): void => {};
	try {
		await firstOwner.start();
		disposeFirstBridge = registerPendingStageIntercomBridge(firstOwner.pi as never, store);
		await firstOwner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await raw.register("delivered-retry-sender", group);
		raw.send({ type: "send", to: `workflow:${runId}/reviewer`, message });
		assert.deepEqual(await raw.nextDeliveryAcknowledgment(message.id), {
			type: "queued",
			messageId: message.id,
			target: `workflow:${runId}/reviewer`,
			position: 1,
		});
		assert.equal(
			await store.markPendingStageMessageDelivered(
				runId,
				"reviewer",
				message.id,
				"2026-08-27T12:00:00.000Z",
				writer,
			),
			true,
		);
		const deliveredSnapshot = structuredClone(writer.getWorkflow(runId)?.pendingStageMessages);

		disposeFirstBridge();
		await firstOwner.shutdown();
		const reader = new DbosDurableBackend(sdk, { executorId: "delivered-retry-reader" });
		await reader.hydrateWorkflow(runId);
		const reloadedStore = createStore();
		reloadedStore.recordRunStart({
			id: runId,
			name: "delivered-retry",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
			pendingStageMessages: [...(reader.getWorkflow(runId)?.pendingStageMessages ?? [])],
		});
		setDurableBackend(reader);
		secondOwner = extensionFixture("delivered-retry-owner-2", "delivered-retry-owner-2", undefined, "default");
		intercomHeavy(secondOwner.pi as never);
		await secondOwner.start();
		disposeSecondBridge = registerPendingStageIntercomBridge(secondOwner.pi as never, reloadedStore);
		await secondOwner.waitForEventCompletion("atomic:workflow-pending-stage-route");

		raw.send({ type: "send", to: `workflow:${runId}/reviewer-id`, message });
		assert.deepEqual(await raw.nextDeliveryAcknowledgment(message.id), {
			type: "delivered",
			messageId: message.id,
		});
		assert.deepEqual(reader.getWorkflow(runId)?.pendingStageMessages, deliveredSnapshot);
		assert.deepEqual(reloadedStore.runs()[0]?.pendingStageMessages, deliveredSnapshot);
		assert.deepEqual(reloadedStore.pendingStageMessagesFor(runId, "reviewer"), []);
	} finally {
		disposeSecondBridge();
		if (secondOwner !== undefined) await secondOwner.shutdown();
		disposeFirstBridge();
		await firstOwner.shutdown();
		await raw.close();
		rawClients.delete(raw);
	}
});

test("a drained message ID is revalidated by its durable owner after a broker restart", async () => {
	const runId = "a9f23cf8-10c1-4b72-9cc6-9f6677961fd1";
	const group = `workflow:${runId}`;
	const target = `workflow:${runId}/reviewer`;
	const messageId = "drained-live-conflict";
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "live-conflict-writer" });
	writer.registerWorkflow({ workflowId: runId, name: "live-conflict", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	const stage = (id: string, name: string, status: "pending" | "running", sessionId?: string) => ({
		id,
		name,
		status,
		parentIds: [],
		toolEvents: [],
		pendingStageDeliveryAvailable: true,
		...(sessionId === undefined ? {} : { sessionId }),
	});
	store.recordRunStart({
		id: runId,
		name: "live-conflict",
		inputs: {},
		status: "running",
		stages: [stage("reviewer-id", "reviewer", "pending"), stage("other-id", "other", "pending")],
		startedAt: 1,
	});
	const firstOwner = extensionFixture("live-conflict-owner-1", "live-conflict-owner-1", undefined, "default");
	intercomHeavy(firstOwner.pi as never);
	let disposeFirstBridge = (): void => {};
	const firstSender = new IntercomClient();
	const firstStage = new RawBrokerClient();
	const controlSender = new RawBrokerClient();
	const conflictingSender = new RawBrokerClient();
	for (const client of [firstStage, controlSender, conflictingSender]) rawClients.add(client);
	const recipientDir = mkdtempSync(join(tmpdir(), "live-conflict-recipient-"));
	const recipientSession = SessionManager.create("/repo", recipientDir);
	const firstAdmission = StageAdmissionBoundary.restore(recipientSession.getBranch());
	let secondOwner: ReturnType<typeof extensionFixture> | undefined;
	let disposeSecondBridge = (): void => {};
	let secondSender: InstanceType<typeof IntercomClient> | undefined;
	let secondStage: RawBrokerClient | undefined;
	try {
		await firstOwner.start();
		disposeFirstBridge = registerPendingStageIntercomBridge(firstOwner.pi as never, store);
		await firstOwner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await firstSender.connect(
			{ name: "live-conflict-sender", group, cwd: repoRoot, model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
			undefined,
			undefined,
			{ subagentRunId: "admitted-source" },
		);
		assert.deepEqual(await firstSender.send(target, { messageId, text: "original payload" }), {
			id: messageId,
			delivered: false,
			queued: true,
			target: `workflow:${runId}/reviewer`,
			position: 1,
		});
		const durableControl = {
			id: "durable-live-controls",
			timestamp: 100,
			replyTo: "original-reply",
			expectsReply: false,
			replyError: "original-error",
			source: { subagentRunId: "control-source", subagentAgent: "reviewer", subagentIndex: 1 },
			content: {
				text: "control payload",
				attachments: [{ type: "snippet", name: "contract.md", content: "literal", language: "md" }],
			},
		} as const;
		await controlSender.register("live-control-sender", group);
		controlSender.send({ type: "send", to: target, message: durableControl });
		assert.equal((await controlSender.next("queued", (frame) => frame.messageId === durableControl.id)).position, 2);

		const firstPending = createWorkflowPendingStageDelivery(store, runId, "reviewer-id", "reviewer");
		await firstStage.register("live-conflict-stage-1", group);
		for (const registration of [
			{ requestId: "live-conflict-route-1", stageKeys: ["reviewer-id", "reviewer"] },
			{ requestId: "live-conflict-other-route-1", stageKeys: ["other-id", "other"] },
		] as const) {
			firstStage.send({
				type: "register_live_workflow_stage_route",
				requestId: registration.requestId,
				runId,
				stageKeys: registration.stageKeys,
				capability: firstPending.routeCapability,
			});
			await firstStage.next(
				"live_workflow_stage_route_registered",
				(frame) => frame.requestId === registration.requestId,
			);
		}
		let visible = 0;
		await firstPending.deliverPending(async (from, message) => {
			const admitted = firstAdmission.admit(
				`intercom:${message.id}`,
				() => {
					recipientSession.appendCustomMessageEntry(
						"intercom_message",
						message.content.text,
						true,
						{ from, message },
						undefined,
						undefined,
						`intercom:${message.id}`,
					);
					recipientSession.flush();
					visible += 1;
				},
				() => {
					throw new Error("unexpected late pending-stage delivery");
				},
			);
			assert.equal(admitted.decision, "admitted");
			await admitted.completion;
		});
		assert.equal(visible, 2);
		assert.deepEqual(
			writer.getWorkflow(runId)?.pendingStageMessages?.map((entry) => entry.status),
			["delivered", "delivered"],
		);
		assert.equal(recipientSession.getBranch().filter((entry) => entry.type === "custom_message").length, 2);

		controlSender.send({ type: "send", to: target, message: { ...durableControl, timestamp: 999 } });
		assert.deepEqual(await controlSender.nextDeliveryAcknowledgment(durableControl.id), {
			type: "delivered",
			messageId: durableControl.id,
		});
		await conflictingSender.register("changed-control-sender", group);
		const conflicts = [
			{ to: `workflow:${runId}/other`, message: durableControl },
			{ to: target, message: { ...durableControl, content: { ...durableControl.content, text: "changed text" } } },
			{
				to: target,
				message: {
					...durableControl,
					content: {
						...durableControl.content,
						attachments: [{ type: "snippet", name: "contract.md", content: "changed", language: "md" }],
					},
				},
			},
			{ to: target, message: { ...durableControl, replyTo: "changed-reply" } },
			{ to: target, message: { ...durableControl, expectsReply: true } },
			{ to: target, message: { ...durableControl, replyError: "changed-error" } },
			{
				to: target,
				message: { ...durableControl, source: { ...durableControl.source, subagentRunId: "changed-source" } },
			},
		] as const;
		for (const conflict of conflicts) {
			controlSender.send({ type: "send", ...conflict });
			assert.equal(
				(await controlSender.next("delivery_failed", (frame) => frame.messageId === durableControl.id)).reasonCode,
				"message_id_conflict",
			);
		}
		conflictingSender.send({ type: "send", to: target, message: durableControl });
		assert.equal(
			(await conflictingSender.next("delivery_failed", (frame) => frame.messageId === durableControl.id)).reasonCode,
			"message_id_conflict",
		);

		const brandNewId = "brand-new-live-message";
		assert.deepEqual(await firstSender.send(target, { messageId: brandNewId, text: "immediate live delivery" }), {
			id: brandNewId,
			delivered: true,
		});
		await firstStage.next("message", (frame) => frame.message.id === brandNewId);
		assert.equal(
			firstStage.received.filter((frame) => frame.type === "message" && frame.message.id === durableControl.id)
				.length,
			0,
			"a durable delivered retry is not forwarded",
		);
		assert.equal(writer.getWorkflow(runId)?.pendingStageMessages?.length, 2);
		assert.equal(
			writer.getWorkflow(runId)?.pendingStageMessages?.some((entry) => entry.id === brandNewId),
			false,
			"a brand-new live ID is not persisted as pending validation state",
		);

		await firstSender.disconnect();
		await firstStage.close();
		rawClients.delete(firstStage);
		disposeFirstBridge();
		disposeFirstBridge = (): void => {};
		await firstOwner.shutdown();
		await stopBroker();
		await startBroker();

		const reader = new DbosDurableBackend(sdk, { executorId: "live-conflict-reader" });
		await reader.hydrateWorkflow(runId);
		setDurableBackend(reader);
		const reloadedStore = createStore();
		reloadedStore.recordRunStart({
			id: runId,
			name: "live-conflict",
			inputs: {},
			status: "running",
			stages: [
				stage("reviewer-id", "reviewer", "running", "durable-stage-session"),
				stage("other-id", "other", "running", "other-session"),
			],
			startedAt: 1,
			pendingStageMessages: [...(reader.getWorkflow(runId)?.pendingStageMessages ?? [])],
		});
		secondOwner = extensionFixture("live-conflict-owner-2", "live-conflict-owner-2", undefined, "default");
		intercomHeavy(secondOwner.pi as never);
		await secondOwner.start();
		disposeSecondBridge = registerPendingStageIntercomBridge(secondOwner.pi as never, reloadedStore);
		await secondOwner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		const secondPending = createWorkflowPendingStageDelivery(reloadedStore, runId, "reviewer-id", "reviewer");
		secondStage = new RawBrokerClient();
		rawClients.add(secondStage);
		await secondStage.register("live-conflict-stage-2", group);
		secondStage.send({
			type: "register_live_workflow_stage_route",
			requestId: "live-conflict-route-2",
			runId,
			stageKeys: ["reviewer-id", "reviewer"],
			capability: secondPending.routeCapability,
		});
		await secondStage.next(
			"live_workflow_stage_route_registered",
			(frame) => frame.requestId === "live-conflict-route-2",
		);
		secondSender = new IntercomClient();
		await secondSender.connect(
			{ name: "live-conflict-sender", group, cwd: repoRoot, model: "test", pid: 2, startedAt: 2, lastActivity: 2 },
			undefined,
			undefined,
			{ subagentRunId: "changed-source" },
		);

		const acknowledgment = await secondSender.send(target, { messageId, text: "CHANGED payload" });
		if (acknowledgment.delivered) {
			const forwarded = await secondStage.next(
				"message",
				(frame) => frame.message.id === messageId && frame.message.content.text === "CHANGED payload",
			);
			const restoredAdmission = StageAdmissionBoundary.restore(recipientSession.getBranch());
			const duplicate = restoredAdmission.admit(
				`intercom:${forwarded.message.id}`,
				() => {
					throw new Error("persistent recipient admitted a duplicate");
				},
				() => {
					throw new Error("unexpected late route");
				},
			);
			assert.equal(duplicate.decision, "duplicate");
			await duplicate.completion;
		}
		assert.deepEqual(acknowledgment, {
			id: messageId,
			delivered: false,
			reason: `Intercom message ID '${messageId}' conflicts with the durable identity for ${target}`,
			reasonCode: "message_id_conflict",
		});
		const freshBrandNewId = "fresh-broker-brand-new-live";
		assert.deepEqual(
			await secondSender.send(target, { messageId: freshBrandNewId, text: "fresh immediate delivery" }),
			{
				id: freshBrandNewId,
				delivered: true,
			},
		);
		await secondStage.next("message", (frame) => frame.message.id === freshBrandNewId);
		assert.equal(
			secondStage.received.filter((frame) => frame.type === "message" && frame.message.id === messageId).length,
			0,
			"the durable conflict is refused before forwarding",
		);
		assert.equal(reader.getWorkflow(runId)?.pendingStageMessages?.length, 2);
		assert.equal(recipientSession.getBranch().filter((entry) => entry.type === "custom_message").length, 2);
	} finally {
		if (secondSender !== undefined) await secondSender.disconnect();
		if (secondStage !== undefined) {
			await secondStage.close();
			rawClients.delete(secondStage);
		}
		disposeSecondBridge();
		if (secondOwner !== undefined) await secondOwner.shutdown();
		await firstSender.disconnect();
		for (const client of [firstStage, controlSender, conflictingSender]) {
			await client.close();
			rawClients.delete(client);
		}
		disposeFirstBridge();
		await firstOwner.shutdown();
		if (broker === undefined) await startBroker();
		rmSync(recipientDir, { recursive: true, force: true });
	}
});
test("raw malformed messages are rejected before durable mutation and valid optional fields survive DBOS reload", async () => {
	const runId = "2f34ff35-9813-4a60-b7a3-24698cd01592";
	const group = `workflow:${runId}`;
	const target = `workflow:${runId}/reviewer`;
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "wire-validation-writer" });
	writer.registerWorkflow({ workflowId: runId, name: "wire-validation", inputs: {}, status: "running", createdAt: 1 });
	await writer.flush();
	setDurableBackend(writer);
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "wire-validation",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "reviewer-id",
				name: "reviewer",
				status: "pending",
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable: true,
			},
		],
		startedAt: 1,
	});
	const owner = extensionFixture("wire-owner", "wire-owner", undefined, "default");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	const raw = new RawBrokerClient();
	rawClients.add(raw);
	try {
		await owner.start();
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await raw.register("raw-sender", group);
		const malformed = [
			{ id: "malformed-reply-error", timestamp: 1, replyError: { bad: true }, content: { text: "bad" } },
			{ id: "malformed-source", timestamp: 2, source: {}, content: { text: "bad" } },
			{
				id: "malformed-attachment",
				timestamp: 3,
				content: { text: "bad", attachments: [{ type: "file", name: "bad", content: "bad", language: 9 }] },
			},
		] as const;
		for (const message of malformed) {
			raw.send({ type: "send", to: target, message });
			assert.deepEqual(await raw.next("delivery_failed", (frame) => frame.messageId === message.id), {
				type: "delivery_failed",
				messageId: message.id,
				reason: "Invalid message format",
			});
		}
		assert.deepEqual(store.pendingStageMessagesFor(runId, "reviewer"), []);
		const cleanReload = new DbosDurableBackend(sdk, { executorId: "wire-validation-clean-reader" });
		await cleanReload.hydrateWorkflow(runId);
		assert.deepEqual(cleanReload.getWorkflow(runId)?.pendingStageMessages, []);

		const validMessage = {
			id: "valid-full-message",
			timestamp: 4,
			replyTo: "prior-message",
			expectsReply: false,
			replyError: "preserved remote context",
			source: { subagentRunId: "subagent-run", subagentAgent: "reviewer", subagentIndex: 3 },
			content: {
				text: "valid",
				attachments: [{ type: "context", name: "contract", content: "literal", language: "txt" }],
			},
		};
		raw.send({ type: "send", to: target, message: validMessage });
		const queued = await raw.next("queued", (frame) => frame.messageId === validMessage.id);
		assert.equal(queued.position, 1);
		raw.send({ type: "send", to: `workflow:${runId}/reviewer-id`, message: validMessage });
		assert.equal((await raw.next("queued", (frame) => frame.messageId === validMessage.id)).position, 1);
		raw.send({
			type: "send",
			to: `workflow:${runId}/reviewer-id`,
			message: { ...validMessage, content: { ...validMessage.content, text: "conflicting reuse" } },
		});
		assert.deepEqual(await raw.next("delivery_failed", (frame) => frame.messageId === validMessage.id), {
			type: "delivery_failed",
			messageId: validMessage.id,
			reason: `Intercom message ID '${validMessage.id}' was already queued for workflow:${runId}/reviewer-id with a different target, sender, or payload`,
		});
		for (let position = 2; position <= 50; position++) {
			const message = { id: `capacity-${position}`, timestamp: position + 4, content: { text: String(position) } };
			raw.send({
				type: "send",
				to: `workflow:${runId}/${position % 2 === 0 ? "reviewer-id" : "reviewer"}`,
				message,
			});
			assert.equal((await raw.next("queued", (frame) => frame.messageId === message.id)).position, position);
		}
		raw.send({
			type: "send",
			to: `workflow:${runId}/reviewer`,
			message: { id: "capacity-51", timestamp: 55, content: { text: "refused" } },
		});
		assert.match(
			(await raw.next("delivery_failed", (frame) => frame.messageId === "capacity-51")).reason,
			/queue is full \(limit 50\)/,
		);
		const validReload = new DbosDurableBackend(sdk, { executorId: "wire-validation-valid-reader" });
		await validReload.hydrateWorkflow(runId);
		assert.equal(validReload.getWorkflow(runId)?.pendingStageMessages?.length, 50);
		assert.deepEqual(validReload.getWorkflow(runId)?.pendingStageMessages?.[0]?.message, validMessage);
	} finally {
		await raw.close();
		rawClients.delete(raw);
		disposeBridge();
		await owner.shutdown();
	}
});

test("an ordinary queued send receives one correlated failure when its stage becomes undeliverable", async () => {
	const runId = "71805cb7-169f-4531-ad39-bbcab6b01087";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("undeliverable-owner", "undeliverable-owner", undefined, "default");
	const sender = extensionFixture("undeliverable-sender", "undeliverable-sender", undefined, group);
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	intercom(sender.pi as never);
	try {
		await owner.start();
		store.recordRunStart({
			id: runId,
			name: "undeliverable",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
		});
		backend.registerWorkflow({
			workflowId: runId,
			name: "undeliverable",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.start();
		const queued = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${runId}/reviewer`,
			message: "ordinary handoff",
		});
		assert.equal(queued.details.queued, true);
		assert.ok(queued.details.messageId);
		assert.equal(store.pendingStageMessagesFor(runId, "reviewer")[0]?.message.expectsReply, undefined);

		const failureVisible = sender.waitForInjectedCount(1);
		const notified = waitForStoreState(
			store,
			() => store.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt !== undefined,
		);
		store.recordStageEnd(runId, {
			id: "reviewer-id",
			name: "reviewer",
			status: "skipped",
			parentIds: [],
			toolEvents: [],
			skippedReason: "fail-fast",
		});
		await failureVisible;
		await notified;
		const failure = sender.injectedMessages[0];
		assert.match(failure?.content ?? "", /could not receive intercom message:.*skipped.*fail-fast/i);
		assert.equal(failure?.details?.message?.replyTo, queued.details.messageId);
		assert.match(failure?.details?.message?.replyError ?? "", /could not receive intercom message/i);
		assert.equal(typeof store.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt, "string");
		assert.equal(sender.injectedMessages.length, 1);
	} finally {
		disposeBridge();
		await sender.shutdown();
		await owner.shutdown();
	}
});

test("the workflow owner session receives its own undeliverable notice when it is the sender", async () => {
	// The launching session commonly joins its own invocation group and steers a stage from
	// there. Its undeliverable notice then targets the very session that owns the pending
	// route, which the broker refuses as a self-send; the host must admit it locally instead.
	const runId = "5d2c9a1e-6f3b-4c8d-9e0f-1a2b3c4d5e6f";
	const group = `workflow:${runId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("self-notice-owner", "self-notice-owner", undefined, group);
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	try {
		await owner.start();
		store.recordRunStart({
			id: runId,
			name: "self-notice",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
		});
		backend.registerWorkflow({
			workflowId: runId,
			name: "self-notice",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		const queued = await executeIntercom(owner, {
			action: "send",
			to: `workflow:${runId}/reviewer`,
			message: "self-steer before the reviewer exists",
		});
		assert.equal(queued.details.queued, true);
		assert.ok(queued.details.messageId);

		const failureVisible = owner.waitForInjectedCount(1);
		const notified = waitForStoreState(
			store,
			() => store.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt !== undefined,
		);
		store.recordStageEnd(runId, {
			id: "reviewer-id",
			name: "reviewer",
			status: "skipped",
			parentIds: [],
			toolEvents: [],
			skippedReason: "fail-fast",
		});
		await failureVisible;
		await notified;
		const failure = owner.injectedMessages[0];
		assert.match(failure?.content ?? "", /could not receive intercom message:.*skipped.*fail-fast/i);
		assert.equal(failure?.details?.message?.replyTo, queued.details.messageId);
		assert.equal(typeof store.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt, "string");
		assert.equal(owner.injectedMessages.length, 1);
	} finally {
		disposeBridge();
		await owner.shutdown();
	}
});

test("a reconnected logical sender receives its durable undeliverable notice after a broker restart", async () => {
	const runId = "33333333-3333-4333-8333-333333333333";
	const group = `workflow:${runId}`;
	const nestedSenderRunId = "44444444-4444-4444-8444-444444444444";
	const nestedSenderContext: TestContext["orchestrationContext"] = {
		intercomGroup: group,
		kind: "workflow-stage",
		workflowRunId: nestedSenderRunId,
		workflowStageId: "nested-planner-id",
		workflowStageName: "nested-planner",
	};
	const sdk = createMockSdk();
	const writer = new DbosDurableBackend(sdk, { executorId: "sender-reconnect-writer" });
	writer.registerWorkflow({
		workflowId: runId,
		name: "sender-reconnect",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	await writer.flush();
	setDurableBackend(writer);
	const writerStore = createStore();
	writerStore.recordRunStart({
		id: runId,
		name: "sender-reconnect",
		inputs: {},
		status: "running",
		stages: [
			{
				id: "reviewer-id",
				name: "reviewer",
				status: "pending",
				parentIds: [],
				toolEvents: [],
				pendingStageDeliveryAvailable: true,
			},
		],
		startedAt: 1,
	});
	const ownerBefore = extensionFixture(
		"sender-reconnect-owner-before",
		"sender-reconnect-owner",
		undefined,
		"default",
	);
	const senderBefore = extensionFixture(
		"sender-reconnect-session-before",
		"planner",
		undefined,
		group,
		nestedSenderContext,
	);
	intercomHeavy(ownerBefore.pi as never);
	let disposeBefore = (): void => {};
	intercomHeavy(senderBefore.pi as never);
	let ownerAfter: ReturnType<typeof extensionFixture> | undefined;
	let senderAfter: ReturnType<typeof extensionFixture> | undefined;
	let disposeAfter = (): void => {};
	try {
		await ownerBefore.start();
		await senderBefore.start();
		disposeBefore = registerPendingStageIntercomBridge(ownerBefore.pi as never, writerStore);
		await ownerBefore.waitForEventCompletion("atomic:workflow-pending-stage-route");
		const queued = await executeIntercom(senderBefore, {
			action: "send",
			to: `workflow:${runId}/reviewer`,
			message: "scope changed before the broker restart",
		});
		assert.equal(queued.details.queued, true);
		assert.ok(queued.details.messageId);
		const storedBeforeRestart = writerStore.pendingStageMessagesFor(runId, "reviewer")[0];
		assert.ok(storedBeforeRestart);
		assert.equal(storedBeforeRestart.from.name, "planner");
		assert.equal(storedBeforeRestart.from.group, group);
		assert.equal(storedBeforeRestart.senderRegistrationName, "planner");
		assert.equal(storedBeforeRestart.senderReturnAddress, "sender-reconnect-session-before");
		await writer.flush();

		disposeBefore();
		await senderBefore.shutdown();
		await ownerBefore.shutdown();
		await stopBroker();
		await startBroker();

		const reader = new DbosDurableBackend(sdk, { executorId: "sender-reconnect-reader" });
		await reader.hydrateWorkflow(runId);
		const reloadedStore = createStore();
		reloadedStore.recordRunStart({
			id: runId,
			name: "sender-reconnect",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "pending",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
			pendingStageMessages: [...(reader.getWorkflow(runId)?.pendingStageMessages ?? [])],
		});
		setDurableBackend(reader);
		ownerAfter = extensionFixture("sender-reconnect-owner-after", "sender-reconnect-owner", undefined, "default");
		senderAfter = extensionFixture(
			"sender-reconnect-session-before",
			"planner",
			undefined,
			group,
			nestedSenderContext,
		);
		intercomHeavy(ownerAfter.pi as never);
		intercomHeavy(senderAfter.pi as never);
		await ownerAfter.start();
		await senderAfter.start();
		disposeAfter = registerPendingStageIntercomBridge(ownerAfter.pi as never, reloadedStore);
		await ownerAfter.waitForEventCompletion("atomic:workflow-pending-stage-route");

		const senderAfterStatus = await executeIntercom(senderAfter, { action: "status" });
		const senderAfterId = /Session ID: ([0-9a-f-]+)/i.exec(senderAfterStatus.content[0]?.text ?? "")?.[1];
		assert.ok(senderAfterId);
		assert.notEqual(senderAfterId, storedBeforeRestart.from.id);

		reloadedStore.recordStageEnd(runId, {
			id: "reviewer-id",
			name: "reviewer",
			status: "skipped",
			parentIds: [],
			toolEvents: [],
			skippedReason: "branch not taken",
		});
		await ownerAfter.waitForEventCompletion("atomic:workflow-pending-stage-undeliverable");
		await waitForStoreState(
			reloadedStore,
			() => reloadedStore.runs()[0]?.pendingStageMessages?.[0]?.undeliverableNotifiedAt !== undefined,
		);

		const storedAfterRestart = reloadedStore.runs()[0]?.pendingStageMessages?.[0];
		assert.ok(storedAfterRestart);
		assert.equal(storedAfterRestart.from.id, storedBeforeRestart.from.id);
		assert.equal(storedAfterRestart.from.name, storedBeforeRestart.from.name);
		assert.equal(storedAfterRestart.from.group, storedBeforeRestart.from.group);
		assert.equal(storedAfterRestart.senderRegistrationName, storedBeforeRestart.senderRegistrationName);
		assert.equal(storedAfterRestart.senderReturnAddress, storedBeforeRestart.senderReturnAddress);
		assert.equal(senderAfter.injectedMessages.length, 1);
		assert.equal(typeof storedAfterRestart.undeliverableNotifiedAt, "string");
		const notice = senderAfter.injectedMessages[0];
		assert.equal(notice?.details?.message?.replyTo, queued.details.messageId);
		assert.match(notice?.details?.message?.replyError ?? "", /branch not taken/);

		const notificationId = storedAfterRestart.undeliverableNotificationId;
		const notifiedAt = storedAfterRestart.undeliverableNotifiedAt;
		assert.ok(notificationId);
		assert.equal(notice?.details?.message?.id, notificationId);
		assert.equal(storedAfterRestart.message.id, queued.details.messageId);
		assert.equal(storedAfterRestart.message.content.text, "scope changed before the broker restart");
		assert.ok(notifiedAt);
		disposeAfter();
		disposeAfter = (): void => {};
		await senderAfter.shutdown();
		await ownerAfter.shutdown();
		await stopBroker();
		await startBroker();

		const receiptReader = new DbosDurableBackend(sdk, { executorId: "sender-reconnect-receipt-reader" });
		await receiptReader.hydrateWorkflow(runId);
		const restartedStore = createStore();
		restartedStore.recordRunStart({
			id: runId,
			name: "sender-reconnect",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "reviewer-id",
					name: "reviewer",
					status: "skipped",
					parentIds: [],
					toolEvents: [],
					skippedReason: "branch not taken",
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
			pendingStageMessages: [...(receiptReader.getWorkflow(runId)?.pendingStageMessages ?? [])],
		});
		setDurableBackend(receiptReader);
		let retryNotifications = 0;
		assert.equal(
			await settleUndeliverablePendingStageMessages(restartedStore, async () => {
				retryNotifications += 1;
				return true;
			}),
			0,
		);
		const receiptAfterRestart = restartedStore.runs()[0]?.pendingStageMessages?.[0];
		assert.equal(retryNotifications, 0);
		assert.equal(receiptAfterRestart?.undeliverableNotificationId, notificationId);
		assert.equal(receiptAfterRestart?.undeliverableNotifiedAt, notifiedAt);
		assert.equal(senderAfter.injectedMessages.length, 1);
	} finally {
		disposeAfter();
		if (senderAfter !== undefined) await senderAfter.shutdown();
		if (ownerAfter !== undefined) await ownerAfter.shutdown();
		disposeBefore();
		await senderBefore.shutdown();
		await ownerBefore.shutdown();
		if (broker === undefined) await startBroker();
	}
});

// Slice 3 (D3/D4/D5/D6/D9) end-to-end: the real broker routes pattern and `**` targets
// through the real pending-stage bridge; live stages receive ordinary inbound messages
// with the sender identity while future iterations receive the pre-start prelude.
test("a sticky pattern preludes every materializing iteration and ** broadcasts live stages", async () => {
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const owner = extensionFixture("sticky-owner-session", "workflow-owner", undefined, "default");
	const sender = extensionFixture("sticky-sender-session", "stage-a");
	intercom(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	intercom(sender.pi as never);
	let liveStage: ReturnType<typeof extensionFixture> | undefined;
	let raw: RawBrokerClient | undefined;

	try {
		await owner.start();
		store.recordRunStart({
			id: RUN_ID,
			name: "flow",
			inputs: {},
			status: "running",
			possibleStages: ["orchestrator-*", "pull-request"],
			stages: [
				{
					id: "orchestrator-2-id",
					name: "orchestrator-2",
					status: "running",
					sessionId: "sticky-live-orchestrator",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
		});
		backend.registerWorkflow({ workflowId: RUN_ID, name: "flow", inputs: {}, status: "running", createdAt: 1 });
		await owner.waitForEventCompletion("atomic:workflow-pending-stage-route");
		await sender.start();
		raw = new RawBrokerClient();
		rawClients.add(raw);
		await raw.register("sticky-raw-sender", GROUP);

		// A live iteration registered under the depth-faithful live aliases.
		const liveDelivery = createWorkflowPendingStageDelivery(store, RUN_ID, "orchestrator-2-id", "orchestrator-2");
		liveStage = extensionFixture("sticky-live-stage-session", "orchestrator-2", liveDelivery, GROUP, {
			intercomGroup: GROUP,
			kind: "workflow-stage",
			workflowRunId: RUN_ID,
			workflowStageId: "orchestrator-2-id",
			workflowStageName: "orchestrator-2",
			pendingStageDelivery: liveDelivery,
		});
		intercom(liveStage.pi as never);
		await liveStage.start();

		// D6/D9: `**` reaches the live stage now, through the ordinary inbound admission
		// path, carrying the original sender identity.
		const broadcast = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${RUN_ID}/**`,
			message: "Broadcast to the whole invocation.",
		});
		assert.equal(broadcast.isError, false);
		assert.equal(broadcast.details.queued, true);
		assert.equal(broadcast.details.position, 1);
		assert.equal(broadcast.details.notInKnownSet, undefined);
		await liveStage.waitForInjectedCount(1);
		assert.match(liveStage.injectedMessages[0]?.content ?? "", /Broadcast to the whole invocation\./);
		assert.match(liveStage.injectedMessages[0]?.content ?? "", /\*\*📨 From stage-a\*\*/);

		// Round-1 review, finding 8: a retried sticky broadcast (same message id) re-routes
		// to the host ledger and acks `queued` again — never `delivered` from the broker's
		// in-memory delivered-message cache — without re-broadcasting to the live stage.
		const rawBroadcastId = "sticky-raw-broadcast";
		const rawBroadcast = {
			type: "send",
			to: `workflow:${RUN_ID}/**`,
			message: { id: rawBroadcastId, timestamp: 5, content: { text: "Raw broadcast to the invocation." } },
		};
		raw.send(rawBroadcast);
		assert.deepEqual(await raw.nextDeliveryAcknowledgment(rawBroadcastId), {
			type: "queued",
			messageId: rawBroadcastId,
			target: `workflow:${RUN_ID}/**`,
			position: 2,
		});
		await liveStage.waitForInjectedCount(2);
		assert.equal(
			liveStage.injectedMessages.filter(({ content }) => content?.includes("Raw broadcast to the invocation."))
				.length,
			1,
		);
		raw.send(rawBroadcast);
		assert.deepEqual(await raw.nextDeliveryAcknowledgment(rawBroadcastId), {
			type: "queued",
			messageId: rawBroadcastId,
			target: `workflow:${RUN_ID}/**`,
			position: 2,
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		assert.equal(
			liveStage.injectedMessages.filter(({ content }) => content?.includes("Raw broadcast to the invocation."))
				.length,
			1,
		);

		// D3: a pattern send is queued sticky for every future matching iteration.
		const pattern = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${RUN_ID}/orchestrator-*`,
			message: "Steer all orchestrator iterations.",
		});
		assert.equal(pattern.isError, false);
		assert.equal(pattern.details.queued, true);
		assert.equal(pattern.details.position, 1);
		assert.equal(pattern.details.notInKnownSet, undefined);

		// D4: a target outside the persisted scan is accepted speculatively with the warning.
		const speculative = await executeIntercom(sender, {
			action: "send",
			to: `workflow:${RUN_ID}/slice-9/writer`,
			message: "Speculative future target.",
		});
		assert.equal(speculative.isError, false);
		assert.equal(speculative.details.queued, true);
		assert.equal(speculative.details.notInKnownSet, true);

		// Asks to pattern targets stay refused.
		const patternAsk = await executeIntercom(sender, {
			action: "ask",
			to: `workflow:${RUN_ID}/orchestrator-*`,
			message: "Any orchestrator there?",
		});
		assert.equal(patternAsk.details.refusal, "pending_stage_ask_unsupported");

		// Iteration 3 materializes and drains both sticky entries as the pre-start prelude,
		// in durable admission order.
		const prelude: string[] = [];
		const iterationDelivery = createWorkflowPendingStageDelivery(
			store,
			RUN_ID,
			"orchestrator-3-id",
			"orchestrator-3",
		);
		await iterationDelivery.deliverPending((_from, message) => {
			prelude.push(message.content.text);
		});
		assert.deepEqual(prelude, [
			"Broadcast to the whole invocation.",
			"Raw broadcast to the invocation.",
			"Steer all orchestrator iterations.",
		]);

		const entries = () => store.runs()[0]?.pendingStageMessages ?? [];
		const broadcastEntries = entries().filter((entry) => entry.targetPath === `workflow:${RUN_ID}/**`);
		assert.equal(broadcastEntries.length, 2);
		const patternEntry = entries().find((entry) => entry.targetPath === `workflow:${RUN_ID}/orchestrator-*`);
		assert.ok(broadcastEntries.every((entry) => entry.deliveryCount === 2));
		assert.ok(broadcastEntries.every((entry) => entry.status === "queued"));
		// The pattern also matched the live orchestrator-2 at send time (D6: patterns
		// deliver immediately to live matches), so its ledger holds two deliveries.
		assert.equal(patternEntry?.deliveryCount, 2);
		assert.equal(patternEntry?.status, "queued");

		// Exactly-once per (entry, materialized stage): a redelivery attempt adds nothing.
		await iterationDelivery.deliverPending((_from, message) => {
			prelude.push(`repeat:${message.content.text}`);
		});
		assert.equal(prelude.length, 3);

		// Iteration 4 receives both entries again: sticky delivery is per future stage.
		await createWorkflowPendingStageDelivery(store, RUN_ID, "orchestrator-4-id", "orchestrator-4").deliverPending(
			(_from, message) => {
				prelude.push(`orchestrator-4:${message.content.text}`);
			},
		);
		assert.deepEqual(prelude.slice(-3), [
			"orchestrator-4:Broadcast to the whole invocation.",
			"orchestrator-4:Raw broadcast to the invocation.",
			"orchestrator-4:Steer all orchestrator iterations.",
		]);
		assert.ok(
			entries()
				.filter((entry) => entry.targetPath === `workflow:${RUN_ID}/**`)
				.every((entry) => entry.deliveryCount === 3),
		);
	} finally {
		if (liveStage !== undefined) await liveStage.shutdown();
		disposeBridge();
		await sender.shutdown();
		await owner.shutdown();
		if (raw !== undefined) {
			await raw.close();
			rawClients.delete(raw);
		}
	}
});
