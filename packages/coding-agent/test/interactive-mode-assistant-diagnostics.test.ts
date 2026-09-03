import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "survived" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fable-5-1",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	diagnostics: [
		{
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: {
				droppedBlockCount: 1,
				reasons: ["prefix_binding_mismatch"],
				paths: ["messages.2.content.0"],
			},
		},
	],
};

describe("InteractiveMode assistant diagnostics", () => {
	test("shows Anthropic thinking drops when cache miss notices are enabled", () => {
		const maybeShowAssistantDiagnostics = Reflect.get(InteractiveMode.prototype, "maybeShowAssistantDiagnostics") as (
			this: {
				chatContainer: Container;
				settingsManager: { getShowCacheMissNotices(): boolean };
			},
			message: AssistantMessage,
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		maybeShowAssistantDiagnostics.call(enabled, message);
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped thinking block: prefix_binding_mismatch at messages.2.content.0");
		expect(output.match(/Anthropic dropped/g)).toHaveLength(1);
		expect(enabled.chatContainer.children).toHaveLength(2);

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		maybeShowAssistantDiagnostics.call(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("replays persisted Anthropic thinking-drop diagnostics once", () => {
		initTheme("dark");
		const chatContainer = new Container();
		const entry: SessionEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message,
		};
		const mode = {
			pendingTools: new Map(),
			deferredRenderedUserInputs: [],
			deferredRenderedUserInputComponents: new Map(),
			footer: { invalidate: () => undefined },
			updateEditorBorderColor: () => undefined,
			chatContainer,
			settingsManager: { getShowCacheMissNotices: () => true },
			session: { modelRuntime: { getModel: () => undefined } },
			ui: { requestRender: () => undefined },
			addRenderedChatEntry: () => new Text("assistant response", 0, 0),
			maybeShowAssistantDiagnostics: Reflect.get(InteractiveMode.prototype, "maybeShowAssistantDiagnostics"),
			renderDeferredUserInput: () => undefined,
		};
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(mode, [entry]);
		const output = stripAnsi(chatContainer.render(120).join("\n"));
		expect(output.match(/Anthropic dropped/g)).toHaveLength(1);
	});
});
