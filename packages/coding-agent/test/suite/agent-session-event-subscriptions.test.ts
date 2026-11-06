import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import {
	isSubscriptionChildUnavailableError,
	isSubscriptionClosedError,
	isSubscriptionConfigError,
	isSubscriptionHandlerError,
	type SubscriptionChildUnavailableError,
	type SubscriptionConfigError,
} from "../../src/core/event-subscriptions/errors.ts";
import { SUBSCRIPTION_REPORT_TOOL_NAME } from "../../src/core/event-subscriptions/prompts.ts";
import {
	EVENT_REPORT_MESSAGE_TYPE,
	EVENT_SUBSCRIPTION_ENTRY_TYPE,
	EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE,
	type EventReportDetails,
	runThenDispose,
	type SessionEventChild,
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
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done"),
		]);
		const results: string[] = [];
		const texts: string[] = [];
		const stats = await harness.session.subscribe(
			listSource([{ id: "deploy-7", type: "deployment" }]),
			async (_event, child) => {
				const result = await child.task({ prompt: "Report failed deployments." });
				results.push(result.sessionId);
				texts.push(result.text);
			},
		).done;
		assert.equal(stats.reports, 1);
		assert.deepEqual(texts, ["done"]);
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

	it("validates its inputs before recording anything, and refuses a closed session (#4311)", async () => {
		const harness = await createHarness();
		const fields: string[][] = [];
		const attempt = (run: () => unknown): void => {
			try {
				run();
				fields.push(["accepted"]);
			} catch (error) {
				assert.equal(isSubscriptionConfigError(error), true);
				fields.push([(error as SubscriptionConfigError).field, (error as SubscriptionConfigError).reason]);
			}
		};
		attempt(() => harness.session.subscribe({ id: "x" } as never, async () => {}));
		attempt(() => harness.session.subscribe(listSource([]), undefined as never));
		attempt(() => harness.session.subscribe(listSource([]), async () => {}, { name: "" }));
		attempt(() => harness.session.subscribe(listSource([]), async () => {}, { name: 3 as never }));
		attempt(() => harness.session.subscribe(listSource([]), async () => {}, { maxConcurrent: 0 }));
		assert.deepEqual(fields, [
			["source", "not-event-source"],
			["handler", "not-function"],
			["options.name", "not-string"],
			["options.name", "not-string"],
			["options.maxConcurrent", "not-positive-integer"],
		]);
		assert.equal(
			harness.sessionManager.getEntries().some((entry) => entry.type === "custom"),
			false,
		);
		await harness.cleanup();
		assert.throws(
			() => harness.session.subscribe(listSource([]), async () => {}, { name: "late" }),
			(error) =>
				isSubscriptionClosedError(error) &&
				(error as { subscriptionId: string }).subscriptionId === `${harness.session.sessionId}/late`,
		);
	});

	it("numbers subscriptions per name, records each one, and skips only its own processed ids (#4311)", async () => {
		const sessionManager = SessionManager.inMemory();
		await sessionManager.appendCustomEntry(EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE, {
			subscription: "other#1",
			eventId: "a",
		});
		await sessionManager.appendCustomEntry("unrelated", { subscription: "list#1", eventId: "b" });
		await sessionManager.appendCustomEntry(EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE, {
			subscription: "list#1",
			eventId: 7,
		});
		await sessionManager.appendCustomEntry(EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE, {
			subscription: "list#1",
			eventId: "c",
		});
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		const handled: string[] = [];
		const first = harness.session.subscribe(listSource([{ id: "a" }, { id: "b" }, { id: "c" }]), async (event) => {
			handled.push(event.id);
		});
		const second = harness.session.subscribe(listSource([]), async () => {}, {
			maxConcurrent: 2,
			maxRate: { events: 5, intervalMs: 1000 },
		});
		assert.deepEqual(
			[first.id, second.id],
			[`${harness.session.sessionId}/list#1`, `${harness.session.sessionId}/list#2`],
		);
		await Promise.all([first.done, second.done]);
		assert.deepEqual(handled, ["a", "b"]);
		assert.deepEqual(
			harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === EVENT_SUBSCRIPTION_ENTRY_TYPE ? [entry.data] : [],
				),
			[
				{ subscription: "list#1", source: "list" },
				{ subscription: "list#2", source: "list", maxConcurrent: 2, maxRate: { events: 5, intervalMs: 1000 } },
			],
		);
	});

	it("delivers a visible report that starts a turn, and refuses bad or late reports (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("noted")]);
		let kept: SessionEventChild | undefined;
		await harness.session.subscribe(listSource([{ id: "x" }]), async (_event, child) => {
			kept = child;
			await child.report("x matters");
		}).done;
		const report = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === EVENT_REPORT_MESSAGE_TYPE,
		) as { display?: boolean; content?: unknown } | undefined;
		assert.equal(report?.display, true);
		assert.equal(report?.content, 'Report from event child "list/x" (event x):\n\nx matters');
		for (let wait = 0; wait < 200 && harness.session.messages.at(-1)?.role !== "assistant"; wait++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(harness.session.messages.at(-1)?.role, "assistant");
		await assert.rejects(kept!.report("too late"), (error) => isSubscriptionClosedError(error));
		const bad = await harness.session
			.subscribe(listSource([{ id: "y" }]), async (_event, child) => {
				await child.report(5 as never);
			})
			.done.then(
				() => undefined,
				(error: Error) => error.cause,
			);
		assert.equal(isSubscriptionConfigError(bad), true);
		assert.equal((bad as SubscriptionConfigError).field, "report.text");
	});

	it("disposing the session cancels every open subscription (#4311)", async () => {
		const harness = await createHarness();
		const open = ["a", "b"].map((name) =>
			harness.session.subscribe({ id: name, start: () => {} }, async () => {}, { name }),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await harness.cleanup();
		const reasons = await Promise.all(
			open.map((subscription) => subscription.done.catch((error: DOMException) => error)),
		);
		assert.deepEqual(
			reasons.map((reason) => [(reason as DOMException).name, (reason as DOMException).message]),
			[
				["AbortError", "The subscribing session closed"],
				["AbortError", "The subscribing session closed"],
			],
		);
	});
});

describe("runThenDispose", () => {
	it("returns the work's result after disposing, and lets a disposal failure after success propagate", async () => {
		const order: string[] = [];
		assert.equal(
			await runThenDispose(
				async () => {
					order.push("work");
					return 7;
				},
				async () => {
					order.push("dispose");
				},
			),
			7,
		);
		assert.deepEqual(order, ["work", "dispose"]);
		const cleanup = new Error("dispose failed");
		await assert.rejects(
			runThenDispose(
				async () => 1,
				async () => {
					throw cleanup;
				},
			),
			(error) => error === cleanup,
		);
	});

	it("keeps the primary failure and attaches a disposal failure as cleanupCause", async () => {
		const primary = new Error("prompt failed");
		const cleanup = new Error("dispose failed");
		await assert.rejects(
			runThenDispose(
				async () => {
					throw primary;
				},
				async () => {
					throw cleanup;
				},
			),
			(error) => error === primary,
		);
		assert.equal((primary as Error & { cleanupCause?: unknown }).cleanupCause, cleanup);
		assert.deepEqual(Object.keys(primary), []);
		const frozen = Object.freeze(new Error("frozen"));
		await assert.rejects(
			runThenDispose(
				async () => {
					throw frozen;
				},
				async () => {
					throw cleanup;
				},
			),
			(error) => error === frozen,
		);
		await assert.rejects(
			runThenDispose(
				async () => {
					throw "text";
				},
				async () => {
					throw cleanup;
				},
			),
			(error) => error === "text",
		);
		let disposed = false;
		const plain = new Error("only work failed");
		await assert.rejects(
			runThenDispose(
				async () => {
					throw plain;
				},
				async () => {
					disposed = true;
				},
			),
			(error) => error === plain,
		);
		assert.equal(disposed, true);
		assert.equal("cleanupCause" in plain, false);
	});
});
