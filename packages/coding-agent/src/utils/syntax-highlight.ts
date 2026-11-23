/// <reference path="./highlight-js.d.ts" />
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decodeHtmlEntityAt } from "./html.ts";
import { createModuleRequire } from "./module-require.js";

type HighlightCore = typeof import("highlight.js/lib/core.js").default;
type HighlightLanguageFactory = typeof import("highlight.js/lib/languages/bash.js").default;

interface EagerLanguageEntry {
	readonly name: string;
	readonly specifier: string;
	readonly aliases: readonly string[];
}

const EAGER_LANGUAGE_ENTRIES: readonly EagerLanguageEntry[] = [
	{ name: "python", specifier: "highlight.js/lib/languages/python.js", aliases: ["py", "gyp", "ipython"] },
	{ name: "java", specifier: "highlight.js/lib/languages/java.js", aliases: ["jsp"] },
	{ name: "go", specifier: "highlight.js/lib/languages/go.js", aliases: ["golang"] },
	{ name: "javascript", specifier: "highlight.js/lib/languages/javascript.js", aliases: ["js", "jsx", "mjs", "cjs"] },
	{
		name: "cpp",
		specifier: "highlight.js/lib/languages/cpp.js",
		aliases: ["cc", "c++", "h++", "hpp", "hh", "hxx", "cxx"],
	},
	{ name: "typescript", specifier: "highlight.js/lib/languages/typescript.js", aliases: ["ts", "tsx"] },
	{
		name: "php",
		specifier: "highlight.js/lib/languages/php.js",
		aliases: ["php3", "php4", "php5", "php6", "php7", "php8"],
	},
	{
		name: "ruby",
		specifier: "highlight.js/lib/languages/ruby.js",
		aliases: ["rb", "gemspec", "podspec", "thor", "irb"],
	},
	{ name: "c", specifier: "highlight.js/lib/languages/c.js", aliases: ["h"] },
	{ name: "csharp", specifier: "highlight.js/lib/languages/csharp.js", aliases: ["cs", "c#"] },
	{ name: "nix", specifier: "highlight.js/lib/languages/nix.js", aliases: ["nixos"] },
	{ name: "bash", specifier: "highlight.js/lib/languages/bash.js", aliases: ["sh", "zsh"] },
	{ name: "rust", specifier: "highlight.js/lib/languages/rust.js", aliases: ["rs"] },
	{ name: "scala", specifier: "highlight.js/lib/languages/scala.js", aliases: [] },
	{ name: "kotlin", specifier: "highlight.js/lib/languages/kotlin.js", aliases: ["kt", "kts"] },
	{ name: "swift", specifier: "highlight.js/lib/languages/swift.js", aliases: [] },
	{ name: "dart", specifier: "highlight.js/lib/languages/dart.js", aliases: [] },
	{ name: "groovy", specifier: "highlight.js/lib/languages/groovy.js", aliases: [] },
	{ name: "perl", specifier: "highlight.js/lib/languages/perl.js", aliases: ["pl", "pm"] },
	{ name: "lua", specifier: "highlight.js/lib/languages/lua.js", aliases: [] },
];

const BUNDLED_HIGHLIGHT_CORE_SYMBOL = Symbol.for("atomic.bundledHighlightCore");
const LAZY_EAGER_ENTRY_SYMBOL = Symbol("atomic.lazyEagerHighlightEntry");

let hljsCore: HighlightCore | undefined;
let hljsRequire: ReturnType<typeof createModuleRequire> | undefined;
const loadedEagerLanguages = new Set<string>();

function getHighlightRequire(): ReturnType<typeof createModuleRequire> {
	if (hljsRequire === undefined) hljsRequire = createModuleRequire(import.meta.url);
	return hljsRequire;
}

function materializeEagerEntry(core: HighlightCore, entry: EagerLanguageEntry): Record<string | symbol, unknown> {
	const existing = core.getLanguage(entry.name) as Record<string | symbol, unknown> | undefined;
	if (existing && existing[LAZY_EAGER_ENTRY_SYMBOL] !== entry) {
		loadedEagerLanguages.add(entry.name);
		return existing;
	}
	const req = getHighlightRequire();
	const mod = req(entry.specifier) as HighlightLanguageFactory & { default?: HighlightLanguageFactory };
	const factory = mod.default ?? mod;
	const built = factory(core);
	const aliases = built.aliases;
	core.registerLanguage(entry.name, () => ({ ...built, aliases: undefined }));
	const registered = core.getLanguage(entry.name) as Record<string | symbol, unknown>;
	if (aliases !== undefined) {
		registered.aliases = [...aliases];
	} else {
		delete registered.aliases;
	}
	loadedEagerLanguages.add(entry.name);
	return registered;
}

function registerLazyEagerProxy(core: HighlightCore, entry: EagerLanguageEntry): void {
	const placeholder: Record<string | symbol, unknown> = { name: entry.name };
	let materialized: Record<string | symbol, unknown> | undefined;
	let registering = true;
	const materialize = (): Record<string | symbol, unknown> => {
		if (materialized === undefined) materialized = materializeEagerEntry(core, entry);
		return materialized;
	};
	const proxy = new Proxy(placeholder, {
		get(_target, prop) {
			if (prop === LAZY_EAGER_ENTRY_SYMBOL) return entry;
			if (registering && (prop === "name" || prop === "aliases")) {
				return prop === "name" ? entry.name : undefined;
			}
			const real = materialize();
			const value = Reflect.get(real, prop, real);
			return typeof value === "function" ? value.bind(real) : value;
		},
		set(_target, prop, value) {
			if (registering && (prop === "rawDefinition" || prop === "name")) {
				placeholder[prop] = value;
				return true;
			}
			const real = materialize();
			return Reflect.set(real, prop, value, real);
		},
		has(_target, prop) {
			if (prop === LAZY_EAGER_ENTRY_SYMBOL) return true;
			return Reflect.has(materialize(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(materialize());
		},
		getOwnPropertyDescriptor(_target, prop) {
			return Reflect.getOwnPropertyDescriptor(materialize(), prop);
		},
		defineProperty(_target, prop, descriptor) {
			return Reflect.defineProperty(materialize(), prop, descriptor);
		},
		deleteProperty(_target, prop) {
			return Reflect.deleteProperty(materialize(), prop);
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(materialize());
		},
	});
	core.registerLanguage(entry.name, () => proxy as unknown as ReturnType<HighlightLanguageFactory>);
	registering = false;
}

function getHighlightCore(): HighlightCore {
	if (hljsCore !== undefined) return hljsCore;
	const bundled = (globalThis as Record<symbol, unknown>)[BUNDLED_HIGHLIGHT_CORE_SYMBOL] as HighlightCore | undefined;
	if (bundled !== undefined) {
		hljsCore = bundled;
		for (const entry of EAGER_LANGUAGE_ENTRIES) loadedEagerLanguages.add(entry.name);
		return bundled;
	}
	const req = getHighlightRequire();
	const loaded = req("highlight.js/lib/core.js") as HighlightCore & { default?: HighlightCore };
	const core = loaded.default ?? loaded;
	// Match eager two-pass registration semantics without synchronously requiring all 20 grammar files:
	// Pass 1 registers lightweight lazy proxies for missing eager languages so pre-registered
	// overrides stay intact AND pre-registered alias redirects (e.g. "hpp" -> "c", "cc" -> "rust")
	// resolve in Pass 2 before any built-in alias is judged free.
	for (const entry of EAGER_LANGUAGE_ENTRIES) {
		if (core.getLanguage(entry.name) !== undefined) {
			loadedEagerLanguages.add(entry.name);
		} else {
			registerLazyEagerProxy(core, entry);
		}
	}
	for (const entry of EAGER_LANGUAGE_ENTRIES) {
		const freeAliases = entry.aliases.filter((alias) => core.getLanguage(alias) === undefined);
		if (freeAliases.length > 0) {
			core.registerAliases(freeAliases, { languageName: entry.name });
		}
	}
	hljsCore = core;
	return core;
}

function materializeLanguageIfLazy(core: HighlightCore, name: string): void {
	const lang = core.getLanguage(name) as Record<string | symbol, unknown> | undefined;
	const lazyEntry = lang?.[LAZY_EAGER_ENTRY_SYMBOL] as EagerLanguageEntry | undefined;
	if (lazyEntry !== undefined) {
		materializeEagerEntry(core, lazyEntry);
	}
}

function ensureAllEagerLanguages(core: HighlightCore): void {
	if (loadedEagerLanguages.size >= EAGER_LANGUAGE_ENTRIES.length) return;
	for (const entry of EAGER_LANGUAGE_ENTRIES) {
		if (!loadedEagerLanguages.has(entry.name)) {
			materializeEagerEntry(core, entry);
		}
	}
}

export interface LoadAllHighlightLanguagesOptions {
	/** Stops background chunk loading at the next event-loop yield when aborted. */
	readonly signal?: AbortSignal;
}

const HIGHLIGHT_INDEX_REGISTER_PREFIX = "hljs.registerLanguage('";
const HIGHLIGHT_INDEX_REQUIRE_MARKER = "', require('";
const HIGHLIGHT_INDEX_REQUIRE_SUFFIX = "'));";
const HIGHLIGHT_CHUNK_BATCH_SIZE = 4;
const HIGHLIGHT_CHUNK_SLICE_BUDGET_MS = 12;

interface HighlightLanguageEntry {
	readonly name: string;
	readonly filePath: string;
}

interface HighlightLoadWaiter {
	readonly signal?: AbortSignal;
	readonly resolve: () => void;
	readonly cleanup: () => void;
}

let allLanguagesLoaded = false;
let highlightIndexEntries: readonly HighlightLanguageEntry[] | undefined;
let preloadedEagerIndex = 0;
let registeredIndexCursor = 0;
let activeHighlightLoadToken: symbol | undefined;
const activeHighlightWaiters = new Set<HighlightLoadWaiter>();

function parseHighlightIndexEntries(source: string, indexDir: string): HighlightLanguageEntry[] {
	const entries: HighlightLanguageEntry[] = [];
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith(HIGHLIGHT_INDEX_REGISTER_PREFIX) || !line.endsWith(HIGHLIGHT_INDEX_REQUIRE_SUFFIX)) {
			continue;
		}
		const markerIndex = line.indexOf(HIGHLIGHT_INDEX_REQUIRE_MARKER, HIGHLIGHT_INDEX_REGISTER_PREFIX.length);
		if (markerIndex === -1) continue;
		const name = line.slice(HIGHLIGHT_INDEX_REGISTER_PREFIX.length, markerIndex);
		const relPath = line.slice(
			markerIndex + HIGHLIGHT_INDEX_REQUIRE_MARKER.length,
			line.length - HIGHLIGHT_INDEX_REQUIRE_SUFFIX.length,
		);
		if (name.length === 0 || !relPath.startsWith("./languages/") || relPath.includes("..")) continue;
		entries.push({ name, filePath: resolve(indexDir, relPath) });
	}
	return entries;
}

function nextEventLoopTurn(): Promise<void> {
	return new Promise((resolveTurn) => {
		setImmediate(resolveTurn);
	});
}

function hasLiveHighlightWaiter(): boolean {
	for (const waiter of activeHighlightWaiters) {
		if (!waiter.signal?.aborted) return true;
	}
	return false;
}

async function resolveHighlightIndexEntries(
	req: ReturnType<typeof createModuleRequire>,
): Promise<readonly HighlightLanguageEntry[] | null> {
	if (highlightIndexEntries !== undefined) return highlightIndexEntries;
	try {
		const indexPath = req.resolve("highlight.js/lib/index.js");
		const source = await readFile(indexPath, "utf8");
		const entries = parseHighlightIndexEntries(source, dirname(indexPath));
		if (entries.length > 0) {
			highlightIndexEntries = entries;
			return entries;
		}
		return null;
	} catch {
		// Leave uncached so a transient miss (e.g. during an in-place package swap) can retry.
		return null;
	}
}

async function runChunkedHighlightLoad(token: symbol): Promise<void> {
	try {
		await nextEventLoopTurn();
		if (!hasLiveHighlightWaiter()) return;

		// Standalone binaries pre-bundle highlight.js core on globalThis without separate language files on disk.
		const bundled = (globalThis as Record<symbol, unknown>)[BUNDLED_HIGHLIGHT_CORE_SYMBOL] as
			| HighlightCore
			| undefined;
		const req = bundled === undefined ? createModuleRequire(import.meta.url) : undefined;
		const entries = req ? await resolveHighlightIndexEntries(req) : null;
		if (!hasLiveHighlightWaiter()) return;

		if (!req || entries === null) {
			try {
				const mod = await import("highlight.js/lib/index.js");
				const loaded = (mod as { default?: HighlightCore }).default ?? (mod as unknown as HighlightCore);
				if (typeof loaded?.highlight === "function") {
					if (hljsCore === undefined) {
						hljsCore = loaded;
					}
					allLanguagesLoaded = true;
				}
			} catch {
				// Leave allLanguagesLoaded false so later highlight loads retry after transient failures.
			}
			return;
		}

		// Warm remaining eager language files in bounded slices before registering them with
		// two-pass override/alias preservation, so a cold background load never opens 20 files in one turn.
		if (
			loadedEagerLanguages.size < EAGER_LANGUAGE_ENTRIES.length &&
			preloadedEagerIndex < EAGER_LANGUAGE_ENTRIES.length
		) {
			if (hljsCore === undefined) {
				req("highlight.js/lib/core.js");
				await nextEventLoopTurn();
			}
			while (preloadedEagerIndex < EAGER_LANGUAGE_ENTRIES.length && hasLiveHighlightWaiter()) {
				const sliceStart = performance.now();
				const batchEnd = Math.min(EAGER_LANGUAGE_ENTRIES.length, preloadedEagerIndex + HIGHLIGHT_CHUNK_BATCH_SIZE);
				while (preloadedEagerIndex < batchEnd && hasLiveHighlightWaiter()) {
					const entry = EAGER_LANGUAGE_ENTRIES[preloadedEagerIndex]!;
					if (!loadedEagerLanguages.has(entry.name)) {
						req(entry.specifier);
					}
					preloadedEagerIndex += 1;
					if (performance.now() - sliceStart >= HIGHLIGHT_CHUNK_SLICE_BUDGET_MS) break;
				}
				if (preloadedEagerIndex < EAGER_LANGUAGE_ENTRIES.length && hasLiveHighlightWaiter()) {
					await nextEventLoopTurn();
				}
			}
			if (!hasLiveHighlightWaiter()) return;
		}

		const core = getHighlightCore();
		ensureAllEagerLanguages(core);
		while (registeredIndexCursor < entries.length && hasLiveHighlightWaiter()) {
			const sliceStart = performance.now();
			const batchEnd = Math.min(entries.length, registeredIndexCursor + HIGHLIGHT_CHUNK_BATCH_SIZE);
			while (registeredIndexCursor < batchEnd && hasLiveHighlightWaiter()) {
				const { name, filePath } = entries[registeredIndexCursor]!;
				// Check registered primary language names rather than getLanguage(), so pre-registered
				// overrides stay intact while aliases added by earlier chunks (e.g. handlebars -> htmlbars)
				// do not suppress later built-in language modules.
				if (!core.listLanguages().includes(name)) {
					const mod = req(filePath) as HighlightLanguageFactory & { default?: HighlightLanguageFactory };
					const factory = mod.default ?? mod;
					core.registerLanguage(name, factory);
				}
				registeredIndexCursor += 1;
				if (performance.now() - sliceStart >= HIGHLIGHT_CHUNK_SLICE_BUDGET_MS) break;
			}
			if (registeredIndexCursor < entries.length && hasLiveHighlightWaiter()) {
				await nextEventLoopTurn();
			}
		}

		if (registeredIndexCursor >= entries.length) {
			allLanguagesLoaded = true;
		}
	} catch {
		// Eager languages and plaintext fallback remain available; leave allLanguagesLoaded false for retry.
	} finally {
		if (activeHighlightLoadToken === token) {
			activeHighlightLoadToken = undefined;
		}
		const completed = [...activeHighlightWaiters];
		activeHighlightWaiters.clear();
		for (const waiter of completed) {
			waiter.cleanup();
			waiter.resolve();
		}
	}
}

export function loadAllHighlightLanguages(options?: LoadAllHighlightLanguagesOptions): Promise<void> {
	if (allLanguagesLoaded || options?.signal?.aborted) {
		return Promise.resolve();
	}
	return new Promise((resolveWaiter) => {
		const signal = options?.signal;
		const onAbort = () => {
			if (!activeHighlightWaiters.delete(waiter)) return;
			waiter.cleanup();
			resolveWaiter();
		};
		const waiter: HighlightLoadWaiter = {
			signal,
			resolve: resolveWaiter,
			cleanup: () => signal?.removeEventListener("abort", onAbort),
		};
		activeHighlightWaiters.add(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (activeHighlightLoadToken === undefined) {
			const token = Symbol("highlight-load");
			activeHighlightLoadToken = token;
			void runChunkedHighlightLoad(token);
		}
	});
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
	if (options.language) {
		materializeLanguageIfLazy(hljs, options.language);
	} else if (options.languageSubset) {
		for (const lang of options.languageSubset) materializeLanguageIfLazy(hljs, lang);
	} else {
		ensureAllEagerLanguages(hljs);
	}
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
