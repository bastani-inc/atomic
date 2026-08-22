import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import {
	ForegroundDetachHandoff,
	handleForegroundInboundDelivery,
} from "../../packages/intercom/foreground-detach-handoff.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import {
	PARENT_ASK_PAUSE_REQUEST_EVENT,
	type ParentAskPauseRequest,
	requestParentAskPause,
} from "../../packages/intercom/parent-ask-pause.js";
import { routeIncomingReply } from "../../packages/intercom/reply-routing.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterSlot } from "../../packages/intercom/reply-waiter.js";
import type { Attachment, Message, SessionInfo } from "../../packages/intercom/types.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { registerExecutionParentAskPause } from "../../packages/subagents/src/runs/foreground/execution-parent-ask-pause.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

function agentConfig(): AgentConfig {
	return {
		name: "fake-worker",
		description: "Fake worker",
		source: "project",
		filePath: "fake-worker.md",
		systemPrompt: "Work.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		model: "provider-a/stalled",
		fallbackModels: ["provider-b/working"],
	};
}

function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: object,
	): Promise<{ content: Array<{ text: string }>; isError: boolean }>;
};

function fixture(kind: "intercom" | "supervisor") {
	let tool: Tool | undefined;
	const sent: Array<{
		to: string;
		supervisor: boolean;
		message: {
			messageId?: string;
			text: string;
			attachments?: Attachment[];
			expectsReply?: boolean;
			replyTo?: string;
		};
	}> = [];
	const waiterCalls: Array<{ from: string; replyTo: string }> = [];
	const emitter = new EventEmitter();
	let connectCalls = 0;
	const slot = new ReplyWaiterSlot();
	const client = {
		sessionId: "child-id",
		supervisorSessionId: "parent-id",
		async listSessions() {
			return [];
		},
		async send(
			to: string,
			message: {
				messageId?: string;
				text: string;
				attachments?: Attachment[];
				expectsReply?: boolean;
				replyTo?: string;
			},
		) {
			sent.push({ to, message, supervisor: false });
			return { id: message.messageId ?? "sent", delivered: true };
		},
		async sendToSupervisor(
			to: string,
			message: {
				messageId?: string;
				text: string;
				attachments?: Attachment[];
				expectsReply?: boolean;
				replyTo?: string;
			},
		) {
			sent.push({ to, message, supervisor: true });
			return { id: message.messageId ?? "sent", delivered: true };
		},
	};
	const pi = {
		events: {
			on(channel: string, handler: (payload: unknown) => void) {
				emitter.on(channel, handler);
				return () => emitter.off(channel, handler);
			},
			emit(channel: string, payload: unknown) {
				emitter.emit(channel, payload);
			},
		},
		registerTool(value: Tool) {
			tool = value;
		},
		appendEntry() {},
	};
	const common = {
		ensureConnected: async () => {
			connectCalls += 1;
			return client;
		},
		syncPresenceIdentity() {},
		resolveSessionTarget: async (_client: object, target: string) => (target === "parent" ? "parent-id" : target),
		beginReplyWait(from: string, replyTo: string, signal?: AbortSignal) {
			waiterCalls.push({ from, replyTo });
			return slot.begin(from, replyTo, signal);
		},
		hasReplyWaiter: () => slot.has(),
	};
	if (kind === "intercom") {
		registerIntercomTool(
			pi as never,
			{
				...common,
				confirmSend: false,
				replyTracker: new ReplyTracker(),
				childOrchestratorMetadata: {
					orchestratorTarget: "parent",
					runId: "run",
					agent: "worker",
					index: 2,
					sessionName: "subagent-worker-run-3",
				},
			} as never,
		);
	} else {
		registerContactSupervisorTool(
			pi as never,
			{
				...common,
				childOrchestratorMetadata: {
					orchestratorTarget: "parent",
					runId: "run",
					agent: "worker",
					index: 2,
					sessionName: "subagent-worker-run-3",
					supervisor: { capability: "capability", supervisorSessionId: "stale-parent-id" },
				},
			} as never,
		);
	}
	return {
		events: pi.events,
		get connectCalls() {
			return connectCalls;
		},
		sent,
		waiterCalls,
		get waiter() {
			return slot.current() ?? undefined;
		},
		get tool() {
			assert.ok(tool);
			return tool;
		},
		reply(text: string, replyError?: string) {
			const current = slot.current();
			assert.ok(current);
			current.resolve({
				id: "reply",
				timestamp: 2,
				replyTo: current.replyTo,
				...(replyError !== undefined ? { replyError } : {}),
				content: { text },
			});
		},
	};
}

const context = { sessionManager: { getSessionId: () => "child-session" }, hasUI: false };

describe("registered blocking intercom tools", () => {
	test("contact_supervisor need_decision yields to a claimed parent ask before broker connection", async () => {
		const current = fixture("supervisor");
		let captured: ParentAskPauseRequest | undefined;
		current.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, (payload) => {
			captured = payload as ParentAskPauseRequest;
			captured.claimed = true;
		});

		const result = await current.tool.execute(
			"call",
			{ reason: "need_decision", message: "Choose verbatim" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false);
		assert.equal(current.connectCalls, 0);
		assert.equal(current.sent.length, 0);
		assert.equal(current.waiterCalls.length, 0);
		assert.equal(captured?.kind, "decision");
		assert.equal(captured?.question, "Choose verbatim");
		assert.equal(captured?.runId, "run");
		assert.equal(captured?.index, 2);
		assert.equal(captured?.agent, "worker");
	});
	test("contact_supervisor interview_request preserves validated question order in the pause request", async () => {
		const current = fixture("supervisor");
		let captured: ParentAskPauseRequest | undefined;
		current.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, (payload) => {
			captured = payload as ParentAskPauseRequest;
			captured.claimed = true;
		});

		const result = await current.tool.execute(
			"call",
			{
				reason: "interview_request",
				message: "Answer both",
				interview: {
					title: "Choices",
					questions: [
						{ id: "first", type: "single", question: "Pick", options: ["A", "B"] },
						{ id: "second", type: "text", question: "Why?" },
					],
				},
			},
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false);
		assert.equal(current.connectCalls, 0);
		assert.equal(captured?.kind, "interview");
		assert.equal(captured?.question, "Answer both");
		assert.deepEqual(
			captured?.interview?.questions.map((question) => question.id),
			["first", "second"],
		);
		assert.deepEqual(captured?.interview?.questions[0]?.options, ["A", "B"]);
	});
	test("intercom ask yields when its target resolves to the launching parent", async () => {
		const current = fixture("intercom");
		let captured: ParentAskPauseRequest | undefined;
		current.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, (payload) => {
			captured = payload as ParentAskPauseRequest;
			captured.claimed = true;
		});

		const result = await current.tool.execute(
			"call",
			{ action: "ask", to: "parent", message: "Keep  spacing\nraw" },
			undefined,
			undefined,
			context,
		);

		assert.equal(result.isError, false);
		assert.equal(current.connectCalls, 1);
		assert.equal(current.sent.length, 0);
		assert.equal(current.waiterCalls.length, 0);
		assert.equal(captured?.kind, "intercom");
		assert.equal(captured?.question, "Keep  spacing\nraw");
		assert.equal(captured?.resolvedTargetId, "parent-id");
	});
	test("parent-targeted intercom ask preserves ordered attachments", async () => {
		const current = fixture("intercom");
		let captured: ParentAskPauseRequest | undefined;
		current.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, (payload) => {
			captured = payload as ParentAskPauseRequest;
			captured.claimed = true;
		});
		const attachments: Attachment[] = [
			{ type: "file", name: "first.txt", content: "first  content" },
			{ type: "snippet", name: "duplicate", content: "const x = 1;", language: "ts" },
			{ type: "context", name: "duplicate", content: "last\ncontext" },
		];
		const result = await current.tool.execute(
			"call",
			{ action: "ask", to: "parent", message: "Review attachments", attachments },
			undefined,
			undefined,
			context,
		);
		assert.equal(result.isError, false);
		assert.equal(captured?.attachments, attachments);
		assert.deepEqual(captured?.attachments, attachments);
		assert.equal(current.sent.length, 0);
	});
	test("intercom ask also yields for the exact launching-parent session ID", async () => {
		const current = fixture("intercom");
		let captured: ParentAskPauseRequest | undefined;
		current.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, (payload) => {
			captured = payload as ParentAskPauseRequest;
			captured.claimed = true;
		});
		const result = await current.tool.execute(
			"call",
			{ action: "ask", to: "parent-id", message: "Exact parent ID" },
			undefined,
			undefined,
			context,
		);
		assert.equal(result.isError, false);
		assert.equal(captured?.resolvedTargetId, "parent-id");
		assert.equal(current.waiterCalls.length, 0);
	});

	test("intercom ask to a non-parent peer keeps the normal waiter and send path", async () => {
		const current = fixture("intercom");
		let parentAskEvents = 0;
		current.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, () => {
			parentAskEvents += 1;
		});
		const execution = current.tool.execute(
			"call",
			{ action: "ask", to: "sibling", message: "Peer question" },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		assert.equal(parentAskEvents, 0);
		assert.equal(current.sent[0]?.to, "sibling");
		assert.equal(current.waiterCalls.length, 1);
		current.reply("Peer answer");
		assert.equal((await execution).isError, false);
	});
	test("non-parent intercom ask sends attachments unchanged", async () => {
		const current = fixture("intercom");
		const attachments: Attachment[] = [
			{ type: "snippet", name: "same", content: "one", language: "txt" },
			{ type: "context", name: "same", content: "two" },
		];
		const execution = current.tool.execute(
			"call",
			{ action: "ask", to: "sibling", message: "Peer attachments", attachments },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		assert.equal(current.sent[0]?.message.attachments, attachments);
		current.reply("Received");
		assert.equal((await execution).isError, false);
	});
	test("intercom ask waits for an exact threaded reply and resumes", async () => {
		const current = fixture("intercom");
		const execution = current.tool.execute(
			"call",
			{ action: "ask", to: "parent", message: "Choose" },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		assert.equal(current.sent.length, 1);
		const question = current.sent[0]!;
		assert.equal(question.to, "parent-id");
		assert.equal(question.message.expectsReply, true);
		assert.equal(typeof question.message.messageId, "string");
		assert.deepEqual(current.waiterCalls, [{ from: "parent-id", replyTo: question.message.messageId }]);
		assert.equal(current.waiter?.replyTo, question.message.messageId);
		current.reply("Approved");
		const result = await execution;
		assert.equal(result.isError, false);
		assert.match(result.content[0]?.text ?? "", /Approved/);
		assert.equal(
			context.sessionManager.getSessionId(),
			"child-session",
			"the same foreground child continues after its reply",
		);
	});

	test("intercom ask surfaces a correlated completed-target revival failure as a tool error", async () => {
		const current = fixture("intercom");
		const execution = current.tool.execute(
			"call",
			{ action: "ask", to: "parent", message: "Choose" },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		current.reply(
			"Completed workflow stage could not process intercom ask",
			"Completed workflow stage is not resumable",
		);
		const result = await execution;
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, "Failed: Completed workflow stage is not resumable");
	});

	test("contact_supervisor need_decision uses the same threaded waiter path", async () => {
		const current = fixture("supervisor");
		const execution = current.tool.execute(
			"call",
			{ reason: "need_decision", message: "Choose" },
			undefined,
			undefined,
			context,
		);
		await sleep(0);
		assert.equal(current.sent.length, 1);
		assert.equal(current.sent[0]?.to, "parent-id");
		assert.equal(current.sent[0]?.message.expectsReply, true);
		assert.equal(current.sent[0]?.supervisor, true);
		assert.deepEqual(current.waiterCalls, [{ from: "parent-id", replyTo: current.sent[0]?.message.messageId }]);
		current.reply("Use option B");
		const result = await execution;
		assert.equal(result.isError, false);
		assert.match(result.content[0]?.text ?? "", /Use option B/);
	});

	test("send and progress_update return without creating a reply waiter", async () => {
		const send = fixture("intercom");
		let parentAskEvents = 0;
		send.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, () => {
			parentAskEvents += 1;
		});
		const sent = await send.tool.execute(
			"call",
			{ action: "send", to: "parent", message: "Update" },
			undefined,
			undefined,
			context,
		);
		assert.equal(sent.isError, false);
		assert.equal(send.sent[0]?.message.expectsReply, undefined);
		assert.equal(send.waiterCalls.length, 0);
		assert.equal(parentAskEvents, 0);

		const progress = fixture("supervisor");
		progress.events.on(PARENT_ASK_PAUSE_REQUEST_EVENT, () => {
			parentAskEvents += 1;
		});
		const updated = await progress.tool.execute(
			"call",
			{ reason: "progress_update", message: "Halfway" },
			undefined,
			undefined,
			context,
		);
		assert.equal(updated.isError, false);
		assert.equal(progress.sent[0]?.message.expectsReply, undefined);
		assert.equal(progress.sent[0]?.supervisor, true);
		assert.equal(progress.waiterCalls.length, 0);
		assert.equal(parentAskEvents, 0);
	});
});

type EventPayload = Record<string, unknown>;

function joinedBus(emitter: EventEmitter, order: string[]) {
	return {
		on(channel: string, handler: (payload: EventPayload) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: EventPayload) {
			if (channel.endsWith("detach-request")) order.push(String(payload.phase));
			emitter.emit(channel, payload);
		},
	};
}

test("a child-scoped event bus claims the exact live parent execution through the process channel", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-parent-ask-claim-"));
	const gate = deferred();
	const emitter = new EventEmitter();
	const listenerReady = Promise.withResolvers<void>();
	const interruptController = new AbortController();
	let captured: ParentAskPauseRequest | undefined;
	const bus = {
		on(channel: string, handler: (payload: unknown) => void) {
			emitter.on(channel, handler);
			if (channel === PARENT_ASK_PAUSE_REQUEST_EVENT) listenerReady.resolve();
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			emitter.emit(channel, payload);
		},
	};
	const childEmitter = new EventEmitter();
	const childBus = {
		on(channel: string, handler: (payload: unknown) => void) {
			childEmitter.on(channel, handler);
			return () => childEmitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			childEmitter.emit(channel, payload);
		},
	};
	try {
		const foreground = runSync(dir, [agentConfig()], "fake-worker", "task", {
			cwd: dir,
			runId: "exact-run",
			index: 0,
			intercomSessionName: "subagent-fake-worker-exact-run-1",
			orchestratorIntercomTarget: "parent-id",
			intercomEvents: bus,
			interruptSignal: interruptController.signal,
			onParentAskClaim: (request) => {
				captured = request;
				interruptController.abort();
			},
			testSession: { output: "must not complete", promptGate: gate.promise, abortResolvesPrompt: true },
		});
		const registered = await Promise.race([listenerReady.promise.then(() => true), sleep(100).then(() => false)]);
		if (!registered) {
			interruptController.abort();
			await foreground;
			assert.fail("parent-ask listener was not registered");
		}
		const claimed = requestParentAskPause(
			childBus as never,
			{
				runId: "exact-run",
				index: "0",
				agent: "fake-worker",
				sessionName: "subagent-fake-worker-exact-run-1",
				orchestratorTarget: "parent-id",
			},
			{ kind: "decision", question: "Which option?" },
		);
		const result = await foreground;

		assert.equal(claimed, true);
		assert.equal(captured?.question, "Which option?");
		assert.equal(result.status, "interrupted");
		assert.equal(result.interrupted, true);
		assert.notEqual(result.finalOutput, "must not complete");
		assert.equal(
			requestParentAskPause(
				childBus as never,
				{
					runId: "exact-run",
					index: "0",
					agent: "fake-worker",
					sessionName: "subagent-fake-worker-exact-run-1",
					orchestratorTarget: "parent-id",
				},
				{ kind: "decision", question: "After cleanup" },
			),
			false,
		);
	} finally {
		gate.release();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a parent ask request can be claimed only once", () => {
	const emitter = new EventEmitter();
	const events = {
		on(channel: string, handler: (payload: unknown) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			emitter.emit(channel, payload);
		},
	};
	let claims = 0;
	for (let listener = 0; listener < 2; listener++) {
		registerExecutionParentAskPause(
			{
				runId: "same-run",
				index: 0,
				intercomSessionName: "same-child",
				orchestratorIntercomTarget: "same-parent",
				intercomEvents: events,
				onParentAskClaim: () => {
					claims += 1;
				},
			},
			{ agent: "worker", isUnavailable: () => false },
		);
	}
	const unmatched: ParentAskPauseRequest[] = [
		{
			runId: "other-run",
			index: 0,
			agent: "worker",
			childIntercomTarget: "same-child",
			orchestratorTarget: "same-parent",
			kind: "decision",
			question: "wrong run",
			claimed: false,
		},
		{
			runId: "same-run",
			index: 1,
			agent: "worker",
			childIntercomTarget: "same-child",
			orchestratorTarget: "same-parent",
			kind: "decision",
			question: "wrong index",
			claimed: false,
		},
		{
			runId: "same-run",
			index: 0,
			agent: "worker",
			childIntercomTarget: "other-child",
			orchestratorTarget: "same-parent",
			kind: "decision",
			question: "wrong child",
			claimed: false,
		},
	];
	for (const candidate of unmatched) events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, candidate);
	assert.ok(unmatched.every((candidate) => !candidate.claimed));
	assert.equal(claims, 0);
	const request: ParentAskPauseRequest = {
		runId: "same-run",
		index: 0,
		agent: "worker",
		childIntercomTarget: "same-child",
		orchestratorTarget: "same-parent",
		kind: "decision",
		question: "one owner",
		claimed: false,
	};
	events.emit(PARENT_ASK_PAUSE_REQUEST_EVENT, request);
	assert.equal(request.claimed, true);
	assert.equal(claims, 1);
});

for (const kind of ["intercom", "supervisor"] as const) {
	test(`joined production inbound handoff resumes ${kind === "intercom" ? "generic ask" : "contact_supervisor need_decision"}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), `atomic-intercom-joined-${kind}-`));
		const gate = deferred();
		try {
			const emitter = new EventEmitter();
			const order: string[] = [];
			const bus = joinedBus(emitter, order);
			const piForHandoff = { events: bus };
			const childTarget = "subagent-worker-joined-1";
			const recovered: SingleResult[] = [];
			const recoveredExit = Promise.withResolvers<SingleResult>();
			const foreground = runSync(
				dir,
				[{ ...agentConfig(), systemPrompt: "Intercom orchestration channel" }],
				"fake-worker",
				"task",
				{
					cwd: dir,
					runId: "joined",
					index: 0,
					intercomSessionName: childTarget,
					allowIntercomDetach: true,
					intercomEvents: bus,
					testSession: { output: "eventual recovered child result", promptGate: gate.promise },
					onDetachedExit: (value) => {
						recovered.push(value);
						recoveredExit.resolve(value);
					},
				},
			);

			let registered: Tool | undefined;
			const slot = new ReplyWaiterSlot();
			const surfaced: Message[] = [];
			const handoff = new ForegroundDetachHandoff(piForHandoff as never, 1000);
			const from: SessionInfo = {
				id: "child-id",
				name: childTarget,
				cwd: dir,
				model: "test",
				pid: 1,
				startedAt: 1,
				lastActivity: 1,
				status: "thinking",
			};
			const client = {
				sessionId: "child-id",
				async listSessions() {
					return [];
				},
				async send(
					_to: string,
					outgoing: { messageId?: string; text: string; expectsReply?: boolean; replyTo?: string },
				) {
					const message: Message = {
						id: outgoing.messageId ?? "missing",
						timestamp: Date.now(),
						expectsReply: outgoing.expectsReply,
						replyTo: outgoing.replyTo,
						content: { text: outgoing.text },
					};
					await handleForegroundInboundDelivery({
						handoff,
						from,
						message,
						generation: 7,
						isCurrent: () => true,
						surface: () => {
							order.push("surface");
							surfaced.push(message);
						},
						onUnclaimed: () => {
							throw new Error("exact foreground owner was not found");
						},
					});
					return { id: message.id, delivered: true };
				},
				async sendToSupervisor(
					_to: string,
					outgoing: { messageId?: string; text: string; expectsReply?: boolean; replyTo?: string },
				) {
					return this.send(_to, outgoing);
				},
			};
			const common = {
				ensureConnected: async () => client,
				syncPresenceIdentity() {},
				resolveSessionTarget: async () => "parent-id",
				beginReplyWait(from: string, replyTo: string, signal?: AbortSignal) {
					return slot.begin(from, replyTo, signal);
				},
				hasReplyWaiter: () => slot.has(),
			};
			const toolPi = {
				registerTool(value: Tool) {
					registered = value;
				},
				appendEntry() {},
			};
			if (kind === "intercom")
				registerIntercomTool(
					toolPi as never,
					{ ...common, confirmSend: false, replyTracker: new ReplyTracker() } as never,
				);
			else
				registerContactSupervisorTool(
					toolPi as never,
					{
						...common,
						childOrchestratorMetadata: {
							orchestratorTarget: "parent",
							runId: "joined",
							agent: "worker",
							index: 0,
						},
					} as never,
				);
			assert.ok(registered);
			const toolExecution =
				kind === "intercom"
					? registered.execute(
							"call",
							{ action: "ask", to: "parent", message: "Choose" },
							undefined,
							undefined,
							context,
						)
					: registered.execute(
							"call",
							{ reason: "need_decision", message: "Choose" },
							undefined,
							undefined,
							context,
						);

			const detached = await foreground;
			assert.equal(detached.status, "continued");
			assert.equal(detached.detached, true);
			assert.equal(surfaced.length, 1);
			assert.deepEqual(order.slice(0, 3), ["probe", "commit", "surface"]);
			assert.equal(slot.current()?.replyTo, surfaced[0]?.id);
			order.push("reply");
			const routed = routeIncomingReply(
				slot.current(),
				{
					id: "parent-id",
					name: "parent",
					cwd: dir,
					model: "test",
					pid: 2,
					startedAt: 1,
					lastActivity: 1,
					status: "waiting",
				},
				{ id: "parent-reply", timestamp: Date.now(), replyTo: surfaced[0]?.id, content: { text: "Approved" } },
			);
			assert.equal(routed, true, "production routing seam accepts the exact threaded parent reply");
			const resumed = await toolExecution;
			assert.equal(resumed.isError, false);
			assert.match(resumed.content[0]?.text ?? "", /Approved/);
			order.push("continued");
			gate.release();
			const recoveredResult = await recoveredExit.promise;
			assert.equal(recovered.length, 1);
			assert.equal(recoveredResult.status, "ok");
			assert.match(recoveredResult.finalOutput ?? "", /eventual recovered child result/);
			assert.ok(order.indexOf("continued") > order.indexOf("reply"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
