import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

/**
 * Regression: interactive streaming rendered nothing until `message_end`.
 *
 * `modes/json-event.ts` strips the cumulative `message` from wire `message_update`
 * frames. The isolated interactive engine is the DEFAULT interactive path (`main.ts`
 * sets isolateInteractiveHost for every interactive session) and forwards those wire
 * frames straight into `handleEvent`, so the handler saw no snapshot and skipped the
 * whole render block: `streamingComponent.updateContent()` was never called while the
 * answer streamed. Observed in a real terminal as a pane that showed only a spinner
 * for ~8s and then printed a 150-line answer all at once.
 *
 * This drives the real handler with delta-only frames and asserts the component is
 * updated with progressively longer text.
 */
interface HandleEventAccess {
	handleEvent(event: unknown): Promise<void>;
}

function seedMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "pending",
	} as unknown as AssistantMessage;
}

function makeMode() {
	const rendered: string[] = [];
	const updateContent = vi.fn((message: AssistantMessage, _isStreaming: boolean) => {
		const text = message.content
			.filter(
				(entry): entry is Extract<AssistantMessage["content"][number], { type: "text" }> => entry.type === "text",
			)
			.map((entry) => entry.text)
			.join("");
		rendered.push(text);
	});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		chatContainer: { addChild: vi.fn() },
		runtimeHost: { session: { settingsManager: { getShowCacheMissNotices: () => false } } },
		pendingTools: new Map(),
		toolOutputExpanded: false,
		streamingComponent: { updateContent },
		streamingMessage: seedMessage(),
	});
	return { mode, rendered, updateContent };
}

describe("interactive delta streaming render (2221)", () => {
	it("updates the streaming component while delta-only frames arrive", async () => {
		const { mode, rendered, updateContent } = makeMode();
		const deltas = [
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "LINE-1\n" },
			{ type: "text_delta", contentIndex: 0, delta: "LINE-2\n" },
			{ type: "text_delta", contentIndex: 0, delta: "LINE-3\n" },
		];

		for (const assistantMessageEvent of deltas) {
			// Delta-only wire frame: no `message` key at all.
			await (mode as HandleEventAccess).handleEvent({ type: "message_update", assistantMessageEvent });
		}

		// Before the fix this was 0: the render block was skipped entirely.
		assert.equal(updateContent.mock.calls.length, 4);
		assert.deepEqual(rendered, ["", "LINE-1\n", "LINE-1\nLINE-2\n", "LINE-1\nLINE-2\nLINE-3\n"]);
		assert.ok(updateContent.mock.calls.every(([, isStreaming]) => isStreaming === true));
	});

	it("marks a settled assistant message as non-streaming", async () => {
		const { mode, updateContent } = makeMode();
		const message = seedMessage();
		message.stopReason = "stop";
		message.content = [{ type: "text", text: "final answer" }];

		await (mode as HandleEventAccess).handleEvent({ type: "message_end", message });

		assert.deepEqual(updateContent.mock.calls.at(-1), [message, false]);
		assert.equal(mode.streamingComponent, undefined);
	});

	it("preserves duplicate deltas in arrival order", async () => {
		const { mode, rendered } = makeMode();
		const delta = { type: "text_delta", contentIndex: 0, delta: "x" };

		await (mode as HandleEventAccess).handleEvent({ type: "message_update", assistantMessageEvent: delta });
		await (mode as HandleEventAccess).handleEvent({ type: "message_update", assistantMessageEvent: delta });

		assert.deepEqual(rendered, ["x", "xx"]);
	});
});
