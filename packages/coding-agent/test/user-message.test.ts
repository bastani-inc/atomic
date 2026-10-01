import { Box, Markdown } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test.each([
		{ text: "hello", width: 20, pad: 1 },
		{ text: "first line\n\n- one\n- two\n\n`code` and **bold**", width: 40, pad: 1 },
		{ text: "a wrapped message that is longer than the available width", width: 18, pad: 2 },
		{ text: "wide 日本語 text", width: 30, pad: 0 },
	])("renders the same lines as a padded background box around the Markdown ($text)", ({ text, width, pad }) => {
		initTheme("dark");
		const markdownTheme = getMarkdownTheme();
		const reference = new Box(pad, 1, (content: string) => theme.bg("userMessageBg", content));
		reference.addChild(
			new Markdown(
				text,
				0,
				0,
				markdownTheme,
				{ color: (content: string) => theme.fg("userMessageText", content) },
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
			),
		);

		const rendered = new UserMessageComponent(text, markdownTheme, pad).render(width);
		const expected = reference.render(width);

		expect(
			rendered.map((line) => line.replace(OSC133_ZONE_START, "").replace(OSC133_ZONE_END + OSC133_ZONE_FINAL, "")),
		).toEqual(expected);
	});

	test("chains Markdown transformers with user-message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});
});
