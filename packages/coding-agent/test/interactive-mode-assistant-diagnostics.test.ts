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
				sessionManager: { getBranch(): SessionEntry[] };
			},
			message: AssistantMessage,
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getBranch: (): SessionEntry[] => [] },
		};
		maybeShowAssistantDiagnostics.call(enabled, message);
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped 1 thinking block (details in session)");
		expect(output).not.toContain("prefix_binding_mismatch");
		expect(output).not.toContain("messages.2.content.0");
		expect(output.match(/Anthropic dropped/g)).toHaveLength(1);
		expect(enabled.chatContainer.children).toHaveLength(2);

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getBranch: (): SessionEntry[] => [] },
		};
		maybeShowAssistantDiagnostics.call(disabled, message);
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("does not replay persisted Anthropic thinking-drop diagnostics", () => {
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
			resetTranscriptSelection: vi.fn(),
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
		expect(output).not.toContain("Anthropic dropped");
	});
	// Upstream #9391: an unchanged cumulative drop count is not a new warning.
	test("suppresses unchanged drops but reports an increased count", () => {
		initTheme("dark");
		const mode = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: {
				getBranch: (): SessionEntry[] => [
					{ type: "message", id: "previous", parentId: null, timestamp: new Date(1).toISOString(), message },
				],
			},
		};
		const show = Reflect.get(InteractiveMode.prototype, "maybeShowAssistantDiagnostics") as (
			this: typeof mode,
			message: AssistantMessage,
		) => void;
		show.call(mode, message);
		expect(mode.chatContainer.children).toHaveLength(0);
		show.call(mode, {
			...message,
			diagnostics: [{ type: "anthropic_input_transformations", timestamp: 2, details: { droppedBlockCount: 2 } }],
		});
		expect(stripAnsi(mode.chatContainer.render(120).join("\n"))).toContain(
			"Anthropic dropped 2 thinking blocks (details in session)",
		);
	});

	test("shows a service tier warning whether or not cache miss notices are enabled (#3529)", () => {
		initTheme("dark");
		const warning = "ultrafast isn't available for gpt-5.6-sol on this account; ran at default";
		const warned: AssistantMessage = {
			...message,
			diagnostics: [
				{ type: "service_tier_unavailable", timestamp: 1, details: { severity: "warning", message: warning } },
			],
		};
		const show = Reflect.get(InteractiveMode.prototype, "maybeShowAssistantDiagnostics") as (
			this: {
				chatContainer: Container;
				settingsManager: { getShowCacheMissNotices(): boolean };
				sessionManager: { getBranch(): SessionEntry[] };
			},
			message: AssistantMessage,
		) => void;
		for (const enabled of [true, false]) {
			const mode = {
				chatContainer: new Container(),
				settingsManager: { getShowCacheMissNotices: () => enabled },
				sessionManager: { getBranch: (): SessionEntry[] => [] },
			};
			show.call(mode, warned);
			const output = stripAnsi(mode.chatContainer.render(120).join("\n"));
			expect(output).toContain(`Warning: ${warning}`);
		}
	});
});
