import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { createSessionAsyncDeliveryHandler } from "../src/core/async/session-manager.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

function relevantDelivery(message: AgentSession["messages"][number]): string | undefined {
	if (message.role === "user") {
		const text = getMessageText(message);
		return text === "explicit resume driver" || text.includes("late raw") ? `user:${text}` : undefined;
	}
	if (message.role !== "custom") return undefined;
	return [
		"late-trigger",
		"late-batch",
		"late-interrupt",
		"async-job-result",
	].includes(message.customType) ? `custom:${message.customType}:${String(message.details && "id" in message.details ? message.details.id : "")}` : undefined;
}

describe("paused queue late admission gate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	test("late custom, batch, interrupt, async, user, and prompt deliveries wait for explicit resume", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			...Array.from({ length: 7 }, (_, index) => fauxAssistantMessage(`handled ${index}`)),
		]);

		const active = harness.session.prompt("start then pause");
		await started.promise;
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;
		const responsesBeforeLateArrival = harness.getPendingResponseCount();

		await harness.session.sendCustomMessage(
			{
				customType: "late-trigger",
				content: [{ type: "text", text: "\tlate raw trigger  \n" }],
				display: true,
				details: { id: 1, optional: undefined },
			},
			{ triggerTurn: true },
		);
		await harness.session.sendCustomMessages(
			[1, 2].map((id) => ({
				customType: "late-batch",
				content: [{ type: "text" as const, text: "duplicate late raw batch" }],
				display: true,
				details: { id },
			})),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await harness.session.sendCustomMessage(
			{
				customType: "late-interrupt",
				content: "late raw interrupt",
				display: true,
				details: { id: 3 },
			},
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		const deliverAsync = createSessionAsyncDeliveryHandler(harness.session);
		await deliverAsync({
			customType: "async-job-result",
			content: "late raw async result",
			display: true,
			details: { jobId: "job-paused", type: "bash", status: "completed", command: "printf raw" },
		});
		await harness.session.sendUserMessage("late raw user", { deliverAs: "followUp" });
		await harness.session.prompt("\tlate raw prompt  \n");
		await harness.session.sendCustomMessage(
			{ customType: "history-only", content: "history only", display: true, details: { retained: true } },
			{ triggerTurn: false },
		);

		expect(harness.getPendingResponseCount()).toBe(responsesBeforeLateArrival);
		expect(harness.session.queuedMessagesPaused).toBe(true);
		expect(harness.session.messages.filter((message) => message.role === "custom" && message.customType === "history-only")).toHaveLength(1);

		await harness.session.resumeQueuedMessages();
		expect(harness.getPendingResponseCount()).toBe(responsesBeforeLateArrival);
		expect(harness.session.queuedMessagesPaused).toBe(false);

		await harness.session.prompt("explicit resume driver");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.map(relevantDelivery).filter(Boolean)).toEqual([
			"user:explicit resume driver",
			"custom:late-trigger:1",
			"custom:late-interrupt:3",
			"user:\tlate raw prompt  \n",
			"custom:late-batch:1",
			"custom:late-batch:2",
			"custom:async-job-result:",
			"user:late raw user",
		]);
		const deliveredCustom = harness.session.messages.filter((message) => message.role === "custom");
		const lateTrigger = deliveredCustom.find((message) => message.customType === "late-trigger");
		expect(lateTrigger).toMatchObject({
			content: [{ type: "text", text: "\tlate raw trigger  \n" }],
			display: true,
			details: { id: 1, optional: undefined },
		});
		expect(Object.hasOwn(lateTrigger?.details ?? {}, "optional")).toBe(true);
		expect(deliveredCustom.filter((message) => message.customType === "late-batch").map((message) => message.details)).toEqual([
			{ id: 1 },
			{ id: 2 },
		]);
		expect(deliveredCustom.find((message) => message.customType === "async-job-result")?.details).toMatchObject({
			jobId: "job-paused",
			status: "completed",
			command: "printf raw",
		});
	});

	test("an admitted interrupt that interleaves with pause joins the hold and resume does not hang", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			fauxAssistantMessage("resume"),
			fauxAssistantMessage("held queue"),
		]);

		const active = harness.session.prompt("interleave start");
		await started.promise;
		await harness.session.steer("older held steer");
		const interrupt = harness.session.sendCustomMessage(
			{ customType: "late-interleaved-interrupt", content: "interleaved interrupt", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		harness.session.pauseQueuedMessages();
		const resume = harness.session.resumeQueuedMessages();
		await Promise.all([harness.session.abort(), active, interrupt, resume]);

		expect(harness.getPendingResponseCount()).toBe(2);
		expect(harness.session.queuedMessagesPaused).toBe(false);

		await harness.session.prompt("resume interleave");
		expect(harness.getPendingResponseCount()).toBe(0);
		const delivered = harness.session.messages
			.filter((message) =>
				(message.role === "user" && ["older held steer", "resume interleave"].includes(getMessageText(message))) ||
				(message.role === "custom" && message.customType === "late-interleaved-interrupt"),
			)
			.map((message) => message.role === "custom" ? `custom:${message.content}` : `user:${getMessageText(message)}`);
		expect(delivered).toEqual([
			"user:resume interleave",
			"user:older held steer",
			"custom:interleaved interrupt",
		]);
	});

	test("non-trigger custom single and batch arrivals remain history-only during paused abort overlap", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const providerStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const finishAbortingTurn = Promise.withResolvers<void>();
		harness.setResponses([
			async (_context, options) => {
				providerStarted.resolve();
				const observeAbort = () => abortObserved.resolve();
				if (options?.signal?.aborted) observeAbort();
				else options?.signal?.addEventListener("abort", observeAbort, { once: true });
				await finishAbortingTurn.promise;
				return fauxAssistantMessage("interrupted");
			},
		]);

		const active = harness.session.prompt("start non-trigger overlap");
		await providerStarted.promise;
		harness.session.pauseQueuedMessages();
		const aborting = harness.session.abort();
		await abortObserved.promise;
		await harness.session.sendCustomMessage(
			{ customType: "overlap-history-single", content: "single history", display: true, details: { id: 1 } },
			{ triggerTurn: false },
		);
		await harness.session.sendCustomMessages([
			{ customType: "overlap-history-batch", content: "batch history", display: true, details: { id: 2 } },
			{ customType: "overlap-history-batch", content: "batch history", display: true, details: { id: 3 } },
		], { triggerTurn: false });

		const overlappingHistory = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType.startsWith("overlap-history-"),
		);
		const paused = harness.session as AgentSession & {
			readonly _activeInterruptQueueHold?: { readonly steering: readonly object[]; readonly followUp: readonly object[] };
		};
		const heldDuringAbort = (paused._activeInterruptQueueHold?.steering.length ?? 0) +
			(paused._activeInterruptQueueHold?.followUp.length ?? 0);

		finishAbortingTurn.resolve();
		await Promise.all([active, aborting]);
		const released = await harness.session.resumeQueuedMessages();

		expect(overlappingHistory.map((message) => message.details)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(heldDuringAbort).toBe(0);
		expect(released).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	test("a later independent pause generation releases only its own late batch", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first driver"),
			fauxAssistantMessage("first late queue"),
			fauxAssistantMessage("second driver"),
			fauxAssistantMessage("second late queue"),
		]);

		for (const generation of [1, 2]) {
			harness.session.pauseQueuedMessages();
			await harness.session.steer(`late generation ${generation}`);
			const released = await harness.session.resumeQueuedMessages();
			expect(released).toBe(true);
			await harness.session.prompt(`resume generation ${generation}`);
		}

		for (const generation of [1, 2]) {
			expect(harness.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === `late generation ${generation}`,
			)).toHaveLength(1);
		}
		expect(harness.session.queuedMessagesPaused).toBe(false);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});
});
