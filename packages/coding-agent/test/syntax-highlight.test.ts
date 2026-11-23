import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resetCapabilitiesCache, setCapabilities } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_TS_SOURCE_HOOK } from "../../../test/helpers/node-ts-sources.js";
import {
	getLanguageFromPath,
	getMarkdownTheme,
	highlightCode,
	initTheme,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import {
	highlight,
	loadAllHighlightLanguages,
	renderHighlightedHtml,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

const eagerLanguages = [
	"python",
	"java",
	"go",
	"javascript",
	"cpp",
	"typescript",
	"php",
	"ruby",
	"c",
	"csharp",
	"nix",
	"bash",
	"rust",
	"scala",
	"kotlin",
	"swift",
	"dart",
	"groovy",
	"perl",
	"lua",
];
const eagerLanguagesLoadedAtStartup = eagerLanguages.every(supportsLanguage);
const uncommonLanguageLoadedAtStartup = supportsLanguage("ada");

describe("syntax highlight renderer", () => {
	it("loads the twenty most common languages at startup and defers the rest", async () => {
		expect(eagerLanguagesLoadedAtStartup).toBe(true);
		expect(uncommonLanguageLoadedAtStartup).toBe(false);
		await loadAllHighlightLanguages();
		expect(supportsLanguage("ada")).toBe(true);
	});

	it("maps file extensions of eagerly loaded languages to their language (pi #11790)", () => {
		expect(getLanguageFromPath("lib/main.dart")).toBe("dart");
		expect(getLanguageFromPath("flake.nix")).toBe("nix");
		expect(getLanguageFromPath("script.groovy")).toBe("groovy");
		expect(getLanguageFromPath("build.gradle")).toBe("groovy");
		expect(getLanguageFromPath("src/Main.kt")).toBe("kotlin");
	});

	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

let previousColorTerm: string | undefined;

describe("theme syntax highlighting", () => {
	beforeEach(() => {
		previousColorTerm = process.env.COLORTERM;
		process.env.COLORTERM = "truecolor";
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
		resetCapabilitiesCache();
	});

	it("colors each line of Python docstrings independently (#10143)", () => {
		const code = '"""\nline one\n\nline two\n"""\nafter';
		const ansi = theme.getFgAnsi("syntaxString");
		const expected = [
			`${ansi}"""\x1b[39m`,
			`${ansi}line one\x1b[39m`,
			"",
			`${ansi}line two\x1b[39m`,
			`${ansi}"""\x1b[39m`,
			"after",
		];

		expect(highlightCode(code, "python")).toEqual(expected);
		expect(getMarkdownTheme().highlightCode?.(code, "python")).toEqual(expected);
	});

	it("uses text color for string substitutions", () => {
		const interpolation = "$" + "{value}";
		const line = highlightCode(`\`hello ${interpolation}\``, "javascript")[0];
		expect(line).toContain(theme.fg("text", interpolation));
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe("\x1b[38;2;204;102;102m-old\x1b[39m");
		expect(lines[1]).toBe("\x1b[38;2;181;189;104m+new\x1b[39m");
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			"\x1b[38;2;206;145;120m/foo+/gi\x1b[39m",
		);
		expect(highlightCode("@decorator", "python")[0]).toBe("\x1b[38;2;128;128;128m@decorator\x1b[39m");
		expect(highlightCode("<div></div>", "html")[0]).toContain("\x1b[38;2;86;156;214mdiv\x1b[39m");
	});

	it("loads only the requested eager language on demand instead of all 20 grammars at once, preserving overrides and aliases", () => {
		const syntaxHighlightUrl = pathToFileURL(resolve(import.meta.dirname, "../src/utils/syntax-highlight.ts")).href;
		const tuiThemeUrl = pathToFileURL(resolve(import.meta.dirname, "../src/modes/interactive/theme/theme.ts")).href;
		const script = [
			NODE_TS_SOURCE_HOOK,
			`import assert from "node:assert/strict";`,
			`const hljs = (await import("highlight.js/lib/core.js")).default;`,
			`const sh = await import(${JSON.stringify(syntaxHighlightUrl)});`,
			`const th = await import(${JSON.stringify(tuiThemeUrl)});`,
			`// Pre-register custom override for python (without declaring "py") and alias redirect hpp -> c.`,
			`hljs.registerLanguage("python", () => ({ keywords: "custompyonly" }));`,
			`hljs.registerLanguage("c", () => ({ aliases: ["hpp"], keywords: "customcword" }));`,
			`// Asking for an uncommon language loads zero eager grammars.`,
			`assert.equal(sh.supportsLanguage("ada"), false);`,
			`assert.deepEqual(hljs.listLanguages().sort(), ["c", "python"]);`,
			`// Highlighting TypeScript via its alias loads only typescript, not all 20 eager grammars.`,
			`assert.equal(sh.supportsLanguage("TS"), true);`,
			`const tsOut = sh.highlight("const x = 1;", { language: "ts", theme: { keyword: (t) => "[kw:" + t + "]" } });`,
			`assert.ok(tsOut.includes("[kw:const]"), tsOut);`,
			`assert.deepEqual(hljs.listLanguages().sort(), ["c", "python", "typescript"]);`,
			`// CodeHighlighter reuses its first cached result without loading unrelated languages.`,
			`th.initTheme("dark");`,
			`const ch = new th.CodeHighlighter();`,
			`const first = ch.highlight("const a = 1;", "ts");`,
			`assert.equal(ch.highlight("const a = 1;", "ts"), first);`,
			`assert.deepEqual(hljs.listLanguages().sort(), ["c", "python", "typescript"]);`,
			`// Pre-registered python override still owns "py" when requested on demand.`,
			`assert.equal(sh.supportsLanguage("py"), true);`,
			`assert.equal(sh.highlight("custompyonly", { language: "py", theme: { keyword: (t) => "[kw:" + t + "]" } }), "[kw:custompyonly]");`,
			`// Pre-registered hpp -> c alias is NOT stolen when cpp is loaded on demand.`,
			`assert.equal(sh.supportsLanguage("cpp"), true);`,
			`assert.equal(sh.highlight("customcword", { language: "hpp", theme: { keyword: (t) => "[kw:" + t + "]" } }), "[kw:customcword]");`,
			`// Unspecified language (highlightAuto) loads remaining eager grammars and highlights.`,
			`const autoOut = sh.highlight("def foo(): return 1", {});`,
			`assert.ok(autoOut.length > 0);`,
			`assert.ok(hljs.listLanguages().length >= 20);`,
		].join("\n");
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: resolve(import.meta.dirname, ".."),
			stdio: "pipe",
		});
	});
});
