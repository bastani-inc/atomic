import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.ts";
import type { ChatSessionHostStyle } from "../src/modes/interactive/components/chat-session-host-types.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const identity = (text: string): string => text;

const style: ChatSessionHostStyle = {
	dim: identity,
	text: identity,
	textMuted: identity,
	accent: identity,
	accentBold: identity,
	rule: (_hex, text) => text,
	cursor: () => "",
	blank: (width) => " ".repeat(width),
	editorRuleColor: () => "#ffffff",
};

const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

test("marks only the live assistant entry as streaming for Markdown transformers", () => {
	initTheme("dark");
	let streaming = true;
	const transformer: MarkdownTransformer = (markdown, context) =>
		`${context.isStreaming ? "stream" : "final"}:${markdown}`;
	const host = new ChatSessionHost({
		style,
		editorTheme,
		isStreaming: () => streaming,
		getChatRenderSettings: () => ({ markdownTransformers: [transformer] }),
	});

	try {
		host.appendMessages([assistantMessage("saved")]);
		host.applyAgentEvent({ type: "message_start", message: assistantMessage("live") } as never);

		const activeOutput = stripAnsi(host.renderBody(100, 20).join("\n"));
		assert.match(activeOutput, /final:saved/);
		assert.match(activeOutput, /stream:live/);

		host.applyAgentEvent({ type: "message_end", message: assistantMessage("live") } as never);
		streaming = false;

		const settledOutput = stripAnsi(host.renderBody(100, 20).join("\n"));
		assert.match(settledOutput, /final:saved/);
		assert.match(settledOutput, /final:live/);
		assert.doesNotMatch(settledOutput, /stream:live/);
	} finally {
		host.dispose();
	}
});

test("keeps settled long assistant rows whole while a later assistant streams", () => {
	initTheme("dark");
	const settledText = ["settled-start", ...Array.from({ length: 240 }, (_, index) => `settled-${index}`)].join("\n");
	const host = new ChatSessionHost({
		style,
		editorTheme,
		isStreaming: () => true,
	});

	try {
		host.appendMessages([assistantMessage(settledText)]);
		host.applyAgentEvent({ type: "message_start", message: assistantMessage("live") } as never);

		const output = stripAnsi(host.renderBody(100, 300).join("\n"));
		assert.equal(host.bodyScrollFromBottom(), 0);
		assert.match(output, /settled-start/);
		assert.doesNotMatch(output, /\[earlier streaming output hidden while attached\]/);
	} finally {
		host.dispose();
	}
});

test("rebuilds cached transcript rows when Markdown transformers change", () => {
	initTheme("dark");
	let transformer: MarkdownTransformer = (markdown) => `first:${markdown}`;
	const host = new ChatSessionHost({
		style,
		editorTheme,
		getChatRenderSettings: () => ({ markdownTransformers: [transformer] }),
	});

	try {
		host.appendMessages([assistantMessage("saved")]);
		assert.match(stripAnsi(host.renderBody(100, 20).join("\n")), /first:saved/);

		transformer = (markdown) => `second:${markdown}`;
		const rendered = stripAnsi(host.renderBody(100, 20).join("\n"));
		assert.match(rendered, /second:saved/);
		assert.doesNotMatch(rendered, /first:saved/);
	} finally {
		host.dispose();
	}
});

test("rebuilds cached transcript rows when LaTeX rendering changes", () => {
	initTheme("dark");
	let renderLatex = true;
	const source = String.raw`Inline $\frac{1}{2}$`;
	const host = new ChatSessionHost({
		style,
		editorTheme,
		getChatRenderSettings: () => ({ renderLatex }),
	});

	try {
		host.appendMessages([assistantMessage(source)]);
		const enabled = stripAnsi(host.renderBody(100, 20).join("\n"));
		assert.match(enabled, /1\/2/);

		renderLatex = false;
		const disabled = stripAnsi(host.renderBody(100, 20).join("\n"));
		assert.match(disabled, /\\frac\{1\}\{2\}/);
		assert.doesNotMatch(disabled, /1\/2/);
	} finally {
		host.dispose();
	}
});
