import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import {
	hasToolDetachment,
	markToolCallReadyForDetachment,
	toolCallNeedsDetachmentHandoff,
} from "../src/core/agent-session-detached-tools.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { harnessPool, persistedManager, toolResultIds } from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

function askTool(options: {
	readonly requiresReady: boolean;
	readonly execute: (signal: AbortSignal | undefined) => Promise<ReturnType<typeof text>>;
}): ToolDefinition {
	return {
		name: "ask_peer",
		label: "Ask peer",
		description: "Asks a peer",
		parameters: Type.Object({}),
		detachable: true,
		...(options.requiresReady ? { detachmentRequiresReady: true } : {}),
		execute: async (_id, _params, signal) => options.execute(signal),
	};
}

describe("the detachment policy of a session (#4326)", () => {
	test("a session has a policy only between setToolDetachment and clearing it", async () => {
		const harness = await pool.harnessWith([]);
		assert.equal(hasToolDetachment(harness.session), false, "none was ever set");
		harness.session.setToolDetachment({ afterMs: 10 });
		assert.equal(hasToolDetachment(harness.session), true);
		harness.session.setToolDetachment(undefined);
		assert.equal(hasToolDetachment(harness.session), false);
	});
});

describe("the readiness signal (#4326)", () => {
	test("a signal no call is waiting on is neither ready nor in need of a handoff, and marking it does nothing", () => {
		const unrelated = new AbortController().signal;
		assert.equal(toolCallNeedsDetachmentHandoff(unrelated), false);
		assert.equal(toolCallNeedsDetachmentHandoff(undefined), false);
		assert.doesNotThrow(() => markToolCallReadyForDetachment(unrelated));
	});

	test("only a tool that requires its handoff is told to prepare one, and only while its call runs", async () => {
		const seen: Record<string, { during: boolean; after?: () => boolean }> = {};
		const harness = await pool.harnessWith([
			askTool({
				requiresReady: true,
				execute: async (signal) => {
					seen.requires = {
						during: toolCallNeedsDetachmentHandoff(signal),
						after: () => toolCallNeedsDetachmentHandoff(signal),
					};
					return text("done");
				},
			}),
		]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_peer", {}, { id: "a-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("answered"),
		]);
		await harness.session.prompt("ask");
		assert.equal(seen.requires?.during, true);
		assert.equal(seen.requires?.after?.(), false, "its call ended, so nothing waits on it any more");
		assert.deepEqual(toolResultIds(harness.sessionManager), ["a-1"]);

		const plain = await pool.harnessWith([
			askTool({
				requiresReady: false,
				execute: async (signal) => {
					seen.plain = { during: toolCallNeedsDetachmentHandoff(signal) };
					return text("done");
				},
			}),
		]);
		plain.session.setToolDetachment({ afterMs: 60_000 });
		plain.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_peer", {}, { id: "a-2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("answered"),
		]);
		await plain.session.prompt("ask");
		assert.equal(seen.plain?.during, false);
	});

	test("a call that marks itself ready before the delay has passed keeps running inline until it finishes", async () => {
		const harness = await pool.harnessWith([
			askTool({
				requiresReady: true,
				execute: async (signal) => {
					assert.ok(signal);
					markToolCallReadyForDetachment(signal);
					await new Promise((resolve) => setTimeout(resolve, 30));
					return text("answer");
				},
			}),
		]);
		harness.session.setToolDetachment({ afterMs: 60_000 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_peer", {}, { id: "a-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("answered"),
		]);
		await harness.session.prompt("ask");
		assert.deepEqual(harness.session.takeDetachedToolCalls(), [], "ready is not enough: the delay has not passed");
		assert.deepEqual(toolResultIds(harness.sessionManager), ["a-1"]);
	});
});

describe("a transcript that ends on a call no detachable tool made (#4326)", () => {
	test("has no detached turn to continue, and nothing to start again", async () => {
		const { manager, store } = await persistedManager();
		await manager.appendMessage({ role: "user", content: "run it", timestamp: 1 });
		await manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "starting" },
				{ type: "toolCall", id: "x-1", name: "no_such_tool", arguments: {} },
			],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		const reopened = await pool.harnessWith([], await SessionManager.open(store, manager.getSessionId()));
		assert.equal(reopened.session.hasPendingDetachedTurn(), false);
		assert.deepEqual(reopened.session.redispatchDetachedToolCalls(), []);
	});
});
