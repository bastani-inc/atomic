import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { createJiti } from "jiti";

/**
 * jiti hands plain JavaScript (`.mjs`, `.cjs`, `.js` that is ESM in a
 * `"type": "module"` package, and CommonJS `.js`) to the runtime's own module
 * loader. Node and Bun keep such a module until the process exits, so an edit
 * would never reach `/reload`, and cache-busting its URL would keep one module
 * graph per reload. Extension JavaScript is instead evaluated through jiti's
 * transform, like TypeScript: each load evaluates the files as they are on
 * disk now, and an evaluation is collectable once nothing uses it (#4988).
 *
 * The entry is evaluated with {@link evaluateReloadableScript}. Its relative
 * imports reach {@link bindReloadableScriptLoaders} through a prologue that
 * {@link withReloadableScriptPrologue} adds to every module the extension
 * transform emits, which routes relative JavaScript imports and requires back
 * here. Bare specifiers (packages, node builtins, host modules) keep jiti's
 * resolution, and so does JavaScript inside `node_modules` other than the
 * extension's own package.
 */

type Jiti = ReturnType<typeof createJiti>;
type JitiImport = (id: string, options?: { default?: boolean }) => Promise<unknown>;
type ModuleCache = Record<string, ModuleRecord>;

interface ModuleRecord {
	exports: unknown;
	filename?: string;
	parent?: ModuleRecord;
}

/** One load of one extension: the modules it evaluated, shared so each file is evaluated once per load. */
interface LoadContext {
	cache: ModuleCache;
	/** The package directory of an entry inside `node_modules`, whose own files are reloadable too. */
	packageRoot: string | undefined;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const BINDER_KEY = Symbol.for("atomic.extensions.reloadableScripts");
const PROLOGUE = `{const __atomicReloadable=globalThis[Symbol.for("atomic.extensions.reloadableScripts")];if(__atomicReloadable)[require,jitiImport]=__atomicReloadable(module,require,jitiImport);}`;
const USE_STRICT = /^\s*(["'])use strict\1;?/;

// The CommonJS fs object, which graph recording observes; an ESM namespace would not see its replacement.
const fsExports = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const loadContexts = new WeakMap<object, LoadContext>();

export function isReloadableScriptPath(filePath: string): boolean {
	return SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function packageRootOf(filePath: string): string | undefined {
	const segments = filePath.split(path.sep);
	const index = segments.lastIndexOf("node_modules");
	if (index < 0 || index + 1 >= segments.length - 1) return undefined;
	const scoped = segments[index + 1]?.startsWith("@") ? 2 : 1;
	return segments.slice(0, index + 1 + scoped).join(path.sep);
}

function createLoadContext(entry: string): LoadContext {
	const context: LoadContext = { cache: {}, packageRoot: packageRootOf(entry) };
	// jiti records each module it creates in the cache it evaluates with; remember which load it belongs to.
	context.cache = new Proxy(Object.create(null) as ModuleCache, {
		set(target, key, value) {
			target[key as string] = value;
			if (typeof value === "object" && value !== null) loadContexts.set(value, context);
			return true;
		},
	});
	return context;
}

/** The load an importing module belongs to; a module jiti evaluated on its own starts one at its root. */
function loadContextOf(module: ModuleRecord): LoadContext {
	let root = module;
	for (let current: ModuleRecord | undefined = module; current; current = current.parent) {
		const context = loadContexts.get(current);
		if (context) return context;
		root = current;
	}
	const context = createLoadContext(root.filename ?? "");
	loadContexts.set(root, context);
	return context;
}

function reloadableTarget(id: unknown, require: Jiti, context: LoadContext): string | undefined {
	if (typeof id !== "string") return undefined;
	const isFile = id.startsWith("./") || id.startsWith("../") || id.startsWith("file:") || path.isAbsolute(id);
	if (!isFile) return undefined;
	let resolved: string;
	try {
		resolved = require.resolve(id.startsWith("file:") ? fileURLToPath(id) : id);
	} catch {
		return undefined;
	}
	if (!path.isAbsolute(resolved) || !isReloadableScriptPath(resolved)) return undefined;
	const packageRoot = packageRootOf(resolved);
	if (packageRoot !== undefined && packageRoot !== context.packageRoot) return undefined;
	return resolved;
}

function evaluate(jiti: Jiti, filename: string, async: boolean, cache: ModuleCache): unknown {
	return jiti.evalModule(fsExports.readFileSync(filename, "utf8"), {
		filename,
		async,
		forceTranspile: true,
		cache,
	} as Parameters<Jiti["evalModule"]>[1]);
}

/**
 * Called by the prologue of each transformed extension module with its own
 * `module`, `require` and `jitiImport`; returns the replacements it uses.
 */
function bindReloadableScriptLoaders(module: ModuleRecord, require: Jiti, jitiImport: JitiImport): [Jiti, JitiImport] {
	// A module jiti did not evaluate in a load of ours shares jiti's cache, not ours, for a module both evaluated.
	const ownsCache = loadContexts.has(module);
	const load = (filename: string, async: boolean, original: () => unknown): unknown => {
		const context = loadContextOf(module);
		const cached = context.cache[filename];
		if (cached) return ownsCache ? original() : cached.exports;
		return evaluate(require, filename, async, context.cache);
	};
	const reloadableRequire = new Proxy(require, {
		apply(target, thisArg, args: [string]) {
			const filename = reloadableTarget(args[0], target, loadContextOf(module));
			if (filename === undefined) return Reflect.apply(target, thisArg, args);
			return load(filename, false, () => Reflect.apply(target, thisArg, args));
		},
	});
	const reloadableImport: JitiImport = async (id, options) => {
		const filename = reloadableTarget(id, require, loadContextOf(module));
		if (filename === undefined) return jitiImport(id, options);
		const loaded = (await load(filename, true, () => jitiImport(id))) as { default?: unknown } | undefined;
		return options?.default ? (loaded?.default ?? loaded) : loaded;
	};
	return [reloadableRequire, reloadableImport];
}

/** Adds the prologue that routes a transformed module's relative JavaScript imports to a fresh evaluation. */
export function withReloadableScriptPrologue(code: string): string {
	(globalThis as Record<symbol, unknown>)[BINDER_KEY] ??= bindReloadableScriptLoaders;
	const directive = USE_STRICT.exec(code)?.[0] ?? "";
	return `${directive}${PROLOGUE}${code.slice(directive.length)}`;
}

/**
 * Evaluates a JavaScript extension entry through jiti's transform in a new
 * load, so the entry and the relative JavaScript it imports run as they are on
 * disk now. Returns the module's exports, or its default export when asked.
 */
export async function evaluateReloadableScript(
	jiti: Jiti,
	filename: string,
	options: { default?: boolean } = {},
): Promise<unknown> {
	(globalThis as Record<symbol, unknown>)[BINDER_KEY] ??= bindReloadableScriptLoaders;
	const loaded = (await evaluate(jiti, filename, true, createLoadContext(filename).cache)) as
		| { default?: unknown }
		| undefined;
	return options.default ? (loaded?.default ?? loaded) : loaded;
}
