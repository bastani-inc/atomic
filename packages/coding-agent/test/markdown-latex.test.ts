import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

test("renders LaTeX math in the interactive transcript without changing message content", () => {
	initTheme("dark");
	const source = String.raw`Inline $\frac{1}{2}$ and $x^2$`;
	const message = assistantMessage(source);
	const component = new AssistantMessageComponent(message);

	const rendered = stripAnsi(component.render(80).join("\n"));

	expect(rendered).toContain("1/2");
	expect(rendered).toContain("x²");
	expect(message.content).toEqual([{ type: "text", text: source }]);
});

test("honors the LaTeX display toggle", () => {
	initTheme("dark");
	const source = String.raw`Inline $\frac{1}{2}$`;
	const message = assistantMessage(source);
	const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [], false, false);

	const rendered = stripAnsi(component.render(80).join("\n"));

	expect(rendered).toContain(source);
	expect(rendered).not.toContain("1/2");
});
