import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parse } from "@babel/parser";

/**
 * Runtime module-graph walker used to prove the intercom broker stays self-contained.
 *
 * A regex scanner over import syntax is not enough: `createRequire(import.meta.url)("pkg")`
 * loads a package at runtime and looks nothing like an import declaration. This parses each file
 * with Babel and tracks, scope by scope, which local names denote a module object, a `require`
 * factory, a require function, or a resolver, so every spelling of the same load is caught:
 *
 * ```ts
 * import * as moduleApi from "node:module";   // namespace alias
 * import mod from "node:module";              // default alias
 * import { createRequire as make } from "node:module";
 * module.createRequire(url)("pkg");           // free CJS module object
 * mod["createRequire"](url)("pkg");           // computed string property
 * const box = { createRequire }; box.createRequire(url)("pkg");
 * ```
 *
 * Scope matters in both directions: a local binding named `module` is *not* the CJS module
 * object and must not produce an edge, while an unbound `module` is.
 *
 * Where a target cannot be known statically the walker fails closed rather than passing:
 *
 * - a non-literal specifier (`require(name)`, `import(name)`) — `dynamic`;
 * - a non-literal computed property on a loader object (`moduleApi[key](...)`) — `dynamic`;
 * - a loader value escaping into unmodelled container flow (`makeBox(createRequire)`) or a
 *   re-export (`export { createRequire }`) — `dynamic`.
 *
 * `process[name](...)` is deliberately not flagged: the only loader on `process` is
 * `getBuiltinModule`, which can return nothing but a Node builtin.
 *
 * Static analysis still cannot see module requests built by `eval`, `new Function`, a native
 * addon, or generated source, and this walker does not propagate loader metadata across module
 * boundaries. Those need a reviewed exception rather than silent acceptance.
 */

const nodeBuiltins = new Set(builtinModules);

const MODULE_SPECIFIERS = new Set(["module", "node:module"]);

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
		| "import.meta.resolve"
		| "computed-loader-member"
		| "loader-escape"
		| "loader-reexport";
	readonly importer: string;
	/** Node type of a non-literal argument. */
	readonly raw?: string;
}

interface BabelNode {
	readonly type: string;
	readonly [key: string]: unknown;
}

/** What a local name denotes, as far as module loading is concerned. */
type LoaderKind = "module-object" | "factory" | "require" | "resolver" | "container" | "other";

interface Binding {
	readonly kind: LoaderKind;
	/** Property or index → kind, for object and array literals holding loader values. */
	readonly members?: Map<string, LoaderKind>;
}

interface Scope {
	readonly bindings: Map<string, Binding>;
	readonly parent?: Scope;
}

const LOADER_KINDS: ReadonlySet<LoaderKind> = new Set<LoaderKind>([
	"module-object",
	"factory",
	"require",
	"resolver",
	"container",
]);

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
	if (node.type === "NumericLiteral" && typeof node.value === "number") return String(node.value);
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

function identifierName(node: unknown): string | undefined {
	return isNode(node) && node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined;
}

/**
 * Property name of a member expression, for both `a.b` and `a["b"]` / `a[0]`.
 * Returns `undefined` for a computed non-literal property, which cannot be resolved statically.
 */
function memberPropertyName(node: BabelNode): string | undefined {
	if (node.computed === true) return stringLiteralValue(node.property);
	return identifierName(node.property);
}

function lookup(scope: Scope, name: string): Binding | undefined {
	for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
		const binding = current.bindings.get(name);
		if (binding !== undefined) return binding;
	}
	return undefined;
}

function childScope(parent: Scope): Scope {
	return { bindings: new Map(), parent };
}

function declarePattern(node: unknown, scope: Scope, kind: LoaderKind = "other"): void {
	if (!isNode(node)) return;
	const name = identifierName(node);
	if (name !== undefined) {
		scope.bindings.set(name, { kind });
		return;
	}
	// Destructuring binds several names; none of them are loader values we model.
	for (const child of childNodes(node)) declarePattern(child, scope, "other");
}

const SCOPE_NODE_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
	"BlockStatement",
	"CatchClause",
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"StaticBlock",
]);

/** Every runtime module request a file makes, with type-only edges already removed. */
export function runtimeRequestsOf(filePath: string): RuntimeRequest[] {
	const ast = parseFile(filePath);
	const requests: RuntimeRequest[] = [];

	const record = (kind: RuntimeRequest["kind"], argument?: unknown): void => {
		const specifier = stringLiteralValue(argument);
		if (specifier !== undefined) {
			requests.push({ kind, specifier, importer: filePath });
			return;
		}
		requests.push({ kind, importer: filePath, raw: isNode(argument) ? argument.type : undefined });
	};

	/** Nodes already reported as an unresolvable computed member, so they are reported once. */
	const flagged = new Set<BabelNode>();
	const resolutions = new Map<BabelNode, Binding | undefined>();

	/**
	 * What this expression denotes, when that is statically knowable. Records a violation for a
	 * computed non-literal property on something we know is a loader object. Memoized, so a node
	 * reached from several traversal positions still reports at most once.
	 */
	function resolveLoader(node: unknown, scope: Scope): Binding | undefined {
		if (!isNode(node)) return undefined;
		if (resolutions.has(node)) return resolutions.get(node);
		const result = computeLoader(node, scope);
		resolutions.set(node, result);
		return result;
	}

	function computeLoader(node: BabelNode, scope: Scope): Binding | undefined {
		if (node.type === "Identifier") {
			const name = String(node.name);
			const binding = lookup(scope, name);
			if (binding !== undefined) return binding;
			// Unbound: the CJS globals are the only names that matter here.
			if (name === "module") return { kind: "module-object" };
			if (name === "require") return { kind: "require" };
			return undefined;
		}

		if (node.type === "MemberExpression") {
			// `import.meta.resolve` has a MetaProperty base rather than an identifier.
			const object = node.object;
			if (isNode(object) && object.type === "MetaProperty") {
				return memberPropertyName(node) === "resolve" ? { kind: "resolver" } : undefined;
			}
			if (identifierName(object) === "process" && lookup(scope, "process") === undefined) {
				return memberPropertyName(node) === "getBuiltinModule" ? { kind: "resolver" } : undefined;
			}

			const base = resolveLoader(object, scope);
			if (base === undefined) return undefined;
			const property = memberPropertyName(node);
			if (property === undefined) {
				if (LOADER_KINDS.has(base.kind)) {
					record("computed-loader-member");
					flagged.add(node);
				}
				return undefined;
			}
			if (base.kind === "module-object") return property === "createRequire" ? { kind: "factory" } : undefined;
			if (base.kind === "require") return property === "resolve" ? { kind: "resolver" } : undefined;
			if (base.kind === "container") {
				const member = base.members?.get(property);
				return member === undefined ? undefined : { kind: member };
			}
			return undefined;
		}

		if (node.type === "CallExpression") {
			const callee = resolveLoader(node.callee, scope);
			return callee?.kind === "factory" ? { kind: "require" } : undefined;
		}

		if (node.type === "ObjectExpression") {
			const members = new Map<string, LoaderKind>();
			for (const property of (node.properties as BabelNode[] | undefined) ?? []) {
				if (property.type !== "ObjectProperty" || property.computed === true) continue;
				const key = identifierName(property.key) ?? stringLiteralValue(property.key);
				const value = resolveLoader(property.value, scope);
				if (key !== undefined && value !== undefined && LOADER_KINDS.has(value.kind)) members.set(key, value.kind);
			}
			return members.size > 0 ? { kind: "container", members } : undefined;
		}

		if (node.type === "ArrayExpression") {
			const members = new Map<string, LoaderKind>();
			const elements = (node.elements as (BabelNode | null)[] | undefined) ?? [];
			elements.forEach((element, index) => {
				const value = resolveLoader(element, scope);
				if (value !== undefined && LOADER_KINDS.has(value.kind)) members.set(String(index), value.kind);
			});
			return members.size > 0 ? { kind: "container", members } : undefined;
		}

		if (
			node.type === "TSAsExpression" ||
			node.type === "TSNonNullExpression" ||
			node.type === "ParenthesizedExpression"
		) {
			return resolveLoader(node.expression, scope);
		}

		return undefined;
	}

	/**
	 * Does this subtree hand a loader value back to a caller? An exported wrapper such as
	 * `export function make(u) { return createRequire(u); }` gives importers the same power as
	 * exporting the factory itself, so it has to fail closed too.
	 */
	function subtreeYieldsLoader(node: BabelNode, scope: Scope): boolean {
		let found = false;
		const scan = (current: BabelNode): void => {
			if (found) return;
			const returned =
				current.type === "ReturnStatement"
					? current.argument
					: current.type === "ArrowFunctionExpression" &&
							isNode(current.body) &&
							current.body.type !== "BlockStatement"
						? current.body
						: undefined;
			if (isNode(returned)) {
				const resolved = resolveLoader(returned, scope);
				if (resolved !== undefined && LOADER_KINDS.has(resolved.kind)) {
					found = true;
					return;
				}
			}
			for (const child of childNodes(current)) scan(child);
		};
		scan(node);
		return found;
	}

	/**
	 * An `export const make = createRequire` carries a loader across the module boundary just as
	 * `export { createRequire }` does, but Babel puts it in `declaration` with no specifiers, so
	 * the specifier scan alone missed it entirely.
	 */
	function recordExportedLoaders(declaration: BabelNode, scope: Scope): void {
		if (declaration.type === "VariableDeclaration") {
			for (const declarator of (declaration.declarations as BabelNode[] | undefined) ?? []) {
				const name = identifierName(declarator.id);
				if (name !== undefined) {
					const binding = lookup(scope, name);
					if (binding !== undefined && LOADER_KINDS.has(binding.kind)) {
						record("loader-reexport");
						continue;
					}
				}
				// A destructured loader export already reports through the generic escape path.
				if (isNode(declarator.init) && subtreeYieldsLoader(declarator.init, scope)) record("loader-reexport");
			}
			return;
		}
		if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
			if (subtreeYieldsLoader(declaration, scope)) record("loader-reexport");
		}
	}

	/** Records the load a call performs, if any. Returns true when the callee was consumed. */
	function classifyCall(node: BabelNode, scope: Scope): boolean {
		const callee = node.callee;
		const args = (node.arguments as unknown[] | undefined) ?? [];
		const first = args[0];

		if (isNode(callee) && callee.type === "Import") {
			record("dynamic-import", first);
			return true;
		}

		const resolved = resolveLoader(callee, scope);
		if (resolved === undefined) return false;
		switch (resolved.kind) {
			case "require":
				record(identifierName(callee) === "require" ? "require" : "created-require", first);
				return true;
			case "resolver": {
				const isBuiltinAccessor =
					isNode(callee) &&
					callee.type === "MemberExpression" &&
					memberPropertyName(callee) === "getBuiltinModule";
				record(isBuiltinAccessor ? "process.getBuiltinModule" : "require.resolve", first);
				return true;
			}
			case "factory":
				// Calling a factory yields a require function; the load happens on the next call.
				return true;
			default:
				return false;
		}
	}

	function visit(node: BabelNode, scope: Scope): void {
		switch (node.type) {
			case "ImportDeclaration": {
				const source = stringLiteralValue(node.source);
				const isModuleApi = source !== undefined && MODULE_SPECIFIERS.has(source);
				for (const specifier of (node.specifiers as BabelNode[] | undefined) ?? []) {
					const local = identifierName(specifier.local);
					if (local === undefined) continue;
					if (!isModuleApi || specifier.importKind === "type" || node.importKind === "type") {
						scope.bindings.set(local, { kind: "other" });
						continue;
					}
					if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") {
						scope.bindings.set(local, { kind: "module-object" });
						continue;
					}
					const imported = identifierName(specifier.imported) ?? stringLiteralValue(specifier.imported);
					if (imported === "createRequire") scope.bindings.set(local, { kind: "factory" });
					else if (imported === "default") scope.bindings.set(local, { kind: "module-object" });
					else scope.bindings.set(local, { kind: "other" });
				}
				if (!isTypeOnlyImport(node)) record("import", node.source);
				return;
			}
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration": {
				if (isNode(node.source)) {
					if (!isTypeOnlyExport(node)) {
						record("export-from", node.source);
						// Loader metadata is not propagated across module boundaries, so a re-exported
						// factory has to fail closed rather than silently disappear.
						const source = stringLiteralValue(node.source);
						if (source !== undefined && MODULE_SPECIFIERS.has(source)) {
							for (const specifier of (node.specifiers as BabelNode[] | undefined) ?? []) {
								const local = identifierName(specifier.local);
								if (local === "createRequire" || local === "default") record("loader-reexport");
							}
						}
					}
					return;
				}
				if (!isTypeOnlyExport(node)) {
					for (const specifier of (node.specifiers as BabelNode[] | undefined) ?? []) {
						const local = identifierName(specifier.local);
						if (local === undefined) continue;
						const binding = lookup(scope, local);
						if (binding !== undefined && LOADER_KINDS.has(binding.kind)) record("loader-reexport");
					}
				}
				if (isNode(node.declaration)) {
					// Visit first so the exported binders carry their resolved kinds, then report.
					visit(node.declaration, scope);
					if (!isTypeOnlyExport(node)) recordExportedLoaders(node.declaration, scope);
				}
				return;
			}
			case "ExportDefaultDeclaration": {
				const declaration = node.declaration;
				if (!isNode(declaration)) return;
				const resolved = resolveLoader(declaration, scope);
				if (resolved !== undefined && LOADER_KINDS.has(resolved.kind)) {
					// Returning here avoids a second record from the generic escape path.
					record("loader-reexport");
					return;
				}
				visit(declaration, scope);
				recordExportedLoaders(declaration, scope);
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
			case "VariableDeclarator": {
				const init = node.init;
				const resolved = isNode(init) ? resolveLoader(init, scope) : undefined;
				const name = identifierName(node.id);
				if (name !== undefined && resolved !== undefined && LOADER_KINDS.has(resolved.kind)) {
					scope.bindings.set(name, resolved);
					// The init is fully modelled; descending would report it as an escape.
					return;
				}
				declarePattern(node.id, scope, "other");
				if (isNode(init)) visit(init, scope);
				return;
			}
			case "CallExpression": {
				const consumed = classifyCall(node, scope);
				if (!consumed && isNode(node.callee)) visit(node.callee, scope);
				for (const argument of (node.arguments as unknown[] | undefined) ?? []) {
					if (isNode(argument)) visit(argument, scope);
				}
				return;
			}
			case "Identifier":
			case "MemberExpression": {
				// Reached outside every modelled position: a loader value is escaping into flow
				// this walker does not track, so fail closed instead of losing the edge.
				const resolved = resolveLoader(node, scope);
				if (resolved !== undefined && LOADER_KINDS.has(resolved.kind)) {
					record("loader-escape");
					return;
				}
				// Already reported as an unresolvable computed member; descending would double-count
				// the same construct through its own object expression.
				if (flagged.has(node)) return;
				for (const child of childNodes(node)) visit(child, scope);
				return;
			}
			default: {
				let next = scope;
				if (SCOPE_NODE_TYPES.has(node.type)) {
					next = childScope(scope);
					for (const parameter of (node.params as BabelNode[] | undefined) ?? []) declarePattern(parameter, next);
					if (node.type === "CatchClause") declarePattern(node.param, next);
					const id = identifierName(node.id);
					if (id !== undefined) next.bindings.set(id, { kind: "other" });
				}
				for (const child of childNodes(node)) visit(child, next);
				return;
			}
		}
	}

	const moduleScope: Scope = { bindings: new Map() };
	const program = ast.program;
	const body = (isNode(program) ? (program.body as BabelNode[] | undefined) : undefined) ?? [];
	// Hoist declared names first so a reference above its declaration is not read as a CJS global.
	for (const statement of body) {
		if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
			const name = identifierName(statement.id);
			if (name !== undefined) moduleScope.bindings.set(name, { kind: "other" });
		}
		if (statement.type === "VariableDeclaration") {
			for (const declarator of (statement.declarations as BabelNode[] | undefined) ?? []) {
				const name = identifierName(declarator.id);
				if (name !== undefined && !moduleScope.bindings.has(name))
					moduleScope.bindings.set(name, { kind: "other" });
			}
		}
	}
	for (const statement of body) visit(statement, moduleScope);

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
				dynamic.push({ importer: current, description: `${request.kind}(<${request.raw ?? "non-literal"}>)` });
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
