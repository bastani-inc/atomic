import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import {
	isSubscriptionChildUnavailableError,
	isSubscriptionClosedError,
	isSubscriptionConfigError,
	isSubscriptionHandlerError,
	isSubscriptionRecordError,
	type SubscriptionChildUnavailableError,
	type SubscriptionConfigError,
	type SubscriptionRecordError,
} from "../../src/core/event-subscriptions/errors.ts";
import { SUBSCRIPTION_REPORT_TOOL_NAME } from "../../src/core/event-subscriptions/prompts.ts";
import {
	cancelSessionSubscriptions,
	type EventReportDetails,
	runThenDispose,
	type SessionEventChild,
} from "../../src/core/event-subscriptions/session-subscription.ts";
import type { EventSource, SubscriptionEvent } from "../../src/core/event-subscriptions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function listSource(events: readonly SubscriptionEvent[]): EventSource {
	return {
		id: "list",
		start: async (_signal, emit) => {
			for (const event of events) emit(event);
		},
	};
}

/** Waits until the session's turns end and no steered report is still queued, so every delivered report is in `messages`. */
async function untilIdle(harness: Harness): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		await harness.session.agent.waitForIdle();
		if (!harness.session.isStreaming && harness.session.pendingMessageCount === 0) return;
	}
	assert.fail("the session did not go idle");
}

function reportsIn(harness: Harness): EventReportDetails[] {
	return harness.session.messages
		.filter((message) => message.role === "custom" && message.customType === "event_report")
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
		await untilIdle(harness);
		assert.deepEqual(
			reportsIn(harness).map((details) => details.eventId),
			["e0", "e10", "e20"],
		);
		const processed = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "event_subscription_processed");
		assert.equal(processed.length, 30);
	});

	it("names each child `<name>#<n>/<event id>` with the id URI-encoded, so no two subscriptions can share a child name (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("noted")));
		const names: string[] = [];
		const reports: string[] = [];
		const handler = async (_event: SubscriptionEvent, child: SessionEventChild) => {
			names.push(child.name);
			await child.report("matters");
			reports.push(child.name);
		};
		await harness.session.subscribe(listSource([{ id: "a/b c#d" }]), handler, { name: "a" }).done;
		await harness.session.subscribe(listSource([{ id: "c" }]), handler, { name: "a/b" }).done;
		await harness.session.subscribe(listSource([{ id: "e" }]), handler, { name: "a" }).done;
		assert.deepEqual(names, ["a#1/a%2Fb%20c%23d", "a/b#1/c", "a#2/e"]);
		await untilIdle(harness);
		assert.deepEqual(
			reportsIn(harness).map((details) => details.child),
			names,
		);
	});

	it("a processed-event record that fails rejects done with a SubscriptionRecordError after the handler succeeded (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const append = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
		const disk = new Error("transcript volume unavailable");
		vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementation(async (customType, data) => {
			if (customType === "event_subscription_processed") throw disk;
			return append(customType, data);
		});
		const handled: string[] = [];
		const subscription = harness.session.subscribe(
			listSource([{ id: "e1" }, { id: "e2" }]),
			async (event) => {
				handled.push(event.id);
			},
			{ maxConcurrent: 1 },
		);
		const failure = await subscription.done.then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.equal(isSubscriptionRecordError(failure), true);
		assert.equal(isSubscriptionHandlerError(failure), false);
		const record = failure as SubscriptionRecordError;
		assert.deepEqual(
			{ code: record.code, record: record.record, eventId: record.eventId, subscriptionId: record.subscriptionId },
			{
				code: "record-failed",
				record: "processed-event",
				eventId: "e1",
				subscriptionId: `${harness.session.sessionId}/list#1`,
			},
		);
		assert.equal(record.cause, disk);
		assert.deepEqual(handled, ["e1"]);
		assert.equal(subscription.stats().handled, 0);
	});

	it("a subscription record that fails rejects done with a SubscriptionRecordError and handles nothing (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const disk = new Error("transcript volume unavailable");
		vi.spyOn(harness.sessionManager, "appendCustomEntry").mockRejectedValue(disk);
		const handled: string[] = [];
		const failure = await harness.session
			.subscribe(listSource([{ id: "e1" }]), async (event) => {
				handled.push(event.id);
			})
			.done.then(
				() => undefined,
				(error: unknown) => error,
			);
		assert.equal(isSubscriptionRecordError(failure), true);
		assert.deepEqual(
			{ record: (failure as SubscriptionRecordError).record, eventId: (failure as SubscriptionRecordError).eventId },
			{ record: "subscription", eventId: null },
		);
		assert.equal((failure as SubscriptionRecordError).cause, disk);
		assert.deepEqual(handled, []);
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
			{ subscriptionId: `${harness.session.sessionId}/list#1`, eventId: "deploy-7", child: "list#1/deploy-7" },
		]);
	});

	it("a child limited to an explicit tool list can still call report_to_subscriber (#4311)", async () => {
		const harness = await createHarness({ childSessions: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(SUBSCRIPTION_REPORT_TOOL_NAME, { text: "deploy failed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done"),
		]);
		const stats = await harness.session.subscribe(listSource([{ id: "deploy-8" }]), async (_event, child) => {
			await child.task({ prompt: "Report failed deployments.", tools: ["read"] });
		}).done;
		assert.equal(stats.reports, 1);
		assert.deepEqual(
			reportsIn(harness).map((details) => details.eventId),
			["deploy-8"],
		);
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
				(error as { subscriptionId: string }).subscriptionId === `${harness.session.sessionId}/late` &&
				(error as { operation: string }).operation === "subscribe" &&
				(error as { hint: string }).hint ===
					"Subscribe while the session is open; a closed session accepts no subscriptions.",
		);
	});

	it("numbers subscriptions per name, records each one, and skips only its own processed ids (#4311)", async () => {
		const sessionManager = SessionManager.inMemory();
		await sessionManager.appendCustomEntry("event_subscription_processed");
		await sessionManager.appendCustomEntry("event_subscription_processed", {
			subscription: "other#1",
			eventId: "a",
		});
		await sessionManager.appendCustomEntry("unrelated", { subscription: "list#1", eventId: "b" });
		await sessionManager.appendCustomEntry("event_subscription_processed", {
			subscription: "list#1",
			eventId: 7,
		});
		await sessionManager.appendCustomEntry("event_subscription_processed", {
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
					entry.type === "custom" && entry.customType === "event_subscription" ? [entry.data] : [],
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
			(message) => message.role === "custom" && message.customType === "event_report",
		) as { display?: boolean; content?: unknown } | undefined;
		assert.equal(report?.display, true);
		assert.equal(report?.content, 'Report from event child "list#1/x" (event x):\n\nx matters');
		for (let wait = 0; wait < 200 && harness.session.messages.at(-1)?.role !== "assistant"; wait++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(harness.session.messages.at(-1)?.role, "assistant");
		await assert.rejects(
			kept!.report("too late"),
			(error) =>
				isSubscriptionClosedError(error) &&
				error.operation === "report" &&
				error.subscriptionId === `${harness.session.sessionId}/list#1`,
		);
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
		assert.equal((bad as SubscriptionConfigError).reason, "not-string");
	});

	it("sends each report as a turn-starting steer message and records the subscription under its literal entry types (#4311)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("noted")]);
		const send = vi.spyOn(harness.session, "sendCustomMessage");
		await harness.session.subscribe(listSource([{ id: "x" }]), async (_event, child) => {
			await child.report("x matters");
		}).done;
		assert.equal(send.mock.calls.length, 1);
		assert.deepEqual(send.mock.calls[0]?.[1], { triggerTurn: true, deliverAs: "steer" });
		assert.equal(send.mock.calls[0]?.[0].customType, "event_report");
		assert.deepEqual(
			harness.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom" ? [[entry.customType, entry.data]] : [])),
			[
				["event_subscription", { subscription: "list#1", source: "list" }],
				["event_subscription_processed", { subscription: "list#1", eventId: "x" }],
			],
		);
	});

	it("child.task returns the child's final text, an empty text when it gave none, and disposes every child (#4311)", async () => {
		const flushed: string[] = [];
		const childSettings = SettingsManager.inMemory();
		const flush = childSettings.flush.bind(childSettings);
		childSettings.flush = async () => {
			flushed.push("child settings flushed");
			await flush();
		};
		const harness = await createHarness({ childSessions: { settingsManager: childSettings } });
		harnesses.push(harness);
		let childTool: { name: string; description: string } | undefined;
		harness.setResponses([
			(context) => {
				childTool = context.messages
					.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
					.find((tool) => tool.name === SUBSCRIPTION_REPORT_TOOL_NAME);
				return fauxAssistantMessage("verdict: fine");
			},
			fauxAssistantMessage(""),
		]);
		const results: Array<{ text: string; sessionId: string }> = [];
		await harness.session.subscribe(listSource([{ id: "a" }, { id: "b" }]), async (_event, child) => {
			results.push(await child.task({ prompt: "Judge the event." }));
		}).done;
		assert.deepEqual(
			results.map((result) => result.text),
			["verdict: fine", ""],
		);
		assert.equal(new Set(results.map((result) => result.sessionId)).size, 2);
		assert.equal(flushed.length, 2);
		assert.match(childTool?.description ?? "", /to the session that subscribed to it/);
	});

	it("disposing the session aborts and disposes a running child session and rejects child.task with the cancellation reason (#4311)", async () => {
		const flushed: string[] = [];
		const childSettings = SettingsManager.inMemory();
		const flush = childSettings.flush.bind(childSettings);
		childSettings.flush = async () => {
			flushed.push("child settings flushed");
			await flush();
		};
		const harness = await createHarness({ childSessions: { settingsManager: childSettings } });
		const modelSignals: Array<AbortSignal | undefined> = [];
		const modelStarted = Promise.withResolvers<void>();
		harness.setResponses([
			(_context, options) => {
				modelSignals.push(options?.signal);
				modelStarted.resolve();
				return new Promise((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
						{
							once: true,
						},
					);
				});
			},
		]);
		const taskOutcome = Promise.withResolvers<unknown>();
		const subscription = harness.session.subscribe(listSource([{ id: "slow" }]), async (_event, child) => {
			await child.task({ prompt: "Take your time." }).then(
				() => taskOutcome.resolve(undefined),
				(error: unknown) => taskOutcome.resolve(error),
			);
		});
		void subscription.done.catch(() => undefined);
		await modelStarted.promise;
		assert.equal(modelSignals[0]?.aborted, false);
		assert.equal(flushed.length, 0);
		await harness.cleanup();
		const outcome = await taskOutcome.promise;
		assert.equal(modelSignals[0]?.aborted, true);
		assert.equal(flushed.length, 1);
		assert.equal((outcome as DOMException).name, "AbortError");
		assert.equal((outcome as DOMException).message, "The subscribing session closed");
		assert.equal(isSubscriptionHandlerError(outcome), false);
	});

	it("child.task after the session closed creates no child session and rejects with the cancellation reason (#4311)", async () => {
		const flushed: string[] = [];
		const childSettings = SettingsManager.inMemory();
		const flush = childSettings.flush.bind(childSettings);
		childSettings.flush = async () => {
			flushed.push("child settings flushed");
			await flush();
		};
		const harness = await createHarness({ childSessions: { settingsManager: childSettings } });
		let modelCalls = 0;
		harness.setResponses([
			() => {
				modelCalls += 1;
				return fauxAssistantMessage("never asked");
			},
		]);
		const inHandler = Promise.withResolvers<SessionEventChild>();
		const proceed = Promise.withResolvers<void>();
		const taskOutcome = Promise.withResolvers<unknown>();
		const subscription = harness.session.subscribe(listSource([{ id: "late" }]), async (_event, child) => {
			inHandler.resolve(child);
			await proceed.promise;
			await child.task({ prompt: "Too late." }).then(
				() => taskOutcome.resolve(undefined),
				(error: unknown) => taskOutcome.resolve(error),
			);
		});
		void subscription.done.catch(() => undefined);
		await inHandler.promise;
		await harness.cleanup();
		proceed.resolve();
		const outcome = await taskOutcome.promise;
		assert.equal((outcome as DOMException).name, "AbortError");
		assert.equal((outcome as DOMException).message, "The subscribing session closed");
		assert.equal(modelCalls, 0);
		assert.equal(flushed.length, 0);
	});

	it("a session closed while its child session is still being created never prompts that child (#4311)", async () => {
		const flushed: string[] = [];
		const childSettings = SettingsManager.inMemory();
		const flush = childSettings.flush.bind(childSettings);
		childSettings.flush = async () => {
			flushed.push("child settings flushed");
			await flush();
		};
		const harness = await createHarness({ childSessions: { settingsManager: childSettings } });
		const getSteeringMode = childSettings.getSteeringMode.bind(childSettings);
		childSettings.getSteeringMode = () => {
			cancelSessionSubscriptions(harness.session);
			return getSteeringMode();
		};
		let modelCalls = 0;
		harness.setResponses([
			() => {
				modelCalls += 1;
				return fauxAssistantMessage("never asked");
			},
		]);
		const taskOutcome = Promise.withResolvers<unknown>();
		harness.session
			.subscribe(listSource([{ id: "racing" }]), async (_event, child) => {
				await child.task({ prompt: "Racing the close." }).then(
					() => taskOutcome.resolve(undefined),
					(error: unknown) => taskOutcome.resolve(error),
				);
			})
			.done.catch(() => undefined);
		const outcome = await taskOutcome.promise;
		assert.equal((outcome as DOMException).name, "AbortError");
		assert.equal(modelCalls, 0);
		assert.equal(flushed.length, 1);
		await harness.cleanup();
	});

	it("a failing child abort is attached to the cancellation reason and the child is still disposed (#4311)", async () => {
		const flushed: string[] = [];
		const childSettings = SettingsManager.inMemory();
		const flush = childSettings.flush.bind(childSettings);
		childSettings.flush = async () => {
			flushed.push("child settings flushed");
			await flush();
		};
		const harness = await createHarness({ childSessions: { settingsManager: childSettings } });
		const abort = AgentSession.prototype.abort;
		const abortSpy = vi.spyOn(AgentSession.prototype, "abort").mockImplementation(async function (
			this: AgentSession,
		) {
			await abort.call(this);
			if (this === harness.session) return;
			await new Promise<void>((resolve) => setImmediate(resolve));
			throw new Error("child abort failed");
		});
		try {
			const modelStarted = Promise.withResolvers<void>();
			harness.setResponses([
				(_context, options) => {
					modelStarted.resolve();
					return new Promise((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
							{ once: true },
						);
					});
				},
			]);
			const taskOutcome = Promise.withResolvers<unknown>();
			harness.session
				.subscribe(listSource([{ id: "stuck" }]), async (_event, child) => {
					await child.task({ prompt: "Hang." }).then(
						() => taskOutcome.resolve(undefined),
						(error: unknown) => taskOutcome.resolve(error),
					);
				})
				.done.catch(() => undefined);
			await modelStarted.promise;
			await harness.cleanup();
			const outcome = (await taskOutcome.promise) as DOMException & { cleanupCause?: Error };
			assert.equal(outcome.name, "AbortError");
			assert.equal(outcome.cleanupCause?.message, "child abort failed");
			assert.equal(flushed.length, 1);
		} finally {
			abortSpy.mockRestore();
		}
	});

	it("a finished child is no longer aborted when its session closes later (#4311)", async () => {
		const harness = await createHarness({ childSessions: true });
		const abortedSessions: AgentSession[] = [];
		const abort = AgentSession.prototype.abort;
		const abortSpy = vi.spyOn(AgentSession.prototype, "abort").mockImplementation(async function (
			this: AgentSession,
		) {
			if (this !== harness.session) abortedSessions.push(this);
			await abort.call(this);
		});
		try {
			harness.setResponses([fauxAssistantMessage("fine")]);
			const finished = Promise.withResolvers<void>();
			const subscription = harness.session.subscribe(listSource([{ id: "quick" }]), async (_event, child) => {
				await child.task({ prompt: "Quick." });
				finished.resolve();
			});
			void subscription.done.catch(() => undefined);
			await finished.promise;
			await harness.cleanup();
			assert.equal(abortedSessions.length, 0);
		} finally {
			abortSpy.mockRestore();
		}
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
