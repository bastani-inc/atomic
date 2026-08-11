import assert from "node:assert/strict";
import { isStaleExtensionContextError, STALE_EXTENSION_CONTEXT_MARKER } from "@bastani/atomic";
import { registerPromptTemplateBridgeRequestSettlement } from "@bastani/subagents";
import { test } from "vitest";
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

function requestFromPromptTemplateModel(events: FakeEvents, payload: typeof request): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let done = false;
		let unregisterSettlement: (() => void) | undefined;
		const unsubscribeResponse = events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== payload.requestId) return;
			finish(() => resolve(data));
		});
		const finish = (next: () => void): void => {
			if (done) return;
			done = true;
			unsubscribeResponse();
			unregisterSettlement?.();
			next();
		};
		unregisterSettlement = registerPromptTemplateBridgeRequestSettlement(payload.requestId, (error) =>
			finish(() => reject(error)),
		);
		try {
			events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, payload);
		} catch (error) {
			finish(() => reject(error));
		}
	});
}
test("a stale prompt-template response emit rejects the external caller", async () => {
	const events = new FakeEvents((event) => {
		if (event === PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT) throw new Error(STALE_EXTENSION_CONTEXT_MARKER);
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
		await assert.rejects(requestFromPromptTemplateModel(events, request), (error: unknown) => {
			assert.equal(isStaleExtensionContextError(error), true);
			return true;
		});
	} finally {
		bridge.dispose();
	}
});
