import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

afterEach(() => resetCapabilitiesCache());

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Pick<Theme, "fg" | "getFgAnsi">;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

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

describe("Mermaid rendering", () => {
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	it("leaves unsupported and oversized diagrams unchanged", () => {
		const unsupported = "```mermaid\ngantt\n  title Plan\n```";
		const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(oversized, { maxWidth: 10 })).toBe(oversized);
	});

	it("leaves malformed diagrams unchanged without throwing", () => {
		const malformed = "```mermaid\nflowchart LR\n  A[Start] -->\n```";

		expect(() => transformMermaid(malformed)).not.toThrow();
		expect(transformMermaid(malformed)).toContain(malformed);
	});

	it("renders diagram types added by lovely-mermaid (pi #8158)", () => {
		const rendered = transformMermaid('```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```');

		expect(rendered).toContain("Pets");
		expect(rendered).toContain("Dogs");
		expect(rendered).toContain("████████████████████");
		expect(rendered).not.toContain("```mermaid");
	});

	it("maps semantic spans through the Atomic theme", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			getFgAnsi: (color: string) => {
				const colors: Record<string, number> = { accent: 45, borderMuted: 240, muted: 245, text: 255 };
				return `\x1b[38;5;${colors[color]}m`;
			},
		};
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });

		expect(rendered).toContain("\x1b[38;5;240m");
		expect(rendered).toContain("\x1b[38;5;45m");
	});

	it("styles each diagram role with its own Atomic theme color", () => {
		const colors: Record<string, number> = { accent: 45, borderMuted: 240, muted: 245, text: 255 };
		const theme = {
			fg: (_color: string, text: string) => text,
			getFgAnsi: (color: string) => `\x1b[38;5;${colors[color]}m`,
		};
		const flowchart = transformMermaid("```mermaid\nflowchart LR\n  A[Start] -->|go| B[Done]\n```", { theme });
		const pie = transformMermaid('```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```', { theme });

		for (const rendered of [flowchart, pie]) {
			expect(rendered).not.toContain("undefined");
			expect(rendered).not.toContain("\x1b[\x1b[");
			expect(stripAnsi(rendered)).not.toContain("\x1b");
		}
		expect(flowchart).toContain("\x1b[38;5;240m");
		expect(flowchart).toContain("\x1b[38;5;255mStart");
		expect(flowchart).toContain("\x1b[38;5;255mgo");
		expect(pie).toContain("\x1b[1;38;5;45mPets");
	});

	it("applies author class styles over the Atomic theme (pi #8158)", () => {
		const theme = { fg: (_color: string, text: string) => text, getFgAnsi: () => "\x1b[39m" };
		const rendered = transformMermaid(
			"```mermaid\nflowchart LR\n  A[Hot]:::highlight --> B[Plain]\n  classDef highlight fill:#f96,stroke:#333,color:#000,font-weight:bold\n```",
			{ theme },
		);

		expect(rendered).toContain("\x1b[1;38;2;51;51;51;48;2;255;153;102m");
		expect(rendered).toContain("\x1b[1;38;2;0;0;0;48;2;255;153;102m");
		expect(rendered).not.toContain("```mermaid");
	});

	it("links only Mermaid labels and only when the terminal supports hyperlinks (pi #8158)", () => {
		const theme = { fg: (_color: string, text: string) => text, getFgAnsi: () => "\x1b[39m" };
		const markdown = '```mermaid\nflowchart TD\n  A[Docs] --> B[Done]\n  click A "https://example.com/docs"\n```';

		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const linked = transformMermaid(markdown, { theme });
		const linkOpen = "\x1b]8;;https://example.com/docs\x1b\\";
		expect(linked.split(linkOpen)).toHaveLength(2);
		expect(linked).not.toContain("```mermaid");

		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const unlinked = transformMermaid(markdown, { theme });
		expect(unlinked).not.toContain("\x1b]8;;");
		expect(unlinked).not.toContain("https://example.com/docs");
		expect(unlinked).not.toContain("```mermaid");
	});

	it.each([true, false])("keeps the whole diagram around a clickable node when hyperlinks are %s", (hyperlinks) => {
		const theme = { fg: (_color: string, text: string) => text, getFgAnsi: () => "\x1b[39m" };
		const markdown = '```mermaid\nflowchart TD\n  A[Docs] --> B[Done]\n  click A "https://example.com/docs"\n```';
		setCapabilities({ images: null, trueColor: true, hyperlinks });

		expect(stripAnsi(transformMermaid(markdown, { theme }))).toBe(transformMermaid(markdown));
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	it("renders class annotations without a partial-render warning", () => {
		// A :::class without a classDef renders as a plain node.
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		for (const isStreaming of [false, true]) {
			const rendered = transformMermaid(markdown, { isStreaming });
			expect(rendered).toContain("│ Foo ├───▶│ Bar │");
			expect(rendered).not.toContain("```mermaid");
			expect(rendered).not.toContain("Mermaid diagram not rendered");
		}
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] ??? B[Bar]\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, expected a link: "??? B[Bar]"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		expect(streaming).not.toContain("```mermaid");
		expect(streaming).toContain("│ Foo │");
	});

	it("summarizes additional partial-render warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] ??? B[Bar]\n  C[Baz] ??? D[Qux]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain(markdown);
		expect(rendered).toContain('dropped, expected a link: "??? B[Bar]"');
		expect(rendered).toContain("(+1 more)");
		expect(rendered).not.toContain('dropped, expected a link: "??? D[Qux]"');
	});

	it("respects rendering modes and skips thinking blocks and non-transcript surfaces", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
		expect(transformMermaid(markdown, { messageType: "user" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "summary" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "custom" })).toBe(markdown);
		expect(transformMermaid(markdown, { messageType: "changelog" })).toBe(markdown);
	});

	it("changes only display output and leaves assistant message content intact", () => {
		initTheme("dark");
		const source = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";
		const message = assistantMessage(source);
		const originalContent = structuredClone(message.content);
		const transformer = createMermaidMarkdownTransformer({ getMode: () => "streaming" });
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [transformer]);

		const rendered = stripAnsi(component.render(100).join("\n"));

		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(message.content).toEqual(originalContent);
	});
});
