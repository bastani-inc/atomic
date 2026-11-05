import { type Component, Container, getKeybindings, setKeybindings, Text } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
import { highlightCode, initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `{${color}}${text}`,
	bold: (text: string) => text,
} as unknown as Theme;

type WriteArgs = { path?: unknown; file_path?: unknown; content?: unknown };
type CacheView = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

const previousKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	setKeybindings(previousKeybindings);
});

function render(
	args: WriteArgs,
	options: { argsComplete?: boolean; expanded?: boolean; lastComponent?: Component } = {},
): Component {
	return writeRenderers.renderCall!(args as never, theme, {
		args,
		lastComponent: options.lastComponent,
		argsComplete: options.argsComplete ?? true,
		expanded: options.expanded ?? false,
		isPartial: false,
		cwd: "/repo",
		state: {},
		invalidate: () => {},
	} as ToolRenderContext as never);
}

function cacheOf(component: Component): CacheView | undefined {
	return (component as Component & { cache?: CacheView }).cache;
}

function plain(component: Component): string {
	return component
		.render(200)
		.map((line) => stripAnsi(line).trimEnd())
		.join("\n");
}

function stream(path: string, chunks: string[]): Component {
	let component: Component | undefined;
	let content = "";
	for (const chunk of chunks) {
		content += chunk;
		component = render({ path, content }, { argsComplete: false, lastComponent: component });
	}
	return component!;
}

describe("write call rendering", () => {
	it("shows the tool, the path and the first ten lines with an expand hint", () => {
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
		const collapsed = plain(render({ path: "notes.txt", content }));
		expect(collapsed).toContain("<toolTitle>write</toolTitle> <accent>notes.txt</accent>");
		expect(collapsed).toContain("<toolOutput>line 10</toolOutput>");
		expect(collapsed).not.toContain("line 11");
		expect(collapsed).toContain("<toolOutput>line 10</toolOutput><muted>\n... </muted>(2 more lines, 12 total, ");
		expect(collapsed).toMatch(/12 total, .+ Expand\)$/);
		const expanded = plain(render({ path: "notes.txt", content }, { expanded: true }));
		expect(expanded).toContain("<toolOutput>line 12</toolOutput>");
		expect(expanded).not.toContain("more lines");
	});

	it("shows exactly ten lines without a hint, and trims trailing blank lines", () => {
		const ten = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n");
		const rendered = plain(render({ path: "notes.txt", content: `${ten}\n\n\n` }));
		expect(rendered).toContain("<toolOutput>row 9</toolOutput>");
		expect(rendered).not.toContain("more lines");
		expect(rendered.trimEnd().endsWith("<toolOutput>row 9</toolOutput>")).toBe(true);
	});

	it("replaces tabs and carriage returns in plain text", () => {
		const rendered = plain(render({ file_path: "notes.txt", content: "a\tb\r\nc" }));
		expect(rendered).toContain("<toolOutput>a   b</toolOutput>\n<toolOutput>c</toolOutput>");
		expect(rendered).toContain("<accent>notes.txt</accent>");
	});

	it("highlights a known language and shows nothing more for empty content", () => {
		const content = "const value = 1;\n";
		const rendered = render({ path: "a.ts", content }).render(200).join("\n");
		expect(rendered).toContain(highlightCode("const value = 1;", "typescript")[0]!);
		expect(plain(render({ path: "a.ts", content: "" }))).toBe("<toolTitle>write</toolTitle> <accent>a.ts</accent>");
	});

	it("marks content that is not a string", () => {
		expect(plain(render({ path: "a.ts", content: 5 }))).toContain(
			"<error>[invalid content arg - expected string]</error>",
		);
	});

	it("renders without arguments", () => {
		expect(plain(render(undefined as unknown as WriteArgs))).toBe(
			"<toolTitle>write</toolTitle> <toolOutput>...</toolOutput>",
		);
		expect(cacheOf(render(undefined as unknown as WriteArgs, { argsComplete: false }))).toBeUndefined();
	});

	it("reuses the row's previous text component", () => {
		const first = render({ path: "a.txt", content: "x" });
		expect(render({ path: "a.txt", content: "y" }, { lastComponent: first })).toBe(first);
	});
});

describe("write streaming highlight cache", () => {
	it("extends the cache line by line and matches a full highlight of the result", () => {
		const component = stream("a.ts", ["const a = 1;\n", "const b", " = 2;\n", "\tconst c = 3;\r\n", "// done"]);
		const full = "const a = 1;\nconst b = 2;\n\tconst c = 3;\r\n// done";
		const cache = cacheOf(component)!;
		expect(cache.rawPath).toBe("a.ts");
		expect(cache.lang).toBe("typescript");
		expect(cache.rawContent).toBe(full);
		expect(cache.normalizedLines).toEqual(["const a = 1;", "const b = 2;", "   const c = 3;", "// done"]);
		expect(cache.highlightedLines).toEqual(
			highlightCode("const a = 1;\nconst b = 2;\n   const c = 3;\n// done", "typescript"),
		);
	});

	it("keeps the same cache when the content has not grown", () => {
		const component = stream("a.ts", ["const a = 1;"]);
		const cache = cacheOf(component);
		render({ path: "a.ts", content: "const a = 1;" }, { argsComplete: false, lastComponent: component });
		expect(cacheOf(component)).toBe(cache);
	});

	it("rebuilds the cache when the path, the language or a non-appending change arrives", () => {
		const component = stream("a.ts", ["const a = 1;"]);
		const first = cacheOf(component);
		render({ path: "b.ts", content: "const a = 1;" }, { argsComplete: false, lastComponent: component });
		expect(cacheOf(component)).not.toBe(first);
		expect(cacheOf(component)!.rawPath).toBe("b.ts");
		render({ path: "b.py", content: "const a = 1;" }, { argsComplete: false, lastComponent: component });
		expect(cacheOf(component)!.lang).toBe("python");
		const beforeRewrite = cacheOf(component);
		render({ path: "b.py", content: "x = 2" }, { argsComplete: false, lastComponent: component });
		expect(cacheOf(component)).not.toBe(beforeRewrite);
		expect(cacheOf(component)!.normalizedLines).toEqual(["x = 2"]);
	});

	it("re-highlights only the first fifty lines as one block once the file grows past them", () => {
		const lines = Array.from({ length: 60 }, (_, index) => `const v${index} = "${index}";`);
		const component = stream(
			"a.ts",
			lines.map((line) => `${line}\n`),
		);
		const cache = cacheOf(component)!;
		const prefix = highlightCode(lines.slice(0, 50).join("\n"), "typescript");
		expect(cache.highlightedLines.slice(0, 50)).toEqual(prefix);
		expect(cache.highlightedLines[55]).toBe(highlightCode(lines[55]!, "typescript")[0]);
		expect(cache.highlightedLines).toHaveLength(61);
	});

	it("highlights the first fifty streamed lines as one block, so multi-line constructs stay coloured", () => {
		const component = stream("a.ts", ["/*\n", " inside\n", "*/\n", "const a = 1;"]);
		const cache = cacheOf(component)!;
		const block = highlightCode("/*\n inside\n*/\nconst a = 1;", "typescript");
		expect(cache.highlightedLines).toEqual(block);
		expect(cache.highlightedLines[1]).not.toBe(highlightCode(" inside", "typescript")[0]);
	});

	it("highlights streamed lines past the first fifty one line at a time", () => {
		const head = Array.from({ length: 52 }, (_, index) => `const v${index} = ${index};`);
		const component = stream(
			"a.ts",
			[...head, "/*", " inside", "*/"].map((line) => `${line}\n`),
		);
		const cache = cacheOf(component)!;
		expect(cache.normalizedLines[53]).toBe(" inside");
		expect(cache.highlightedLines[53]).toBe(highlightCode(" inside", "typescript")[0]);
	});

	it("keeps no cache for complete arguments, unknown languages, missing paths or invalid content", () => {
		expect(cacheOf(render({ path: "a.ts", content: "x" }, { argsComplete: true }))).toBeUndefined();
		expect(cacheOf(render({ path: "notes.unknownext", content: "x" }, { argsComplete: false }))).toBeUndefined();
		expect(cacheOf(render({ content: "x" }, { argsComplete: false }))).toBeUndefined();
		expect(cacheOf(render({ path: "a.ts", content: 1 }, { argsComplete: false }))).toBeUndefined();
		const streamed = stream("a.ts", ["x"]);
		render({ path: "a.ts", content: "x" }, { argsComplete: true, lastComponent: streamed });
		expect(cacheOf(streamed)).toBeUndefined();
	});
});

describe("write result rendering", () => {
	function result(
		content: Array<{ type: "text"; text: string }>,
		isError: boolean,
		lastComponent?: Component,
	): Component {
		return writeRenderers.renderResult!(
			{ content, details: undefined } as never,
			{ expanded: false, isPartial: false },
			theme,
			{ isError, lastComponent, state: {}, args: {}, cwd: "/" } as never,
		);
	}

	it("shows nothing for a successful write", () => {
		const component = result([{ type: "text", text: "Successfully wrote to a.txt" }], false);
		expect(component).toBeInstanceOf(Container);
		expect(plain(component)).toBe("");
	});

	it("shows an error's text on its own line in the error colour", () => {
		const component = result(
			[
				{ type: "text", text: "EACCES" },
				{ type: "text", text: "denied" },
			],
			true,
		);
		expect(component).toBeInstanceOf(Text);
		expect(plain(component)).toBe("\n<error>EACCES\ndenied</error>");
		expect(result([{ type: "text", text: "again" }], true, component)).toBe(component);
	});

	it("joins only the text blocks of an error, keeping empty ones", () => {
		const component = result(
			[
				{ type: "image", data: "", mimeType: "image/png" },
				{ type: "text", text: "" },
				{ type: "text", text: "second" },
			] as never,
			true,
		);
		expect(plain(component)).toBe("\n<error>\nsecond</error>");
	});

	it("shows nothing for an error without text and clears a reused container", () => {
		const container = new Container();
		container.addChild(new Text("stale", 0, 0));
		expect(result([], true, container)).toBe(container);
		expect(plain(container)).toBe("");
	});
});
