import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createWriteToolDefinition } from "../src/core/tools/write.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";

const writeRenderers = createWriteToolDefinition(process.cwd());

import { codemodeRenderers } from "../src/extensions/codemode/renderer.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { CodeHighlighter, highlightCode, initTheme } from "../src/modes/interactive/theme/theme.js";
import * as syntaxHighlight from "../src/utils/syntax-highlight.js";

const tui = { requestRender: () => {} } as unknown as TUI;

describe("CodeHighlighter", () => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("reuses its last result until the code, the theme or the grammars change", async () => {
		const code = 'const page = html`<div class="x">ok</div>`;';
		const highlighter = new CodeHighlighter();
		const first = highlighter.highlight(code, "javascript");
		assert.equal(highlighter.highlight(code, "javascript"), first);
		assert.notEqual(highlighter.highlight("const a = 1;", "javascript"), first);

		initTheme("light");
		assert.deepEqual(highlighter.highlight(code, "javascript"), highlightCode(code, "javascript"));
		const light = highlighter.highlight(code, "javascript");
		await syntaxHighlight.loadAllHighlightLanguages();
		assert.notDeepEqual(highlighter.highlight(code, "javascript"), light);
	});

	it("codemode highlights the script once across progress, timer ticks, expanding and completion", () => {
		vi.useFakeTimers();
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		const row = new ToolExecutionComponent(
			"codemode",
			"c",
			{ code: "await tools.read({});" },
			{},
			codemodeRenderers,
			tui,
			"/",
		);
		row.setArgsComplete();
		row.markExecutionStarted();
		row.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
		vi.advanceTimersByTime(2_000);
		row.setExpanded(true);
		row.updateResult({ content: [{ type: "text", text: "done" }], details: { calls: [] }, isError: false }, false);
		row.render(80);
		assert.equal(highlight.mock.calls.length, 1);
	});

	it("write highlights unchanged first lines and a complete file only once", () => {
		const content = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const row = new ToolExecutionComponent("write", "w", { path: "a.js", content }, {}, writeRenderers, tui, "/");
		row.updateArgs({ path: "a.js", content: `${content} //` });
		row.render(80);
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		// Only the changed last line is highlighted again.
		row.updateArgs({ path: "a.js", content: `${content} // more` });
		row.render(80);
		assert.equal(highlight.mock.calls.length, 1);

		row.setArgsComplete();
		row.setExpanded(true);
		row.setExpanded(false);
		row.render(80);
		assert.equal(highlight.mock.calls.length, 2);
	});
});

it("streamed answers reuse earlier code blocks and update the transformer stream state", () => {
	initTheme("dark");
	const highlight = vi.spyOn(syntaxHighlight, "highlight");
	const states: boolean[] = [];
	const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
		(text, context) => {
			states.push(context.isStreaming);
			return text;
		},
	]);
	const message = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "example",
		model: "example",
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
	});
	const code = "```javascript\nconst a = 1;\n```";
	component.updateContent(message(code), true);
	component.render(80);
	component.updateContent(message(`${code}\n\nDone.`), false);
	component.render(80);
	assert.equal(highlight.mock.calls.length, 1);
	assert.equal(states.at(-1), false);
	vi.restoreAllMocks();
});
