import assert from "node:assert/strict";
import { type Component, Container, getKeybindings, setKeybindings, Text } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { writeRenderers } from "../src/core/tools/renderers/write.js";
import { highlightCode, initTheme, type Theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

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
		assert.ok(collapsed.includes("<toolTitle>write</toolTitle> <accent>notes.txt</accent>"));
		assert.ok(collapsed.includes("<toolOutput>line 10</toolOutput>"));
		assert.ok(!collapsed.includes("line 11"));
		assert.ok(collapsed.includes("<toolOutput>line 10</toolOutput><muted>\n... </muted>(2 more lines, 12 total, "));
		assert.match(collapsed, /12 total, .+ Expand\)$/);
		const expanded = plain(render({ path: "notes.txt", content }, { expanded: true }));
		assert.ok(expanded.includes("<toolOutput>line 12</toolOutput>"));
		assert.ok(!expanded.includes("more lines"));
	});

	it("shows exactly ten lines without a hint, and trims trailing blank lines", () => {
		const ten = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n");
		const rendered = plain(render({ path: "notes.txt", content: `${ten}\n\n\n` }));
		assert.ok(rendered.includes("<toolOutput>row 9</toolOutput>"));
		assert.ok(!rendered.includes("more lines"));
		assert.equal(rendered.trimEnd().endsWith("<toolOutput>row 9</toolOutput>"), true);
	});

	it("replaces tabs and carriage returns in plain text", () => {
		const rendered = plain(render({ file_path: "notes.txt", content: "a\tb\r\nc" }));
		assert.ok(rendered.includes("<toolOutput>a   b</toolOutput>\n<toolOutput>c</toolOutput>"));
		assert.ok(rendered.includes("<accent>notes.txt</accent>"));
	});

	it("highlights a known language and shows nothing more for empty content", () => {
		const content = "const value = 1;\n";
		const rendered = render({ path: "a.ts", content }).render(200).join("\n");
		assert.ok(rendered.includes(highlightCode("const value = 1;", "typescript")[0]!));
		assert.equal(plain(render({ path: "a.ts", content: "" })), "<toolTitle>write</toolTitle> <accent>a.ts</accent>");
	});

	it("marks content that is not a string", () => {
		assert.ok(
			plain(render({ path: "a.ts", content: 5 })).includes("<error>[invalid content arg - expected string]</error>"),
		);
	});

	it("renders without arguments", () => {
		assert.equal(
			plain(render(undefined as unknown as WriteArgs)),
			"<toolTitle>write</toolTitle> <toolOutput>...</toolOutput>",
		);
		assert.equal(cacheOf(render(undefined as unknown as WriteArgs, { argsComplete: false })), undefined);
	});

	it("reuses the row's previous text component", () => {
		const first = render({ path: "a.txt", content: "x" });
		assert.equal(render({ path: "a.txt", content: "y" }, { lastComponent: first }), first);
	});
});

describe("write streaming highlight cache", () => {
	it("extends the cache line by line and matches a full highlight of the result", () => {
		const component = stream("a.ts", ["const a = 1;\n", "const b", " = 2;\n", "\tconst c = 3;\r\n", "// done"]);
		const full = "const a = 1;\nconst b = 2;\n\tconst c = 3;\r\n// done";
		const cache = cacheOf(component)!;
		assert.equal(cache.rawPath, "a.ts");
		assert.equal(cache.lang, "typescript");
		assert.equal(cache.rawContent, full);
		assert.deepEqual(cache.normalizedLines, ["const a = 1;", "const b = 2;", "   const c = 3;", "// done"]);
		assert.deepEqual(
			cache.highlightedLines,
			highlightCode("const a = 1;\nconst b = 2;\n   const c = 3;\n// done", "typescript"),
		);
	});

	it("keeps the same cache when the content has not grown", () => {
		const component = stream("a.ts", ["const a = 1;"]);
		const cache = cacheOf(component);
		render({ path: "a.ts", content: "const a = 1;" }, { argsComplete: false, lastComponent: component });
		assert.equal(cacheOf(component), cache);
	});

	it("rebuilds the cache when the path, the language or a non-appending change arrives", () => {
		const component = stream("a.ts", ["const a = 1;"]);
		const first = cacheOf(component);
		render({ path: "b.ts", content: "const a = 1;" }, { argsComplete: false, lastComponent: component });
		assert.notEqual(cacheOf(component), first);
		assert.equal(cacheOf(component)!.rawPath, "b.ts");
		render({ path: "b.py", content: "const a = 1;" }, { argsComplete: false, lastComponent: component });
		assert.equal(cacheOf(component)!.lang, "python");
		const beforeRewrite = cacheOf(component);
		render({ path: "b.py", content: "x = 2" }, { argsComplete: false, lastComponent: component });
		assert.notEqual(cacheOf(component), beforeRewrite);
		assert.deepEqual(cacheOf(component)!.normalizedLines, ["x = 2"]);
	});

	it("re-highlights only the first fifty lines as one block once the file grows past them", () => {
		const lines = Array.from({ length: 60 }, (_, index) => `const v${index} = "${index}";`);
		const component = stream(
			"a.ts",
			lines.map((line) => `${line}\n`),
		);
		const cache = cacheOf(component)!;
		const prefix = highlightCode(lines.slice(0, 50).join("\n"), "typescript");
		assert.deepEqual(cache.highlightedLines.slice(0, 50), prefix);
		assert.equal(cache.highlightedLines[55], highlightCode(lines[55]!, "typescript")[0]);
		assert.equal(cache.highlightedLines.length, 61);
	});

	it("highlights the first fifty streamed lines as one block, so multi-line constructs stay coloured", () => {
		const component = stream("a.ts", ["/*\n", " inside\n", "*/\n", "const a = 1;"]);
		const cache = cacheOf(component)!;
		const block = highlightCode("/*\n inside\n*/\nconst a = 1;", "typescript");
		assert.deepEqual(cache.highlightedLines, block);
		assert.notEqual(cache.highlightedLines[1], highlightCode(" inside", "typescript")[0]);
	});

	it("highlights streamed lines past the first fifty one line at a time", () => {
		const head = Array.from({ length: 52 }, (_, index) => `const v${index} = ${index};`);
		const component = stream(
			"a.ts",
			[...head, "/*", " inside", "*/"].map((line) => `${line}\n`),
		);
		const cache = cacheOf(component)!;
		assert.equal(cache.normalizedLines[53], " inside");
		assert.equal(cache.highlightedLines[53], highlightCode(" inside", "typescript")[0]);
	});

	it("keeps no cache for complete arguments, unknown languages, missing paths or invalid content", () => {
		assert.equal(cacheOf(render({ path: "a.ts", content: "x" }, { argsComplete: true })), undefined);
		assert.equal(cacheOf(render({ path: "notes.unknownext", content: "x" }, { argsComplete: false })), undefined);
		assert.equal(cacheOf(render({ content: "x" }, { argsComplete: false })), undefined);
		assert.equal(cacheOf(render({ path: "a.ts", content: 1 }, { argsComplete: false })), undefined);
		const streamed = stream("a.ts", ["x"]);
		render({ path: "a.ts", content: "x" }, { argsComplete: true, lastComponent: streamed });
		assert.equal(cacheOf(streamed), undefined);
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
		assert.ok(component instanceof Container);
		assert.equal(plain(component), "");
	});

	it("shows an error's text on its own line in the error colour", () => {
		const component = result(
			[
				{ type: "text", text: "EACCES" },
				{ type: "text", text: "denied" },
			],
			true,
		);
		assert.ok(component instanceof Text);
		assert.equal(plain(component), "\n<error>EACCES\ndenied</error>");
		assert.equal(result([{ type: "text", text: "again" }], true, component), component);
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
		assert.equal(plain(component), "\n<error>\nsecond</error>");
	});

	it("shows nothing for an error without text and clears a reused container", () => {
		const container = new Container();
		container.addChild(new Text("stale", 0, 0));
		assert.equal(result([], true, container), container);
		assert.equal(plain(container), "");
	});
});
