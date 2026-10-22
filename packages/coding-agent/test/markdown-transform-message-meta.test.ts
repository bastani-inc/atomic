import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import {
	type ChatMessageEntry,
	renderChatMessageEntry,
} from "../src/modes/interactive/components/chat-message-renderer.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type CapturedContext = Pick<MarkdownTransformContext, "messageType" | "messageId" | "timestamp">;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function capturingTransformer(captured: CapturedContext[]) {
	return (markdown: string, context: MarkdownTransformContext): string => {
		captured.push({ messageType: context.messageType, messageId: context.messageId, timestamp: context.timestamp });
		return markdown;
	};
}

function entry(id: string, timestamp: string, body: Omit<SessionEntry, "id" | "parentId" | "timestamp">): SessionEntry {
	return { id, parentId: null, timestamp, ...body } as SessionEntry;
}

describe("markdown transformer message identity (pi 64627838)", () => {
	test("user messages pass persisted entry identity; live messages leave it undefined", () => {
		initTheme("dark");
		const captured: CapturedContext[] = [];
		const transformer = capturingTransformer(captured);

		new UserMessageComponent(
			"restored",
			undefined,
			1,
			[transformer],
			true,
			"entry-abc",
			"2025-01-15T10:30:00.000Z",
		).render(80);
		new UserMessageComponent("live", undefined, 1, [transformer]).render(80);

		assert.deepEqual(captured, [
			{ messageType: "user", messageId: "entry-abc", timestamp: "2025-01-15T10:30:00.000Z" },
			{ messageType: "user", messageId: undefined, timestamp: undefined },
		]);
	});

	test("assistant text and thinking pass persisted entry identity", () => {
		initTheme("dark");
		const captured: CapturedContext[] = [];
		new AssistantMessageComponent(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "pondering" },
					{ type: "text", text: "answer" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage,
				stopReason: "stop",
				timestamp: 1,
			},
			false,
			undefined,
			undefined,
			1,
			[capturingTransformer(captured)],
			false,
			true,
			"entry-a",
			"2025-01-15T10:31:00.000Z",
		).render(80);

		assert.deepEqual(captured, [
			{ messageType: "assistant-thinking", messageId: "entry-a", timestamp: "2025-01-15T10:31:00.000Z" },
			{ messageType: "assistant", messageId: "entry-a", timestamp: "2025-01-15T10:31:00.000Z" },
		]);
	});

	test("rendering persisted session entries attaches each entry's id and timestamp", () => {
		initTheme("dark");
		const captured: CapturedContext[] = [];
		const rendered: ChatMessageEntry[] = [];
		const chatContainer = new Container();
		const mode = {
			resetTranscriptSelection: () => undefined,
			pendingTools: new Map(),
			deferredRenderedUserInputs: [],
			deferredRenderedUserInputComponents: new Map(),
			chatContainer,
			settingsManager: { getShowCacheMissNotices: () => false },
			session: {
				modelRuntime: { getModel: () => undefined },
				extensionRunner: { getEntryRenderer: () => undefined },
			},
			ui: { requestRender: () => undefined },
			addRenderedChatEntry: (chatEntry: ChatMessageEntry) => {
				rendered.push(chatEntry);
				const component = renderChatMessageEntry(chatEntry, {
					ui: { requestRender: () => undefined },
					cwd: process.cwd(),
					markdownTransformers: [capturingTransformer(captured)],
				});
				component.render(80);
				return new Text(chatEntry.kind, 0, 0);
			},
			addCustomEntryToChat: () => undefined,
			renderDeferredUserInput: () => undefined,
		};
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(mode, [
			entry("u1", "2025-01-15T10:30:00.000Z", {
				type: "message",
				message: { role: "user", content: "question", timestamp: 1 },
			}),
			entry("a1", "2025-01-15T10:31:00.000Z", {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage,
					stopReason: "stop",
					timestamp: 2,
				},
			}),
		]);

		assert.deepEqual(
			rendered.map((chatEntry) => chatEntry.kind),
			["user", "assistant"],
		);
		assert.deepEqual(captured, [
			{ messageType: "user", messageId: "u1", timestamp: "2025-01-15T10:30:00.000Z" },
			{ messageType: "assistant", messageId: "a1", timestamp: "2025-01-15T10:31:00.000Z" },
		]);
	});
});
