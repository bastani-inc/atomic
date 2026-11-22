/// <reference path="./highlight-js.d.ts" />
import { decodeHtmlEntityAt } from "./html.ts";
import { createModuleRequire } from "./module-require.js";

type HighlightCore = typeof import("highlight.js/lib/core.js").default;
type HighlightLanguageFactory = typeof import("highlight.js/lib/languages/bash.js").default;

const EAGER_LANGUAGE_SPECIFIERS: readonly (readonly [string, string])[] = [
	["python", "highlight.js/lib/languages/python.js"],
	["java", "highlight.js/lib/languages/java.js"],
	["go", "highlight.js/lib/languages/go.js"],
	["javascript", "highlight.js/lib/languages/javascript.js"],
	["cpp", "highlight.js/lib/languages/cpp.js"],
	["typescript", "highlight.js/lib/languages/typescript.js"],
	["php", "highlight.js/lib/languages/php.js"],
	["ruby", "highlight.js/lib/languages/ruby.js"],
	["c", "highlight.js/lib/languages/c.js"],
	["csharp", "highlight.js/lib/languages/csharp.js"],
	["nix", "highlight.js/lib/languages/nix.js"],
	["bash", "highlight.js/lib/languages/bash.js"],
	["rust", "highlight.js/lib/languages/rust.js"],
	["scala", "highlight.js/lib/languages/scala.js"],
	["kotlin", "highlight.js/lib/languages/kotlin.js"],
	["swift", "highlight.js/lib/languages/swift.js"],
	["dart", "highlight.js/lib/languages/dart.js"],
	["groovy", "highlight.js/lib/languages/groovy.js"],
	["perl", "highlight.js/lib/languages/perl.js"],
	["lua", "highlight.js/lib/languages/lua.js"],
];

const BUNDLED_HIGHLIGHT_CORE_SYMBOL = Symbol.for("atomic.bundledHighlightCore");

let hljsCore: HighlightCore | undefined;

function getHighlightCore(): HighlightCore {
	if (hljsCore !== undefined) return hljsCore;
	const bundled = (globalThis as Record<symbol, unknown>)[BUNDLED_HIGHLIGHT_CORE_SYMBOL] as HighlightCore | undefined;
	if (bundled !== undefined) {
		hljsCore = bundled;
		return bundled;
	}
	const req = createModuleRequire(import.meta.url);
	const loaded = req("highlight.js/lib/core.js") as HighlightCore & { default?: HighlightCore };
	const core = loaded.default ?? loaded;
	// Match eager-registration semantics: grammars and aliases registered by an app or extension
	// after importing @bastani/atomic (and before the first highlightCode call) always win over
	// built-in eager grammars, while pre-registered overrides of an eager language name keep that
	// language's unclaimed built-in aliases (e.g. overriding "python" keeps "py").
	// Register missing eager grammars in two passes so aliases redirected to a later eager grammar
	// (e.g. "hpp" -> "c" registered before "cpp") resolve before any built-in alias is judged free.
	const eagerBuilt = EAGER_LANGUAGE_SPECIFIERS.map(([name, specifier]) => {
		const mod = req(specifier) as HighlightLanguageFactory & { default?: HighlightLanguageFactory };
		const factory = mod.default ?? mod;
		return { name, built: factory(core) };
	});
	const newlyRegistered = new Set<string>();
	for (const { name, built } of eagerBuilt) {
		if (core.getLanguage(name) === undefined) {
			core.registerLanguage(name, () => ({ ...built, aliases: undefined }));
			newlyRegistered.add(name);
		}
	}
	for (const { name, built } of eagerBuilt) {
		const freeAliases = (built.aliases ?? []).filter((alias) => core.getLanguage(alias) === undefined);
		if (freeAliases.length > 0) {
			core.registerAliases(freeAliases, { languageName: name });
		}
		if (newlyRegistered.has(name)) {
			const registered = core.getLanguage(name);
			if (registered !== undefined) {
				if (built.aliases !== undefined) {
					registered.aliases = built.aliases;
				} else {
					delete registered.aliases;
				}
			}
		}
	}
	hljsCore = core;
	return core;
}

let allLanguagesPromise: Promise<void> | undefined;

export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			setImmediate(() => {
				void import("highlight.js/lib/index.js").then(
					(mod) => {
						const loaded = (mod as { default?: HighlightCore }).default ?? (mod as unknown as HighlightCore);
						if (hljsCore === undefined && typeof loaded?.highlight === "function") {
							hljsCore = loaded;
						}
						resolve();
					},
					() => {
						// Eager languages and plaintext fallback remain available.
						resolve();
					},
				);
			});
		});
	}
	return allLanguagesPromise;
}

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter
			? textBuffer
					.split("\n")
					.map((line) => (line ? formatter(line) : line))
					.join("\n")
			: textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const hljs = getHighlightCore();
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return getHighlightCore().getLanguage(name) !== undefined;
}

/**
 * Number of registered grammars. It grows when the deferred grammars load, which can change the highlighting of
 * code that embeds another language, such as HTML in a JavaScript template literal.
 */
export function getHighlightLanguageCount(): number {
	return getHighlightCore().listLanguages().length;
}
