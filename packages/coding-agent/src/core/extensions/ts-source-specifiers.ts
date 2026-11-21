import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { createJiti } from "jiti";

type CreateJiti = typeof createJiti;
type JitiTransform = NonNullable<NonNullable<Parameters<CreateJiti>[1]>["transform"]>;
type JitiTransformOptions = Parameters<JitiTransform>[0];

// 2: a stored transform starts with a line listing the module's static imports.
// 5: `import.meta` is an object of the module's own file, and every path the module reads is written as the platform
// writes it (see `moduleImportMetaPlugin`).
const TRANSFORM_CACHE_FORMAT = 5;
const RELATIVE_SCRIPT_SPECIFIER = /["'](\.\.?\/[^"'\r\n]*?\.[cm]?jsx?)["']/g;
const SCRIPT_EXTENSION = /\.[cm]?jsx?$/;
const TYPESCRIPT_EXTENSION_FOR: Readonly<Record<string, string>> = {
	".js": ".ts",
	".mjs": ".mts",
	".cjs": ".cts",
	".jsx": ".tsx",
};

/**
 * jiti tries a `./x.js` import of `x.ts` against every resolution condition,
 * base URL, and extension before its `.js` -> `.ts` fallback, and each miss
 * throws. Naming the TypeScript source that fallback would select resolves it
 * on the first probe.
 */
export function typeScriptSourceSpecifier(specifier: string, importer: string): string | undefined {
	const scriptExtension = SCRIPT_EXTENSION.exec(specifier)?.[0];
	if (!scriptExtension || !(specifier.startsWith("./") || specifier.startsWith("../"))) return undefined;
	const typeScriptSpecifier = specifier.slice(0, -scriptExtension.length) + TYPESCRIPT_EXTENSION_FOR[scriptExtension];
	const directory = path.dirname(importer);
	if (fs.existsSync(path.resolve(directory, specifier))) return undefined;
	if (!fs.existsSync(path.resolve(directory, typeScriptSpecifier))) return undefined;
	return typeScriptSpecifier;
}

/** Every rewrite this source can receive; part of the cache key, so a sibling change re-transforms. */
function planRewrites(source: string, importer: string): ReadonlyMap<string, string> {
	const rewrites = new Map<string, string>();
	for (const [, specifier] of source.matchAll(RELATIVE_SCRIPT_SPECIFIER)) {
		if (!specifier || rewrites.has(specifier)) continue;
		const rewritten = typeScriptSourceSpecifier(specifier, importer);
		if (rewritten !== undefined) rewrites.set(specifier, rewritten);
	}
	return rewrites;
}

interface StringLiteralNode {
	type: string;
	value?: string;
	extra?: object;
}

interface ModuleSourceNode {
	source?: StringLiteralNode | null;
}

interface CallNode {
	callee?: { type: string; name?: string };
	arguments?: StringLiteralNode[];
}

interface NodePath<Node> {
	node: Node;
	scope: { hasBinding(name: string): boolean };
}

/** A module jiti's transform produced: its code and the path specifiers its evaluation imports before its code runs. */
export interface TransformedModule {
	readonly code: string;
	readonly imports: readonly string[];
}

interface PluginOptions {
	rewrites: ReadonlyMap<string, string>;
	/** Filled with the path specifiers of the import statements the module keeps. */
	imports: string[];
}

function rewriteSource(literal: StringLiteralNode | null | undefined, rewrites: ReadonlyMap<string, string>): void {
	if (literal?.type !== "StringLiteral" || typeof literal.value !== "string") return;
	const rewritten = rewrites.get(literal.value);
	if (rewritten === undefined) return;
	literal.value = rewritten;
	literal.extra = undefined;
}

function isModuleLoadCall(nodePath: NodePath<CallNode>): boolean {
	const callee = nodePath.node.callee;
	if (callee?.type === "Import") return true;
	return callee?.type === "Identifier" && callee.name === "require" && !nodePath.scope.hasBinding("require");
}

function isPathSpecifier(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function typeScriptSourceSpecifierPlugin(_babel: object, options: PluginOptions) {
	return {
		name: "atomic-typescript-source-specifiers",
		visitor: {
			// The import statements and `export … from` declarations the module keeps: the TypeScript plugin, listed
			// before this one, has already removed those that import only types. jiti's module transform turns each
			// into an import the module awaits before its own code runs; a dynamic `import()` runs later.
			"ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(nodePath: NodePath<ModuleSourceNode>) {
				const source = nodePath.node.source;
				rewriteSource(source, options.rewrites);
				const specifier = source?.type === "StringLiteral" ? source.value : undefined;
				if (specifier !== undefined && isPathSpecifier(specifier) && !options.imports.includes(specifier))
					options.imports.push(specifier);
			},
			ImportExpression(nodePath: NodePath<ModuleSourceNode>) {
				rewriteSource(nodePath.node.source, options.rewrites);
			},
			CallExpression(nodePath: NodePath<CallNode>) {
				if (isModuleLoadCall(nodePath)) rewriteSource(nodePath.node.arguments?.[0], options.rewrites);
			},
		},
	};
}

interface ScopeLike {
	hasBinding(name: string): boolean;
	hasOwnBinding(name: string): boolean;
	rename(name: string): void;
	generateUidIdentifier(name: string): { name: string };
}

interface MetaPropertyPath {
	node: { meta?: { name?: string }; property?: { name?: string } };
	replaceWith(node: object): void;
}

interface IdentifierPath {
	node: object & { name?: string };
	parent: { type: string; callee?: object };
	scope: ScopeLike;
	isReferencedIdentifier(): boolean;
}

interface ProgramPath {
	scope: ScopeLike;
	traverse(visitor: {
		Scopable?(nodePath: { scope: ScopeLike }): void;
		MetaProperty?(nodePath: MetaPropertyPath): void;
	}): void;
	unshiftContainer(key: "body", node: object): void;
}

/** The names jiti's module wrapper gives the functions its transform calls for `import()` and `import.meta.resolve`. */
const JITI_FUNCTION_NAMES = ["jitiImport", "jitiESMResolve"];

interface BabelApi {
	types: { identifier(name: string): object; callExpression(callee: object, args: object[]): object };
	template: { statement: { ast(code: string): object } };
}

/**
 * jiti replaces a module's `import.meta.url`, `filename`, `dirname` and `resolve` where the code names them directly,
 * with paths written with forward slashes on Windows too, and leaves the rest of `import.meta` to the code it evaluates:
 * under Node that names no file at all, under Bun a `data:` module. This gives each module an `import.meta` object of
 * its own file instead, the one a natively imported module has: `url`, `filename`, `dirname` and `resolve`, under Bun
 * also `path`, `dir`, `file`, `main` and a `require` of the file, and `env`, as jiti gave it before. Every use of
 * `import.meta` reads that object, whether it names a property directly, keeps the object in a variable, or
 * destructures it. Every path it names, and `__filename`, `__dirname` and `require.resolve`'s, is written as the
 * platform writes it, as for a module Node or Bun loads itself.
 *
 * The code this adds never reads the module's own bindings: the function that returns the object has a name no other
 * binding in the module has, and reads Node's globals through `globalThis`, so a module's own `process` or `require`
 * never stands in for them. It is a hoisted function, so code an import cycle runs before the module's own can call it.
 */
function moduleImportMetaPlugin(babel: BabelApi, options: { filename: string }) {
	// The file's path as the platform writes it: jiti names it with forward slashes on Windows too.
	const filename = path.resolve(options.filename);
	const url = pathToFileURL(filename).href;
	const dirname = path.dirname(filename);
	const file = path.basename(filename);
	const fileGlobals: Readonly<Record<string, string>> = { __filename: filename, __dirname: dirname };
	type State = { importMeta?: string; fileGlobals?: Set<string>; resolvesPaths?: boolean };
	const literal = JSON.stringify;
	return {
		name: "atomic-module-import-meta",
		pre(this: State, file: { path: ProgramPath }) {
			// This runs before any plugin's visitors: jiti's own rewrites the module's direct reads of its URL, dirname
			// and filename as soon as it enters the program.
			const program = file.path;
			// A binding of the module's own with a name jiti's wrapper gives its functions would stand in for them.
			const renameJitiNames = (scope: ScopeLike) => {
				for (const name of JITI_FUNCTION_NAMES) if (scope.hasOwnBinding(name)) scope.rename(name);
			};
			renameJitiNames(program.scope);
			program.traverse({ Scopable: (nodePath) => renameJitiNames(nodePath.scope) });
			program.traverse({
				MetaProperty: (nodePath) => {
					if (nodePath.node.meta?.name !== "import" || nodePath.node.property?.name !== "meta") return;
					this.importMeta ??= program.scope.generateUidIdentifier("importMeta").name;
					nodePath.replaceWith(babel.types.callExpression(babel.types.identifier(this.importMeta), []));
				},
			});
		},
		visitor: {
			Identifier(nodePath: IdentifierPath, state: State) {
				const name = nodePath.node.name;
				if (name === undefined || !nodePath.isReferencedIdentifier() || nodePath.scope.hasBinding(name)) return;
				if (name in fileGlobals) {
					state.fileGlobals ??= new Set();
					state.fileGlobals.add(name);
				}
				// jiti's `require`, other than to call it: `require.resolve` names a path.
				if (
					name === "require" &&
					!(nodePath.parent.type === "CallExpression" && nodePath.parent.callee === nodePath.node)
				)
					state.resolvesPaths = true;
			},
			Program: {
				exit(nodePath: ProgramPath, state: State) {
					const assignments = [...(state.fileGlobals ?? [])]
						.filter((name) => !nodePath.scope.hasBinding(name))
						.map((name) => `${name} = ${literal(fileGlobals[name])};`);
					// jiti's `__filename` and `__dirname` name the file with forward slashes on Windows too.
					for (const assignment of assignments)
						nodePath.unshiftContainer("body", babel.template.statement.ast(assignment));
					if (state.resolvesPaths && !nodePath.scope.hasBinding("require")) {
						nodePath.unshiftContainer(
							"body",
							babel.template.statement.ast(
								`if (globalThis.process.platform === "win32") {
									const { resolve } = require;
									const { win32 } = globalThis.process.getBuiltinModule("node:path");
									require.resolve = (id, options) => {
										const resolved = resolve(id, options);
										return win32.isAbsolute(resolved) ? win32.normalize(resolved) : resolved;
									};
									require.resolve.paths = resolve.paths;
								}`,
							),
						);
					}
					const importMeta = state.importMeta;
					if (importMeta === undefined) return;
					// Its `resolve` answers as a native one does: a built-in module by its `node:` name, a path or URL to no
					// file by its URL, and a package it cannot find with ERR_MODULE_NOT_FOUND.
					nodePath.unshiftContainer(
						"body",
						babel.template.statement.ast(
							`function ${importMeta}() {
								${importMeta}.meta ??= ((nodeProcess, jitiResolve) => {
									const nodeModule = nodeProcess.getBuiltinModule("node:module");
									const resolve = (specifier, parent) => {
										if (nodeModule.isBuiltin(specifier)) return specifier.includes(":") ? specifier : "node:" + specifier;
										try {
											return jitiResolve(specifier, parent);
										} catch (error) {
											if (!/^(?:\\.{0,2}\\/|[a-zA-Z][a-zA-Z\\d+.-]*:)/.test(specifier)) {
												if (error?.code !== "MODULE_NOT_FOUND") throw error;
												throw Object.assign(new Error(error.message, { cause: error }), { code: "ERR_MODULE_NOT_FOUND" });
											}
											return new URL(specifier, parent ?? ${literal(url)}).href;
										}
									};
									const meta = { url: ${literal(url)}, filename: ${literal(filename)}, dirname: ${literal(dirname)}, resolve, env: nodeProcess.env };
									if (nodeProcess.versions.bun === undefined) return meta;
									const require = nodeModule.createRequire(${literal(filename)});
									return { ...meta, path: ${literal(filename)}, dir: ${literal(dirname)}, file: ${literal(file)}, main: false, require };
								})(globalThis.process, jitiESMResolve);
								return ${importMeta}.meta;
							}`,
						),
					);
				},
			},
		},
	};
}

function cacheFile(cacheDir: string, options: JitiTransformOptions, rewrites: ReadonlyMap<string, string>): string {
	const key = crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				TRANSFORM_CACHE_FORMAT,
				options.filename,
				options.async,
				options.ts,
				options.jsx,
				options.interopDefault,
				options.retainLines,
				options.babel?.sourceMaps,
				[...rewrites],
				options.source,
			]),
		)
		.digest("hex")
		.slice(0, 32);
	const name = path.basename(options.filename ?? "module").replace(/[^\w.-]/g, "_");
	return path.join(cacheDir, `${name}.${key}.${options.async ? "mjs" : "cjs"}`);
}

/** A stored transform: one line with the JSON list of its static imports, then the code jiti evaluates. */
function storedForm({ code, imports }: TransformedModule): string {
	return `${JSON.stringify(imports)}\n${code}`;
}

function readCached(file: string): TransformedModule | undefined {
	let stored: string;
	try {
		stored = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const lineEnd = stored.indexOf("\n");
	if (lineEnd < 0) return undefined;
	try {
		const imports: unknown = JSON.parse(stored.slice(0, lineEnd));
		if (!Array.isArray(imports) || !imports.every((specifier) => typeof specifier === "string")) return undefined;
		return { code: stored.slice(lineEnd + 1), imports };
	} catch {
		return undefined;
	}
}

/** Writes only into an existing cache directory, so a removed agent directory is never recreated (#4728). */
function writeCached(file: string, code: string): Promise<void> {
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	return fs.promises
		.writeFile(temporary, code, "utf8")
		.then(() => fs.promises.rename(temporary, file))
		.catch(() => fs.promises.rm(temporary, { force: true }))
		.catch(() => {});
}

type BabelHost = ReturnType<CreateJiti>;
const babelHosts = new WeakMap<CreateJiti, Map<string, BabelHost>>();

/** One Babel host per jiti implementation and id, so a transform per cache directory stays cheap. */
function babelHostFor(createJitiImpl: CreateJiti, id: string): BabelHost {
	let hosts = babelHosts.get(createJitiImpl);
	if (!hosts) {
		hosts = new Map();
		babelHosts.set(createJitiImpl, hosts);
	}
	let host = hosts.get(id);
	if (!host) {
		host = createJitiImpl(id, { fsCache: false, moduleCache: false });
		hosts.set(id, host);
	}
	return host;
}

/**
 * A jiti `transform` that runs jiti's own Babel transform plus the specifier
 * rewrite. Use it with jiti's `fsCache: false`: jiti keys its cache on the
 * importer source alone, while a rewrite also depends on which siblings exist.
 * `cacheDir` must already exist; the transform never creates it. `onWrite` is
 * handed each write of a stored transform as it starts.
 */
export function createTypeScriptSourceSpecifierTransform(
	createJitiImpl: CreateJiti,
	id: string,
	cacheDir: () => string | undefined,
	onWrite?: (write: Promise<void>) => void,
): JitiTransform & {
	flush: () => Promise<void>;
	cached: (options: JitiTransformOptions) => TransformedModule | undefined;
	module: (options: JitiTransformOptions) => TransformedModule;
} {
	const babelHost = babelHostFor(createJitiImpl, id);
	const writes = new Set<Promise<void>>();
	const transformModule = (options: JitiTransformOptions): TransformedModule => {
		if (!options.filename) return { code: babelHost.transform(options), imports: [] };
		const rewrites = planRewrites(options.source, options.filename);
		const directory = cacheDir();
		const cached = directory ? cacheFile(directory, options, rewrites) : undefined;
		const hit = cached ? readCached(cached) : undefined;
		if (hit !== undefined) return hit;
		const plugins: ReadonlyArray<string | object> = Array.isArray(options.babel?.plugins)
			? options.babel.plugins
			: [];
		const imports: string[] = [];
		const code = babelHost.transform({
			...options,
			babel: {
				...options.babel,
				plugins: [
					...plugins,
					[typeScriptSourceSpecifierPlugin, { rewrites, imports }],
					[moduleImportMetaPlugin, { filename: options.filename }],
				],
			},
		});
		const transformed: TransformedModule = { code, imports };
		if (cached && !code.includes("__JITI_ERROR__")) {
			const write = writeCached(cached, storedForm(transformed));
			writes.add(write);
			void write.then(() => writes.delete(write));
			onWrite?.(write);
		}
		return transformed;
	};
	const transform: JitiTransform = (options: JitiTransformOptions) => ({ code: transformModule(options).code });
	return Object.assign(transform, {
		async flush(): Promise<void> {
			while (writes.size > 0) await Promise.all(writes);
		},
		/** The stored transform for `options`, without transforming on a miss. */
		cached(options: JitiTransformOptions): TransformedModule | undefined {
			const directory = cacheDir();
			if (!options.filename || !directory) return undefined;
			return readCached(cacheFile(directory, options, planRewrites(options.source, options.filename)));
		},
		/** The transform for `options` with the static imports Babel found, stored like any other. */
		module: transformModule,
	});
}
