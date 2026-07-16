import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the heavy module's config discovery from developer/user machines
// before the lazy import chain can snapshot config paths.
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "intercom-lazy-relay-"));

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
});

import intercom from "../../packages/intercom/index.js";
import { InboundMessageAdmission } from "../../packages/intercom/inbound-message-admission.js";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => void | Promise<void>;

const SESSION_ID = "019f0000-aaaa-7bbb-8ccc-dddddddddddd";
const SELF_ALIAS = "subagent-chat-019f0000";

function fixture() {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const entries: Array<{ type: string; data: { error?: string } }> = [];
	const inboundMessages: Array<{ customType?: string }> = [];
	const deliveryAcks: Array<{ requestId?: string; delivered?: boolean; error?: string }> = [];
	const sourceAdmission = new InboundMessageAdmission();
	const ctx = {
		hasUI: false,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => SESSION_ID },
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
		appendEntry(type: string, data: { error?: string }) { entries.push({ type, data }); },
		sendMessage(message: { customType?: string }) { inboundMessages.push(message); },
		sendMessages(messages: Array<{ customType?: string }>) { inboundMessages.push(...messages); },
		getSessionName: () => undefined,
		events: {
			on(name: string, handler: (payload: unknown) => void) {
				const current = eventHandlers.get(name) ?? [];
				current.push(handler);
				eventHandlers.set(name, current);
				return () => {};
			},
			emit(name: string, payload: unknown) {
				if (name === "subagent:result-intercom-delivery") {
					deliveryAcks.push(payload as { requestId?: string; delivered?: boolean; error?: string });
				}
				for (const handler of eventHandlers.get(name) ?? []) handler(payload);
			},
		},
	};
	intercom(pi as never);
	return {
		entries,
		inboundMessages,
		deliveryAcks,
		async fire(name: string, event: Record<string, unknown>) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		emitResult(requestId: string) {
			pi.events.emit("subagent:result-intercom", { to: SELF_ALIAS, message: "grouped results", requestId });
		},
		emitLateStageMessage() {
			const details = {
				from: { id: "sender", name: "reviewer", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
				message: { id: "late-message", timestamp: 1, content: { text: "late reviewer message" } },
				bodyText: "late reviewer message",
			};
			assert.equal(sourceAdmission.accept(details.from, details.message), true);
			const payload: { handled: boolean; completion?: Promise<void>; batch: boolean; messages: object[]; options: object } = {
				handled: false,
				batch: false,
				messages: [{
					customType: "intercom_message",
					content: "late reviewer message",
					display: true,
					details,
				}],
				options: { triggerTurn: true, stageAdmissionKey: "intercom:late-message" },
			};
			pi.events.emit("atomic:workflow-stage-late-message", payload);
			return payload;
		},
	};
}

async function settle(done: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !done(); attempt++) await Bun.sleep(5);
	// One extra tick so any spurious follow-up work (extra acks, error
	// entries) has a chance to surface before assertions.
	await Bun.sleep(10);
}

describe("lazy relay lifecycle-context fallback", () => {
	test("delivers self-addressed results locally in sessions that never emit session_start", async () => {
		const current = fixture();
		// Sessions created without extension bindings (for example
		// non-interactive in-process child sessions) skip session_start but
		// still emit turn/tool lifecycle events.
		await current.fire("turn_start", { type: "turn_start" });
		await current.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent", args: {} });

		current.emitResult("req-lifecycle-ctx");
		await settle(() => current.deliveryAcks.length > 0);

		assert.deepEqual(current.deliveryAcks, [{ requestId: "req-lifecycle-ctx", delivered: true }]);
		assert.equal(current.inboundMessages.filter((message) => message.customType === "intercom_message").length, 1);
		assert.deepEqual(current.entries, [], "no delivery-error entries are recorded");
	});


	test("lazy-loads parent Intercom before accepting a late stage route", async () => {
		const current = fixture();
		await current.fire("turn_start", { type: "turn_start" });
		const payload = current.emitLateStageMessage();

		assert.equal(payload.handled, true);
		assert.ok(payload.completion);
		await payload.completion;
		assert.equal(current.inboundMessages.filter((message) => message.customType === "intercom_message").length, 1);
	});
	test("still delivers locally on the normal session_start path", async () => {
		const current = fixture();
		await current.fire("session_start", { type: "session_start", reason: "startup" });

		current.emitResult("req-session-start");
		await settle(() => current.deliveryAcks.length > 0);

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
		await settle(() => current.deliveryAcks.length > 0);

		assert.equal(current.deliveryAcks.length, 1);
		assert.equal(current.deliveryAcks[0]?.requestId, "req-cold");
		assert.equal(current.deliveryAcks[0]?.delivered, false);
		assert.deepEqual(current.entries, [], "no delivery-error entries are recorded for an uninitialized runtime");
		assert.deepEqual(current.inboundMessages, []);
	});
});
