import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createSessionAsyncDeliveryHandler } from "../src/core/async/session-manager.ts";
import type { SendMessageOptions, SendMessagesOptions } from "../src/core/extensions/index.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.ts";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../src/core/agent-session-persistent-custom-messages.ts";
import { StageSessionReplacement } from "../../workflows/src/runs/foreground/stage-runner-replacement.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

type QueueHold = {
	readonly steering: AgentMessage[];
	readonly followUp: AgentMessage[];
};

type CustomInput = Pick<CustomMessage, "customType" | "content" | "display" | "details">;

type TransferSession = AgentSession & {
	readonly _activeInterruptQueueHold?: QueueHold;
	_agentEventQueue: Promise<void>;
	_queuedMessagesPauseAbortBoundary: Promise<void> | undefined;
	_workflowStageAdmission: WorkflowStageAdmissionBoundary | undefined;
	_orchestrationContext: {
		lateMessageRouter: {
			routeMessage(message: CustomInput): void;
			routeMessages(messages: CustomInput[]): void;
		};
	} | undefined;
	readonly _protectedStreamingCustomMessages: Array<{
		readonly message: AgentMessage;
		readonly delivery: "steer" | "followUp";
		readonly phase: "queued" | "consumed-unpersisted" | "persistence-failed";
	}>;
	sendCustomMessages(messages: CustomInput[], options?: SendMessagesOptions): Promise<void>;
	transferWorkflowStageDeliveriesTo(target: object): void;
};

function rawUser(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function shareAdmissionBoundary(source: TransferSession, target: TransferSession): {
  readonly boundary: WorkflowStageAdmissionBoundary;
  readonly late: string[];
} {
  const boundary = new WorkflowStageAdmissionBoundary();
  const late: string[] = [];
  const lateMessageRouter = {
    routeMessage(message: CustomInput) { late.push(message.customType); },
    routeMessages(messages: CustomInput[]) { late.push(...messages.map((message) => message.customType)); },
  };
  source._workflowStageAdmission = boundary;
  target._workflowStageAdmission = boundary;
  source._orchestrationContext = { lateMessageRouter };
  target._orchestrationContext = { lateMessageRouter };
  return { boundary, late };
}

function barrierOptions(
  key: string,
  entered: PromiseWithResolvers<void>,
  release: PromiseWithResolvers<void>,
  extra: SendMessageOptions = {},
): SendMessageOptions {
  return {
    triggerTurn: true,
    deliverAs: "followUp",
    ...extra,
    stageAdmissionKey: key,
    stageAdmissionBarrier: () => { entered.resolve(); return release.promise; },
  };
}

describe("paused queue stage-session transfer", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("older source hold and display state transfer before newer source and target traffic", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		target.setResponses([
			fauxAssistantMessage("resume"),
			fauxAssistantMessage("steering"),
			fauxAssistantMessage("follow-up"),
		]);

		source.session.pauseQueuedMessages();
		await source.session.steer("old source held steer");
		await source.session.followUp("duplicate old source follow-up");
		await source.session.followUp("duplicate old source follow-up");
		source.session.agent.steer(rawUser("newer source live steer"));
		source.session.agent.followUp(rawUser("newer source live follow-up"));
		await target.session.steer("newest target steer");
		await target.session.followUp("newest target follow-up");

		const replacement = new StageSessionReplacement();
		replacement.retire(source.session);
		replacement.adopt(target.session);

		expect(source.session.queuedMessagesPaused).toBe(false);
		expect(source.session.pendingMessageCount).toBe(0);
		expect(source.session.getSteeringMessages()).toEqual([]);
		expect(source.session.getFollowUpMessages()).toEqual([]);
		expect(source.session.agent.hasQueuedMessages()).toBe(false);

		expect(target.session.queuedMessagesPaused).toBe(true);
		expect(target.session.pendingMessageCount).toBe(5);
		expect(target.session.getSteeringMessages()).toEqual([
			"old source held steer",
			"newest target steer",
		]);
		expect(target.session.getFollowUpMessages()).toEqual([
			"duplicate old source follow-up",
			"duplicate old source follow-up",
			"newest target follow-up",
		]);
		const hold = (target.session as TransferSession)._activeInterruptQueueHold;
		expect(hold?.steering.map(getMessageText)).toEqual([
			"old source held steer",
			"newer source live steer",
			"newest target steer",
		]);
		expect(hold?.followUp.map(getMessageText)).toEqual([
			"duplicate old source follow-up",
			"duplicate old source follow-up",
			"newer source live follow-up",
			"newest target follow-up",
		]);

		await target.session.resumeQueuedMessages();
		expect(target.getPendingResponseCount()).toBe(3, "resume only releases the transfer hold");
		await target.session.prompt("resume transfer driver");

		expect(target.getPendingResponseCount()).toBe(0);
		expect(target.session.pendingMessageCount).toBe(0);
		expect(target.session.getSteeringMessages()).toEqual([]);
		expect(target.session.getFollowUpMessages()).toEqual([]);
		const delivered = target.session.messages
			.filter((message) => message.role === "user")
			.map(getMessageText)
			.filter((text) => text !== "resume transfer driver");
		expect(delivered).toEqual([
			"old source held steer",
			"newer source live steer",
			"newest target steer",
			"duplicate old source follow-up",
			"duplicate old source follow-up",
			"newer source live follow-up",
			"newest target follow-up",
		]);
	});

	test("a rejecting transferred boundary waits for a newer target abort boundary before retry cleanup", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		target.setResponses([
			fauxAssistantMessage("resume driver"),
			fauxAssistantMessage("held follow-up"),
		]);
		const exactHeldContent = "\ttransferred held content  \n";
		const older = Promise.withResolvers<void>();
		const newer = Promise.withResolvers<void>();
		const originalError = new Error("transient transferred pause settlement");
		source.session.pauseQueuedMessages();
		await source.session.followUp(exactHeldContent);
		(source.session as TransferSession)._queuedMessagesPauseAbortBoundary = older.promise;

		(source.session as TransferSession).transferWorkflowStageDeliveriesTo(target.session);
		const targetInternal = target.session as TransferSession;
		targetInternal._agentEventQueue = newer.promise;
		const newerAbortBoundary = target.session.abort();
		const combinedBoundary = targetInternal._queuedMessagesPauseAbortBoundary;
		const firstResume = target.session.resumeQueuedMessages();
		let firstResumeState: "pending" | "fulfilled" | "rejected" = "pending";
		let firstResumeRejections = 0;
		void firstResume.then(
			() => { firstResumeState = "fulfilled"; },
			() => { firstResumeState = "rejected"; firstResumeRejections += 1; },
		);

		older.reject(originalError);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(firstResumeState).toBe("pending");
		expect(target.session.queuedMessagesPaused).toBe(true);
		expect(targetInternal._queuedMessagesPauseAbortBoundary).toBe(combinedBoundary);

		newer.resolve();
		await newerAbortBoundary;
		await expect(firstResume).rejects.toBe(originalError);
		expect(firstResumeState).toBe("rejected");
		expect(firstResumeRejections).toBe(1);
		expect(target.session.queuedMessagesPaused).toBe(true);
		expect(targetInternal._queuedMessagesPauseAbortBoundary).toBeUndefined();
		expect(await target.session.resumeQueuedMessages()).toBe(true);
		await target.session.prompt("resume transferred boundary");
		expect(target.session.messages.filter(
			(message) => message.role === "user" && getMessageText(message) === exactHeldContent,
		)).toHaveLength(1);
	});

	test("successful transferred pause boundaries settle only after every constituent", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		const older = Promise.withResolvers<void>();
		const newer = Promise.withResolvers<void>();
		source.session.pauseQueuedMessages();
		target.session.pauseQueuedMessages();
		(source.session as TransferSession)._queuedMessagesPauseAbortBoundary = older.promise;
		(target.session as TransferSession)._queuedMessagesPauseAbortBoundary = newer.promise;
		(source.session as TransferSession).transferWorkflowStageDeliveriesTo(target.session);
		const resume = target.session.resumeQueuedMessages();
		let settled = false;
		void resume.finally(() => { settled = true; });

		older.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		expect(target.session.queuedMessagesPaused).toBe(true);
		newer.resolve();
		expect(await resume).toBe(false);
		expect(target.session.queuedMessagesPaused).toBe(false);
	});

	test("an in-flight protected delivery commits only to the paused replacement after retirement", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		const providerStarted = Promise.withResolvers<void>();
		const finishSourceTurn = Promise.withResolvers<void>();
		const protectedAdmission = Promise.withResolvers<void>();
		source.setResponses([
			async () => {
				providerStarted.resolve();
				await finishSourceTurn.promise;
				return fauxAssistantMessage("source interrupted after transfer");
			},
			fauxAssistantMessage("must not consume retired delivery"),
		]);
		target.setResponses([fauxAssistantMessage("replacement consumed protected reconciliation")]);

		const sourceTurn = source.session.prompt("start source retirement race");
		await providerStarted.promise;
		const sourceInternal = source.session as TransferSession;
		sourceInternal._agentEventQueue = protectedAdmission.promise;
		source.session.agent.state.pendingToolCalls.add("in-flight-protected-delivery");
		const delivery = source.session.sendCustomMessage(
			{
				customType: "in-flight-protected-card",
				content: [{ type: "text", text: "preserve exact protected payload" }],
				display: true,
				details: { optional: undefined, sequence: 1 },
			},
			{ triggerTurn: true, persistWhenStreaming: true },
		);
		await Promise.resolve();
		source.session.pauseQueuedMessages();
		sourceInternal.transferWorkflowStageDeliveriesTo(target.session);
		source.session.agent.state.pendingToolCalls.delete("in-flight-protected-delivery");
		protectedAdmission.resolve();
		await delivery;
		finishSourceTurn.resolve();
		await sourceTurn;

		const targetInternal = target.session as TransferSession;
		expect(sourceInternal._protectedStreamingCustomMessages).toEqual([]);
		expect(source.session.agent.hasQueuedMessages()).toBe(false);
		expect(source.session.queuedMessagesPaused).toBe(false);
		expect(source.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "in-flight-protected-card",
		)).toHaveLength(0);
		expect(target.session.queuedMessagesPaused).toBe(true);
		expect(targetInternal._protectedStreamingCustomMessages).toHaveLength(1);
		expect(targetInternal._protectedStreamingCustomMessages[0]).toMatchObject({
			delivery: "steer",
			phase: "queued",
			message: { customType: PROTECTED_RECONCILIATION_CUSTOM_TYPE, display: false },
		});
		expect(target.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "in-flight-protected-card",
		)).toHaveLength(1);
		expect(targetInternal._activeInterruptQueueHold?.steering).toContain(
			targetInternal._protectedStreamingCustomMessages[0]?.message,
		);

		const released = await target.session.resumeQueuedMessages();
		expect(released).toBe(true);
		await target.session.prompt("resume replacement once");
		expect(targetInternal._protectedStreamingCustomMessages).toEqual([]);
		expect(target.session.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom_message" && entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE,
		)).toHaveLength(1);

	});

	test("retired forwarding rejects a reverse cycle and delivers later work once to the live target", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		source.session.pauseQueuedMessages();
		const sourceInternal = source.session as TransferSession;
		const targetInternal = target.session as TransferSession;

		sourceInternal.transferWorkflowStageDeliveriesTo(target.session);
		targetInternal.transferWorkflowStageDeliveriesTo(source.session);
		await source.session.steer("post-retirement forwarded once");

		expect(source.session.agent.hasQueuedMessages()).toBe(false);
		expect(source.session.pendingMessageCount).toBe(0);
		expect(target.session.queuedMessagesPaused).toBe(true);
		expect(targetInternal._activeInterruptQueueHold?.steering.map(getMessageText)).toEqual([
			"post-retirement forwarded once",
		]);
		expect(target.session.getSteeringMessages()).toEqual(["post-retirement forwarded once"]);
	});

	test("a prompt submitted through a retired session joins the paused replacement without starting the source", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		source.setResponses([fauxAssistantMessage("must remain unused on retired source")]);
		source.session.pauseQueuedMessages();
		const sourceInternal = source.session as TransferSession;
		const targetInternal = target.session as TransferSession;

		sourceInternal.transferWorkflowStageDeliveriesTo(target.session);
		await source.session.prompt("post-retirement prompt payload");

		expect(source.getPendingResponseCount()).toBe(1);
		expect(source.session.messages.some(
			(message) => message.role === "user" && getMessageText(message) === "post-retirement prompt payload",
		)).toBe(false);
		expect(target.session.queuedMessagesPaused).toBe(true);
		expect(targetInternal._activeInterruptQueueHold?.steering.map(getMessageText)).toEqual([
			"post-retirement prompt payload",
		]);
	});

	test("accepted single and batch commits bypass re-admission after replacement sealing", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		const sourceInternal = source.session as TransferSession;
		const targetInternal = target.session as TransferSession;
		const { boundary, late } = shareAdmissionBoundary(sourceInternal, targetInternal);
		target.session.pauseQueuedMessages();

		const singleEntered = Promise.withResolvers<void>();
		const singleRelease = Promise.withResolvers<void>();
		const single = source.session.sendCustomMessage(
			{ customType: "accepted-single", content: "single exact payload", display: true, details: { id: 1 } },
			barrierOptions("accepted-single", singleEntered, singleRelease),
		);
		await singleEntered.promise;
		sourceInternal.transferWorkflowStageDeliveriesTo(target.session);
		boundary.seal();
		singleRelease.resolve();
		await single;

		const secondSource = await createHarness();
		harnesses.push(secondSource);
		const secondSourceInternal = secondSource.session as TransferSession;
		secondSourceInternal._workflowStageAdmission = boundary;
		secondSourceInternal._orchestrationContext = sourceInternal._orchestrationContext;
		// Re-open only a separate generation for the batch race, then seal its
		// shared boundary after retirement exactly as the single generation did.
		const batchBoundary = new WorkflowStageAdmissionBoundary();
		secondSourceInternal._workflowStageAdmission = batchBoundary;
		targetInternal._workflowStageAdmission = batchBoundary;
		const batchEntered = Promise.withResolvers<void>();
		const batchRelease = Promise.withResolvers<void>();
		const batch = secondSourceInternal.sendCustomMessages([
			{ customType: "accepted-batch", content: "duplicate", display: true, details: { id: 2 } },
			{ customType: "accepted-batch", content: "duplicate", display: true, details: { id: 3 } },
		], barrierOptions("accepted-batch", batchEntered, batchRelease) as SendMessagesOptions);
		await batchEntered.promise;
		secondSourceInternal.transferWorkflowStageDeliveriesTo(target.session);
		batchBoundary.seal();
		batchRelease.resolve();
		await batch;

		const held = targetInternal._activeInterruptQueueHold?.followUp ?? [];
		expect(held.map((message) => message.role === "custom" ? `${message.customType}:${String(message.details && "id" in message.details ? message.details.id : "")}` : "other")).toEqual([
			"accepted-single:1",
			"accepted-batch:2",
			"accepted-batch:3",
		]);
		expect(late).toEqual([]);
		await source.session.sendCustomMessage(
			{ customType: "first-admitted-after-seal", content: "late normally", display: true },
			{ triggerTurn: true, stageAdmissionKey: "late-after-seal" },
		);
		expect(late).toEqual(["first-admitted-after-seal"]);
	});

	test("accepted protected async commit remains on the replacement after sealing", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		const sourceInternal = source.session as TransferSession;
		const targetInternal = target.session as TransferSession;
		const { boundary, late } = shareAdmissionBoundary(sourceInternal, targetInternal);
		target.session.pauseQueuedMessages();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();

		const deliverAsync = createSessionAsyncDeliveryHandler({
			sendCustomMessage(message, options) {
				return source.session.sendCustomMessage(message, {
					...options,
					persistWhenStreaming: true,
					stageAdmissionBarrier: () => { entered.resolve(); return release.promise; },
				});
			},
		});
		const delivery = deliverAsync({
			customType: "async-job-result",
			content: "\tprotected exact async payload  \n",
			display: true,
			details: {
				jobId: "protected-4",
				type: "bash",
				status: "completed",
				command: "printf protected",
			},
		});
		await entered.promise;
		sourceInternal.transferWorkflowStageDeliveriesTo(target.session);
		boundary.seal();
		release.resolve();
		await delivery;

		expect(late).toEqual([]);
		expect(target.session.messages.filter((message) => message.role === "custom" && message.customType === "async-job-result")).toHaveLength(1);
		expect(targetInternal._protectedStreamingCustomMessages).toHaveLength(1);
		expect(targetInternal._activeInterruptQueueHold?.followUp).toContain(targetInternal._protectedStreamingCustomMessages[0]?.message);
	});

	test("paused disposal persists transferred protected ownership in source-first order", async () => {
		const source = await createHarness();
		const target = await createHarness({ sessionManager: source.sessionManager });
		harnesses.push(source, target);
		source.session.pauseQueuedMessages();
		target.session.pauseQueuedMessages();
		await source.session.sendCustomMessage(
			{ customType: "source-protected-card", content: "source protected payload", display: true },
			{ triggerTurn: true, deliverAs: "followUp", persistWhenStreaming: true },
		);
		await target.session.sendCustomMessage(
			{ customType: "target-protected-card", content: "target protected payload", display: true },
			{ triggerTurn: true, deliverAs: "followUp", persistWhenStreaming: true },
		);

		(source.session as TransferSession).transferWorkflowStageDeliveriesTo(target.session);
		target.session.dispose();

		const persistedOrder = target.sessionManager.getEntries()
			.filter((entry) => entry.type === "custom_message")
			.map((entry) => `${entry.customType}:${getMessageText(entry)}`);
		expect(persistedOrder).toEqual([
			"source-protected-card:source protected payload",
			"target-protected-card:target protected payload",
			`${PROTECTED_RECONCILIATION_CUSTOM_TYPE}:source protected payload`,
			`${PROTECTED_RECONCILIATION_CUSTOM_TYPE}:target protected payload`,
		]);
	});
});
