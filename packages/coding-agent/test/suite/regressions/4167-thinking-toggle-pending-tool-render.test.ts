import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionContext } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import type { ChatMessageEntry, ChatMessageRenderOptions } from "../../../src/modes/interactive/components/chat-message-renderer.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	deferredRenderedUserInputs: string[];
	deferredRenderedUserInputComponents: Map<string, Component[][]>;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: ChatMessageRenderOptions["ui"];
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string };
	session: { retryAttempt: number; extensionRunner: { getMessageRenderer(customType: string): undefined } };
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	editor: { addToHistory(text: string): void };
	updateEditorBorderColor(): void;
	getMarkdownThemeWithSettings(): ReturnType<typeof getMarkdownTheme>;
	getRegisteredToolDefinition(toolName: string): undefined;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	chatMessageRenderOptions(): ChatMessageRenderOptions;
	addRenderedChatEntry(entry: ChatMessageEntry): Component;
};

type RenderSessionContext = (
	this: RenderSessionContextThis,
	sessionContext: SessionContext,
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	const proto = InteractiveMode.prototype as {
		chatMessageRenderOptions: () => ChatMessageRenderOptions;
		addRenderedChatEntry: (entry: ChatMessageEntry) => Component;
	};
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map<string, Component[][]>(),
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		session: { retryAttempt: 0, extensionRunner: { getMessageRenderer: () => undefined } },
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		toolOutputExpanded: false,
		isInitialized: true,
		editor: { addToHistory: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		chatMessageRenderOptions: proto.chatMessageRenderOptions,
		addRenderedChatEntry: proto.addRenderedChatEntry,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionContext(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		model: null,
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;
		const handleEvent = (InteractiveMode.prototype as { handleEvent: HandleEvent }).handleEvent;

		renderSessionContext.call(fakeThis, createSessionContext([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		renderSessionContext.call(
			fakeThis,
			createSessionContext([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});
