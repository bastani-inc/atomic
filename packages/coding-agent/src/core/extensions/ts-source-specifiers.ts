import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { createJiti } from "jiti";

type CreateJiti = typeof createJiti;
type JitiTransform = NonNullable<NonNullable<Parameters<CreateJiti>[1]>["transform"]>;
type JitiTransformOptions = Parameters<JitiTransform>[0];

// 2: a stored transform starts with a line listing the module's static imports.
const TRANSFORM_CACHE_FORMAT = 2;
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
 * `cacheDir` must already exist; the transform never creates it.
 */
export function createTypeScriptSourceSpecifierTransform(
	createJitiImpl: CreateJiti,
	id: string,
	cacheDir: () => string | undefined,
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
			babel: { ...options.babel, plugins: [...plugins, [typeScriptSourceSpecifierPlugin, { rewrites, imports }]] },
		});
		const transformed: TransformedModule = { code, imports };
		if (cached && !code.includes("__JITI_ERROR__")) {
			const write = writeCached(cached, storedForm(transformed));
			writes.add(write);
			void write.then(() => writes.delete(write));
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
