import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";

// Isolate the heavy module's config discovery from developer/user machines
// before the lazy import chain can snapshot config paths.
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousIntercomGroup = process.env.ATOMIC_INTERCOM_GROUP;
const previousLegacyIntercomGroup = process.env.PI_INTERCOM_GROUP;
process.env.ATOMIC_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "intercom-lazy-relay-"));
delete process.env.ATOMIC_INTERCOM_GROUP;
delete process.env.PI_INTERCOM_GROUP;

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousIntercomGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
	else process.env.ATOMIC_INTERCOM_GROUP = previousIntercomGroup;
	if (previousLegacyIntercomGroup === undefined) delete process.env.PI_INTERCOM_GROUP;
	else process.env.PI_INTERCOM_GROUP = previousLegacyIntercomGroup;
});

import intercom from "../../packages/intercom/index.js";
import { sleep } from "../helpers/runtime.js";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => void | Promise<void>;

const SESSION_ID = "019f0000-aaaa-7bbb-8ccc-dddddddddddd";
const SELF_ALIAS = "subagent-chat-019f0000-aaaa-7bbb-8ccc-dddddddddddd";

interface CapturedInboundMessage {
	readonly customType?: string;
	readonly details?: { readonly message?: object };
}

function fixture(options: { rejectLateRoutes?: number } = {}) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
	const entries: Array<{ type: string; data: { error?: string } }> = [];
	const inboundMessages: CapturedInboundMessage[] = [];
	const deliveryAcks: Array<{ requestId?: string; delivered?: boolean; error?: string }> = [];
	const firstAck = Promise.withResolvers<void>();
	let remainingLateRouteRejections = options.rejectLateRoutes ?? 0;
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [] },
		model: { id: "test-model" },
		isIdle: () => true,
		ui: { notify() {} },
	};
	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry(type: string, data: { error?: string }) {
			entries.push({ type, data });
		},
		async sendMessage(message: CapturedInboundMessage) {
			if (message.customType === "intercom_message" && remainingLateRouteRejections > 0) {
				remainingLateRouteRejections -= 1;
				throw new Error("injected main-chat route failure");
			}
			inboundMessages.push(message);
		},
		async sendMessages(messages: CapturedInboundMessage[]) {
			if (
				messages.some((message) => message.customType === "intercom_message") &&
				remainingLateRouteRejections > 0
			) {
				remainingLateRouteRejections -= 1;
				throw new Error("injected main-chat route failure");
			}
			inboundMessages.push(...messages);
		},
		getSessionName: () => undefined,
		events: {
			on(name: string, handler: (payload: unknown) => void | Promise<void>) {
				const current = eventHandlers.get(name) ?? [];
				current.push(handler);
				eventHandlers.set(name, current);
				return () => {};
			},
			emit(name: string, payload: unknown) {
				if (name === "subagent:result-intercom-delivery") {
					deliveryAcks.push(payload as { requestId?: string; delivered?: boolean; error?: string });
					firstAck.resolve();
				}
				for (const handler of eventHandlers.get(name) ?? []) void handler(payload);
			},
		},
	};
	intercom(pi as never);
	return {
		entries,
		inboundMessages,
		deliveryAcks,
		/** Settles with the relay's first delivery acknowledgement. */
		firstAck: firstAck.promise,
		async fire(name: string, event: Record<string, unknown>) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		emitResult(requestId: string) {
			pi.events.emit("subagent:result-intercom", { to: SELF_ALIAS, message: "grouped results", requestId });
		},
	};
}

/**
 * Waits for the relay's first acknowledgement, however long a loaded machine takes to load its modules on first use.
 */
async function settle(acknowledged: Promise<void>): Promise<void> {
	await acknowledged;
	// One extra tick so any spurious follow-up work (extra acks, error
	// entries) has a chance to surface before assertions.
	await sleep(10);
}

describe("lazy relay lifecycle-context fallback", () => {
	test("delivers self-addressed results locally in sessions that never emit session_start", async () => {
		const current = fixture();
		// Sessions created without extension bindings (for example
		// non-interactive in-process child sessions) skip session_start but
		// still emit turn/tool lifecycle events.
		await current.fire("turn_start", { type: "turn_start" });
		await current.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "subagent",
			args: {},
		});

		current.emitResult("req-lifecycle-ctx");
		await settle(current.firstAck);

		assert.deepEqual(current.deliveryAcks, [{ requestId: "req-lifecycle-ctx", delivered: true }]);
		assert.equal(current.inboundMessages.filter((message) => message.customType === "intercom_message").length, 1);
		assert.deepEqual(current.entries, [], "no delivery-error entries are recorded");
	});

	test("still delivers locally on the normal session_start path", async () => {
		const current = fixture();
		await current.fire("session_start", { type: "session_start", reason: "startup" });

		current.emitResult("req-session-start");
		await settle(current.firstAck);

		assert.deepEqual(current.deliveryAcks, [{ requestId: "req-session-start", delivered: true }]);
		assert.equal(current.inboundMessages.filter((message) => message.customType === "intercom_message").length, 1);
		assert.deepEqual(current.entries, []);
	});

	test("acknowledges quietly instead of recording a connection error when no context is known", async () => {
		const current = fixture();
		// No session_start and no lifecycle events at all: the runtime cannot
		// initialize, so the relay must fall back to an undelivered ack without
		// appending misleading connection-error entries.
		current.emitResult("req-cold");
		await settle(current.firstAck);

		assert.equal(current.deliveryAcks.length, 1);
		assert.equal(current.deliveryAcks[0]?.requestId, "req-cold");
		assert.equal(current.deliveryAcks[0]?.delivered, false);
		assert.deepEqual(current.entries, [], "no delivery-error entries are recorded for an uninitialized runtime");
		assert.deepEqual(current.inboundMessages, []);
	});
});
