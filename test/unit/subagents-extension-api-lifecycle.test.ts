import assert from "node:assert/strict";
import type { ExtensionAPI } from "@bastani/atomic";
import { test } from "vitest";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../packages/subagents/src/shared/types.js";
import {
	buildSlashInitialResult,
	getSlashRenderableSnapshot,
} from "../../packages/subagents/src/slash/slash-live-state.js";

class TestEventBus {
	private readonly handlers = new Map<string, Set<(payload: object) => void>>();

	constructor(private readonly ineffectiveUnsubscribe = false) {}

	on(event: string, handler: (payload: object) => void): () => void {
		const handlers = this.handlers.get(event) ?? new Set<(payload: object) => void>();
		handlers.add(handler);
		this.handlers.set(event, handlers);
		return () => {
			if (!this.ineffectiveUnsubscribe) handlers.delete(handler);
		};
	}

	emit(event: string, payload: object): void {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
	}

	count(event: string): number {
		return this.handlers.get(event)?.size ?? 0;
	}

	totalCount(): number {
		return [...this.handlers.values()].reduce((total, handlers) => total + handlers.size, 0);
	}
}

interface TestApi {
	pi: ExtensionAPI;
	events: TestEventBus;
	messages: Array<{ customType?: string; content: string }>;
}

function makeApi(ineffectiveUnsubscribe = false): TestApi {
	const events = new TestEventBus(ineffectiveUnsubscribe);
	const messages: TestApi["messages"] = [];
	const pi = {
		events,
		sendMessage(message: { customType?: string; content: string }) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, events, messages };
}

interface ExtensionHarness extends TestApi {
	shutdownHandlers: Array<() => void>;
}

function makeExtensionHarness(): ExtensionHarness {
	const base = makeApi();
	const shutdownHandlers: Array<() => void> = [];
	Object.assign(base.pi, {
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	});
	return { ...base, shutdownHandlers };
}
test("full extension wiring keeps parent handlers alive across stage shutdown and reload", () => {
	const parent = makeExtensionHarness();
	const stage = makeExtensionHarness();
	registerSubagentExtension(parent.pi);
	registerSubagentExtension(stage.pi);
	assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "parent owns tracker and notify handlers");
	assert.equal(stage.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "stage owns independent handlers");
	const parentSlash = buildSlashInitialResult("shared-request", { agent: "worker", task: "parent task" }, parent.pi);
	buildSlashInitialResult("shared-request", { agent: "worker", task: "stage task" }, stage.pi);

	stage.shutdownHandlers[0]?.();
	assert.equal(stage.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 0);
	assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 2, "stage shutdown must preserve parent handlers");
	assert.equal(
		getSlashRenderableSnapshot(parentSlash, parent.pi).result.details.results[0]?.task,
		"parent task",
		"stage shutdown must preserve the parent slash snapshot store",
	);

	registerSubagentExtension(parent.pi);
	assert.equal(
		parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT),
		2,
		"same-API reload replaces rather than duplicates handlers",
	);
	parent.shutdownHandlers[0]?.();
	assert.equal(
		parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT),
		2,
		"stale shutdown cannot tear down the replacement",
	);
	parent.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
		id: "full-extension-result",
		agent: "worker",
		success: true,
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(parent.messages.length, 1);
	parent.shutdownHandlers[1]?.();
	assert.equal(parent.events.count(SUBAGENT_ASYNC_COMPLETE_EVENT), 0);
});
