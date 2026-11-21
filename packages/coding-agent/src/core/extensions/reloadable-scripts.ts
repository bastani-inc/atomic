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
 * - A JSON file it imports or requires by path, or by a package name that
 *   leads into the load's package, is read once per load, as the file is then,
 *   and parsed as the runtime's `require` parses it. jiti would load it through
 *   that `require`, whose cache keeps the content first read until the process
 *   exits; the cache is left as it is.
 * - Everything else (Node builtins, TypeScript files, bare specifiers in
 *   TypeScript, JSON a bare specifier names) keeps jiti's handling.
 *
 * jiti's transform makes every module strict; CommonJS keeps the sloppy mode
 * the runtime would have run it in, unless it asks for strict mode itself.
 */

type Jiti = ReturnType<typeof createJiti>;
export type JitiImport = (id: string) => Promise<unknown>;
type ModuleCache = Record<string, ModuleRecord>;

interface ModuleRecord {
	exports: unknown;
	filename: string;
	parent?: ModuleRecord;
	/** Set by jiti once the module's evaluation has finished. */
	loaded?: boolean;
	children?: ModuleRecord[];
}

/** A module jiti evaluated for an extension, as the prologue hands it over. */
export type LoadedModule = ModuleRecord;

/**
 * Takes over a path import made by a module that has finished evaluating, or returns `undefined` to leave it to
 * jiti at once.
 */
export type SettledPathImport = (
	importer: LoadedModule,
	id: string,
	require: Jiti,
	jitiImport: JitiImport,
) => Promise<unknown> | undefined;

/** One load of one extension: the modules it evaluated, so each file is evaluated once per load. */
interface LoadContext {
	cache: ModuleCache;
	/** The JSON values the load read, by file, so each file is read once per load. */
	json: Map<string, unknown>;
	/** The `node_modules` package the load's entry is in, whose own files are reloadable too. */
	packageRoot: string;
}

/**
 * Told of each JSON file a load reads, with the content it parsed, or `undefined` when it cannot vouch for what it
 * parsed; keyed by the options of the load's jiti.
 */
const jsonReadObservers = new WeakMap<object, (file: string, content: Buffer | undefined) => void>();

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const BINDER_KEY = Symbol.for("atomic.extensions.reloadableScripts");
const prologue = (bindings: string) =>
	`{const __atomicReloadable=globalThis[Symbol.for("atomic.extensions.reloadableScripts")];if(__atomicReloadable)[${bindings}]=__atomicReloadable(module,require,jitiImport);}`;
const PROLOGUE = prologue("require,jitiImport");
// CommonJS also gets the platform's own paths, which jiti gives with forward slashes on Windows.
const COMMONJS_PROLOGUE = prologue("require,jitiImport,__filename,__dirname");
// A leading strict directive, as jiti's transform emits it, or the module's own, which the transform keeps.
const USE_STRICT = /^\s*(["'])use strict\1;?/;
// jiti's own test for ESM in a `.js` file outside a "type": "module" package.
const ESM_SYNTAX = /(?:^|[\s;])(?:import\s*["'{*]|import\s+\w|export\s*[{*]|export\s+\w|import\.meta\b)/m;

// The CommonJS fs object, which graph recording observes; an ESM namespace would not see its replacement.
const fsExports = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const loadContexts = new WeakMap<object, LoadContext>();
let createResolver: (id: string) => Jiti;
let settledPathImport: SettledPathImport | undefined;
/** Per importing directory, a jiti without host aliases that resolves a bare import from there as the runtime would. */
const runtimeResolvers = new Map<string, Jiti>();

function runtimeResolverFor(importer: string): Jiti {
	const directory = path.dirname(importer);
	let resolver = runtimeResolvers.get(directory);
	if (!resolver) {
		// Based in the importing directory, so jiti's last resort, a CommonJS resolve from its base, starts there too.
		resolver = createResolver(pathToFileURL(importer).href);
		runtimeResolvers.set(directory, resolver);
	}
	return resolver;
}

export function isReloadableScriptPath(filePath: string): boolean {
	return SCRIPT_EXTENSIONS.has(path.extname(filePath));
}

/**
 * The `node_modules` package a file is in. Outside `node_modules` this is the
 * first path segment, the same for every file on the drive.
 */
function packageRootOf(filePath: string): string {
	const segments = path.normalize(filePath).split(path.sep);
	const index = segments.lastIndexOf("node_modules");
	return segments.slice(0, index + (segments[index + 1].startsWith("@") ? 3 : 2)).join(path.sep);
}

/**
 * The load a module belongs to, kept on the root of its chain of importers:
 * the extension entry, which starts the load's module cache.
 */
function loadContextOf(module: ModuleRecord): LoadContext {
	let root = module;
	while (root.parent) root = root.parent;
	let context = loadContexts.get(root);
	if (!context) {
		const filename = path.normalize(root.filename);
		context = { cache: { [filename]: root }, json: new Map(), packageRoot: packageRootOf(filename) };
		loadContexts.set(root, context);
	}
	return context;
}

function isPathSpecifier(id: string): boolean {
	return id.startsWith("./") || id.startsWith("../") || id.startsWith("file:") || path.isAbsolute(id);
}

/** A file a path specifier names that this load reads itself: JavaScript it evaluates, or JSON. */
interface OwnFile {
	readonly kind: "script" | "json";
	readonly filename: string;
}

function ownFile(id: string, require: Jiti, context: LoadContext): OwnFile | undefined {
	const resolved = path.normalize(require.resolve(id.startsWith("file:") ? fileURLToPath(id) : id));
	if (isReloadableScriptPath(resolved)) {
		return packageRootOf(resolved) === context.packageRoot ? { kind: "script", filename: resolved } : undefined;
	}
	const json = path.extname(resolved) === ".json" ? ownJson(resolved, context) : undefined;
	return json === undefined ? undefined : { kind: "json", filename: json };
}

/**
 * The real path of JSON file `resolved` when it lies in the load's own package, so that every specifier naming the
 * file, by path or by a package name linked into the load's package, reads the one value of the load.
 */
function ownJson(resolved: string, context: LoadContext): string | undefined {
	let real: string;
	try {
		real = path.normalize(fsExports.realpathSync(resolved));
	} catch {
		return undefined;
	}
	return packageRootOf(real) === context.packageRoot ? real : undefined;
}

/** {@link ownJson} for a bare specifier that names a `.json` file, such as one in a workspace package linked in. */
function ownJsonByName(id: string, require: Jiti, context: LoadContext): string | undefined {
	if (path.extname(id) !== ".json") return undefined;
	let resolved: string;
	try {
		resolved = require.resolve(id);
	} catch {
		return undefined;
	}
	return path.extname(resolved) === ".json" ? ownJson(resolved, context) : undefined;
}

/**
 * The JSON files Bun's `require` reads as JSON with comments: a `package.json`, and a `tsconfig.json` or `jsconfig.json`,
 * also with a further name part (`tsconfig.base.json`), in any letter case.
 */
const BUN_JSONC_NAME = /^(?:package|tsconfig(?:\..*)?|jsconfig(?:\..*)?)\.json$/i;

interface BunJsonc {
	readonly JSONC: { parse(text: string): unknown };
}

/** The value the runtime's `require` gives for a JSON file with this content: Node's and Bun's read it the same way. */
function parseJson(filename: string, content: Buffer): unknown {
	const text = content.toString("utf8");
	const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const bun = (globalThis as { Bun?: BunJsonc }).Bun;
	return bun !== undefined && BUN_JSONC_NAME.test(path.basename(filename)) ? bun.JSONC.parse(json) : JSON.parse(json);
}

/** The value of a JSON file from the runtime's own `require`, leaving its cache entry as it was. */
function requireAfresh(filename: string): unknown {
	const runtimeRequire = createRequire(filename);
	const key = runtimeRequire.resolve(filename);
	const cached = Object.hasOwn(runtimeRequire.cache, key) ? runtimeRequire.cache[key] : undefined;
	delete runtimeRequire.cache[key];
	try {
		return runtimeRequire(key);
	} finally {
		if (cached !== undefined) runtimeRequire.cache[key] = cached;
		else delete runtimeRequire.cache[key];
	}
}

/**
 * The JSON file `filename` as jiti gives it, read once for `context`'s load: with a `default` that is the value
 * itself when the value has none, which jiti adds to the runtime's value.
 */
function readJson(filename: string, require: Jiti, context: LoadContext): unknown {
	if (context.json.has(filename)) return context.json.get(filename);
	// One read gives the value and what the load records about the file, which the graph recording also observes.
	const content = fsExports.readFileSync(filename);
	const onRead = jsonReadObservers.get(require.options);
	let value: unknown;
	try {
		value = parseJson(filename, content);
		onRead?.(filename, content);
	} catch {
		// The runtime's own `require` throws its own error. Should it read the file, which then changed since, its value
		// is used, and the load records the file as changed.
		onRead?.(filename, undefined);
		value = requireAfresh(filename);
	}
	// As jiti's own JSON load, including its TypeError for a value `in` cannot search.
	if (value && !("default" in (value as object)))
		Object.defineProperty(value, "default", { value, enumerable: false });
	context.json.set(filename, value);
	return value;
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
			if (isPathSpecifier(id)) {
				const context = loadContextOf(module);
				const own = ownFile(id, target, context);
				if (own === undefined) return Reflect.apply(target, thisArg, args);
				return own.kind === "json" ? readJson(own.filename, target, context) : load(own.filename, false);
			}
			const context = loadContextOf(module);
			const json = ownJsonByName(id, target, context);
			if (json !== undefined) return readJson(json, target, context);
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
			const context = loadContextOf(module);
			const own = ownFile(id, require, context);
			if (own?.kind === "json") return readJson(own.filename, require, context);
			if (own !== undefined) return load(own.filename, true);
			return (
				(module.loaded === true ? settledPathImport?.(module, id, require, jitiImport) : undefined) ??
				jitiImport(id)
			);
		}
		const context = loadContextOf(module);
		const json = ownJsonByName(id, require, context);
		if (json !== undefined) return readJson(json, require, context);
		if (!resolvesBareByRuntime) return jitiImport(id);
		let target: string;
		try {
			target = runtimeResolverFor(module.filename).esmResolve(id) as string;
		} catch {
			return jitiImport(id);
		}
		return import(target);
	};
	const filename = path.normalize(module.filename);
	return [reloadableRequire, reloadableImport, filename, path.dirname(filename)];
}

/**
 * Tells `onRead` of each JSON file a load by `jiti` reads, with the content the load then uses, or `undefined` when it
 * cannot vouch for what it parsed.
 */
export function observeJsonReads(jiti: Jiti, onRead: (file: string, content: Buffer | undefined) => void): void {
	jsonReadObservers.set(jiti.options, onRead);
}

/**
 * Routes the imports of transformed extension modules as described above; `createJiti` makes a jiti without host
 * aliases. `onSettledPathImport` may take over a path import made after its importer finished evaluating.
 */
export function installReloadableScripts(
	createJiti: (id: string) => Jiti,
	onSettledPathImport?: SettledPathImport,
): void {
	createResolver = createJiti;
	settledPathImport = onSettledPathImport;
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
	const sloppy = commonJs && !USE_STRICT.test(source);
	return `${sloppy ? "" : directive}${commonJs ? COMMONJS_PROLOGUE : PROLOGUE}${code.slice(directive.length)}`;
}

/**
 * Evaluates a JavaScript extension entry through jiti's transform in a new
 * load, so the entry and the JavaScript it imports by path run as they are on
 * disk now. Returns the default export, else the module.
 */
export async function evaluateReloadableScript(jiti: Jiti, filename: string): Promise<unknown> {
	const loaded = (await evaluate(jiti, filename, true, {})) as { default?: unknown };
	return loaded.default ?? loaded;
}
