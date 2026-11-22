/// <reference path="./highlight-js.d.ts" />
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
let highlightIndexEntries: readonly HighlightLanguageEntry[] | null | undefined;
let preloadedEagerIndex = 0;
let registeredIndexCursor = 0;
let activeHighlightLoadLoop: Promise<void> | undefined;
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
		highlightIndexEntries = entries.length > 0 ? entries : null;
	} catch {
		highlightIndexEntries = null;
	}
	return highlightIndexEntries;
}

async function runChunkedHighlightLoad(): Promise<void> {
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
				if (hljsCore === undefined && typeof loaded?.highlight === "function") {
					hljsCore = loaded;
				}
			} catch {
				// Eager languages and plaintext fallback remain available.
			}
			allLanguagesLoaded = true;
			return;
		}

		// Warm eager language files in bounded slices before getHighlightCore() registers them with
		// two-pass override/alias preservation, so a cold background load never opens 20 files in one turn.
		if (hljsCore === undefined && preloadedEagerIndex < EAGER_LANGUAGE_SPECIFIERS.length) {
			req("highlight.js/lib/core.js");
			await nextEventLoopTurn();
			while (preloadedEagerIndex < EAGER_LANGUAGE_SPECIFIERS.length && hasLiveHighlightWaiter()) {
				const sliceStart = performance.now();
				const batchEnd = Math.min(
					EAGER_LANGUAGE_SPECIFIERS.length,
					preloadedEagerIndex + HIGHLIGHT_CHUNK_BATCH_SIZE,
				);
				while (preloadedEagerIndex < batchEnd && hasLiveHighlightWaiter()) {
					const [, specifier] = EAGER_LANGUAGE_SPECIFIERS[preloadedEagerIndex]!;
					req(specifier);
					preloadedEagerIndex += 1;
					if (performance.now() - sliceStart >= HIGHLIGHT_CHUNK_SLICE_BUDGET_MS) break;
				}
				if (preloadedEagerIndex < EAGER_LANGUAGE_SPECIFIERS.length && hasLiveHighlightWaiter()) {
					await nextEventLoopTurn();
				}
			}
			if (!hasLiveHighlightWaiter()) return;
		}

		const core = getHighlightCore();
		while (registeredIndexCursor < entries.length && hasLiveHighlightWaiter()) {
			const sliceStart = performance.now();
			const batchEnd = Math.min(entries.length, registeredIndexCursor + HIGHLIGHT_CHUNK_BATCH_SIZE);
			while (registeredIndexCursor < batchEnd && hasLiveHighlightWaiter()) {
				const { name, filePath } = entries[registeredIndexCursor]!;
				registeredIndexCursor += 1;
				if (core.getLanguage(name) === undefined) {
					const mod = req(filePath) as HighlightLanguageFactory & { default?: HighlightLanguageFactory };
					const factory = mod.default ?? mod;
					core.registerLanguage(name, factory);
				}
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
		// Eager languages and plaintext fallback remain available.
	} finally {
		activeHighlightLoadLoop = undefined;
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
		if (!activeHighlightLoadLoop) {
			activeHighlightLoadLoop = runChunkedHighlightLoad();
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
