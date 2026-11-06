import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import {
	isSubscriptionChildUnavailableError,
	isSubscriptionHandlerError,
	type SubscriptionChildUnavailableError,
} from "../../src/core/event-subscriptions/errors.ts";
import { SUBSCRIPTION_REPORT_TOOL_NAME } from "../../src/core/event-subscriptions/prompts.ts";
import {
	EVENT_REPORT_MESSAGE_TYPE,
	EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE,
	type EventReportDetails,
} from "../../src/core/event-subscriptions/session-subscription.ts";
import type { EventSource, SubscriptionEvent } from "../../src/core/event-subscriptions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function listSource(events: readonly SubscriptionEvent[]): EventSource {
	return {
		id: "list",
		start: async (_signal, emit) => {
			for (const event of events) emit(event);
		},
	};
}

function reportsIn(harness: Harness): EventReportDetails[] {
	return harness.session.messages
		.filter((message) => message.role === "custom" && message.customType === EVENT_REPORT_MESSAGE_TYPE)
		.map((message) => (message as { details: EventReportDetails }).details);
}

describe("AgentSession.subscribe(source, handler)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("delivers only reports into the session, once per relevant event, and records processed ids (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("noted")));
		const events = Array.from({ length: 30 }, (_, index) => ({ id: `e${index}`, payload: { index } }));
		const subscription = harness.session.subscribe(
			listSource([...events, ...events.slice(0, 5)]),
			async (event, child) => {
				if ((event.payload as { index: number }).index % 10 === 0) await child.report(`event ${event.id} matters`);
			},
			{ name: "alerts", maxConcurrent: 1 },
		);
		assert.equal(subscription.id, `${harness.session.sessionId}/alerts#1`);
		const stats = await subscription.done;
		assert.deepEqual(stats, { received: 35, duplicates: 5, handled: 30, active: 0, queued: 0, reports: 3 });
		assert.deepEqual(
			reportsIn(harness).map((details) => details.eventId),
			["e0", "e10", "e20"],
		);
		const processed = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE);
		assert.equal(processed.length, 30);
	});

	it("a session reopened on the same transcript does not process an event id twice (#4311)", async () => {
		const sessionManager = SessionManager.inMemory();
		const handled: string[] = [];
		const first = await createHarness({ sessionManager });
		harnesses.push(first);
		await first.session.subscribe(listSource([{ id: "a" }, { id: "b" }]), async (event) => {
			handled.push(event.id);
		}).done;
		const second = await createHarness({ sessionManager });
		harnesses.push(second);
		const stats = await second.session.subscribe(
			listSource([{ id: "a" }, { id: "b" }, { id: "c" }]),
			async (event) => {
				handled.push(event.id);
			},
		).done;
		assert.deepEqual(handled, ["a", "b", "c"]);
		assert.equal(stats.duplicates, 2);
	});

	it("runs a short-lived child session seeded with the event; the child's report tool reaches the session (#4311)", async () => {
		const harness = await createHarness({ childSessions: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(SUBSCRIPTION_REPORT_TOOL_NAME, { text: "deploy failed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child done"),
			fauxAssistantMessage("parent noted"),
		]);
		const results: string[] = [];
		const stats = await harness.session.subscribe(
			listSource([{ id: "deploy-7", type: "deployment" }]),
			async (_event, child) => {
				const result = await child.task({ prompt: "Report failed deployments." });
				results.push(result.sessionId);
			},
		).done;
		assert.equal(stats.reports, 1);
		assert.equal(results.length, 1);
		assert.notEqual(results[0], harness.session.sessionId);
		assert.deepEqual(reportsIn(harness), [
			{ subscriptionId: `${harness.session.sessionId}/list#1`, eventId: "deploy-7", child: "list/deploy-7" },
		]);
	});

	it("child.task fails with SubscriptionChildUnavailableError when the session cannot start child sessions (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const failure = await harness.session
			.subscribe(listSource([{ id: "x" }]), async (_event, child) => {
				await child.task({ prompt: "triage" });
			})
			.done.then(
				() => undefined,
				(error: unknown) => error,
			);
		assert.equal(isSubscriptionHandlerError(failure), true);
		assert.equal(isSubscriptionChildUnavailableError(failure), true);
		const cause = (failure as Error).cause as SubscriptionChildUnavailableError;
		assert.equal(cause.code, "child-unavailable");
		assert.equal(cause.sessionId, harness.session.sessionId);
		assert.equal(cause.subscriptionId, `${harness.session.sessionId}/list#1`);
	});

	it("disposing the session cancels its open subscriptions with an AbortError, never a failure (#4311)", async () => {
		const harness = await createHarness();
		let sourceSignal: AbortSignal | undefined;
		const subscription = harness.session.subscribe(
			{
				id: "forever",
				start: (signal) => {
					sourceSignal = signal;
				},
			},
			async () => {},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await harness.cleanup();
		const reason = await subscription.done.then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.equal((reason as DOMException).name, "AbortError");
		assert.equal(isSubscriptionHandlerError(reason), false);
		assert.equal(sourceSignal?.aborted, true);
	});

	it("still subscribes plain session-event listeners (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hi")]);
		const types: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => {
			types.push(event.type);
		});
		await harness.session.prompt("hello");
		unsubscribe();
		assert.equal(types.includes("agent_end"), true);
	});
});
