import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StageSessionReplacement } from "../../workflows/src/runs/foreground/stage-runner-replacement.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

type InterruptOwnerSession = AgentSession & {
	readonly _activeInterruptQueueHold?: {
		readonly steering: AgentMessage[];
		readonly followUp: AgentMessage[];
	};
	readonly _interruptDeliveryQueue: Promise<void>;
	readonly _pendingInterruptDeliveries: number;
	readonly _protectedStreamingCustomMessages: Array<{ readonly message: CustomMessage }>;
};

function transfer(source: AgentSession, target: AgentSession): void {
	const replacement = new StageSessionReplacement();
	replacement.retire(source);
	replacement.adopt(target);
}

describe("transferred interrupt ownership", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
	});

	test("an interrupt settling after retirement restores the unpaused replacement queue", async () => {
		const source = await createHarness();
		const replacement = await createHarness();
		harnesses.push(source, replacement);
		const sourceAbort = vi.spyOn(source.session.agent, "abort");
		const replacementAbort = vi.spyOn(replacement.session.agent, "abort");
		const sourceProviderStarted = Promise.withResolvers<void>();
		const sourceAbortObserved = Promise.withResolvers<void>();
		const finishSourceTurn = Promise.withResolvers<void>();
		let replacementProviderCalls = 0;
		source.setResponses([
			async (_context, options) => {
				sourceProviderStarted.resolve();
				const observeAbort = () => sourceAbortObserved.resolve();
				if (options?.signal?.aborted) observeAbort();
				else options?.signal?.addEventListener("abort", observeAbort, { once: true });
				await finishSourceTurn.promise;
				return fauxAssistantMessage("retired source interrupted");
			},
		]);
		replacement.setResponses([
			() => { replacementProviderCalls += 1; return fauxAssistantMessage("interrupt handled once"); },
			() => { replacementProviderCalls += 1; return fauxAssistantMessage("later prompt handled"); },
			() => { replacementProviderCalls += 1; return fauxAssistantMessage("ordinary queue handled"); },
		]);
		const exactOrdinary = "\tordinary transferred queue content  \n";

		const sourceTurn = source.session.prompt("start transferred interrupt race");
		await sourceProviderStarted.promise;
		await source.session.steer(exactOrdinary);
		await source.session.sendCustomMessage(
			{ customType: "transferred-interrupt", content: "interrupt payload", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		await sourceAbortObserved.promise;
		const sourceInternal = source.session as InterruptOwnerSession;
		const interruptSettled = sourceInternal._interruptDeliveryQueue;

		transfer(source.session, replacement.session);
		finishSourceTurn.resolve();
		await Promise.all([sourceTurn, interruptSettled]);

		const replacementInternal = replacement.session as InterruptOwnerSession;
		expect(replacementProviderCalls).toBe(1);
		expect(sourceAbort).toHaveBeenCalledTimes(1);
		expect(replacementAbort).not.toHaveBeenCalled();
		expect(sourceInternal._pendingInterruptDeliveries).toBe(0);
		expect(sourceInternal._activeInterruptQueueHold).toBeUndefined();
		expect(sourceInternal._protectedStreamingCustomMessages).toEqual([]);
		expect(source.session.agent.hasQueuedMessages()).toBe(false);
		expect(source.session.pendingMessageCount).toBe(0);
		expect(replacementInternal._pendingInterruptDeliveries).toBe(0);
		expect(replacementInternal._activeInterruptQueueHold).toBeUndefined();
		expect(replacementInternal._protectedStreamingCustomMessages).toEqual([]);
		expect(replacement.session.queuedMessagesPaused).toBe(false);
		expect(replacement.session.agent.hasQueuedMessages()).toBe(true);
		expect(replacement.session.getSteeringMessages()).toEqual([exactOrdinary]);

		await replacement.session.prompt("later replacement prompt");

		expect(replacementProviderCalls).toBe(2);
		expect(replacement.session.agent.hasQueuedMessages()).toBe(false);
		expect(replacement.session.pendingMessageCount).toBe(0);
		expect(replacement.session.getSteeringMessages()).toEqual([]);
		expect(replacement.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "transferred-interrupt",
		)).toHaveLength(1);
		expect(replacement.session.messages.filter(
			(message) => message.role === "user" && getMessageText(message) === exactOrdinary,
		)).toHaveLength(1);
		expect(replacement.session.messages.filter(
			(message) => message.role === "user" && ["later replacement prompt", exactOrdinary].includes(getMessageText(message)),
		).map(getMessageText)).toEqual(["later replacement prompt", exactOrdinary]);
		expect(replacementInternal._activeInterruptQueueHold).toBeUndefined();
		expect(replacementInternal._pendingInterruptDeliveries).toBe(0);
		expect(replacementInternal._protectedStreamingCustomMessages).toEqual([]);
	});

	test("an interrupt transferred to a paused replacement stays held until resume", async () => {
		const source = await createHarness();
		const replacement = await createHarness();
		harnesses.push(source, replacement);
		const sourceAbort = vi.spyOn(source.session.agent, "abort");
		const replacementAbort = vi.spyOn(replacement.session.agent, "abort");
		const sourceProviderStarted = Promise.withResolvers<void>();
		const sourceAbortObserved = Promise.withResolvers<void>();
		const finishSourceTurn = Promise.withResolvers<void>();
		let replacementProviderCalls = 0;
		source.setResponses([
			async (_context, options) => {
				sourceProviderStarted.resolve();
				const observeAbort = () => sourceAbortObserved.resolve();
				if (options?.signal?.aborted) observeAbort();
				else options?.signal?.addEventListener("abort", observeAbort, { once: true });
				await finishSourceTurn.promise;
				return fauxAssistantMessage("retired source interrupted before paused transfer");
			},
		]);
		replacement.setResponses([
			() => { replacementProviderCalls += 1; return fauxAssistantMessage("paused replacement resumed once"); },
		]);
		const exactOrdinary = "\tordinary paused replacement content  \n";

		replacement.session.pauseQueuedMessages();
		const sourceTurn = source.session.prompt("start paused replacement interrupt race");
		await sourceProviderStarted.promise;
		await source.session.steer(exactOrdinary);
		await source.session.sendCustomMessage(
			{ customType: "paused-transferred-interrupt", content: "paused interrupt payload", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		await sourceAbortObserved.promise;
		const sourceInternal = source.session as InterruptOwnerSession;
		const interruptSettled = sourceInternal._interruptDeliveryQueue;

		transfer(source.session, replacement.session);
		const replacementInternal = replacement.session as InterruptOwnerSession;
		expect(sourceInternal._pendingInterruptDeliveries).toBe(0);
		expect(sourceInternal._activeInterruptQueueHold).toBeUndefined();
		expect(replacementInternal._pendingInterruptDeliveries).toBe(1);
		expect(replacement.session.queuedMessagesPaused).toBe(true);
		expect(replacementInternal._activeInterruptQueueHold?.steering.map(getMessageText)).toEqual([exactOrdinary]);
		const resume = replacement.session.resumeQueuedMessages();
		let resumeSettled = false;
		void resume.finally(() => { resumeSettled = true; });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(resumeSettled).toBe(false);
		expect(replacement.session.queuedMessagesPaused).toBe(true);

		finishSourceTurn.resolve();
		await Promise.all([sourceTurn, interruptSettled]);
		expect(await resume).toBe(true);

		expect(replacementProviderCalls).toBe(0);
		expect(sourceAbort).toHaveBeenCalledTimes(1);
		expect(replacementAbort).not.toHaveBeenCalled();
		expect(sourceInternal._pendingInterruptDeliveries).toBe(0);
		expect(sourceInternal._activeInterruptQueueHold).toBeUndefined();
		expect(sourceInternal._protectedStreamingCustomMessages).toEqual([]);
		expect(source.session.agent.hasQueuedMessages()).toBe(false);
		expect(source.session.pendingMessageCount).toBe(0);
		expect(replacementInternal._pendingInterruptDeliveries).toBe(0);
		expect(replacement.session.queuedMessagesPaused).toBe(false);
		expect(replacementInternal._activeInterruptQueueHold).toBeUndefined();
		expect(replacement.session.agent.hasQueuedMessages()).toBe(true);
		expect(replacement.session.getSteeringMessages()).toEqual([exactOrdinary]);
		expect(replacementInternal._protectedStreamingCustomMessages).toEqual([]);

		await replacement.session.prompt("later paused replacement prompt");

		expect(replacementProviderCalls).toBe(1);
		expect(replacement.session.agent.hasQueuedMessages()).toBe(false);
		expect(replacement.session.pendingMessageCount).toBe(0);
		expect(replacement.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "paused-transferred-interrupt",
		)).toHaveLength(1);
		expect(replacement.session.messages.filter(
			(message) => message.role === "user" && getMessageText(message) === exactOrdinary,
		)).toHaveLength(1);
		expect(replacement.session.messages.filter((message) =>
			(message.role === "user" && ["later paused replacement prompt", exactOrdinary].includes(getMessageText(message))) ||
			(message.role === "custom" && message.customType === "paused-transferred-interrupt"),
		).map((message) => message.role === "custom" ? `custom:${message.customType}` : `user:${getMessageText(message)}`)).toEqual([
			"user:later paused replacement prompt",
			`user:${exactOrdinary}`,
			"custom:paused-transferred-interrupt",
		]);
		expect(replacementInternal._activeInterruptQueueHold).toBeUndefined();
		expect(replacementInternal._pendingInterruptDeliveries).toBe(0);
		expect(replacementInternal._protectedStreamingCustomMessages).toEqual([]);
	});

	test("source and target interrupts serialize after they acquire one live owner", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		const targetAbort = vi.spyOn(target.session.agent, "abort");
		const sourceStarted = Promise.withResolvers<void>();
		const targetStarted = Promise.withResolvers<void>();
		const sourceAbortObserved = Promise.withResolvers<void>();
		const targetAbortObserved = Promise.withResolvers<void>();
		const finishSource = Promise.withResolvers<void>();
		const finishTarget = Promise.withResolvers<void>();
		const firstTargetInterruptStarted = Promise.withResolvers<void>();
		const releaseFirstTargetInterrupt = Promise.withResolvers<void>();
		let targetInterruptProviders = 0;
		source.setResponses([async (_context, options) => {
			sourceStarted.resolve();
			if (options?.signal?.aborted) sourceAbortObserved.resolve();
			else options?.signal?.addEventListener("abort", () => sourceAbortObserved.resolve(), { once: true });
			await finishSource.promise;
			return fauxAssistantMessage("source interrupted");
		}]);
		target.setResponses([
			async (_context, options) => {
				targetStarted.resolve();
				if (options?.signal?.aborted) targetAbortObserved.resolve();
				else options?.signal?.addEventListener("abort", () => targetAbortObserved.resolve(), { once: true });
				await finishTarget.promise;
				return fauxAssistantMessage("target interrupted");
			},
			async () => {
				targetInterruptProviders += 1;
				firstTargetInterruptStarted.resolve();
				await releaseFirstTargetInterrupt.promise;
				return fauxAssistantMessage("first interrupt handled");
			},
			() => {
				targetInterruptProviders += 1;
				return fauxAssistantMessage("second interrupt handled");
			},
		]);

		const sourceTurn = source.session.prompt("source active");
		const targetTurn = target.session.prompt("target active");
		await Promise.all([sourceStarted.promise, targetStarted.promise]);
		await source.session.sendCustomMessage(
			{ customType: "source-interrupt", content: "source payload", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		await target.session.sendCustomMessage(
			{ customType: "target-interrupt", content: "target payload", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		await Promise.all([sourceAbortObserved.promise, targetAbortObserved.promise]);
		transfer(source.session, target.session);
		finishSource.resolve();
		finishTarget.resolve();
		await Promise.all([sourceTurn, targetTurn, firstTargetInterruptStarted.promise]);

		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(targetInterruptProviders).toBe(1);
		releaseFirstTargetInterrupt.resolve();
		await (target.session as InterruptOwnerSession)._interruptDeliveryQueue;

		expect(targetInterruptProviders).toBe(2);
		expect(target.session.messages.filter(
			(message) => message.role === "custom" && ["source-interrupt", "target-interrupt"].includes(message.customType),
		)).toHaveLength(2);
		expect(targetAbort).toHaveBeenCalledTimes(1);
		expect((target.session as InterruptOwnerSession)._activeInterruptQueueHold).toBeUndefined();
		expect((target.session as InterruptOwnerSession)._pendingInterruptDeliveries).toBe(0);
	});
});
