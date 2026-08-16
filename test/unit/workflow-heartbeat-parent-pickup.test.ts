import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { MessageEndEventResult } from "../../packages/coding-agent/src/core/extensions/event-results.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import {
	isWorkflowHeartbeatTerminalRun,
	workflowHeartbeatConsumedIdentity,
	workflowHeartbeatContextInvalidation,
} from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import type { SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
	type WorkflowHeartbeatIdentity,
} from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";

/**
 * Host-level regression for the heartbeat pickup signal (issue #1975).
 *
 * The scheduler holds a run's single pending slot until the parent chat has
 * actually taken the card. `sendMessage` resolves on *admission* into the
 * parent's queue, so the release has to come from a later host signal — and the
 * signal has to be one that does not fire while the card is still parked.
 *
 * These tests exercise the real `AgentSession` rather than a fake, because the
 * distinction only exists in the host: `agent_settled` is emitted from the
 * `finally` of the prompt cycle whether or not the queue was drained, while
 * `message_end` is emitted by agent-core at the moment a message is injected
 * into the conversation.
 */
describe("workflow heartbeat parent pickup signal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const WAIT_FOR_POLL_INTERVAL_MS = 5;
	const WAIT_FOR_TIMEOUT_MS = 1_000;

	/** Poll a condition the host settles asynchronously; timeout is a test failure. */
	async function waitFor(condition: () => boolean, description: string): Promise<void> {
		const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
		while (!condition()) {
			if (Date.now() >= deadline) {
				throw new Error(`Timed out after ${WAIT_FOR_TIMEOUT_MS}ms waiting for ${description}`);
			}
			await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_POLL_INTERVAL_MS));
		}
	}

	interface ObservedEvents {
		readonly settled: number[];
		readonly consumed: WorkflowHeartbeatIdentity[];
	}

	async function createObservingHarness(): Promise<{ harness: Harness; observed: ObservedEvents }> {
		const observed: ObservedEvents = { settled: [], consumed: [] };
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						observed.settled.push(observed.consumed.length);
					});
					pi.on("message_end", (event, ctx) => {
						// The production narrowing, including the typed intent lookup, so a
						// foreign custom message with copied text cannot report consumption.
						const identity = workflowHeartbeatConsumedIdentity(
							event,
							ctx.sessionManager.getEntries() as readonly SessionEntry[],
						);
						if (identity !== undefined) observed.consumed.push(identity);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		return { harness, observed };
	}

	const HEARTBEAT_TEXT = '♥ Workflow "probe" heartbeat (run probe-run)';

	async function sendHeartbeatCard(harness: Harness, text: string): Promise<void> {
		await harness.session.sendCustomMessage(
			{
				customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
				content: [{ type: "text", text }],
				display: true,
				details: { runId: "probe-run", scheduledAt: 1, workflowName: "probe", startedAt: 0, intervalMinutes: 1 },
			},
			// The production option triple.
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
	}

	test("a steer-queued heartbeat reaches extensions as message_end only when it is consumed", async () => {
		const { harness, observed } = await createObservingHarness();
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
			fauxAssistantMessage("after the queued heartbeat"),
			fauxAssistantMessage("spare"),
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;

		// Admitted into the parent's queue while the turn is streaming.
		await sendHeartbeatCard(harness, HEARTBEAT_TEXT);
		assert.equal(observed.consumed.length, 0, "admission alone is not consumption");

		// Pause, then end the turn. The queue drain is skipped while paused, so
		// the card stays parked — but the prompt cycle still settles.
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		assert.ok(harness.session.queuedMessagesPaused, "the queue is paused");
		assert.ok(observed.settled.length > 0, "agent_settled fired even though nothing was drained");
		assert.equal(
			observed.consumed.length,
			0,
			"no message_end for the parked card — this is the distinction agent_settled cannot make",
		);
		// Resume restores the held card but does not itself start a turn — the
		// host requires an explicit driver, which is the documented behavior in
		// packages/coding-agent/test/paused-queued-late-admission.test.ts.
		await harness.session.resumeQueuedMessages();
		assert.equal(observed.consumed.length, 0, "restoring the hold is still not consumption");

		await harness.session.prompt("explicit resume driver");

		assert.ok(
			observed.consumed.some((identity) => identity.runId === "probe-run" && identity.scheduledAt === 1),
			`the restored card is consumed with its exact identity; saw ${JSON.stringify(observed.consumed)}`,
		);
	});

	test("an idle parent consumes the heartbeat in the turn it triggers", async () => {
		const { harness, observed } = await createObservingHarness();
		harness.setResponses([fauxAssistantMessage("acknowledged"), fauxAssistantMessage("spare")]);

		// On an idle parent the send resolves at admission and the triggered turn
		// continues in the background, so wait for the turn rather than for the send.
		await sendHeartbeatCard(harness, HEARTBEAT_TEXT);
		await waitFor(
			() => observed.consumed.some((identity) => identity.runId === "probe-run" && identity.scheduledAt === 1),
			"the idle parent to consume the heartbeat",
		);

		assert.ok(
			observed.consumed.some((identity) => identity.runId === "probe-run" && identity.scheduledAt === 1),
			`an idle parent consumes the exact heartbeat identity; saw ${JSON.stringify(observed.consumed)}`,
		);
	});

	test("a foreign custom message with identical text reports no heartbeat consumption", async () => {
		const { harness, observed } = await createObservingHarness();
		harness.setResponses([
			fauxAssistantMessage("acknowledged heartbeat"),
			fauxAssistantMessage("acknowledged foreign message"),
			fauxAssistantMessage("spare"),
		]);

		await sendHeartbeatCard(harness, HEARTBEAT_TEXT);
		await waitFor(
			() => observed.consumed.length === 1,
			"the heartbeat to be consumed before sending the foreign message",
		);
		await harness.session.sendCustomMessage(
			{
				customType: "someone-else:notice",
				content: [{ type: "text", text: HEARTBEAT_TEXT }],
				display: true,
				details: { runId: "probe-run", scheduledAt: 1 },
			},
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		await waitFor(() => observed.settled.length >= 2, "the foreign custom message turn to settle");

		assert.ok(observed.settled.length >= 2, "the foreign custom message actually settled");

		assert.deepEqual(observed.consumed, [{ runId: "probe-run", scheduledAt: 1 }]);
	});
});

/**
 * Host-level regression for the last guard on the heartbeat path (issue #1975).
 *
 * The three guards the scheduler owns all sit before `sendMessage`. Once the
 * host accepts a heartbeat, its visible card is committed to the transcript and
 * a hidden reconciliation is queued behind it, and nothing in the extension API
 * withdraws either. So a run that finishes while its card is parked, and a card
 * recovered from a previous process at the restart door, both used to steer the
 * parent about a run that was over.
 *
 * These run against the real `AgentSession` for the same reason as the tests
 * above: the behaviour only exists in the host. What is asserted is the thing
 * that matters — whether the heartbeat text reaches the *provider request*.
 */
describe("workflow heartbeat context invalidation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const RUN_ID = "invalidation-run";
	const HEARTBEAT_TEXT = '♥ Workflow "probe" is still running (run invalidation-run)';
	const FOREIGN_TEXT = "an unrelated extension's custom message";

	function heartbeatDetails(): Record<string, string | number> {
		return { runId: RUN_ID, scheduledAt: 1, workflowName: "probe", startedAt: 0, intervalMinutes: 1 };
	}

	/**
	 * A harness wired with the production decision — the same function
	 * `extension-runtime-state.ts` calls, over the same store authority — rather
	 * than a test-local reimplementation of it.
	 */
	async function createInvalidatingHarness(
		store: ReturnType<typeof createStore>,
		pending: ReadonlyMap<string, WorkflowHeartbeatIdentity> = new Map(),
	): Promise<{
		harness: Harness;
		contexts: string[];
	}> {
		const contexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event, ctx) => {
						const invalidation = workflowHeartbeatContextInvalidation(
							event,
							ctx.sessionManager.getEntries() as readonly SessionEntry[],
							(identity) => {
								const run = store.runs().find((candidate) => candidate.id === identity.runId);
								return (
									pending.get(identity.runId)?.scheduledAt === identity.scheduledAt &&
									run !== undefined &&
									!isWorkflowHeartbeatTerminalRun(run)
								);
							},
						);
						return invalidation as MessageEndEventResult | undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, contexts };
	}

	/** Every provider request this turn, flattened, so a steer cannot hide in a part. */
	function recordContext(contexts: string[], context: unknown): void {
		contexts.push(JSON.stringify(context));
	}

	/**
	 * How many provider requests carried this text. The needle is JSON-encoded
	 * before the search because the haystack is: a card reading `Workflow "probe"`
	 * appears as `Workflow \"probe\"` in the serialized context, and comparing the
	 * raw string would silently never match and pass whatever the code did.
	 */
	function contextsCarrying(contexts: readonly string[], text: string): number {
		const encoded = JSON.stringify(text).slice(1, -1);
		return contexts.filter((context) => context.includes(encoded)).length;
	}

	function startRun(store: ReturnType<typeof createStore>, id: string, startedAt = 0): void {
		store.recordRunStart({ id, name: "probe", inputs: {}, status: "running", stages: [], startedAt });
	}

	test("a card parked while its run becomes recoverably blocked still reaches the model", async () => {
		const store = createStore();
		startRun(store, RUN_ID);
		const pending = new Map<string, WorkflowHeartbeatIdentity>([[RUN_ID, { runId: RUN_ID, scheduledAt: 1 }]]);
		const { harness, contexts } = await createInvalidatingHarness(store, pending);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (context, options) => {
				recordContext(contexts, context);
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after the recoverable block");
			},
			fauxAssistantMessage("spare"),
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;
		await harness.session.sendCustomMessage(
			{
				customType: "workflows:workflow-heartbeat",
				content: [{ type: "text", text: HEARTBEAT_TEXT }],
				display: true,
				details: heartbeatDetails(),
			},
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		assert.equal(
			store.recordRunBlocked(RUN_ID, "rate limited", {
				failureKind: "rate_limit",
				failureRecoverability: "recoverable",
				failureDisposition: "active_blocked",
				failureMessage: "Provider rate limit reached.",
				failedStageId: "s1",
				resumable: true,
			}),
			true,
		);

		await harness.session.resumeQueuedMessages();
		await harness.session.prompt("explicit resume driver");

		assert.ok(
			contextsCarrying(contexts, HEARTBEAT_TEXT) > 0,
			"the resumable run still owns its admitted heartbeat, so the parent learns that it is stuck",
		);
	});

	test("a card parked past its run's terminal state never reaches the model", async () => {
		const store = createStore();
		startRun(store, RUN_ID);
		const pending = new Map<string, WorkflowHeartbeatIdentity>([[RUN_ID, { runId: RUN_ID, scheduledAt: 1 }]]);
		const { harness, contexts } = await createInvalidatingHarness(store, pending);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (context, options) => {
				recordContext(contexts, context);
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after the parked card");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare");
			},
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;

		await harness.session.sendCustomMessage(
			{
				customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
				content: [{ type: "text", text: HEARTBEAT_TEXT }],
				display: true,
				details: heartbeatDetails(),
			},
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		await harness.session.sendCustomMessage(
			{ customType: "someone-else:notice", content: [{ type: "text", text: FOREIGN_TEXT }], display: true },
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		store.recordRunEnd(RUN_ID, "completed");

		await harness.session.resumeQueuedMessages();
		await harness.session.prompt("explicit resume driver");

		assert.ok(contexts.length > 1, "the resumed turn reached the provider");
		assert.ok(
			contextsCarrying(contexts, FOREIGN_TEXT) > 0,
			"another extension's parked custom message still reaches the model, so the drain really ran",
		);
		assert.equal(
			contextsCarrying(contexts, HEARTBEAT_TEXT),
			0,
			"the terminal run's heartbeat never enters the model's context",
		);
		assert.ok(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === WORKFLOW_HEARTBEAT_CUSTOM_TYPE),
			"the visible card remains in the transcript as a true record of what was raised",
		);
	});

	test("an old admitted heartbeat stays invalid after same-id durable resume", async () => {
		const store = createStore();
		startRun(store, RUN_ID);
		const pending = new Map<string, WorkflowHeartbeatIdentity>([[RUN_ID, { runId: RUN_ID, scheduledAt: 1 }]]);
		const { harness, contexts } = await createInvalidatingHarness(store, pending);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const started = Promise.withResolvers<void>();
		harness.setResponses([
			async (context, options) => {
				recordContext(contexts, context);
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("interrupted");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after durable resume");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare");
			},
		]);

		const active = harness.session.prompt("start a streaming turn");
		await started.promise;
		await harness.session.sendCustomMessage(
			{
				customType: WORKFLOW_HEARTBEAT_CUSTOM_TYPE,
				content: [{ type: "text", text: HEARTBEAT_TEXT }],
				display: true,
				details: heartbeatDetails(),
			},
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		await harness.session.sendCustomMessage(
			{ customType: "someone-else:notice", content: [{ type: "text", text: FOREIGN_TEXT }], display: true },
			{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
		);
		harness.session.pauseQueuedMessages();
		await harness.session.abort();
		await active;

		store.recordRunEnd(RUN_ID, "failed");
		pending.delete(RUN_ID);
		store.removeRun(RUN_ID);
		startRun(store, RUN_ID, 2);
		pending.set(RUN_ID, { runId: RUN_ID, scheduledAt: 3 });

		await harness.session.resumeQueuedMessages();
		await harness.session.prompt("drive the resumed queue");

		assert.ok(contextsCarrying(contexts, FOREIGN_TEXT) > 0, "the parked queue drained after resume");
		assert.equal(
			contextsCarrying(contexts, HEARTBEAT_TEXT),
			0,
			"the resumed run's later identity cannot revive the old admitted heartbeat",
		);
	});

	test("a heartbeat recovered from a previous process never reaches the model", async () => {
		// The restart door: the workflows store is cleared at session start and
		// loads lazily, so the run behind a recovered card is normally absent
		// rather than terminal. Delivering it would replay a boundary raised by a
		// process that is gone.
		const store = createStore();
		const { harness, contexts } = await createInvalidatingHarness(store);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("first turn");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("after recovery");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare two");
			},
			(context) => {
				recordContext(contexts, context);
				return fauxAssistantMessage("spare three");
			},
		]);

		// A conversation has to exist before recovery can continue one.
		await harness.session.prompt("prime the conversation");

		// The durable trace a previous process left: a heartbeat card carrying the
		// protected-reconciliation marker and no persisted hidden completion.
		harness.sessionManager.appendCustomMessageEntry(
			"workflows:workflow-heartbeat",
			[{ type: "text", text: HEARTBEAT_TEXT }],
			true,
			heartbeatDetails(),
			true,
			{ delivery: "steer" },
			undefined,
		);
		harness.sessionManager.appendCustomMessageEntry(
			"someone-else:notice",
			[{ type: "text", text: FOREIGN_TEXT }],
			true,
			undefined,
			true,
			{ delivery: "steer" },
			undefined,
		);

		// Binding again drives `recoverProtectedStreamingCustomMessages`.
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.prompt("drive the recovered queue");

		assert.ok(contexts.length > 1, "the recovered queue drove a second turn");
		assert.ok(
			contextsCarrying(contexts, FOREIGN_TEXT) > 0,
			"another extension's recovered card reaches the model, so recovery really requeued and drained",
		);
		assert.equal(
			contextsCarrying(contexts, HEARTBEAT_TEXT),
			0,
			"a stale recovered heartbeat is invalidated rather than replayed to the model",
		);
	});
});
