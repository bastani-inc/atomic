import { createRequire, isBuiltin } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 * The entry is evaluated with {@link evaluateReloadableScript}. Every module
 * the extension transform emits starts with a prologue, added by
 * {@link withReloadableScriptPrologue}, that hands its `require` and
 * `jitiImport` to {@link bindReloadableScriptLoaders}:
 *
 * - A JavaScript file it imports by path is evaluated the same way, once per
 *   load, unless it lies in a `node_modules` package other than the importer's
 *   load's own.
 * - A bare specifier in a JavaScript module resolves as the runtime would have
 *   resolved it from the importing file, and the runtime loads what it finds, once per process.
 *   Only when that finds nothing does jiti resolve it (host aliases and
 *   virtual modules), as jiti did after a failed native load.
 * - Everything else (Node builtins, TypeScript files, bare specifiers in
 *   TypeScript) keeps jiti's handling.
 *
 * jiti's transform makes every module strict; CommonJS keeps the sloppy mode
 * the runtime would have run it in, unless it asks for strict mode itself.
 */

type Jiti = ReturnType<typeof createJiti>;
type JitiImport = (id: string) => Promise<unknown>;
type ModuleCache = Record<string, ModuleRecord>;

interface ModuleRecord {
	exports: unknown;
	filename: string;
	parent?: ModuleRecord;
}

/** One load of one extension: the modules it evaluated, so each file is evaluated once per load. */
interface LoadContext {
	cache: ModuleCache;
	/** The `node_modules` package the load's entry is in, whose own files are reloadable too. */
	packageRoot: string | undefined;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const BINDER_KEY = Symbol.for("atomic.extensions.reloadableScripts");
const prologue = (bindings: string) =>
	`{const __atomicReloadable=globalThis[Symbol.for("atomic.extensions.reloadableScripts")];if(__atomicReloadable)[${bindings}]=__atomicReloadable(module,require,jitiImport);}`;
const PROLOGUE = prologue("require,jitiImport");
// CommonJS also gets the platform's own paths, which jiti gives with forward slashes on Windows.
const COMMONJS_PROLOGUE = prologue("require,jitiImport,__filename,__dirname");
const USE_STRICT = /^"use strict";/;
const SOURCE_USE_STRICT = /^\s*(["'])use strict\1/;
// jiti's own test for ESM in a `.js` file outside a "type": "module" package.
const ESM_SYNTAX = /(?:^|[\s;])(?:import\s*["'{*]|import\s+\w|export\s*[{*]|export\s+\w|import\.meta\b)/m;

// The CommonJS fs object, which graph recording observes; an ESM namespace would not see its replacement.
const fsExports = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const loadContexts = new WeakMap<object, LoadContext>();
/** A jiti without host aliases or virtual modules, used only to resolve a bare import the way the runtime would. */
let runtimeResolver: Jiti;

export function isReloadableScriptPath(filePath: string): boolean {
	return SCRIPT_EXTENSIONS.has(path.extname(filePath));
}

function packageRootOf(filePath: string): string | undefined {
	const segments = path.normalize(filePath).split(path.sep);
	const index = segments.lastIndexOf("node_modules");
	if (index < 0) return undefined;
	return segments.slice(0, index + (segments[index + 1]?.startsWith("@") ? 3 : 2)).join(path.sep);
}

function createLoadContext(entry: string): LoadContext {
	const context: LoadContext = { cache: {}, packageRoot: packageRootOf(entry) };
	// jiti records each module it creates in the cache it evaluates with; remember which load it belongs to.
	context.cache = new Proxy({} as ModuleCache, {
		set(target, key: string, value: ModuleRecord) {
			target[key] = value;
			loadContexts.set(value, context);
			return true;
		},
	});
	return context;
}

/** The load a module belongs to; one jiti evaluated on its own (a TypeScript entry) starts one at its root. */
function loadContextOf(module: ModuleRecord): LoadContext {
	let root = module;
	for (let current: ModuleRecord | undefined = module; current; current = current.parent) {
		const context = loadContexts.get(current);
		if (context) return context;
		root = current;
	}
	const context = createLoadContext(root.filename);
	loadContexts.set(root, context);
	return context;
}

function isPathSpecifier(id: string): boolean {
	return id.startsWith("./") || id.startsWith("../") || id.startsWith("file:") || path.isAbsolute(id);
}

/** The JavaScript file a path specifier names, when this load evaluates it itself. */
function reloadableFile(id: string, require: Jiti, context: LoadContext): string | undefined {
	const resolved = path.normalize(require.resolve(id.startsWith("file:") ? fileURLToPath(id) : id));
	if (!isReloadableScriptPath(resolved)) return undefined;
	return packageRootOf(resolved) === context.packageRoot ? resolved : undefined;
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
function bindReloadableScriptLoaders(
	module: ModuleRecord,
	require: Jiti,
	jitiImport: JitiImport,
): [Jiti, JitiImport, string, string] {
	const load = (filename: string, async: boolean): unknown => {
		const context = loadContextOf(module);
		return context.cache[filename]?.exports ?? evaluate(require, filename, async, context.cache);
	};
	// TypeScript resolves bare specifiers through jiti, host aliases first, as before.
	const resolvesBareByRuntime = isReloadableScriptPath(module.filename);
	const reloadableRequire = new Proxy(require, {
		apply(target, thisArg, args: [string]) {
			const [id] = args;
			if (isBuiltin(id)) return Reflect.apply(target, thisArg, args);
			if (isPathSpecifier(id)) {
				const filename = reloadableFile(id, target, loadContextOf(module));
				return filename === undefined ? Reflect.apply(target, thisArg, args) : load(filename, false);
			}
			if (!resolvesBareByRuntime) return Reflect.apply(target, thisArg, args);
			const runtimeRequire = createRequire(module.filename);
			try {
				runtimeRequire.resolve(id);
			} catch {
				return Reflect.apply(target, thisArg, args);
			}
			return runtimeRequire(id);
		},
	});
	const reloadableImport: JitiImport = async (id) => {
		if (isBuiltin(id)) return jitiImport(id);
		if (isPathSpecifier(id)) {
			const filename = reloadableFile(id, require, loadContextOf(module));
			return filename === undefined ? jitiImport(id) : load(filename, true);
		}
		if (!resolvesBareByRuntime) return jitiImport(id);
		let target: string;
		try {
			target = runtimeResolver.esmResolve(id, pathToFileURL(module.filename).href) as string;
		} catch {
			return jitiImport(id);
		}
		return import(target);
	};
	const filename = path.normalize(module.filename);
	return [reloadableRequire, reloadableImport, filename, path.dirname(filename)];
}

/** Routes the imports of transformed extension modules as described above; `resolver` is a jiti without host aliases. */
export function installReloadableScripts(resolver: Jiti): void {
	runtimeResolver = resolver;
	(globalThis as Record<symbol, unknown>)[BINDER_KEY] = bindReloadableScriptLoaders;
}

/** The `type` of the package.json nearest to `filePath`. */
function packageTypeOf(filePath: string): unknown {
	for (let dir = path.dirname(filePath); ; dir = path.dirname(dir)) {
		const manifest = path.join(dir, "package.json");
		if (fsExports.existsSync(manifest)) {
			try {
				return (JSON.parse(fsExports.readFileSync(manifest, "utf8")) as { type?: unknown }).type;
			} catch {
				return undefined;
			}
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}

/** Whether the runtime would have run `source` as CommonJS. */
function isCommonJs(filename: string, source: string): boolean {
	const extension = path.extname(filename);
	if (extension === ".cjs") return true;
	return extension === ".js" && !ESM_SYNTAX.test(source) && packageTypeOf(filename) !== "module";
}

/** Adds the prologue that routes a transformed module's imports as described above. */
export function withReloadableScriptPrologue(code: string, filename: string, source: string): string {
	const directive = USE_STRICT.exec(code)?.[0] ?? "";
	const commonJs = isCommonJs(filename, source);
	const sloppy = commonJs && !SOURCE_USE_STRICT.test(source);
	return `${sloppy ? "" : directive}${commonJs ? COMMONJS_PROLOGUE : PROLOGUE}${code.slice(directive.length)}`;
}

/**
 * Evaluates a JavaScript extension entry through jiti's transform in a new
 * load, so the entry and the JavaScript it imports by path run as they are on
 * disk now. Returns the default export, else the module.
 */
export async function evaluateReloadableScript(jiti: Jiti, filename: string): Promise<unknown> {
	const loaded = (await evaluate(jiti, filename, true, createLoadContext(filename).cache)) as { default?: unknown };
	return loaded.default ?? loaded;
}
