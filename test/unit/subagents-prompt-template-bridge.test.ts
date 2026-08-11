import assert from "node:assert/strict";
import { isStaleExtensionContextError, STALE_EXTENSION_CONTEXT_MARKER } from "@bastani/atomic";
import { test } from "vitest";
import { registerBridgeRequestSettlement } from "../../packages/subagents/src/slash/bridge-settlement.js";
import {
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	registerPromptTemplateDelegationBridge,
} from "../../packages/subagents/src/slash/prompt-template-bridge.js";

type EventHandler = (data: unknown) => void | Promise<void>;

class FakeEvents {
	private readonly handlers = new Map<string, Set<EventHandler>>();

	constructor(private readonly beforeEmit?: (event: string) => void) {}

	on(event: string, handler: EventHandler): () => void {
		const handlers = this.handlers.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, data: unknown): void {
		this.beforeEmit?.(event);
		for (const handler of this.handlers.get(event) ?? []) {
			try {
				void Promise.resolve(handler(data)).catch(() => {});
			} catch {
				// Match the host event bus, which contains synchronous handler failures.
			}
		}
	}
}

const request = {
	requestId: "prompt-template-stale-response",
	agent: "worker",
	task: "finish the task",
	context: "fresh" as const,
	model: "test/model",
	cwd: "/repo",
};

test("a stale prompt-template response emit rejects its registered settlement", async () => {
	const events = new FakeEvents((event) => {
		if (event === PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT) throw new Error(STALE_EXTENSION_CONTEXT_MARKER);
	});
	const settlementResult = Promise.withResolvers<unknown>();
	const unregister = registerBridgeRequestSettlement("prompt-template", request.requestId, {
		reject: settlementResult.resolve,
	});
	const bridge = registerPromptTemplateDelegationBridge({
		events,
		getContext: () => ({ cwd: request.cwd }),
		execute: async () => ({
			content: [{ type: "text", text: "done" }],
			details: { results: [] },
		}),
	});

	try {
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);
		const error = await settlementResult.promise;
		assert.equal(isStaleExtensionContextError(error), true);
	} finally {
		unregister();
		bridge.dispose();
	}
});
