import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

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
});
