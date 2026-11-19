/**
 * Regression: a *recoverable* Intercom broker disconnect must not be rendered
 * as a session-facing failure while lazy re-initialization can still recover.
 *
 * Two boundaries reached a running session's UI during Goal run
 * 16a9f7ed-e55a-44b4-b89f-3b63ef9197a2:
 *
 *  1. The host extension-error boundary. `packages/intercom/index.ts` eagerly
 *     awaits `loadHeavy(ctx)` inside its `session_start` handler for a session
 *     that must connect at once (now an admitted subagent child). A rejection
 *     that escaped the handler was caught by the host's `runGenericHandlers`
 *     and pushed through `ExtensionRunner.emitError` to `showExtensionError`
 *     (interactive) and `console.error("Extension error ...")` (print) —
 *     painting "Client disconnected" over a session that was still running.
 *
 *  2. The lazy event-relay boundary. The `subagent:*` relays logged
 *     `Intercom event relay failed (<event>): Client disconnected` straight
 *     into the session output for work the user never initiated.
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
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runGenericHandlers } from "../../packages/coding-agent/src/core/extensions/runner-events.js";
import type {
	Extension,
	ExtensionContext,
	ExtensionError,
} from "../../packages/coding-agent/src/core/extensions/types.js";
import intercom from "../../packages/intercom/index.js";
import {
	IntercomBrokerTimeoutError,
	IntercomClientDisconnectedError,
} from "../../packages/intercom/recoverable-disconnect.js";
import { requestSupervisorAuthorization } from "../../packages/subagents/src/intercom/supervisor-authorization.js";

const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const EXTENSION_PATH = "<intercom>";

type HeavyModule = { default: (pi: ExtensionAPI) => void | Promise<void> };
type ImportResult = { error: unknown } | { module: HeavyModule } | { pending: Promise<HeavyModule> };
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

/** Console output the session would have shown for an Intercom relay. */
function relayFailureLogs(): ConsoleErrorCall[] {
	return consoleErrorCalls.filter(
		([message]) => typeof message === "string" && message.startsWith("Intercom event relay failed"),
	);
}

/** A `session_start` context of an admitted subagent child, which connects to Intercom at session start. */
function admittedChildContext(): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		subagentPolicy: { intercom: { orchestratorTarget: "parent", runId: "run", agent: "worker", index: 0 } },
	} as never;
}

function successfulHeavyModule(): HeavyModule {
	return {
		default(heavyPi) {
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

function fixture(importResults: ImportResult[]) {
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
			if ("pending" in result) return await result.pending;
			return result.module;
		},
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
		async emitSessionStart(ctx: ExtensionContext = admittedChildContext()): Promise<ExtensionError[]> {
			const reported: ExtensionError[] = [];
			const event: SessionStartEvent = { type: "session_start", reason: "startup" };
			await runGenericHandlers([hostExtension()], ctx, event as never, (error) => reported.push(error));
			return reported;
		},
		/** Drives `session_shutdown` the way the host runner does. */
		async emitSessionShutdown(ctx: ExtensionContext = admittedChildContext()): Promise<ExtensionError[]> {
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

describe("Intercom recoverable disconnect at the session-start UI boundary", () => {
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
	test("keeps 'Intercom event relay failed' out of the session output while acknowledging the relay", async () => {
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
						error: "Client disconnected",
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
});

describe("Intercom recoverable disconnect at the supervisor-authorization channel", () => {
	// This is the channel that actually leaked in Goal run
	// 16a9f7ed-e55a-44b4-b89f-3b63ef9197a2: the `subagent` tool returned the bare
	// string "Client disconnected" as its entire result, four times, while the
	// session kept running. `requestSupervisorAuthorization` rethrows every
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

describe("Intercom broker registration timeout at the lazy event-relay boundary", () => {
	const PERSISTENT_OUTAGE_MS = 60_000;
	const OUTAGE_REPORT = /^Intercom broker has not answered for over 60s/;

	function outageReports(): ConsoleErrorCall[] {
		return consoleErrorCalls.filter(([message]) => typeof message === "string" && OUTAGE_REPORT.test(message));
	}

	async function relayResult(current: ReturnType<typeof fixture>): Promise<void> {
		current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, { requestId: "req-1", to: "parent", message: "done" });
		await tick();
	}

	test("keeps a burst of relays that all time out out of the session output", async () => {
		const current = fixture([{ error: new IntercomBrokerTimeoutError("Connection timeout") }]);

		for (let update = 0; update < 50; update += 1) {
			current.emitPiEvent(SUBAGENT_RESULT_INTERCOM_EVENT, {
				requestId: `req-${update}`,
				to: "parent",
				message: "done",
			});
		}
		await tick();

		assert.deepEqual(consoleErrorCalls, []);
	});

	test("reports a broker that stays silent once per outage, and again only after a relay succeeds", async () => {
		const broker = { silent: true };
		const current = fixture([
			{
				module: {
					default(heavyPi) {
						heavyPi.events.on(SUBAGENT_RESULT_INTERCOM_EVENT, () => {
							if (broker.silent) throw new IntercomBrokerTimeoutError("Connection timeout");
						});
					},
				},
			},
		]);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const outageStart = Date.UTC(2026, 0, 1);
			vi.setSystemTime(outageStart);
			await relayResult(current);
			vi.setSystemTime(outageStart + PERSISTENT_OUTAGE_MS - 1);
			await relayResult(current);
			assert.equal(outageReports().length, 0, "a timeout that has not persisted is not an outage");

			vi.setSystemTime(outageStart + PERSISTENT_OUTAGE_MS);
			await relayResult(current);
			assert.equal(outageReports().length, 1);
			vi.setSystemTime(outageStart + 3 * PERSISTENT_OUTAGE_MS);
			await relayResult(current);
			await relayResult(current);
			assert.equal(outageReports().length, 1, "one outage is reported once, however many relays it times out");
			assert.deepEqual(relayFailureLogs(), []);

			broker.silent = false;
			await relayResult(current);
			broker.silent = true;
			const nextOutageStart = outageStart + 4 * PERSISTENT_OUTAGE_MS;
			vi.setSystemTime(nextOutageStart);
			await relayResult(current);
			assert.equal(
				outageReports().length,
				1,
				"a relay that succeeded ended the outage; a new timeout starts a fresh one",
			);
			vi.setSystemTime(nextOutageStart + PERSISTENT_OUTAGE_MS);
			await relayResult(current);
			assert.equal(outageReports().length, 2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("keeps a user-initiated Intercom call visibly failing on a broker registration timeout", async () => {
		const timeout = new IntercomBrokerTimeoutError("Connection timeout");
		const current = fixture([{ error: timeout }]);

		await assert.rejects(current.executeIntercomTool(), timeout);
	});
});
