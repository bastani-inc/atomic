import * as fs from "node:fs";
import * as path from "node:path";
import type { createJiti } from "jiti";

type CreateJiti = typeof createJiti;
type JitiTransform = NonNullable<NonNullable<Parameters<CreateJiti>[1]>["transform"]>;
type JitiTransformOptions = Parameters<JitiTransform>[0];

const RELATIVE_SPECIFIER = /^\.\.?\//;
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
 * throws. Dropping the extension when only the TypeScript source exists lets
 * jiti's ordinary extension search find it at once, while a JavaScript file
 * created later still takes precedence.
 */
export function typeScriptSourceSpecifier(specifier: string, importer: string): string | undefined {
	if (!RELATIVE_SPECIFIER.test(specifier)) return undefined;
	const scriptExtension = SCRIPT_EXTENSION.exec(specifier)?.[0];
	if (!scriptExtension) return undefined;
	const target = path.resolve(path.dirname(importer), specifier);
	const stem = target.slice(0, -scriptExtension.length);
	if (fs.existsSync(target) || !fs.existsSync(stem + TYPESCRIPT_EXTENSION_FOR[scriptExtension])) return undefined;
	return specifier.slice(0, -scriptExtension.length);
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
}

function rewriteSource(literal: StringLiteralNode | null | undefined, importer: string): void {
	if (literal?.type !== "StringLiteral" || typeof literal.value !== "string") return;
	const rewritten = typeScriptSourceSpecifier(literal.value, importer);
	if (rewritten === undefined) return;
	literal.value = rewritten;
	literal.extra = undefined;
}

function isModuleLoadCall(callee: CallNode["callee"]): boolean {
	return callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require");
}

function typeScriptSourceSpecifierPlugin(_babel: object, options: { importer: string }) {
	return {
		name: "atomic-typescript-source-specifiers",
		visitor: {
			"ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(nodePath: NodePath<ModuleSourceNode>) {
				rewriteSource(nodePath.node.source, options.importer);
			},
			ImportExpression(nodePath: NodePath<ModuleSourceNode>) {
				rewriteSource(nodePath.node.source, options.importer);
			},
			CallExpression(nodePath: NodePath<CallNode>) {
				if (isModuleLoadCall(nodePath.node.callee)) rewriteSource(nodePath.node.arguments?.[0], options.importer);
			},
		},
	};
}

/** A jiti `transform` that runs jiti's own Babel transform plus the specifier rewrite. */
export function createTypeScriptSourceSpecifierTransform(createJitiImpl: CreateJiti, id: string): JitiTransform {
	const babelHost = createJitiImpl(id, { fsCache: false, moduleCache: false });
	return (options: JitiTransformOptions) => {
		if (!options.filename) return { code: babelHost.transform(options) };
		const plugins: ReadonlyArray<string | object> = Array.isArray(options.babel?.plugins)
			? options.babel.plugins
			: [];
		return {
			code: babelHost.transform({
				...options,
				babel: {
					...options.babel,
					plugins: [...plugins, [typeScriptSourceSpecifierPlugin, { importer: options.filename }]],
				},
			}),
		};
	};
}
