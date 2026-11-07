import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type ChatMessageEntry,
	LiveChatEntriesController,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.js";
import { SCROLLBAR_HIDE_DELAY_MS } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import {
	type EngineHostRenderSettings,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.js";

const identity = (text: string) => text;
function hostOptions(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHostOpts {
	return {
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#fff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
		...overrides,
	};
}
const conversation = Array.from({ length: 60 }, (_, i) => ({
	role: "user" as const,
	content: `LINE-${i}`,
	timestamp: i,
}));

test("prepending earlier history preserves a live assistant stream (#4521)", () => {
	const entries: ChatMessageEntry[] = [];
	const chat = new LiveChatEntriesController(entries);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "first" }],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as AssistantMessage;
	chat.applyEvent({ type: "message_start", message });
	chat.prependMessages([{ role: "user", content: "older", timestamp: 0 }]);
	chat.applyEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " second" },
	});
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.kind, "user");
	const assistant = entries[1];
	assert.ok(assistant?.kind === "assistant");
	assert.deepEqual(assistant.message.content, [{ type: "text", text: "first second" }]);
	assert.equal(chat.isStreamingAssistantEntry(assistant), true);
});

test("the host jump indicator displays its configured and default keys (#4521)", () => {
	initTheme("dark");
	for (const [keybindings, expected] of [
		[new KeybindingsManager({ "tui.altScreen.bottom": ["ctrl+g", "ctrl+e"] }), /ctrl\+g\/ctrl\+e/],
		[undefined, /ctrl\+end/],
	] as const) {
		const host = new ChatSessionHost(hostOptions({ keybindings }));
		try {
			host.replaceMessages(conversation);
			host.renderBody(80, 10);
			host.handleInput("\x1b[5~");
			assert.match(stripVTControlCharacters(host.renderBody(80, 10).join("\n")), expected);
		} finally {
			host.dispose();
		}
	}
});

test("automatic scrollbar expiration requests a repaint if available (#4521)", () => {
	vi.useFakeTimers();
	initTheme("dark");
	let renders = 0;
	const host = new ChatSessionHost(
		hostOptions({
			requestRender: () => renders++,
			getChatRenderSettings: () => ({ hideThinkingBlock: false, fullscreenScrollbar: "auto" }),
		}),
	);
	try {
		host.replaceMessages(conversation);
		host.renderBody(80, 10);
		host.handleInput("\x1b[5~");
		host.renderBody(80, 10);
		const before = renders;
		vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS);
		assert.equal(renders, before + 1);
	} finally {
		host.dispose();
		vi.useRealTimers();
	}
});

test("automatic scrollbar expiration works without a repaint callback (#4521)", () => {
	vi.useFakeTimers();
	initTheme("dark");
	const host = new ChatSessionHost(
		hostOptions({ getChatRenderSettings: () => ({ hideThinkingBlock: false, fullscreenScrollbar: "auto" }) }),
	);
	try {
		host.replaceMessages(conversation);
		host.renderBody(80, 10);
		host.handleInput("\x1b[5~");
		host.renderBody(80, 10);
		assert.doesNotThrow(() => vi.advanceTimersByTime(SCROLLBAR_HIDE_DELAY_MS));
	} finally {
		host.dispose();
		vi.useRealTimers();
	}
});

test("a pending send clears the editor and restores the failed draft above newer input (#4521)", async () => {
	initTheme("dark");
	const pending = Promise.withResolvers<void>();
	let renders = 0;
	const host = new ChatSessionHost(
		hostOptions({ commands: { send: () => pending.promise }, requestRender: () => renders++ }),
	);
	try {
		for (const ch of "first") host.handleInput(ch);
		const before = renders;
		const sending = host.submit();
		assert.equal(host.inputText(), "");
		assert.ok(renders > before);
		for (const ch of "new") host.handleInput(ch);
		pending.reject(new Error("refused"));
		await sending;
		assert.equal(host.inputText(), "first\nnew");
	} finally {
		host.dispose();
	}
});

test("a failed send does not repaint after the host is disposed (#4521)", async () => {
	initTheme("dark");
	const pending = Promise.withResolvers<void>();
	let warnings = 0;
	const host = new ChatSessionHost(
		hostOptions({ commands: { send: () => pending.promise }, showWarning: () => warnings++ }),
	);
	for (const ch of "first") host.handleInput(ch);
	const sending = host.submit();
	host.dispose();
	pending.reject(new Error("refused"));
	await sending;
	assert.equal(warnings, 0);
});

test("an engine retains host settings when a later render omits them (#4521)", async () => {
	const service = new EngineCustomUiService(() => {}, new KeybindingsManager());
	void service.custom(() => ({ render: () => [], invalidate: () => {} }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const settings = {
		hideThinkingBlock: true,
		toolOutputExpanded: true,
		fullscreenScrollbar: "always",
		fullscreenWheelScrollLines: 5,
	} as const;
	const frame = {
		type: "engine_custom_render",
		componentId: "remote_component_1",
		requestId: 1,
		width: 80,
		rows: 24,
	} as const;
	try {
		service.handleLine(serializeInteractiveEngineFrame({ ...frame, renderSettings: settings }));
		assert.deepEqual(service.getHostRenderSettings(), settings);
		service.handleLine(serializeInteractiveEngineFrame({ ...frame, requestId: 2 }));
		assert.deepEqual(service.getHostRenderSettings(), settings);
	} finally {
		service.dispose();
	}
});

test("remote widgets receive changing host chat settings without redundant frames (#4521)", () => {
	let listener: ((message: InteractiveEngineMessage) => void) | undefined;
	const commands: InteractiveEngineCommand[] = [];
	const runtime: RemoteComponentRuntime = {
		onEngineMessage: (callback) => {
			listener = callback;
			return () => {};
		},
		onGenerationEnded: () => () => {},
		sendEngineCommand: (command) => {
			commands.push(command);
		},
	};
	let factory: ((tui: TUI) => Component) | undefined;
	const ui = {
		requestRender: () => {},
		custom: () => new Promise(() => {}),
		setWidget: (_key: string, value: typeof factory) => {
			factory = value;
		},
	} as unknown as ExtensionUIContext;
	let settings: EngineHostRenderSettings = {
		hideThinkingBlock: false,
		toolOutputExpanded: false,
		fullscreenScrollbar: "auto",
		fullscreenWheelScrollLines: 4,
	};
	const controller = new RemoteComponentController(runtime, ui, {
		isFullscreen: () => true,
		onRendererReplaced: () => () => {},
		chatRenderSettings: () => settings,
	});
	try {
		listener?.({ type: "engine_custom_open", componentId: "widget", overlay: false, widgetKey: "w" });
		assert.ok(factory);
		const widget = factory({ terminal: { rows: 24 } } as TUI);
		widget.render(80);
		widget.render(80);
		assert.equal(commands.length, 1);
		assert.deepEqual(commands[0]?.type === "engine_custom_render" && commands[0].renderSettings, settings);
		settings = { ...settings, hideThinkingBlock: true };
		widget.render(80);
		assert.equal(commands.length, 2);
		assert.deepEqual(commands[1]?.type === "engine_custom_render" && commands[1].renderSettings, settings);
	} finally {
		controller.dispose();
	}
});

test("a failed send restores the original draft without a trailing newline (#4521)", async () => {
	initTheme("dark");
	const host = new ChatSessionHost(
		hostOptions({
			commands: {
				send: async () => {
					throw new Error("refused");
				},
			},
		}),
	);
	try {
		for (const ch of "first") host.handleInput(ch);
		await host.submit();
		assert.equal(host.inputText(), "first");
	} finally {
		host.dispose();
	}
});
