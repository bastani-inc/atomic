import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { routeClosedWorkflowStageMessage } from "../../packages/intercom/closed-workflow-stage-message.js";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";
import intercom from "../../packages/intercom/index.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import {
	type CompletedStageHandleResolver,
	registerCompletedStageIntercomAskRouter,
} from "../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { sleep } from "../helpers/runtime.js";

const sender: SessionInfo = {
	id: "stage-b-intercom",
	name: "B",
	cwd: "/repo",
	model: "test",
	pid: 2,
	startedAt: 1,
	lastActivity: 1,
};

function ask(): Message {
	return {
		id: "ask-b-to-a",
		timestamp: 1,
		expectsReply: true,
		content: { text: "exact ask" },
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition did not settle");
		await sleep(2);
	}
}

test("failed completed-stage revival sends an actionable error on the exact ask thread and cleans target context", async () => {
	const admission = new InboundMessageAdmission();
	const tracker = new ReplyTracker();
	const message = ask();
	const sent: Array<{ to: string; options: { text: string; replyTo?: string; replyError?: string } }> = [];
	const client = {
		isConnected: () => true,
		async send(to: string, options: { text: string; replyTo?: string; replyError?: string }) {
			sent.push({ to, options });
			return { id: "failure-reply", delivered: true };
		},
	};

	routeClosedWorkflowStageMessage(
		{ from: sender, message, bodyText: message.content.text },
		admission,
		tracker,
		null,
		async () => {
			throw new Error("target is not resumable");
		},
		() => client as never,
		() => true,
		() => false,
	);
	await waitFor(() => sent.length === 1);

	assert.equal(sent[0]?.to, sender.id);
	assert.equal(sent[0]?.options.replyTo, message.id);
	assert.match(sent[0]?.options.replyError ?? "", /not resumable/);
	assert.deepEqual(tracker.listPending(), []);
	assert.equal(
		admission.admit(sender, message).kind,
		"duplicate",
		"terminal failure response commits dedupe ownership",
	);
});

test("successful completed-stage handoff retains the exact pending ask for the revived turn", async () => {
	const admission = new InboundMessageAdmission();
	const tracker = new ReplyTracker();
	const message = ask();
	let delivered = false;
	routeClosedWorkflowStageMessage(
		{ from: sender, message, bodyText: message.content.text },
		admission,
		tracker,
		null,
		async () => {
			delivered = true;
		},
		() => null,
		() => true,
		() => false,
	);
	await waitFor(() => delivered);

	tracker.beginTurn();
	const target = tracker.resolveReplyTarget({});
	assert.equal(target.from.id, sender.id);
	assert.equal(target.message.id, message.id);
	assert.equal(admission.admit(sender, message).kind, "duplicate");
});

test("ordinary late notifications keep the external route without claiming target reply context", async () => {
	const admission = new InboundMessageAdmission();
	const tracker = new ReplyTracker();
	const message = { ...ask(), expectsReply: false };
	const deliveredMessages: Message[] = [];
	routeClosedWorkflowStageMessage(
		{ from: sender, message, bodyText: message.content.text },
		admission,
		tracker,
		null,
		async () => {
			deliveredMessages.push(message);
		},
		() => null,
		() => true,
		() => false,
	);
	await waitFor(() => deliveredMessages.length === 1);
	assert.equal(deliveredMessages[0], message, "ordinary payload identity remains unchanged");
	assert.deepEqual(tracker.listPending(), []);
	assert.equal(
		admission.admit(sender, message).kind,
		"reserved",
		"destination late router retains admission ownership",
	);
});

test("a closed workflow stage suppresses child-owned late traffic without changing ordinary delivery", async () => {
	const admission = new InboundMessageAdmission();
	const tracker = new ReplyTracker();
	const childMessage: Message = {
		...ask(),
		id: "late-child-update",
		expectsReply: false,
		source: { subagentRunId: "foreground-detach-run-1-0", subagentAgent: "worker", subagentIndex: 0 },
		content: { text: "late child finding" },
	};
	let deliveries = 0;
	routeClosedWorkflowStageMessage(
		{ from: sender, message: childMessage, channel: "supervisor", bodyText: childMessage.content.text },
		admission,
		tracker,
		null,
		async () => {
			deliveries += 1;
		},
		() => null,
		() => true,
		(runId) => runId === childMessage.source?.subagentRunId,
	);
	await sleep(20);

	assert.equal(deliveries, 0);
	assert.deepEqual(tracker.listPending(), []);
});

test("an in-flight child Intercom send cancelled by stage close cannot report success or reach the parent", async () => {
	const admission = new InboundMessageAdmission();
	const tracker = new ReplyTracker();
	const sendStarted = Promise.withResolvers<void>();
	const finishSend = Promise.withResolvers<void>();
	const boundary = new WorkflowStageAdmissionBoundary();
	boundary.registerOwnedSubagentRun("foreground-detach-run-1-0");

	let parentDeliveries = 0;
	let registered:
		| {
				execute(
					id: string,
					params: Record<string, string>,
					signal: AbortSignal | undefined,
					update: undefined,
					ctx: object,
				): Promise<{ content: Array<{ text: string }>; isError: boolean }>;
		  }
		| undefined;
	const parent: SessionInfo = { ...sender, id: "stage-parent", name: "Parent" };
	const child: SessionInfo = { ...sender, id: "child-intercom", name: "Child" };
	const client = {
		sessionId: child.id,
		async send(_to: string, outgoing: { messageId?: string; text: string }) {
			sendStarted.resolve();
			await finishSend.promise;
			const message: Message = {
				id: outgoing.messageId ?? "late-child-send",
				timestamp: Date.now(),
				source: { subagentRunId: "foreground-detach-run-1-0", subagentAgent: "worker", subagentIndex: 0 },
				content: { text: outgoing.text },
			};
			routeClosedWorkflowStageMessage(
				{ from: child, message, bodyText: message.content.text },
				admission,
				tracker,
				null,
				async () => {
					parentDeliveries += 1;
				},
				() => null,
				() => true,
				(runId) => boundary.ownsSubagentRun(runId),
			);
			return { id: message.id, delivered: true };
		},
	};
	registerIntercomTool(
		{
			registerTool(tool: typeof registered) {
				registered = tool;
			},
			appendEntry() {},
		} as never,
		{
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => parent.id,
			beginReplyWait: () => {
				throw new Error("send must not reserve a reply waiter");
			},
			confirmSend: false,
			replyTracker: tracker,
		} as never,
	);
	assert.ok(registered);
	const execution = registered.execute(
		"tool-call",
		{ action: "send", to: parent.id, message: "late child finding" },
		boundary.closeSignal,
		undefined,
		{ sessionManager: { getSessionId: () => child.id }, hasUI: false },
	);
	await sendStarted.promise;
	await boundary.close();
	finishSend.resolve();
	const result = await execution;
	await sleep(20);

	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /Cancelled/);
	assert.equal(parentDeliveries, 0);
});

interface ComposedLateAskEvent {
	handled: boolean;
	completion?: Promise<void>;
	batch: boolean;
	workflowRunId: string;
	workflowStageId: string;
	messages: Array<{
		customType: "intercom_message";
		content: string;
		details: { from: SessionInfo; message: Message; bodyText: string };
	}>;
}

function productionComposition(
	order: "workflow-first" | "intercom-first",
	resolve: CompletedStageHandleResolver,
	onHeavyLateMessage?: (payload: unknown) => void,
) {
	const emitter = new EventEmitter();
	const lifecycleHandlers = new Map<string, Array<(...args: never[]) => void>>();
	const bus = {
		on(name: string, listener: (payload: unknown) => void) {
			emitter.on(name, listener);
			return () => emitter.off(name, listener);
		},
		emit(name: string, payload: unknown) {
			emitter.emit(name, payload);
		},
	};
	let heavyImports = 0;
	const pi = {
		events: bus,
		on(name: string, listener: (...args: never[]) => void) {
			const current = lifecycleHandlers.get(name) ?? [];
			current.push(listener);
			lifecycleHandlers.set(name, current);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
	};
	const registerWorkflow = () => registerCompletedStageIntercomAskRouter(pi, resolve);
	const registerIntercom = () =>
		intercom(pi as never, {
			async importHeavy() {
				heavyImports += 1;
				return {
					default(heavyPi: { events: { on(name: string, listener: (payload: unknown) => void): void } }) {
						if (onHeavyLateMessage) {
							heavyPi.events.on("atomic:workflow-stage-late-message", onHeavyLateMessage);
						}
					},
				};
			},
		});
	if (order === "workflow-first") {
		registerWorkflow();
		registerIntercom();
	} else {
		registerIntercom();
		registerWorkflow();
	}
	registerWorkflow();
	return {
		bus,
		get heavyImports() {
			return heavyImports;
		},
	};
}

test("production listener composition preserves the workflow owner's failed revival completion in either order", async () => {
	for (const order of ["workflow-first", "intercom-first"] as const) {
		let resolutions = 0;
		const composition = productionComposition(order, () => {
			resolutions += 1;
			return undefined;
		});
		const admission = new InboundMessageAdmission();
		const tracker = new ReplyTracker();
		const message = ask();
		const sent = Promise.withResolvers<{
			to: string;
			options: { text: string; replyTo?: string; replyError?: string };
		}>();
		const client = {
			isConnected: () => true,
			async send(to: string, options: { text: string; replyTo?: string; replyError?: string }) {
				sent.resolve({ to, options });
				return { id: "failure-reply", delivered: true };
			},
		};
		routeClosedWorkflowStageMessage(
			{ from: sender, message, bodyText: message.content.text },
			admission,
			tracker,
			null,
			() => {
				const event: ComposedLateAskEvent = {
					handled: false,
					batch: false,
					workflowRunId: "run-1",
					workflowStageId: "stage-a",
					messages: [
						{
							customType: "intercom_message",
							content: "exact ask",
							details: { from: sender, message, bodyText: message.content.text },
						},
					],
				};
				composition.bus.emit("atomic:workflow-stage-late-message", event);
				assert.equal(event.handled, true);
				assert.ok(event.completion);
				return event.completion;
			},
			() => client as never,
			() => true,
			() => false,
		);
		const failure = await Promise.race([
			sent.promise,
			sleep(100).then(() => {
				throw new Error(`correlated failure timed out for ${order}`);
			}),
		]);
		const exact =
			"Completed workflow stage could not process intercom ask: Intercom ask target is unavailable: completed workflow stage run-1/stage-a was deleted or is no longer retained.";
		assert.deepEqual(failure, {
			to: sender.id,
			options: { text: exact, replyTo: message.id, replyError: exact },
		});
		assert.equal(resolutions, 1, "duplicate workflow listeners cannot double-fail");
		assert.equal(composition.heavyImports, 0, "the generic Intercom stub cannot steal a completed-stage ask");
	}
});

test("production listener composition revives a completed stage exactly once in either order", async () => {
	for (const order of ["workflow-first", "intercom-first"] as const) {
		const prompts: string[] = [];
		const handle: StageControlHandle = {
			runId: "run-1",
			stageId: "stage-a",
			stageName: "A",
			status: "completed",
			sessionId: "stage-a-session",
			sessionFile: "/tmp/stage-a.jsonl",
			isStreaming: false,
			messages: [],
			ensureAttached: async () => {},
			prompt: async (text) => {
				prompts.push(text);
			},
			steer: async () => {},
			followUp: async () => {},
			pause: async () => {},
			resume: async () => {},
			subscribe: () => () => {},
		};
		const composition = productionComposition(order, () => ({ ok: true, handle }));
		const event: ComposedLateAskEvent = {
			handled: false,
			batch: false,
			workflowRunId: "run-1",
			workflowStageId: "stage-a",
			messages: [
				{
					customType: "intercom_message",
					content: "exact retained turn",
					details: { from: sender, message: ask(), bodyText: "exact retained turn" },
				},
			],
		};
		composition.bus.emit("atomic:workflow-stage-late-message", event);
		assert.ok(event.completion);
		await event.completion;
		assert.deepEqual(prompts, ["exact retained turn"]);
		assert.equal(composition.heavyImports, 0);
	}
});

test("production listener composition retains ordinary late Intercom handling", async () => {
	for (const order of ["workflow-first", "intercom-first"] as const) {
		const relayed: unknown[] = [];
		const composition = productionComposition(
			order,
			() => {
				throw new Error("ordinary traffic must not resolve a completed-stage handle");
			},
			(payload) => {
				relayed.push(payload);
			},
		);
		const message = { ...ask(), expectsReply: false };
		const event: ComposedLateAskEvent = {
			handled: false,
			batch: false,
			workflowRunId: "run-1",
			workflowStageId: "stage-a",
			messages: [
				{
					customType: "intercom_message",
					content: "ordinary notice",
					details: { from: sender, message, bodyText: "ordinary notice" },
				},
			],
		};
		composition.bus.emit("atomic:workflow-stage-late-message", event);
		assert.equal(event.handled, true);
		assert.ok(event.completion);
		await event.completion;
		assert.deepEqual(relayed, [event]);
		assert.equal(composition.heavyImports, 1);
	}
});

test("the ask tool receives the production-composed correlated revival failure without its long timeout", async () => {
	const composition = productionComposition("workflow-first", () => undefined);
	const targetAdmission = new InboundMessageAdmission();
	const targetTracker = new ReplyTracker();
	const callerWaiter = new ReplyWaiterRegistry();
	const caller: SessionInfo = {
		id: "stage-b-intercom",
		name: "B",
		cwd: "/repo",
		model: "test",
		pid: 2,
		startedAt: 1,
		lastActivity: 1,
	};
	const target: SessionInfo = {
		id: "stage-a-intercom",
		name: "A",
		cwd: "/repo",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	};
	const targetClient = {
		isConnected: () => true,
		async send(_to: string, options: { text: string; replyTo?: string; replyError?: string }) {
			const routed = routeIncomingReply(callerWaiter.pending(), target, {
				id: "correlated-failure",
				timestamp: Date.now(),
				replyTo: options.replyTo,
				replyError: options.replyError,
				content: { text: options.text },
			});
			assert.equal(routed, true);
			return { id: "correlated-failure", delivered: true };
		},
	};
	let registered:
		| {
				execute(
					id: string,
					params: Record<string, string>,
					signal: AbortSignal | undefined,
					update: undefined,
					ctx: object,
				): Promise<{
					content: Array<{ text: string }>;
					isError: boolean;
				}>;
		  }
		| undefined;
	const callerClient = {
		sessionId: caller.id,
		async listSessions() {
			return [target];
		},
		async send(_to: string, outgoing: { messageId?: string; text: string; expectsReply?: boolean }) {
			const inbound: Message = {
				id: outgoing.messageId ?? "missing",
				timestamp: Date.now(),
				expectsReply: outgoing.expectsReply,
				content: { text: outgoing.text },
			};
			routeClosedWorkflowStageMessage(
				{ from: caller, message: inbound, bodyText: inbound.content.text },
				targetAdmission,
				targetTracker,
				null,
				() => {
					const event: ComposedLateAskEvent = {
						handled: false,
						batch: false,
						workflowRunId: "run-1",
						workflowStageId: "stage-a",
						messages: [
							{
								customType: "intercom_message",
								content: outgoing.text,
								details: { from: caller, message: inbound, bodyText: inbound.content.text },
							},
						],
					};
					composition.bus.emit("atomic:workflow-stage-late-message", event);
					assert.ok(event.completion);
					return event.completion;
				},
				() => targetClient as never,
				() => true,
				() => false,
			);
			return { id: inbound.id, delivered: true };
		},
	};
	registerIntercomTool(
		{
			registerTool(tool: typeof registered) {
				registered = tool;
			},
			appendEntry() {},
		} as never,
		{
			ensureConnected: async () => callerClient,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => target.id,
			beginReplyWait(from: string, replyTo: string, signal?: AbortSignal) {
				return callerWaiter.begin(from, replyTo, signal);
			},
			confirmSend: false,
			replyTracker: new ReplyTracker(),
		} as never,
	);
	assert.ok(registered);
	const started = performance.now();
	const result = await registered.execute(
		"tool-call",
		{ action: "ask", to: target.id, message: "exact ask" },
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => caller.id }, hasUI: false },
	);
	assert.ok(performance.now() - started < 1_000, "failure must arrive well below the 10-minute ask timeout");
	const exact =
		"Completed workflow stage could not process intercom ask: Intercom ask target is unavailable: completed workflow stage run-1/stage-a was deleted or is no longer retained.";
	assert.equal(result.isError, true);
	assert.equal(result.content[0]?.text, `Failed: ${exact}`);
	assert.equal(callerWaiter.has(), false);
});
