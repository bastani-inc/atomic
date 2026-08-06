import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parse } from "@babel/parser";

/**
 * Runtime module-graph walker used to prove the intercom broker stays self-contained.
 *
 * A regex scanner over import syntax is not enough: `createRequire(import.meta.url)("pkg")`
 * loads a package at runtime and looks nothing like an import declaration. This parses each
 * file with Babel and collects every construct that performs a runtime module request, so a
 * CommonJS-style reintroduction fails the same way a static import does.
 */

const nodeBuiltins = new Set(builtinModules);

/** Names that produce a CommonJS `require` function when called. */
const DEFAULT_REQUIRE_FACTORIES = ["createRequire"] as const;

export interface RuntimeRequest {
	/** Literal specifier, or `undefined` when the argument is not statically known. */
	readonly specifier?: string;
	/** How the request is made, for error messages. */
	readonly kind:
		| "import"
		| "export-from"
		| "import-equals"
		| "dynamic-import"
		| "require"
		| "require.resolve"
		| "created-require"
		| "process.getBuiltinModule"
		| "import.meta.resolve";
	readonly importer: string;
	/** Source text of a non-literal argument. */
	readonly raw?: string;
}

interface BabelNode {
	readonly type: string;
	readonly [key: string]: unknown;
}

function isNode(value: unknown): value is BabelNode {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function childNodes(node: BabelNode): BabelNode[] {
	const children: BabelNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const entry of value) if (isNode(entry)) children.push(entry);
			continue;
		}
		if (isNode(value)) children.push(value);
	}
	return children;
}

function walk(node: BabelNode, visit: (node: BabelNode) => void): void {
	visit(node);
	for (const child of childNodes(node)) walk(child, visit);
}

type ParserPlugins = NonNullable<NonNullable<Parameters<typeof parse>[1]>["plugins"]>;

/** Babel 8 parses import attributes by default; decorators and JSX still need plugins. */
function parseFile(filePath: string): BabelNode {
	const source = readFileSync(filePath, "utf8");
	const plugins: ParserPlugins = filePath.endsWith(".tsx")
		? ["typescript", "jsx", "decorators"]
		: ["typescript", "decorators"];
	// A parse failure must be loud: silently degrading to text matching is how the
	// createRequire reintroduction slipped through the previous scanner.
	return parse(source, { sourceType: "module", plugins, errorRecovery: false }) as unknown as BabelNode;
}

function stringLiteralValue(node: unknown): string | undefined {
	if (!isNode(node)) return undefined;
	if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
	if (node.type === "TemplateLiteral") {
		const expressions = node.expressions as unknown[] | undefined;
		const quasis = node.quasis as BabelNode[] | undefined;
		if ((expressions?.length ?? 0) === 0 && quasis?.length === 1) {
			const cooked = (quasis[0]?.value as { cooked?: string } | undefined)?.cooked;
			if (typeof cooked === "string") return cooked;
		}
	}
	return undefined;
}

function isTypeOnlyImport(node: BabelNode): boolean {
	if (node.importKind === "type") return true;
	const specifiers = (node.specifiers as BabelNode[] | undefined) ?? [];
	if (specifiers.length === 0) return false;
	return specifiers.every((specifier) => specifier.importKind === "type");
}

function isTypeOnlyExport(node: BabelNode): boolean {
	if (node.exportKind === "type") return true;
	const specifiers = (node.specifiers as BabelNode[] | undefined) ?? [];
	if (specifiers.length === 0) return false;
	return specifiers.every((specifier) => specifier.exportKind === "type");
}

function isIdentifier(node: unknown, name: string): boolean {
	return isNode(node) && node.type === "Identifier" && node.name === name;
}

function isMemberCallee(node: unknown, objectName: string, propertyName: string): boolean {
	if (!isNode(node) || node.type !== "MemberExpression") return false;
	return isIdentifier(node.object, objectName) && isIdentifier(node.property, propertyName);
}

/** `import.meta.resolve(...)` — a MetaProperty base rather than a plain identifier. */
function isImportMetaResolve(node: unknown): boolean {
	if (!isNode(node) || node.type !== "MemberExpression") return false;
	const object = node.object;
	if (!isNode(object) || object.type !== "MetaProperty") return false;
	return isIdentifier(node.property, "resolve");
}

/**
 * Local names bound to a `createRequire` factory, plus the names of require functions those
 * factories produce, including chained `const s = r` aliases resolved to a fixed point.
 */
function collectRequireNames(ast: BabelNode): { factories: Set<string>; requires: Set<string> } {
	const factories = new Set<string>(DEFAULT_REQUIRE_FACTORIES);
	const requires = new Set<string>(["require"]);

	walk(ast, (node) => {
		if (node.type !== "ImportDeclaration") return;
		const source = stringLiteralValue(node.source);
		if (source !== "module" && source !== "node:module") return;
		for (const specifier of (node.specifiers as BabelNode[] | undefined) ?? []) {
			if (specifier.type !== "ImportSpecifier") continue;
			const imported = specifier.imported;
			const local = specifier.local;
			if (isNode(imported) && imported.name === "createRequire" && isNode(local) && typeof local.name === "string") {
				factories.add(local.name);
			}
		}
	});

	// Repeat until stable so `const r = createRequire(...); const s = r;` resolves fully.
	let changed = true;
	while (changed) {
		changed = false;
		walk(ast, (node) => {
			if (node.type !== "VariableDeclarator") return;
			const id = node.id;
			if (!isNode(id) || id.type !== "Identifier" || typeof id.name !== "string") return;
			const init = node.init;
			if (!isNode(init)) return;

			const producesRequire =
				(init.type === "CallExpression" &&
					isNode(init.callee) &&
					((init.callee.type === "Identifier" && factories.has(String(init.callee.name))) ||
						isMemberCallee(init.callee, "module", "createRequire"))) ||
				(init.type === "Identifier" && requires.has(String(init.name)));

			if (producesRequire && !requires.has(id.name)) {
				requires.add(id.name);
				changed = true;
			}
		});
	}

	return { factories, requires };
}

/** Every runtime module request a file makes, with type-only edges already removed. */
export function runtimeRequestsOf(filePath: string): RuntimeRequest[] {
	const ast = parseFile(filePath);
	const { factories, requires } = collectRequireNames(ast);
	const requests: RuntimeRequest[] = [];

	const record = (kind: RuntimeRequest["kind"], argument: unknown): void => {
		const specifier = stringLiteralValue(argument);
		if (specifier !== undefined) {
			requests.push({ kind, specifier, importer: filePath });
			return;
		}
		requests.push({ kind, importer: filePath, raw: isNode(argument) ? argument.type : "unknown" });
	};

	walk(ast, (node) => {
		switch (node.type) {
			case "ImportDeclaration": {
				if (isTypeOnlyImport(node)) return;
				record("import", node.source);
				return;
			}
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration": {
				if (!isNode(node.source)) return;
				if (isTypeOnlyExport(node)) return;
				record("export-from", node.source);
				return;
			}
			case "TSImportEqualsDeclaration": {
				// Babel marks `import type X = require(...)` with importKind, not isTypeOnly.
				if (node.importKind === "type" || node.isTypeOnly === true) return;
				const reference = node.moduleReference;
				if (!isNode(reference) || reference.type !== "TSExternalModuleReference") return;
				record("import-equals", reference.expression);
				return;
			}
			case "ImportExpression": {
				record("dynamic-import", node.source);
				return;
			}
			case "CallExpression": {
				const callee = node.callee;
				const args = (node.arguments as unknown[] | undefined) ?? [];
				const first = args[0];

				if (isNode(callee) && callee.type === "Import") {
					record("dynamic-import", first);
					return;
				}
				if (isNode(callee) && callee.type === "Identifier" && requires.has(String(callee.name))) {
					record(String(callee.name) === "require" ? "require" : "created-require", first);
					return;
				}
				if (isNode(callee) && callee.type === "MemberExpression" && isIdentifier(callee.property, "resolve")) {
					if (
						isNode(callee.object) &&
						callee.object.type === "Identifier" &&
						requires.has(String(callee.object.name))
					) {
						record("require.resolve", first);
						return;
					}
				}
				if (isMemberCallee(callee, "process", "getBuiltinModule")) {
					record("process.getBuiltinModule", first);
					return;
				}
				if (isImportMetaResolve(callee)) {
					record("import.meta.resolve", first);
					return;
				}
				// `createRequire(import.meta.url)("pkg")` and `module.createRequire(...)("pkg")`.
				if (isNode(callee) && callee.type === "CallExpression") {
					const inner = callee.callee;
					const isFactory =
						(isNode(inner) && inner.type === "Identifier" && factories.has(String(inner.name))) ||
						isMemberCallee(inner, "module", "createRequire");
					if (isFactory) record("created-require", first);
				}
				return;
			}
			default:
				return;
		}
	});

	return requests;
}

export interface GraphViolation {
	readonly importer: string;
	readonly description: string;
}

export interface GraphWalk {
	readonly visited: string[];
	/** Requests that reach a package outside Node's builtins. */
	readonly externals: GraphViolation[];
	/** Relative requests that resolve to no file on disk. */
	readonly unresolved: GraphViolation[];
	/** Requests whose target cannot be known statically; these fail closed. */
	readonly dynamic: GraphViolation[];
}

function resolveRelative(importer: string, specifier: string): string | undefined {
	const base = resolve(dirname(importer), specifier);
	const candidates = [base.replace(/\.js$/u, ".ts"), `${base}.ts`, join(base, "index.ts"), base];
	return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(".ts"));
}

export function walkRuntimeGraph(entrypoint: string): GraphWalk {
	const visited = new Set<string>();
	const externals: GraphViolation[] = [];
	const unresolved: GraphViolation[] = [];
	const dynamic: GraphViolation[] = [];
	const queue = [entrypoint];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || visited.has(current)) continue;
		visited.add(current);

		for (const request of runtimeRequestsOf(current)) {
			if (request.specifier === undefined) {
				dynamic.push({
					importer: current,
					description: `${request.kind}(<${request.raw ?? "non-literal"}>)`,
				});
				continue;
			}
			const specifier = request.specifier;
			if (specifier.startsWith("node:") || nodeBuiltins.has(specifier)) continue;
			if (specifier.startsWith(".") || specifier.startsWith("/")) {
				const resolved = resolveRelative(current, specifier);
				if (resolved === undefined) {
					unresolved.push({ importer: current, description: specifier });
					continue;
				}
				queue.push(resolved);
				continue;
			}
			externals.push({ importer: current, description: specifier });
		}
	}

	return { visited: [...visited], externals, unresolved, dynamic };
}
