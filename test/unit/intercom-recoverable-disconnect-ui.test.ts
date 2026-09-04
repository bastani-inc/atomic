/**
 * Regression: a *recoverable* Intercom broker disconnect must not be rendered
 * as a stage-facing failure while lazy re-initialization can still recover.
 *
 * Two boundaries actually reached the workflow-stage UI during Goal run
 * 16a9f7ed-e55a-44b4-b89f-3b63ef9197a2:
 *
 *  1. The host extension-error boundary. `packages/intercom/index.ts` eagerly
 *     awaits `loadHeavy(ctx)` inside its `session_start` handler when the stage
 *     carries a `pendingStageDelivery`. A rejection escaped the handler, so the
 *     host's `runGenericHandlers` caught it and pushed it through
 *     `ExtensionRunner.emitError` to `showExtensionError` (interactive) and
 *     `console.error("Extension error ...")` (print) — painting
 *     "Client disconnected" over a stage that was still running.
 *
 *  2. The lazy event-relay boundary. The `subagent:*` / pending-stage relays
 *     logged `Intercom event relay failed (<event>): Client disconnected`
 *     straight into the stage output for work the user never initiated.
 *
 * `d3910c0818` only silenced Intercom's own "heavy initialization failed" log,
 * which is neither of these channels. These tests drive the real boundaries.
 *
 * The classification is by construction, not by message text: only
 * `IntercomClientDisconnectedError` is treated as recoverable, so protocol,
 * authentication, configuration, non-recoverable initialization, terminal relay
 * failures, and an identically worded plain `Error` all stay actionable.
 */

import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type {
	Extension,
	ExtensionContext,
	ExtensionError,
} from "../../packages/coding-agent/src/core/extensions/types.js";
import intercom from "../../packages/intercom/index.js";
import { IntercomClientDisconnectedError } from "../../packages/intercom/recoverable-disconnect.js";
import { IntercomWarmUpExhaustedError } from "../../packages/intercom/warm-up-exhaustion.js";
import { requestSupervisorAuthorization } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { sleep } from "../helpers/runtime.js";

const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";
const EXTENSION_PATH = "<intercom>";

/** Poll until `predicate` holds, so a timer-driven retry is awaited rather than slept through. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the expected condition");
		await sleep(5);
	}
}

type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type ImportResult = { error: unknown } | { module: HeavyModule };
type ConsoleErrorCall = [message?: unknown, ...optionalParams: unknown[]];
type ExtensionEventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type PiEventListener = (payload: unknown) => void;
type SessionStartEvent = { readonly type: "session_start"; readonly reason: "startup" };

const originalConsoleError = console.error;
let consoleErrorCalls: ConsoleErrorCall[] = [];

beforeEach(() => {
	consoleErrorCalls = [];
	console.error = (...args: ConsoleErrorCall) => {
		consoleErrorCalls.push(args);
	};
});

afterEach(() => {
	console.error = originalConsoleError;
});

/** Console output the workflow stage would have shown for an Intercom relay. */
function relayFailureLogs(): ConsoleErrorCall[] {
	return consoleErrorCalls.filter(
		([message]) => typeof message === "string" && message.startsWith("Intercom event relay failed"),
	);
}

/**
 * A `pendingStageDelivery` modeled on the real contract in
 * `packages/workflows/src/runs/foreground/pending-stage-delivery.ts`: `ready()`
 * returns a promise that a successful `deliverPending()` resolves and a
 * terminal `fail()` rejects, and the only production caller of
 * `deliverPending()` is the heavy module's `session_start` replay. A stage that
 * owns queued messages parks on that promise inside `stage-runner-controller`,
 * with no timeout, so the terminal signal is the only thing that can unpark it
 * when recovery runs out.
 */
function pendingStageDeliveryWithQueuedMessages() {
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	let settled: "pending" | "delivered" | "failed" = "pending";
	const readyPromise = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// Not every test awaits `ready()`; an unobserved terminal rejection must not
	// become a process-level unhandled rejection, exactly as production does.
	readyPromise.catch(() => {});
	const delivery = {
		routeCapability: "test-capability",
		deliverPending: async () => {
			delivery.deliverPendingCalls += 1;
			settled = "delivered";
			resolveReady?.();
		},
		ready: () => readyPromise,
		fail: (reason: Error) => {
			delivery.failReasons.push(reason);
			if (settled !== "pending") return;
			settled = "failed";
			rejectReady?.(reason);
		},
		deliverPendingCalls: 0,
		failReasons: [] as Error[],
		get readySettled() {
			return settled !== "pending";
		},
		get readyOutcome() {
			return settled;
		},
	};
	return delivery;
}

type PendingStageDelivery = ReturnType<typeof pendingStageDeliveryWithQueuedMessages>;

/** A workflow-stage `session_start` context carrying a pending stage delivery. */
function workflowStageContext(pendingStageDelivery?: PendingStageDelivery): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		orchestrationContext: {
			kind: "workflow-stage",
			workflowStageName: "implementation",
			pendingStageDelivery: pendingStageDelivery ?? {
				routeCapability: "test-capability",
				deliverPending: async () => {},
				ready: () => undefined,
				fail: () => {},
			},
		},
	} as never;
}

type StageContext = {
	orchestrationContext?: { pendingStageDelivery?: { deliverPending: (deliver: () => void) => Promise<void> } };
};

function successfulHeavyModule(onSessionStart?: (ctx: unknown) => void): HeavyModule {
	return {
		default(heavyPi) {
			// Mirrors `packages/intercom/index-heavy.ts`, which drains the stage's
			// pending deliveries from its own `session_start` handler.
			heavyPi.on("session_start", async (_event, ctx) => {
				onSessionStart?.(ctx);
				const delivery = (ctx as StageContext).orchestrationContext?.pendingStageDelivery;
				if (delivery) await delivery.deliverPending(() => {});
			});
			heavyPi.registerTool({
				name: "intercom",
				label: "Intercom",
				description: "test intercom",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "connected" }], details: {} };
				},
			});
		},
	};
}

function fixture(importResults: ImportResult[], warmUpRetryDelaysMs?: readonly number[]) {
	const handlers = new Map<string, ExtensionEventHandler[]>();
	const eventListeners = new Map<string, PiEventListener[]>();
	const tools = new Map<string, ToolDefinition>();
	const emittedPiEvents: Array<{ name: string; payload: unknown }> = [];
	let imports = 0;

	const pi = {
		on(event: string, handler: ExtensionEventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		getActiveTools: () => [],
		setActiveTools() {},
		events: {
			on(name: string, listener: PiEventListener) {
				eventListeners.set(name, [...(eventListeners.get(name) ?? []), listener]);
			},
			emit(name: string, payload: unknown) {
				emittedPiEvents.push({ name, payload });
				for (const listener of eventListeners.get(name) ?? []) listener(payload);
			},
		},
	};

	intercom(pi as never, {
		async importHeavy() {
			const result = importResults[imports++];
			assert.ok(result, "each heavy initialization attempt needs a fixture result");
			if ("error" in result) throw result.error;
			return result.module;
		},
		...(warmUpRetryDelaysMs ? { warmUpRetryDelaysMs } : {}),
	});

	/**
	 * The registered handlers as the host loader stores them, so `session_start`
	 * runs through the real `runGenericHandlers` catch → `emitError` boundary.
	 */
	function hostExtension(): Extension {
		const hostHandlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
		for (const [event, registered] of handlers) {
			hostHandlers.set(
				event,
				registered.map((handler) => async (...args: unknown[]) => {
					const [extensionEvent, ctx] = args;
					return await handler(extensionEvent, ctx);
				}),
			);
		}
		return {
			path: EXTENSION_PATH,
			resolvedPath: EXTENSION_PATH,
			sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
			handlers: hostHandlers,
			tools: new Map(),
			messageRenderers: new Map(),
			entryRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		} as never;
	}

	return {
		get imports() {
			return imports;
		},
		emittedPiEvents,
		/** The same event bus `requestSupervisorAuthorization` is handed in production. */
		piEvents: pi.events as never,
		/** Drives `session_start` through the host boundary and returns what the UI would show. */
		async emitSessionStart(ctx: ExtensionContext = workflowStageContext()): Promise<ExtensionError[]> {
			const reported: ExtensionError[] = [];
			const event: SessionStartEvent = { type: "session_start", reason: "startup" };
			await runGenericHandlers([hostExtension()], ctx, event as never, (error) => reported.push(error));
			return reported;
		},
		/** Drives `session_shutdown` the way the host runner does. */
		async emitSessionShutdown(ctx: ExtensionContext = workflowStageContext()): Promise<ExtensionError[]> {
			const reported: ExtensionError[] = [];
			const event = { type: "session_shutdown", reason: "quit" };
			await runGenericHandlers([hostExtension()], ctx, event as never, (error) => reported.push(error));
			return reported;
		},
		emitPiEvent(name: string, payload: unknown): void {
			for (const listener of eventListeners.get(name) ?? []) listener(payload);
		},
		executeIntercomTool() {
			const tool = tools.get("intercom");
			assert.ok(tool, "intercom tool should be registered");
			return tool.execute("tool-call", { action: "list" }, new AbortController().signal, undefined, {
				hasUI: true,
			} as never);
		},
	};
}

describe("Intercom recoverable disconnect at the workflow-stage UI boundary", () => {
	test("keeps a recoverable stage warm-up disconnect out of the host extension-error channel", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);

		const reported = await current.emitSessionStart();

		assert.deepEqual(reported, []);
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("stays healthy and reconnects on the next call without a restart", async () => {
		const replayedContexts: unknown[] = [];
		const current = fixture([
			{ error: new IntercomClientDisconnectedError() },
			{ module: successfulHeavyModule((ctx) => replayedContexts.push(ctx)) },
		]);

		const reported = await current.emitSessionStart();
		const result = await current.executeIntercomTool();

		assert.deepEqual(reported, []);
		assert.deepEqual(consoleErrorCalls, []);
		assert.equal(current.imports, 2, "the next call retries initialization on its own");
		assert.deepEqual(result, { content: [{ type: "text", text: "connected" }], details: {} });
		assert.equal(
			replayedContexts.length,
			1,
			"the captured session_start is replayed into the recovered heavy module",
		);
	});

	test("still reports a non-recoverable initialization failure to the host", async () => {
		const importError = new Error("Cannot import Intercom heavy module");
		const current = fixture([{ error: importError }]);

		const reported = await current.emitSessionStart();

		assert.equal(reported.length, 1);
		assert.equal(reported[0]?.event, "session_start");
		assert.equal(reported[0]?.extensionPath, EXTENSION_PATH);
		assert.equal(reported[0]?.error, "Cannot import Intercom heavy module");
	});

	test("does not reclassify an identically worded plain error as recoverable", async () => {
		const lookalike = new Error("Client disconnected");
		const current = fixture([{ error: lookalike }]);

		const reported = await current.emitSessionStart();

		assert.equal(reported.length, 1, "classification is by construction, not by message text");
		assert.equal(reported[0]?.error, "Client disconnected");
	});

	test("keeps a user-initiated Intercom call visibly failing on a recoverable disconnect", async () => {
		const disconnect = new IntercomClientDisconnectedError();
		const current = fixture([{ error: disconnect }]);

		await assert.rejects(current.executeIntercomTool(), disconnect);
	});
});

describe("Intercom recoverable disconnect at the lazy event-relay boundary", () => {
	test("keeps 'Intercom event relay failed' out of the stage output while acknowledging the relay", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);

		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-1", to: "peer", message: "hi" });
		// One macrotask turn drains the whole relay microtask cascade.
		await tick();

		assert.deepEqual(relayFailureLogs(), []);
		assert.deepEqual(
			current.emittedPiEvents.filter((entry) => entry.name === SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT),
			[
				{
					name: SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
					payload: {
						requestId: "req-1",
						delivered: false,
						error: "Client disconnected. Retry the same Intercom call up to three times to reconnect.",
					},
				},
			],
			"the waiting relay is still acknowledged so nothing hangs on the silenced diagnostic",
		);
	});

	test("classifies a recoverable disconnect wrapped as a cause", async () => {
		// `subagent-relay.ts` and `index-heavy.ts` both rewrap failures with `cause`.
		const wrapped = new Error("Client disconnected", { cause: new IntercomClientDisconnectedError() });
		const current = fixture([{ error: wrapped }]);

		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-2" });
		// One macrotask turn drains the whole relay microtask cascade.
		await tick();

		assert.deepEqual(relayFailureLogs(), []);
	});

	test("still reports a terminal relay failure", async () => {
		const terminal = new Error("Intercom protocol error: bad frame");
		const current = fixture([{ error: terminal }]);

		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-3" });
		// One macrotask turn drains the whole relay microtask cascade.
		await tick();

		assert.deepEqual(relayFailureLogs(), [
			[`Intercom event relay failed (${SUBAGENT_RESULT_INTERCOM_EVENT}):`, terminal],
		]);
	});

	test("keeps a recoverable pending-stage undeliverable relay silent and unhandled", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);
		const payload: {
			handled?: boolean;
			completion?: Promise<boolean>;
			runId: string;
			senderId: string;
			messageId: string;
			notificationId: string;
			reason: string;
		} = {
			runId: "run-1",
			senderId: "sender-1",
			messageId: "message-1",
			notificationId: "notification-1",
			reason: "stage_never_started",
		};

		current.emitPiEvent(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		assert.ok(payload.completion, "the relay claims the event and exposes a completion");

		assert.equal(await payload.completion, false);
		assert.deepEqual(relayFailureLogs(), []);
	});

	test("still reports a terminal pending-stage undeliverable relay failure", async () => {
		const terminal = new Error("Intercom heavy module is unavailable");
		const current = fixture([{ error: terminal }]);
		const payload: {
			handled?: boolean;
			completion?: Promise<boolean>;
			runId: string;
			senderId: string;
			messageId: string;
			notificationId: string;
			reason: string;
		} = {
			runId: "run-2",
			senderId: "sender-2",
			messageId: "message-2",
			notificationId: "notification-2",
			reason: "stage_never_started",
		};

		current.emitPiEvent(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		assert.ok(payload.completion);

		assert.equal(await payload.completion, false);
		assert.deepEqual(relayFailureLogs(), [
			[`Intercom event relay failed (${PENDING_STAGE_UNDELIVERABLE_EVENT}):`, terminal],
		]);
	});
});

describe("Intercom recoverable disconnect at the supervisor-authorization channel", () => {
	// This is the channel that actually leaked in Goal run
	// 16a9f7ed-e55a-44b4-b89f-3b63ef9197a2: the `subagent` tool returned the bare
	// string "Client disconnected" as its entire result, four times, while the
	// stage kept running. `requestSupervisorAuthorization` rethrows every
	// non-stale error, and `subagent-executor-single.ts` awaits it inside the run
	// `try`, so the message became the run result.
	test("resolves undefined so a recoverable disconnect never becomes the subagent run result", async () => {
		const current = fixture([{ error: new IntercomClientDisconnectedError() }]);

		const authorization = await requestSupervisorAuthorization(current.piEvents, "child-agent");

		assert.equal(authorization, undefined, "the launch proceeds with supervisor metadata omitted");
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("still rejects a non-recoverable authorization failure so a claimed provider aborts launch", async () => {
		const importError = new Error("Cannot import Intercom heavy module");
		const current = fixture([{ error: importError }]);

		await assert.rejects(requestSupervisorAuthorization(current.piEvents, "child-agent"), importError);
	});

	test("still rejects when the heavy module registers no authorization provider", async () => {
		const current = fixture([{ module: successfulHeavyModule() }]);

		await assert.rejects(
			requestSupervisorAuthorization(current.piEvents, "child-agent"),
			/Intercom supervisor authorization provider is unavailable/,
		);
	});
});

describe("Intercom bounded warm-up retry for a parked workflow stage", () => {
	// A stage carrying queued pending messages parks on
	// `pendingStageDelivery.ready()` in `stage-runner-controller`, with no
	// timeout. Only a successful heavy-module replay calls `deliverPending()`, so
	// silently discarding the warm-up failure would leave that stage waiting with
	// no owner and no signal.
	test("retries after a recoverable warm-up disconnect and unparks the stage", async () => {
		const delivery = pendingStageDeliveryWithQueuedMessages();
		const current = fixture(
			[{ error: new IntercomClientDisconnectedError() }, { module: successfulHeavyModule() }],
			[1],
		);

		const reported = await current.emitSessionStart(workflowStageContext(delivery));
		assert.deepEqual(reported, [], "the stage is not shown an error while recovery is still ahead");
		assert.equal(delivery.readySettled, false, "the stage is parked until a replay delivers");

		await delivery.ready();

		assert.equal(current.imports, 2, "the wrapper owns the retry; no explicit Intercom call was needed");
		assert.equal(delivery.deliverPendingCalls, 1);
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("hands the stage a terminal signal when the bounded attempts run out, with no console diagnostic", async () => {
		const delivery = pendingStageDeliveryWithQueuedMessages();
		const current = fixture(
			[
				{ error: new IntercomClientDisconnectedError() },
				{ error: new IntercomClientDisconnectedError() },
				{ error: new IntercomClientDisconnectedError() },
			],
			[1, 1],
		);

		const reported = await current.emitSessionStart(workflowStageContext(delivery));
		await waitFor(() => delivery.failReasons.length > 0);

		assert.deepEqual(reported, []);
		assert.equal(current.imports, 3, "one warm-up attempt plus the two scheduled retries");
		assert.deepEqual(consoleErrorCalls, [], "no raw extension text is written into the root transcript");
		assert.equal(delivery.failReasons.length, 1, "exactly one terminal signal, not one per attempt");
		const reason = delivery.failReasons[0];
		assert.ok(reason instanceof IntercomWarmUpExhaustedError, "the terminal reason is typed, not a message string");
		assert.equal(reason.attempts, 2);
		assert.match(String(reason?.message), /after 2 warm-up attempts/);
		assert.equal(
			(reason?.cause as Error | undefined)?.name,
			"IntercomClientDisconnectedError",
			"the last recoverable failure is preserved as the cause",
		);
		assert.equal(delivery.readyOutcome, "failed", "the parked stage is settled instead of waiting forever");
		await assert.rejects(delivery.ready(), (error: Error) => error === reason);
	});

	test("contains a delivery whose fail() throws instead of letting it escape the process", async () => {
		// `fail` is part of the delivery contract, so a delivery that throws from it
		// is a host violating that contract. The exhaustion branch runs from a timer
		// callback and from the retry chain's rejection handler, so an escaping throw
		// becomes an uncaughtException or an unhandled rejection — neither of which a
		// misbehaving host may inflict on the session. Nothing may reach the
		// transcript on this path either.
		const delivery = pendingStageDeliveryWithQueuedMessages();
		const hostile = {
			...delivery,
			fail: (reason: Error) => {
				delivery.fail(reason);
				throw new Error("hostile delivery implementation");
			},
		};
		const escaped: unknown[] = [];
		const onEscape = (error: unknown): void => {
			escaped.push(error);
		};
		process.on("uncaughtException", onEscape);
		process.on("unhandledRejection", onEscape);
		const current = fixture(
			[
				{ error: new IntercomClientDisconnectedError() },
				{ error: new IntercomClientDisconnectedError() },
				{ error: new IntercomClientDisconnectedError() },
			],
			[1, 1],
		);

		try {
			const reported = await current.emitSessionStart(workflowStageContext(hostile as never));
			await waitFor(() => delivery.failReasons.length > 0);
			await sleep(50);

			assert.deepEqual(reported, []);
			assert.deepEqual(consoleErrorCalls, []);
			assert.deepEqual(escaped, [], "the contract violation stays inside the extension");
			assert.equal(delivery.failReasons.length, 1, "the reason is still handed over exactly once");
		} finally {
			process.off("uncaughtException", onEscape);
			process.off("unhandledRejection", onEscape);
		}
	});

	test("cancels the retry on session shutdown without another attempt", async () => {
		const delivery = pendingStageDeliveryWithQueuedMessages();
		const current = fixture(
			[{ error: new IntercomClientDisconnectedError() }, { module: successfulHeavyModule() }],
			[40],
		);

		await current.emitSessionStart(workflowStageContext(delivery));
		const shutdownReported = await current.emitSessionShutdown();
		await sleep(120);

		assert.deepEqual(shutdownReported, []);
		assert.equal(current.imports, 1, "the cancelled retry never fires a second import");
		assert.deepEqual(consoleErrorCalls, []);
	});

	test("does not retry a non-recoverable warm-up failure", async () => {
		const delivery = pendingStageDeliveryWithQueuedMessages();
		const current = fixture([{ error: new Error("Cannot import Intercom heavy module") }], [1]);

		const reported = await current.emitSessionStart(workflowStageContext(delivery));
		await sleep(30);

		assert.equal(reported.length, 1, "a non-recoverable failure stays immediately actionable");
		assert.equal(current.imports, 1, "and is not retried");
	});
});
