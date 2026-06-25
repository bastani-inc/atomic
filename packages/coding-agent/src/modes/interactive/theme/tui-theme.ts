import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";
import { theme } from "./global-theme.ts";
import type { Theme } from "./theme-class.ts";

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// Validate language before highlighting to avoid stderr spam from cli-highlight
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// Skip highlighting when no valid language is specified. cli-highlight's
			// auto-detection is unreliable and can misidentify prose as AppleScript,
			// LiveCodeServer, etc., coloring random English words as keywords.
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): import("@earendil-works/pi-tui").SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
