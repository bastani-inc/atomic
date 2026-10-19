import { Container, Text } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { ChatMessageEntry } from "../src/modes/interactive/components/chat-message-renderer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, body: Omit<SessionEntry, "id" | "parentId" | "timestamp">): SessionEntry {
	return { id, parentId: null, timestamp: new Date(1).toISOString(), ...body } as SessionEntry;
}

test("a rebuilt tool call keeps its result when unrendered records were saved between them (#3760)", () => {
	initTheme("dark");
	const chatContainer = new Container();
	const rendered: ChatMessageEntry[] = [];
	const mode = {
		resetTranscriptSelection: () => undefined,
		pendingTools: new Map(),
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map(),
		chatContainer,
		settingsManager: { getShowCacheMissNotices: () => false },
		session: {
			modelRuntime: { getModel: () => undefined },
			extensionRunner: {
				getEntryRenderer: (customType: string) => (customType === "visible-note" ? () => undefined : undefined),
			},
		},
		ui: { requestRender: () => undefined },
		addRenderedChatEntry: (chatEntry: ChatMessageEntry) => {
			rendered.push(chatEntry);
			return new Text(chatEntry.kind, 0, 0);
		},
		addCustomEntryToChat: (custom: { customType: string }) =>
			chatContainer.addChild(new Text(custom.customType, 0, 0)),
		renderDeferredUserInput: () => undefined,
	};
	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof mode,
		entries: SessionEntry[],
	) => void;

	renderSessionEntries.call(mode, [
		entry("a", {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "worker" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		}),
		entry("r1", { type: "custom", customType: "subagent-child", data: { childId: "run:0" } }),
		entry("r2", { type: "custom", customType: "intercom_session_identity", data: {} }),
		entry("t", {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "subagent",
				content: [{ type: "text", text: "launched" }],
				isError: false,
				timestamp: 2,
			},
		}),
		entry("n", { type: "custom", customType: "visible-note", data: {} }),
	]);

	const tools = rendered.filter((chatEntry) => chatEntry.kind === "tool");
	expect(tools).toHaveLength(1);
	expect(tools[0]?.kind === "tool" && tools[0].isPartial).toBe(false);
	expect(tools[0]?.kind === "tool" && tools[0].args).toEqual({ agent: "worker" });
	expect(stripAnsi(chatContainer.render(80).join("\n"))).toContain("visible-note");
	expect(mode.pendingTools.size).toBe(0);
});
