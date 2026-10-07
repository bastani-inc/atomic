import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { createJiti } from "jiti";

type CreateJiti = typeof createJiti;
type JitiTransform = NonNullable<NonNullable<Parameters<CreateJiti>[1]>["transform"]>;
type JitiTransformOptions = Parameters<JitiTransform>[0];

const TRANSFORM_CACHE_FORMAT = 1;
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

function typeScriptSourceSpecifierPlugin(_babel: object, options: { rewrites: ReadonlyMap<string, string> }) {
	return {
		name: "atomic-typescript-source-specifiers",
		visitor: {
			"ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(nodePath: NodePath<ModuleSourceNode>) {
				rewriteSource(nodePath.node.source, options.rewrites);
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

function readCached(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function writeCached(file: string, code: string): void {
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(temporary, code, "utf8");
		fs.renameSync(temporary, file);
	} catch {
		fs.rmSync(temporary, { force: true });
	}
}

/**
 * A jiti `transform` that runs jiti's own Babel transform plus the specifier
 * rewrite. Use it with jiti's `fsCache: false`: jiti keys its cache on the
 * importer source alone, while a rewrite also depends on which siblings exist.
 */
export function createTypeScriptSourceSpecifierTransform(
	createJitiImpl: CreateJiti,
	id: string,
	cacheDir: () => string | undefined,
): JitiTransform {
	const babelHost = createJitiImpl(id, { fsCache: false, moduleCache: false });
	return (options: JitiTransformOptions) => {
		if (!options.filename) return { code: babelHost.transform(options) };
		const rewrites = planRewrites(options.source, options.filename);
		const directory = cacheDir();
		const cached = directory ? cacheFile(directory, options, rewrites) : undefined;
		const hit = cached ? readCached(cached) : undefined;
		if (hit !== undefined) return { code: hit };
		const plugins: ReadonlyArray<string | object> = Array.isArray(options.babel?.plugins)
			? options.babel.plugins
			: [];
		const code = babelHost.transform({
			...options,
			babel: { ...options.babel, plugins: [...plugins, [typeScriptSourceSpecifierPlugin, { rewrites }]] },
		});
		if (cached && !code.includes("__JITI_ERROR__")) writeCached(cached, code);
		return { code };
	};
}
