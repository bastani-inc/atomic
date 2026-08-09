import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

let previousColorTerm: string | undefined;

beforeEach(() => {
	previousColorTerm = process.env.COLORTERM;
	process.env.COLORTERM = "truecolor";
});

afterEach(() => {
	if (previousColorTerm === undefined) {
		delete process.env.COLORTERM;
	} else {
		process.env.COLORTERM = previousColorTerm;
	}
});

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders thinking content with the muted foreground color", () => {
		initTheme("catppuccin-mocha");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "checking options" }]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered).toContain(theme.getFgAnsi("muted"));
		expect(rendered).not.toContain(theme.getFgAnsi("thinkingText"));
	});

	test("coalesces only adjacent thinking blocks into one rendered section", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "third thought" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
				{ type: "thinking", thinking: "fourth thought" },
			]),
		);

		const markdownChildren = (
			component as unknown as { contentContainer: { children: Array<{ text?: string }> } }
		).contentContainer.children.filter((child) => child.constructor.name === "Markdown");
		expect(markdownChildren.map((child) => child.text)).toEqual([
			"first thought\n\nsecond thought",
			"answer",
			"third thought",
			"fourth thought",
		]);
	});

	test("applies a single Markdown transformer without mutating the message", () => {
		initTheme("dark");
		const contexts: MarkdownTransformContext[] = [];
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				contexts.push(context);
				return `${context.messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(contexts).toEqual([
			{ messageType: "assistant", isStreaming: false, availableWidth: 78 },
			{ messageType: "assistant-thinking", isStreaming: false, availableWidth: 78 },
		]);
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("continues the Markdown transformer chain after a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("marks partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("renders one hidden label for each adjacent thinking run", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first" },
				{ type: "thinking", thinking: "second" },
				{ type: "text", text: "boundary" },
				{ type: "thinking", thinking: "third" },
			]),
			true,
		);
		const rendered = component.render(80).join("\n");
		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(2);
	});

	test("wraps long aborted assistant messages to the render width", () => {
		initTheme("dark");
		const width = 48;
		const component = new AssistantMessageComponent(
			createAssistantMessage([], {
				stopReason: "aborted",
				errorMessage:
					'The main-chat question was dismissed because the user responded in the workflow chat for workflow "hil-interrupt-verifier" (run f8dd07bd-8073-4b3d-9bdd-ee424df90235, stage select, prompt hil-81ce5653-ac91-4a23-a6e0-b9c5ed74cdda). User responded with: Answered while main chat ask_user_question was open. Do not ask the same question again.',
			}),
		);

		const lines = component.render(width);

		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("renders neutral truncation wording for a length stop", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "partial response" }], {
				stopReason: "length",
			}),
		);

		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("Response was truncated before completion.");
	});
});
