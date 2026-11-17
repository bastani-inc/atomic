/**
 * Builds a call graph of the shipped TypeScript sources with the TypeScript 7 compiler API, so that
 * `check-event-loop.ts` can walk it from the interactive entry points.
 *
 * Nodes are function bodies: functions, methods, constructors, accessors, arrow functions, function expressions,
 * class field initializers, static blocks, and each module's top-level code. An edge means the source may run the
 * target on the same turn of the event loop or schedule it later:
 *
 * - `call`: a call, `new`, tagged template or accessor resolved by the type checker to a declaration;
 * - `reference`: a function passed or stored as a value (a callback), resolved the same way;
 * - `dispatch`: an interface or base-class member call, to every class implementing or overriding that member;
 * - `closure`: a function or arrow created by the source, which may run it or hand it to code that does;
 * - `import`: a dynamic `import()` (running the module's top level) and a module's static imports.
 *
 * What the graph cannot see: calls through `any`, through a callback parameter (`listener(data)`), or through a
 * function kept in a collection. Callbacks are reached instead where they are created (`closure`) or registered
 * (the policy's sinks), which is what makes those calls visible to the check.
 */

import { isBuiltin } from "node:module";
import {
	type ArrowFunction,
	type CallExpression,
	type ClassDeclaration,
	type ClassExpression,
	type ConstructorDeclaration,
	type FunctionDeclaration,
	type FunctionExpression,
	type GetAccessorDeclaration,
	type InterfaceDeclaration,
	isBinaryExpression,
	isCallExpression,
	isClassDeclaration,
	isClassExpression,
	isIdentifier,
	isNewExpression,
	isNoSubstitutionTemplateLiteral,
	isPropertyAccessExpression,
	isStringLiteral,
	type MethodDeclaration,
	ModifierFlags,
	type Node,
	type SetAccessorDeclaration,
	type SourceFile,
	SyntaxKind,
	skipTrivia,
} from "typescript/unstable/ast";
import {
	type NodeHandle,
	type Project,
	SymbolFlags,
	type Symbol as TsSymbol,
	type Type as TsType,
} from "typescript/unstable/sync";
import {
	type BlockingApi,
	CLOCK_READS,
	classifyExternalDeclaration,
	classifyUnresolvedCallName,
} from "./blocking-apis.ts";

export type FunctionKind =
	| "module"
	| "function"
	| "method"
	| "constructor"
	| "getter"
	| "setter"
	| "arrow"
	| "function-expression"
	| "class-fields"
	| "static-block";

export type EdgeKind = "call" | "reference" | "dispatch" | "closure" | "import";

export interface BlockingUse {
	readonly line: number;
	readonly api: BlockingApi;
}

export interface RegexUse {
	readonly file?: string;
	readonly line: number;
	readonly pattern: string;
	readonly flags: string;
}

export interface GraphFunction {
	readonly id: number;
	/** Repository-relative path with forward slashes. */
	readonly file: string;
	/** 1-based line of the declaration. */
	readonly line: number;
	/** Qualified name, unique within its file: `Class.method`, `outer/inner`, `Class.method/stdin.on("data")`. */
	readonly name: string;
	readonly kind: FunctionKind;
	/** Declared `async`: a blocking call in it can become an `await` without changing its callers. */
	readonly isAsync: boolean;
	readonly edges: Map<number, EdgeKind>;
	readonly blocking: BlockingUse[];
	readonly regexes: RegexUse[];
}

/** A callback handed to a registration API (a sink), which calls it later from the event loop. */
export interface SinkRegistration {
	readonly registrar: number;
	readonly sink: string;
	readonly line: number;
	readonly callbacks: readonly number[];
	readonly continuation?: boolean;
}

/** A declaration that registers callbacks: what the callee of a call must resolve to. */
export interface SinkSpec {
	/** A suffix of the declaring file's path, such as `@types/node/events.d.ts`. */
	readonly file: string;
	/** The enclosing class or interface, when the declaration is a member. */
	readonly owner?: string;
	readonly names: readonly string[];
	/** Only calls whose first argument is one of these string literals register (event names). */
	readonly events?: readonly string[];
	readonly continuation?: boolean;
}

export interface CallGraph {
	readonly functions: readonly GraphFunction[];
	/**
	 * The functions that implement `member` of the class or interface `typeName` declared in `file`: its own and those
	 * of every class that extends or implements it.
	 */
	readonly implementationsOf: (file: string, typeName: string, member: string) => readonly number[];
	readonly sinkRegistrations: readonly SinkRegistration[];
	/** Each analyzed module's top-level node, by repository-relative path. */
	readonly modules: ReadonlyMap<string, number>;
	/** The repository-relative modules each module imports statically. */
	readonly staticImports: ReadonlyMap<string, ReadonlySet<string>>;
	readonly stats: CallGraphStats;
}

export interface CallGraphStats {
	files: number;
	functions: number;
	references: number;
	resolvedToFunction: number;
	resolvedExternal: number;
	unresolved: number;
	resolvedThroughType: number;
	resolvedThroughFlow: number;
	objectMembersTyped: number;
	dispatchTargets: number;
}

export interface CallGraphOptions {
	readonly repoRoot: string;
	/** Whether a repository-relative source path belongs to the analyzed code. */
	readonly isAnalyzedFile: (relativePath: string) => boolean;
	readonly sinks: readonly SinkSpec[];
	/**
	 * Calls whose callbacks never run while the user interacts, such as `process.on("exit")`: the callbacks get no
	 * closure edge from the function that registers them.
	 */
	readonly detachedCallbacks: readonly SinkSpec[];
}

type ReferenceRole = "call" | "new" | "value" | "accessor";

interface PendingReference {
	readonly container: number;
	readonly node: Node;
	readonly role: ReferenceRole;
	readonly line: number;
	readonly name: string;
}

/** What an expression may evaluate to, as far as functions go: closures it creates and references it makes. */
interface ValueSources {
	readonly functions: readonly number[];
	readonly references: readonly number[];
}

interface PendingCall {
	readonly container: number;
	readonly callee: number;
	readonly line: number;
	readonly argumentFunctions: readonly number[];
	readonly argumentReferences: readonly number[];
	readonly arguments: readonly ValueSources[];
	readonly firstArgument: string | undefined;
	readonly detached: boolean;
	readonly floating: boolean;
	readonly floatingChain: boolean;
}

interface RequiredExport {
	readonly specifier: string;
	readonly name: string | undefined;
}

interface ClassInfo {
	readonly key: string;
	readonly name: string;
	readonly constructors: number[];
	readonly fields: number;
	readonly members: Map<string, number[]>;
	readonly heritage: Array<{ readonly expression: Node; readonly extends: boolean }>;
	base: string | undefined;
}

interface InterfaceInfo {
	readonly key: string;
	readonly heritage: Node[];
	/** Declaration keys of the interface's own members, by name. */
	readonly members: Map<string, string[]>;
}

interface WalkContext {
	readonly file: SourceFileState;
	readonly container: number;
	readonly className: string | undefined;
	readonly classKey: string | undefined;
}

interface SourceFileState {
	readonly source: SourceFile;
	readonly relative: string;
	readonly path: string;
	readonly moduleId: number;
	readonly names: Map<string, number>;
}

const FUNCTION_KINDS = new Set<SyntaxKind>([
	SyntaxKind.FunctionDeclaration,
	SyntaxKind.MethodDeclaration,
	SyntaxKind.Constructor,
	SyntaxKind.GetAccessor,
	SyntaxKind.SetAccessor,
	SyntaxKind.ArrowFunction,
	SyntaxKind.FunctionExpression,
]);

const INITIALIZER_DECLARATIONS = new Set<SyntaxKind>([
	SyntaxKind.VariableDeclaration,
	SyntaxKind.PropertyDeclaration,
	SyntaxKind.PropertyAssignment,
	SyntaxKind.BindingElement,
	SyntaxKind.Parameter,
	SyntaxKind.ExportAssignment,
]);

const EXPRESSION_WRAPPERS = new Set<SyntaxKind>([
	SyntaxKind.ParenthesizedExpression,
	SyntaxKind.AsExpression,
	SyntaxKind.SatisfiesExpression,
	SyntaxKind.NonNullExpression,
	SyntaxKind.TypeAssertionExpression,
]);

const VALUE_OPERATORS = new Set<SyntaxKind>([
	SyntaxKind.EqualsToken,
	SyntaxKind.QuestionQuestionToken,
	SyntaxKind.BarBarToken,
	SyntaxKind.AmpersandAmpersandToken,
	SyntaxKind.QuestionQuestionEqualsToken,
	SyntaxKind.BarBarEqualsToken,
	SyntaxKind.AmpersandAmpersandEqualsToken,
	SyntaxKind.CommaToken,
]);

const RESOLVE_BATCH = 8_000;

/** Declarations that hold a value a function can flow into: parameters, variables and properties. */
const VALUE_LOCATIONS = new Set<SyntaxKind>([
	SyntaxKind.Parameter,
	SyntaxKind.VariableDeclaration,
	SyntaxKind.BindingElement,
	SyntaxKind.PropertyDeclaration,
	SyntaxKind.PropertySignature,
	SyntaxKind.PropertyAssignment,
]);

/** Handler properties (`onSubmit`, `onData`): assigning a function to one registers it for an event. */
const HANDLER_PROPERTY = /^on[A-Z]/;

function declarationKey(path: string, node: Node): string {
	return `${path}:${node.pos}:${node.end}:${node.kind}`;
}

function unwrapExpression(node: Node): Node {
	let current = node;
	while (EXPRESSION_WRAPPERS.has(current.kind)) current = (current as Node & { readonly expression: Node }).expression;
	return current;
}

function nameText(node: Node | undefined): string | undefined {
	if (node === undefined) return undefined;
	switch (node.kind) {
		case SyntaxKind.Identifier:
		case SyntaxKind.PrivateIdentifier:
		case SyntaxKind.StringLiteral:
		case SyntaxKind.NumericLiteral:
		case SyntaxKind.NoSubstitutionTemplateLiteral:
			return (node as Node & { readonly text: string }).text;
		case SyntaxKind.ComputedPropertyName:
			return "[computed]";
		default:
			return undefined;
	}
}

function memberName(node: Node): string | undefined {
	return nameText(memberNameNode(node));
}

function memberNameNode(node: Node): Node | undefined {
	return (node as Node & { readonly name?: Node }).name;
}

function isStatic(node: Node): boolean {
	const flags = (node as Node & { readonly modifierFlags?: number }).modifierFlags ?? 0;
	return (flags & ModifierFlags.Static) !== 0;
}

function stringArgument(node: Node | undefined): string | undefined {
	if (node === undefined) return undefined;
	if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

/** A dotted expression's text (`process.stdin.on`), or undefined for anything else. */
function dottedText(node: Node): string | undefined {
	const target = unwrapExpression(node);
	if (isIdentifier(target)) return target.text;
	if (target.kind === SyntaxKind.ThisKeyword) return "this";
	if (target.kind === SyntaxKind.SuperKeyword) return "super";
	if (isPropertyAccessExpression(target)) {
		const left = dottedText(target.expression);
		const right = nameText(target.name);
		return left !== undefined && right !== undefined ? `${left}.${right}` : undefined;
	}
	if (isCallExpression(target)) {
		const callee = dottedText(target.expression);
		return callee === undefined ? undefined : `${callee}()`;
	}
	return undefined;
}

function isFunctionLike(
	node: Node,
): node is
	| FunctionDeclaration
	| MethodDeclaration
	| ConstructorDeclaration
	| GetAccessorDeclaration
	| SetAccessorDeclaration
	| ArrowFunction
	| FunctionExpression {
	return FUNCTION_KINDS.has(node.kind);
}

function functionKind(node: Node): FunctionKind {
	switch (node.kind) {
		case SyntaxKind.FunctionDeclaration:
			return "function";
		case SyntaxKind.MethodDeclaration:
			return "method";
		case SyntaxKind.Constructor:
			return "constructor";
		case SyntaxKind.GetAccessor:
			return "getter";
		case SyntaxKind.SetAccessor:
			return "setter";
		case SyntaxKind.ArrowFunction:
			return "arrow";
		default:
			return "function-expression";
	}
}

/** Whether `node` sits where its value is used as a value: passed, stored, returned or assigned. */
function isValuePosition(node: Node): boolean {
	let child = node;
	let parent = node.parent as Node | undefined;
	while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) {
		child = parent;
		parent = parent.parent as Node | undefined;
	}
	if (parent === undefined) return false;
	switch (parent.kind) {
		case SyntaxKind.CallExpression:
		case SyntaxKind.NewExpression:
			return (parent as CallExpression).expression !== child;
		case SyntaxKind.VariableDeclaration:
		case SyntaxKind.PropertyDeclaration:
		case SyntaxKind.PropertyAssignment:
		case SyntaxKind.Parameter:
		case SyntaxKind.BindingElement:
			return (parent as Node & { readonly initializer?: Node }).initializer === child;
		case SyntaxKind.ReturnStatement:
		case SyntaxKind.ArrayLiteralExpression:
		case SyntaxKind.ExportAssignment:
		case SyntaxKind.SpreadElement:
		case SyntaxKind.YieldExpression:
		case SyntaxKind.AwaitExpression:
			return true;
		case SyntaxKind.ArrowFunction:
			return (parent as ArrowFunction).body === child;
		case SyntaxKind.ConditionalExpression:
			return (parent as Node & { readonly condition: Node }).condition !== child;
		case SyntaxKind.BinaryExpression: {
			if (!isBinaryExpression(parent)) return false;
			const operator = parent.operatorToken.kind;
			if (!VALUE_OPERATORS.has(operator)) return false;
			return operator === SyntaxKind.EqualsToken ? parent.right === child : true;
		}
		default:
			return false;
	}
}

function isFloating(node: Node): boolean {
	let parent = node.parent as Node | undefined;
	while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) parent = parent.parent as Node | undefined;
	return parent?.kind === SyntaxKind.VoidExpression || parent?.kind === SyntaxKind.ExpressionStatement;
}

function isFloatingChain(node: Node): boolean {
	let current = node;
	for (;;) {
		let parent = current.parent as Node | undefined;
		while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) parent = parent.parent as Node | undefined;
		const call = parent?.parent as Node | undefined;
		if (parent === undefined || !isPropertyAccessExpression(parent) || call === undefined || !isCallExpression(call))
			break;
		if (unwrapExpression(call.expression) !== parent) break;
		current = call;
	}
	return isFloating(current);
}

function classifyRequiredExport(required: RequiredExport, name: string): BlockingApi | undefined {
	const { specifier } = required;
	let path: string;
	if (specifier.startsWith("bun:")) path = `/node_modules/bun-types/${specifier.slice(4)}.d.ts`;
	else if (isBuiltin(specifier)) path = `/node_modules/@types/node/${specifier.replace(/^node:/, "")}.d.ts`;
	else path = `/node_modules/${specifier}/index.d.ts`;
	return classifyExternalDeclaration({ path, name, owner: undefined });
}

export class CallGraphBuilder {
	private readonly functions: GraphFunction[] = [];
	/** The function each function was created in, or -1 for module and class-level nodes. */
	private readonly lexicalParents: number[] = [];
	/** Functions assigned to a property or variable after its declaration: `x.onData = (d) => …`. */
	private readonly pendingAssignments: Array<{ readonly target: Node } & ValueSources> = [];
	/** Each function's parameter declarations, in order; the index of a rest parameter, if any. */
	private readonly functionParameters = new Map<number, { readonly keys: readonly string[]; readonly rest: number }>();
	/** Object literal properties whose value is a reference: `{ onData: handler }`. */
	private readonly pendingObjectValues: Array<{ readonly literal: Node; readonly name: string } & ValueSources> = [];
	/** Declaration keys of the parameters, variables and properties each reference resolved to. */
	private readonly referenceLocations: Array<readonly string[] | undefined> = [];
	/** Assignments resolved to the declarations they write. */
	private readonly assignmentFlows: Array<{ readonly into: readonly string[] } & ValueSources> = [];
	private readonly detachedFunctions = new Set<number>();
	/** References passed to a call whose callbacks only run as the process exits. */
	private readonly detachedReferences = new Set<number>();
	private readonly pendingNameChecks: number[] = [];
	/** References whose type names a declaration, so a name alone says nothing about them. */
	private readonly typedReferences = new Set<number>();
	private readonly objectValueFlows: Array<{ readonly into: readonly string[] } & ValueSources> = [];
	private readonly assignedFunctions = new Map<string, number[]>();
	private readonly pendingObjectMembers: Array<{
		readonly container: number;
		readonly id: number;
		readonly literal: Node;
		readonly name: string;
		readonly stored: boolean;
		readonly detached: boolean;
	}> = [];
	private readonly functionByDeclaration = new Map<string, number>();
	private readonly initializerFunctions = new Map<string, number[]>();
	private readonly classes = new Map<string, ClassInfo>();
	private readonly classByFieldsFunction = new Map<number, string>();
	private readonly interfaces = new Map<string, InterfaceInfo>();
	private readonly typeKeysByName = new Map<string, string>();
	private readonly modules = new Map<string, number>();
	private readonly modulePaths = new Map<string, string>();
	private readonly references: PendingReference[] = [];
	private readonly calls: PendingCall[] = [];
	private readonly accessorNames = new Set<string>();
	private readonly accessorCandidates: Array<{ container: number; node: Node; line: number; name: string }> = [];
	private readonly superCalls: Array<{ container: number; classKey: string }> = [];
	private readonly imports: Array<{ container: number; specifier: Node; dynamic: boolean; fromModule: string }> = [];
	private readonly shorthandValues: Array<{ container: number; node: Node; line: number }> = [];
	private readonly staticImports = new Map<string, Set<string>>();
	private readonly sinkRegistrations: SinkRegistration[] = [];
	private readonly typeFallbacks: number[] = [];
	private readonly assignedHandlers: Array<{
		readonly container: number;
		readonly sink: string;
		readonly line: number;
		readonly functions: readonly number[];
		readonly references: readonly number[];
	}> = [];
	private readonly functionNodes = new Map<number, Node>();
	private readonly prototypeInstalls: Array<{
		readonly path: string;
		readonly target: Node;
		readonly sources: readonly Node[];
	}> = [];
	private readonly propertyInstalls: Array<{
		readonly path: string;
		readonly target: Node;
		readonly name: string;
		readonly descriptor: Node;
	}> = [];
	private readonly accessorFunctions = new Map<string, number[]>();
	private readonly regexHolders = new Map<string, RegexUse[]>();
	private readonly regexHolderNames = new Set<string>();
	private readonly identifierNodes: Node[] = [];
	private readonly identifierContainers: number[] = [];
	private readonly requireCalls: Array<{
		readonly path: string;
		readonly call: Node;
		readonly callee: Node;
		readonly specifier: string;
	}> = [];
	private readonly requiredDeclarations = new Map<string, RequiredExport>();
	private readonly requiredMembers = new Map<Node, RequiredExport>();
	private readonly targetCache = new Map<string, readonly number[]>();
	private readonly externalCache = new Map<number, BlockingApi | null>();
	private readonly locationCache = new Map<string, readonly string[]>();
	private readonly aliasCache = new Map<number, TsSymbol>();
	private readonly subtypes = new Map<string, Set<string>>();
	private readonly stats: CallGraphStats = {
		files: 0,
		functions: 0,
		references: 0,
		resolvedToFunction: 0,
		resolvedExternal: 0,
		unresolved: 0,
		resolvedThroughType: 0,
		resolvedThroughFlow: 0,
		objectMembersTyped: 0,
		dispatchTargets: 0,
	};

	private readonly project: Project;
	private readonly options: CallGraphOptions;

	constructor(project: Project, options: CallGraphOptions) {
		this.project = project;
		this.options = options;
	}

	build(): CallGraph {
		const program = this.project.program;
		const sources: SourceFileState[] = [];
		for (const fileName of program.getSourceFileNames()) {
			const relative = this.relativePath(fileName);
			if (relative === undefined || !this.options.isAnalyzedFile(relative)) continue;
			const source = program.getSourceFile(fileName);
			if (source === undefined || source.isDeclarationFile) continue;
			const moduleId = this.addFunction(relative, 1, "<module>", "module");
			this.modules.set(relative, moduleId);
			this.modulePaths.set(source.path, relative);
			sources.push({ source, relative, path: source.path, moduleId, names: new Map() });
		}
		this.stats.files = sources.length;
		for (const file of sources) {
			const context: WalkContext = { file, container: file.moduleId, className: undefined, classKey: undefined };
			file.source.forEachChild((child) => this.visit(child, context));
		}
		for (const candidate of this.accessorCandidates) {
			if (this.accessorNames.has(candidate.name)) {
				this.references.push({ ...candidate, role: "accessor" });
			}
		}
		this.resolveHeritage();
		this.resolveObjectMembers();
		this.resolveInstalls();
		this.resolveRequires();
		this.resolveRegexHolders();
		this.resolveAssignments();
		this.resolveReferences();
		this.resolveShorthandValues();
		this.resolveSuperCalls();
		this.resolveImports();
		this.stats.functions = this.functions.length;
		return {
			functions: this.functions,
			implementationsOf: (file, typeName, member) => {
				const key = this.typeKeysByName.get(`${file}#${typeName}`);
				if (key === undefined) return [];
				const into = new Set<number>();
				this.addImplementations(key, member, into);
				for (const memberKey of this.interfaces.get(key)?.members.get(member) ?? []) {
					for (const id of this.assignedFunctions.get(memberKey) ?? []) into.add(id);
				}
				return [...into];
			},
			sinkRegistrations: this.sinkRegistrations,
			modules: this.modules,
			staticImports: this.staticImports,
			stats: this.stats,
		};
	}

	private relativePath(fileName: string): string | undefined {
		const normalized = fileName.replaceAll("\\", "/");
		const root = this.options.repoRoot.replaceAll("\\", "/").replace(/\/$/, "");
		if (!normalized.startsWith(`${root}/`)) return undefined;
		const relative = normalized.slice(root.length + 1);
		return relative.includes("/node_modules/") || relative.startsWith("node_modules/") ? undefined : relative;
	}

	private addFunction(
		file: string,
		line: number,
		name: string,
		kind: FunctionKind,
		lexicalParent = -1,
		isAsync = false,
	): number {
		const id = this.functions.length;
		this.lexicalParents.push(lexicalParent);
		this.functions.push({ id, file, line, name, kind, isAsync, edges: new Map(), blocking: [], regexes: [] });
		return id;
	}

	private addEdge(from: number, to: number, kind: EdgeKind): void {
		if (from === to) return;
		const edges = this.functions[from].edges;
		if (!edges.has(to) || kind === "call") edges.set(to, kind);
	}

	private lineOf(file: SourceFileState, node: Node): number {
		const start = skipTrivia(file.source.text, node.pos);
		return file.source.getLineAndCharacterOfPosition(start).line + 1;
	}

	private uniqueName(file: SourceFileState, name: string): string {
		const seen = file.names.get(name) ?? 0;
		file.names.set(name, seen + 1);
		return seen === 0 ? name : `${name}#${seen + 1}`;
	}

	private containerName(context: WalkContext): string {
		const container = this.functions[context.container];
		return container.kind === "module" ? "" : container.name;
	}

	/** The local name of a function expression or arrow function: what it is assigned to or passed to. */
	private closureName(node: Node): string {
		let parent = node.parent as Node | undefined;
		while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) parent = parent.parent as Node | undefined;
		const own = node.kind === SyntaxKind.FunctionExpression ? nameText((node as FunctionExpression).name) : undefined;
		if (own !== undefined) return own;
		if (parent === undefined) return "<anonymous>";
		switch (parent.kind) {
			case SyntaxKind.PropertyAssignment:
				return `${this.objectOwnerName(parent.parent as Node | undefined)}.${memberName(parent) ?? "<anonymous>"}`;
			case SyntaxKind.VariableDeclaration:
			case SyntaxKind.PropertyDeclaration:
				return memberName(parent) ?? "<anonymous>";
			case SyntaxKind.BinaryExpression:
				return isBinaryExpression(parent) ? (dottedText(parent.left) ?? "<assigned>") : "<anonymous>";
			case SyntaxKind.CallExpression:
			case SyntaxKind.NewExpression: {
				const call = parent as CallExpression;
				const callee = dottedText(call.expression) ?? "<call>";
				const event = stringArgument(call.arguments?.[0]);
				return event === undefined ? `${callee}()` : `${callee}(${JSON.stringify(event)})`;
			}
			case SyntaxKind.ReturnStatement:
				return "<returned>";
			default:
				return "<anonymous>";
		}
	}

	private visit(node: Node, context: WalkContext): void {
		if (isFunctionLike(node)) {
			this.visitFunction(node, context);
			return;
		}
		switch (node.kind) {
			case SyntaxKind.ClassDeclaration:
			case SyntaxKind.ClassExpression:
				this.visitClass(node as ClassDeclaration | ClassExpression, context);
				return;
			case SyntaxKind.InterfaceDeclaration:
				this.visitInterface(node as InterfaceDeclaration, context);
				return;
			case SyntaxKind.ImportDeclaration:
			case SyntaxKind.ExportDeclaration:
				this.visitModuleDeclaration(node, context);
				return;
			case SyntaxKind.TypeAliasDeclaration:
				return;
			case SyntaxKind.CallExpression:
				this.visitCall(node as CallExpression, context);
				return;
			case SyntaxKind.NewExpression:
				this.visitNew(node, context);
				return;
			case SyntaxKind.TaggedTemplateExpression:
				this.addReference(context, (node as Node & { readonly tag: Node }).tag, "call");
				break;
			case SyntaxKind.Identifier:
				this.identifierNodes.push(node);
				this.identifierContainers.push(context.container);
				if (isValuePosition(node)) this.addReference(context, node, "value");
				break;
			case SyntaxKind.ElementAccessExpression: {
				const argument = (node as Node & { readonly argumentExpression: Node }).argumentExpression;
				if (stringArgument(argument) !== undefined && isValuePosition(node)) {
					this.addReference(context, argument, "value");
				}
				break;
			}
			case SyntaxKind.PropertyAccessExpression:
				this.visitPropertyAccess(node, context);
				break;
			case SyntaxKind.BinaryExpression:
				if (this.visitAssignment(node, context)) return;
				break;
			case SyntaxKind.PropertyAssignment:
				if (this.visitObjectProperty(node, context)) return;
				break;
			case SyntaxKind.ShorthandPropertyAssignment:
				this.shorthandValues.push({ container: context.container, node, line: this.lineOf(context.file, node) });
				break;
			case SyntaxKind.RegularExpressionLiteral:
				this.recordRegexLiteral(node, context);
				break;
			case SyntaxKind.WhileStatement:
			case SyntaxKind.DoStatement:
			case SyntaxKind.ForStatement:
				this.checkBusyWait(node, context);
				break;
			default:
				break;
		}
		node.forEachChild((child) => this.visit(child, context));
	}

	private visitFunction(
		node:
			| FunctionDeclaration
			| MethodDeclaration
			| ConstructorDeclaration
			| GetAccessorDeclaration
			| SetAccessorDeclaration
			| ArrowFunction
			| FunctionExpression,
		context: WalkContext,
	): void {
		const kind = functionKind(node);
		const parent = node.parent as Node | undefined;
		const inClass = parent !== undefined && (isClassDeclaration(parent) || isClassExpression(parent));
		const inObject = parent !== undefined && parent.kind === SyntaxKind.ObjectLiteralExpression;
		let local: string;
		if (kind === "constructor") local = "constructor";
		else if (kind === "arrow" || kind === "function-expression") local = this.closureName(node);
		else local = memberName(node) ?? "default";
		if (kind === "getter") local = `get ${local}`;
		if (kind === "setter") local = `set ${local}`;
		const outer = this.containerName(context);
		let qualified: string;
		if (inClass && context.className !== undefined) qualified = `${context.className}.${local}`;
		else if (inObject) qualified = `${outer === "" ? "" : `${outer}/`}${this.objectOwnerName(parent)}.${local}`;
		else qualified = outer === "" ? local : `${outer}/${local}`;
		const name = this.uniqueName(context.file, qualified);
		const isAsync = ((node as Node & { readonly modifierFlags?: number }).modifierFlags ?? 0) & ModifierFlags.Async;
		const id = this.addFunction(
			context.file.relative,
			this.lineOf(context.file, node),
			name,
			kind,
			context.container,
			isAsync !== 0,
		);
		this.functionByDeclaration.set(declarationKey(context.file.path, node), id);
		this.functionNodes.set(id, node);
		const parameters = node.parameters ?? [];
		this.functionParameters.set(id, {
			keys: parameters.map((parameter) => declarationKey(context.file.path, parameter)),
			rest: parameters.findIndex((parameter) => parameter.dotDotDotToken !== undefined),
		});
		if (this.isDetachedCallback(node)) this.detachedFunctions.add(id);

		if (kind === "getter" || kind === "setter") {
			const accessor = memberName(node);
			if (accessor !== undefined) this.accessorNames.add(accessor);
		}
		if (inClass && context.classKey !== undefined) {
			const info = this.classes.get(context.classKey);
			if (info !== undefined) {
				if (kind === "constructor") {
					info.constructors.push(id);
					this.addEdge(id, info.fields, "call");
				} else {
					const member = memberName(node);
					if (member !== undefined) {
						const list = info.members.get(member) ?? [];
						list.push(id);
						info.members.set(member, list);
					}
				}
			}
		} else if (inObject || kind === "arrow" || kind === "function-expression") {
			const stored = this.bindToDeclarations(node, id, context);
			const objectMember = this.objectMemberOf(node);
			if (objectMember !== undefined) {
				this.pendingObjectMembers.push({
					container: context.container,
					id,
					literal: objectMember.literal,
					name: objectMember.name,
					stored,
					detached: this.isDetachedCallback(node),
				});
			} else if (!stored && !this.isDetachedCallback(node)) {
				this.addEdge(context.container, id, "closure");
			}
			const member = inObject ? memberName(node) : undefined;
			if (member !== undefined && HANDLER_PROPERTY.test(member)) {
				this.assignedHandlers.push({
					container: context.container,
					sink: `{ ${member}() }`,
					line: this.lineOf(context.file, node),
					functions: [id],
					references: [],
				});
			}
		}
		if (kind === "function") this.bindToDeclarations(node, id, context);

		const inner: WalkContext = { ...context, container: id };
		node.forEachChild((child) => this.visit(child, inner));
	}

	/** The object literal and property a function is the value of: `{ m() {} }` or `{ m: () => … }`. */
	private objectMemberOf(node: Node): { literal: Node; name: string } | undefined {
		let parent = node.parent as Node | undefined;
		if (parent?.kind === SyntaxKind.ObjectLiteralExpression) {
			const name = memberName(node);
			return name === undefined ? undefined : { literal: parent, name };
		}
		while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) parent = parent.parent as Node | undefined;
		if (parent?.kind !== SyntaxKind.PropertyAssignment) return undefined;
		const literal = parent.parent as Node | undefined;
		const name = memberName(parent);
		if (literal?.kind !== SyntaxKind.ObjectLiteralExpression || name === undefined) return undefined;
		return { literal, name };
	}

	/**
	 * An object literal's methods implement the members of the type the literal is checked against (a `Component`,
	 * a `ToolDefinition`, an options type): calls through that type reach them. A method the walk cannot attach to a
	 * declared member, of a literal that is not simply stored, gets a closure edge from its creator instead.
	 */
	private resolveObjectMembers(): void {
		this.resolveObjectValues();
		const byLiteral = new Map<Node, Array<(typeof this.pendingObjectMembers)[number]>>();
		for (const member of this.pendingObjectMembers) {
			const list = byLiteral.get(member.literal) ?? [];
			list.push(member);
			byLiteral.set(member.literal, list);
		}
		const checker = this.project.checker;
		for (const [literal, members] of byLiteral) {
			let type: ReturnType<typeof checker.getContextualType>;
			try {
				type = checker.getContextualType(literal as Parameters<typeof checker.getContextualType>[0]);
			} catch {
				type = undefined;
			}
			for (const member of members) {
				let attached = false;
				if (type !== undefined) {
					let property: TsSymbol | undefined;
					try {
						property = checker.getPropertyOfType(type, member.name);
					} catch {
						property = undefined;
					}
					for (const handle of property?.declarations ?? []) {
						if (!this.modulePaths.has(handle.path)) continue;
						const declaration = this.resolveHandle(handle);
						if (declaration === undefined) continue;
						const key = declarationKey(handle.path, declaration);
						if (this.functionByDeclaration.get(key) === member.id) continue;
						const list = this.assignedFunctions.get(key) ?? [];
						list.push(member.id);
						this.assignedFunctions.set(key, list);
						attached = true;
						this.stats.objectMembersTyped++;
					}
				}
				if (!attached && !member.stored && !member.detached) this.addEdge(member.container, member.id, "closure");
			}
		}
	}

	/** `{ name: reference }`: the reference flows into the property the literal is checked against. */
	private resolveObjectValues(): void {
		const checker = this.project.checker;
		const types = new Map<Node, ReturnType<typeof checker.getContextualType>>();
		for (const value of this.pendingObjectValues) {
			if (!types.has(value.literal)) {
				try {
					types.set(
						value.literal,
						checker.getContextualType(value.literal as Parameters<typeof checker.getContextualType>[0]),
					);
				} catch {
					types.set(value.literal, undefined);
				}
			}
			const type = types.get(value.literal);
			if (type === undefined) continue;
			let property: TsSymbol | undefined;
			try {
				property = checker.getPropertyOfType(type, value.name);
			} catch {
				property = undefined;
			}
			const into: string[] = [];
			for (const handle of property?.declarations ?? []) {
				if (!this.modulePaths.has(handle.path)) continue;
				const declaration = this.resolveHandle(handle);
				if (declaration !== undefined) into.push(declarationKey(handle.path, declaration));
			}
			if (into.length > 0)
				this.objectValueFlows.push({ into, functions: value.functions, references: value.references });
		}
	}

	/** The name of whatever holds an object literal, for naming its methods. */
	private objectOwnerName(objectLiteral: Node | undefined): string {
		const parent = objectLiteral?.parent as Node | undefined;
		if (parent === undefined) return "<object>";
		if (parent.kind === SyntaxKind.VariableDeclaration || parent.kind === SyntaxKind.PropertyAssignment) {
			return memberName(parent) ?? "<object>";
		}
		if (parent.kind === SyntaxKind.ReturnStatement) return "<returned>";
		if (parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) {
			return `${dottedText((parent as CallExpression).expression) ?? "<call>"}()`;
		}
		return "<object>";
	}

	private recordInitializer(key: string, id: number): void {
		const list = this.initializerFunctions.get(key) ?? [];
		list.push(id);
		this.initializerFunctions.set(key, list);
	}

	/**
	 * Records `id` under each declaration whose value it becomes: a variable, field, parameter default, object property
	 * (also under every enclosing property and the variable holding the object), or an assigned property. Returns
	 * whether the function is only stored there, so its creator does not run it: such a function is reached through
	 * references to what holds it. A function passed to a call on the way may be run by that call, so it is not
	 * only stored.
	 */
	private bindToDeclarations(node: Node, id: number, context: WalkContext): boolean {
		const path = context.file.path;
		let child = node;
		let parent = node.parent as Node | undefined;
		let passedToCall = false;
		while (parent !== undefined) {
			const kind = parent.kind;
			if (kind === SyntaxKind.ExportAssignment) {
				this.recordInitializer(declarationKey(path, parent), id);
				return !passedToCall;
			}
			if (INITIALIZER_DECLARATIONS.has(kind)) {
				if ((parent as Node & { readonly initializer?: Node }).initializer !== child) return false;
				this.recordInitializer(declarationKey(path, parent), id);
				if (kind !== SyntaxKind.PropertyAssignment) return !passedToCall;
			} else if (kind === SyntaxKind.BinaryExpression && isBinaryExpression(parent)) {
				const operator = parent.operatorToken.kind;
				if (operator === SyntaxKind.EqualsToken) {
					if (parent.right !== child) return false;
					const target = unwrapExpression(parent.left);
					if (!isIdentifier(target) && !isPropertyAccessExpression(target)) return false;
					return !passedToCall;
				}
				if (!VALUE_OPERATORS.has(operator)) return false;
			} else if (kind === SyntaxKind.CallExpression || kind === SyntaxKind.NewExpression) {
				if ((parent as CallExpression).expression === child) return false;
				passedToCall = true;
			} else if (kind === SyntaxKind.ConditionalExpression) {
				if ((parent as Node & { readonly condition: Node }).condition === child) return false;
			} else if (
				!EXPRESSION_WRAPPERS.has(kind) &&
				kind !== SyntaxKind.ObjectLiteralExpression &&
				kind !== SyntaxKind.ArrayLiteralExpression &&
				kind !== SyntaxKind.SpreadElement &&
				kind !== SyntaxKind.SpreadAssignment
			) {
				return false;
			}
			child = parent;
			parent = parent.parent as Node | undefined;
		}
		return false;
	}

	private isDetachedCallback(node: Node): boolean {
		let parent = node.parent as Node | undefined;
		while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) parent = parent.parent as Node | undefined;
		return parent !== undefined && isCallExpression(parent) && this.isDetachedCall(parent);
	}

	/** A call whose callbacks only run as the process exits, such as `process.on("exit", …)`. */
	private isDetachedCall(call: Node): boolean {
		if (!isCallExpression(call)) return false;
		const callee = dottedText(call.expression);
		if (callee === undefined) return false;
		const event = stringArgument(call.arguments[0]);
		return this.options.detachedCallbacks.some((spec) => {
			const method = callee.slice(callee.lastIndexOf(".") + 1);
			const owner = callee.includes(".") ? callee.slice(0, callee.lastIndexOf(".")) : undefined;
			if (!spec.names.includes(method)) return false;
			if (spec.owner !== undefined && owner !== spec.owner) return false;
			return spec.events === undefined || (event !== undefined && spec.events.includes(event));
		});
	}

	private visitClass(node: ClassDeclaration | ClassExpression, context: WalkContext): void {
		const key = declarationKey(context.file.path, node);
		const outer = this.containerName(context);
		const own =
			nameText(node.name) ?? (node.kind === SyntaxKind.ClassExpression ? this.closureName(node) : "default");
		const className = outer === "" ? own : `${outer}/${own}`;
		const fields = this.addFunction(
			context.file.relative,
			this.lineOf(context.file, node),
			this.uniqueName(context.file, `${className}.<fields>`),
			"class-fields",
		);
		const info: ClassInfo = {
			key,
			name: className,
			constructors: [],
			fields,
			members: new Map(),
			heritage: [],
			base: undefined,
		};
		this.classes.set(key, info);
		this.typeKeysByName.set(`${context.file.relative}#${className}`, key);
		this.classByFieldsFunction.set(fields, key);
		if (node.kind === SyntaxKind.ClassExpression && !this.bindToDeclarations(node, fields, context)) {
			this.addEdge(context.container, fields, "closure");
		}
		for (const clause of node.heritageClauses ?? []) {
			for (const type of clause.types) {
				info.heritage.push({ expression: type.expression, extends: clause.token === SyntaxKind.ExtendsKeyword });
				this.visit(type.expression, context);
			}
		}
		const classContext: WalkContext = { ...context, className, classKey: key };
		for (const member of node.members) {
			if (isFunctionLike(member)) {
				this.visitFunction(member, classContext);
			} else if (member.kind === SyntaxKind.PropertyDeclaration) {
				const container = isStatic(member) ? context.container : fields;
				const fieldContext: WalkContext = { ...classContext, container };
				const property = memberName(member);
				const initializer = (member as Node & { readonly initializer?: Node }).initializer;
				if (initializer !== undefined) this.visit(initializer, fieldContext);
				if (property !== undefined) {
					const functionsInInitializer = this.initializerFunctions.get(declarationKey(context.file.path, member));
					if (functionsInInitializer !== undefined) {
						const list = info.members.get(property) ?? [];
						list.push(...functionsInInitializer);
						info.members.set(property, list);
					}
				}
			} else if (member.kind === SyntaxKind.ClassStaticBlockDeclaration) {
				const block = this.addFunction(
					context.file.relative,
					this.lineOf(context.file, member),
					this.uniqueName(context.file, `${className}.<static>`),
					"static-block",
				);
				this.addEdge(context.container, block, "closure");
				member.forEachChild((child) => this.visit(child, { ...classContext, container: block }));
			}
		}
	}

	private visitInterface(node: InterfaceDeclaration, context: WalkContext): void {
		const key = declarationKey(context.file.path, node);
		const heritage: Node[] = [];
		for (const clause of node.heritageClauses ?? []) {
			for (const type of clause.types) heritage.push(type.expression);
		}
		const members = new Map<string, string[]>();
		for (const member of node.members) {
			const name = memberName(member);
			if (name === undefined) continue;
			const list = members.get(name) ?? [];
			list.push(declarationKey(context.file.path, member));
			members.set(name, list);
		}
		this.interfaces.set(key, { key, heritage, members });
		const name = nameText(node.name);
		if (name !== undefined) this.typeKeysByName.set(`${context.file.relative}#${name}`, key);
	}

	private visitModuleDeclaration(node: Node, context: WalkContext): void {
		if (node.kind === SyntaxKind.ImportDeclaration) {
			const declaration = node as Node & {
				readonly importClause?: Node & { readonly phaseModifier?: SyntaxKind };
				readonly moduleSpecifier: Node;
			};
			if (declaration.importClause?.phaseModifier === SyntaxKind.TypeKeyword) return;
			this.imports.push({
				container: context.container,
				specifier: declaration.moduleSpecifier,
				dynamic: false,
				fromModule: context.file.relative,
			});
			return;
		}
		const declaration = node as Node & { readonly isTypeOnly: boolean; readonly moduleSpecifier?: Node };
		if (declaration.isTypeOnly || declaration.moduleSpecifier === undefined) return;
		this.imports.push({
			container: context.container,
			specifier: declaration.moduleSpecifier,
			dynamic: false,
			fromModule: context.file.relative,
		});
	}

	private visitCall(node: CallExpression, context: WalkContext): void {
		const callee = unwrapExpression(node.expression);
		if (callee.kind === SyntaxKind.ImportKeyword) {
			const specifier = node.arguments[0];
			if (specifier !== undefined && stringArgument(specifier) !== undefined) {
				this.imports.push({
					container: context.container,
					specifier,
					dynamic: true,
					fromModule: context.file.relative,
				});
			}
			return;
		}
		if (callee.kind === SyntaxKind.SuperKeyword) {
			if (context.classKey !== undefined)
				this.superCalls.push({ container: context.container, classKey: context.classKey });
			return;
		}
		if (isIdentifier(callee) && callee.text === "RegExp") this.recordRegexConstructor(node, context);
		const dotted = dottedText(callee);
		if (dotted === "Object.assign") this.recordPrototypeInstall(node, context);
		if (dotted === "Object.defineProperties" || dotted === "Object.defineProperty") {
			this.recordPropertyInstalls(node, dotted, context);
		}
		const specifier = stringArgument(node.arguments[0]);
		if (
			specifier !== undefined &&
			(isIdentifier(callee) || isCallExpression(callee) || isPropertyAccessExpression(callee))
		) {
			this.requireCalls.push({ path: context.file.path, call: node, callee, specifier });
		}
		let calleeReference: number | undefined;
		if (isIdentifier(callee)) {
			calleeReference = this.addReference(context, callee, "call");
		} else if (
			callee.kind === SyntaxKind.ElementAccessExpression &&
			stringArgument((callee as Node & { readonly argumentExpression: Node }).argumentExpression) !== undefined
		) {
			const access = callee as Node & { readonly expression: Node; readonly argumentExpression: Node };
			calleeReference = this.addReference(context, access.argumentExpression, "call");
			this.visit(access.expression, context);
		} else if (isPropertyAccessExpression(callee)) {
			calleeReference = this.addReference(context, callee.name, "call");
			const method = nameText(callee.name);
			if (method === "call" || method === "apply" || method === "bind") {
				const target = unwrapExpression(callee.expression);
				if (isIdentifier(target)) this.addReference(context, target, "call");
				else if (isPropertyAccessExpression(target)) this.addReference(context, target.name, "call");
			}
			this.visit(callee.expression, context);
		} else {
			const created = this.captureCreated(context, () => this.visit(callee, context));
			const detachedAsync = created.functions.filter((id) => this.functions[id].isAsync);
			if (isFloating(node) && detachedAsync.length > 0) {
				this.sinkRegistrations.push({
					registrar: context.container,
					sink: "detached async call",
					line: this.lineOf(context.file, node),
					callbacks: detachedAsync,
					continuation: true,
				});
			}
		}
		this.recordCall(node, calleeReference, context);
	}

	private recordPrototypeInstall(node: CallExpression, context: WalkContext): void {
		const [target, ...sources] = node.arguments;
		if (target === undefined || sources.length === 0) return;
		const unwrapped = unwrapExpression(target);
		if (!isPropertyAccessExpression(unwrapped) || nameText(unwrapped.name) !== "prototype") return;
		this.prototypeInstalls.push({ path: context.file.path, target, sources });
	}

	private recordPropertyInstalls(node: CallExpression, method: string, context: WalkContext): void {
		const target = node.arguments[0];
		if (target === undefined) return;
		const install = (name: string | undefined, descriptor: Node | undefined) => {
			if (name === undefined || descriptor === undefined) return;
			const literal = unwrapExpression(descriptor);
			if (literal.kind !== SyntaxKind.ObjectLiteralExpression) return;
			this.propertyInstalls.push({ path: context.file.path, target, name, descriptor: literal });
			this.accessorNames.add(name);
		};
		if (method === "Object.defineProperty") {
			install(stringArgument(node.arguments[1]), node.arguments[2]);
			return;
		}
		const properties = node.arguments[1] === undefined ? undefined : unwrapExpression(node.arguments[1]);
		if (properties?.kind !== SyntaxKind.ObjectLiteralExpression) return;
		for (const property of (properties as Node & { readonly properties: readonly Node[] }).properties) {
			if (property.kind !== SyntaxKind.PropertyAssignment) continue;
			install(memberName(property), (property as Node & { readonly initializer?: Node }).initializer);
		}
	}

	private recordCall(
		node: Node & { readonly arguments?: readonly Node[] },
		callee: number | undefined,
		context: WalkContext,
	): void {
		const sources = (node.arguments ?? []).map((argument) =>
			this.captureCreated(context, () => this.visit(argument, context)),
		);
		const detached = this.isDetachedCall(node);
		if (detached)
			for (const source of sources) for (const index of source.references) this.detachedReferences.add(index);
		if (callee === undefined) return;
		this.calls.push({
			floating: isFloating(node),
			floatingChain: isFloatingChain(node),
			container: context.container,
			callee,
			line: this.lineOf(context.file, node),
			argumentFunctions: sources.flatMap((source) => source.functions),
			argumentReferences: sources.flatMap((source) => source.references),
			arguments: sources,
			firstArgument: stringArgument(node.arguments?.[0]),
			detached,
		});
	}

	/** Visits `visitInner` and returns the closures and value references it created in the current container. */
	private captureCreated(context: WalkContext, visitInner: () => void): { functions: number[]; references: number[] } {
		const firstReference = this.references.length;
		const firstFunction = this.functions.length;
		visitInner();
		const functions: number[] = [];
		for (let id = firstFunction; id < this.functions.length; id++) {
			if (this.lexicalParents[id] === context.container) functions.push(id);
		}
		const references: number[] = [];
		for (let index = firstReference; index < this.references.length; index++) {
			const reference = this.references[index];
			if (reference.role === "value" && reference.container === context.container) references.push(index);
		}
		return { functions, references };
	}

	/**
	 * `x.handler = value` and `variable = value`: functions the value may be flow into the declaration written, and a
	 * function assigned to a handler property (`x.onSubmit = …`) is registered to run when `x` reports the event.
	 */
	private visitAssignment(node: Node, context: WalkContext): boolean {
		if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken) return false;
		const left = unwrapExpression(node.left);
		if (!isPropertyAccessExpression(left) && !isIdentifier(left)) return false;
		if (isPropertyAccessExpression(left)) this.visit(left.expression, context);
		const created = this.captureCreated(context, () => this.visit(node.right, context));
		this.pendingAssignments.push({ target: isPropertyAccessExpression(left) ? left.name : left, ...created });
		const property = isPropertyAccessExpression(left) ? nameText(left.name) : undefined;
		if (property !== undefined && HANDLER_PROPERTY.test(property)) {
			this.assignedHandlers.push({
				container: context.container,
				sink: `.${property} =`,
				line: this.lineOf(context.file, node),
				...created,
			});
		}
		return true;
	}

	/**
	 * `{ name: value }`: a referenced function flows into the property the literal is checked against, and an options
	 * object's handler (`{ onSubmit: handler }`) is registered to run when the receiver reports the event.
	 */
	private visitObjectProperty(node: Node, context: WalkContext): boolean {
		const property = memberName(node);
		const initializer = (node as Node & { readonly initializer?: Node }).initializer;
		const literal = node.parent as Node | undefined;
		if (property === undefined || initializer === undefined) return false;
		const created = this.captureCreated(context, () => this.visit(initializer, context));
		if (literal?.kind === SyntaxKind.ObjectLiteralExpression && created.references.length > 0) {
			this.pendingObjectValues.push({ literal, name: property, functions: [], references: created.references });
		}
		if (!HANDLER_PROPERTY.test(property)) return true;
		this.assignedHandlers.push({
			container: context.container,
			sink: `{ ${property} }`,
			line: this.lineOf(context.file, node),
			...created,
		});
		return true;
	}

	private visitNew(node: Node, context: WalkContext): void {
		const expression = (node as Node & { readonly expression: Node }).expression;
		const callee = unwrapExpression(expression);
		let reference: number | undefined;
		if (isIdentifier(callee)) {
			if (callee.text === "RegExp") this.recordRegexConstructor(node as CallExpression, context);
			reference = this.addReference(context, callee, "new");
		} else if (isPropertyAccessExpression(callee)) {
			reference = this.addReference(context, callee.name, "new");
			this.visit(callee.expression, context);
		} else {
			this.visit(expression, context);
		}
		this.recordCall(node as Node & { readonly arguments?: readonly Node[] }, reference, context);
	}

	private visitPropertyAccess(node: Node, context: WalkContext): void {
		if (!isPropertyAccessExpression(node)) return;
		const parent = node.parent as Node | undefined;
		const isCallee =
			parent !== undefined &&
			(isCallExpression(parent) || isNewExpression(parent)) &&
			unwrapExpression(parent.expression) === node;
		if (isCallee) return;
		const name = nameText(node.name);
		if (name === undefined) return;
		if (isValuePosition(node)) {
			this.addReference(context, node.name, "value");
			return;
		}
		this.accessorCandidates.push({
			container: context.container,
			node: node.name,
			line: this.lineOf(context.file, node),
			name,
		});
	}

	private addReference(context: WalkContext, node: Node, role: ReferenceRole): number | undefined {
		const target = unwrapExpression(node);
		const name =
			isIdentifier(target) || target.kind === SyntaxKind.PrivateIdentifier || stringArgument(target) !== undefined
				? nameText(target)
				: undefined;
		const resolvable = isPropertyAccessExpression(target) ? target.name : target;
		if (name === undefined && !isPropertyAccessExpression(target)) return undefined;
		this.references.push({
			container: context.container,
			node: resolvable,
			role,
			line: this.lineOf(context.file, node),
			name: name ?? nameText(resolvable) ?? "",
		});
		return this.references.length - 1;
	}

	private recordRegexLiteral(node: Node, context: WalkContext): void {
		const text = (node as Node & { readonly text: string }).text;
		const close = text.lastIndexOf("/");
		if (!text.startsWith("/") || close <= 0) return;
		this.recordRegex(node, context, text.slice(1, close), text.slice(close + 1));
	}

	private recordRegexConstructor(node: CallExpression, context: WalkContext): void {
		const pattern = stringArgument(node.arguments?.[0]);
		if (pattern === undefined) return;
		this.recordRegex(node, context, pattern, stringArgument(node.arguments?.[1]) ?? "");
	}

	private recordRegex(node: Node, context: WalkContext, pattern: string, flags: string): void {
		const use: RegexUse = { file: context.file.relative, line: this.lineOf(context.file, node), pattern, flags };
		this.functions[context.container].regexes.push(use);
		if (this.functions[context.container].kind !== "module") return;
		for (
			let parent = node.parent as Node | undefined;
			parent !== undefined;
			parent = parent.parent as Node | undefined
		) {
			if (isFunctionLike(parent) || parent.kind === SyntaxKind.ClassStaticBlockDeclaration) return;
			if (
				parent.kind !== SyntaxKind.VariableDeclaration &&
				parent.kind !== SyntaxKind.PropertyDeclaration &&
				parent.kind !== SyntaxKind.PropertyAssignment
			)
				continue;
			const name = memberName(parent);
			if (name === undefined) continue;
			const key = declarationKey(context.file.path, parent);
			const list = this.regexHolders.get(key) ?? [];
			list.push(use);
			this.regexHolders.set(key, list);
			this.regexHolderNames.add(name);
		}
	}

	/**
	 * A loop that only reads a clock until it says stop: it holds the thread for the whole wait. A loop that also
	 * does work, or awaits, is not one.
	 */
	private checkBusyWait(loop: Node, context: WalkContext): void {
		let readsClock = false;
		let doesOtherWork = false;
		const scan = (node: Node): void => {
			if (doesOtherWork || isFunctionLike(node)) return;
			if (node.kind === SyntaxKind.AwaitExpression || node.kind === SyntaxKind.YieldExpression) {
				doesOtherWork = true;
				return;
			}
			if (isCallExpression(node)) {
				const callee = dottedText(node.expression)?.replace(/^globalThis\./, "");
				if (callee !== undefined && CLOCK_READS.has(callee)) readsClock = true;
				else doesOtherWork = true;
			}
			if (isNewExpression(node)) {
				const callee = dottedText(node.expression);
				if (callee === "Date") readsClock = true;
				else doesOtherWork = true;
			}
			node.forEachChild(scan);
		};
		loop.forEachChild(scan);
		if (readsClock && !doesOtherWork) {
			this.functions[context.container].blocking.push({
				line: this.lineOf(context.file, loop),
				api: { category: "busy-wait", label: "loop polling a clock" },
			});
		}
	}

	private aliased(symbol: TsSymbol): TsSymbol {
		if ((symbol.flags & SymbolFlags.Alias) === 0) return symbol;
		const cached = this.aliasCache.get(symbol.id);
		if (cached !== undefined) return cached;
		let resolved = symbol;
		try {
			resolved = this.project.checker.getAliasedSymbol(symbol);
		} catch {
			resolved = symbol;
		}
		this.aliasCache.set(symbol.id, resolved);
		return resolved;
	}

	private resolveHandle(handle: NodeHandle): Node | undefined {
		try {
			return handle.resolve(this.project);
		} catch {
			return undefined;
		}
	}

	private ownerName(declaration: Node): string | undefined {
		const parent = declaration.parent as Node | undefined;
		if (parent === undefined) return undefined;
		if (
			parent.kind === SyntaxKind.ClassDeclaration ||
			parent.kind === SyntaxKind.InterfaceDeclaration ||
			parent.kind === SyntaxKind.ModuleDeclaration ||
			parent.kind === SyntaxKind.ClassExpression
		) {
			return nameText((parent as Node & { readonly name?: Node }).name);
		}
		if (parent.kind === SyntaxKind.ModuleBlock) return this.ownerName(parent);
		return undefined;
	}

	/** The functions a resolved symbol may run, or a blocking API when it is an external declaration. */
	private resolveSymbol(
		symbol: TsSymbol,
		role: ReferenceRole,
	): { functions: readonly number[]; blocking: BlockingApi | undefined; locations: readonly string[] } {
		const target = this.aliased(symbol);
		const cacheKey = `${target.id}:${role}`;
		const cachedFunctions = this.targetCache.get(cacheKey);
		const cachedBlocking = this.externalCache.get(target.id);
		const cachedLocations = this.locationCache.get(cacheKey);
		if (cachedFunctions !== undefined && cachedBlocking !== undefined && cachedLocations !== undefined) {
			return { functions: cachedFunctions, blocking: cachedBlocking ?? undefined, locations: cachedLocations };
		}
		const functions = new Set<number>();
		const locations: string[] = [];
		let blocking: BlockingApi | undefined;
		for (const handle of target.declarations) {
			const relative = this.modulePaths.has(handle.path) ? this.modulePaths.get(handle.path) : undefined;
			const declaration = this.resolveHandle(handle);
			if (declaration === undefined) continue;
			if (relative === undefined) {
				blocking ??= classifyExternalDeclaration({
					path: handle.path,
					name: target.name,
					owner: this.ownerName(declaration),
				});
				continue;
			}
			this.collectDeclarationTargets(handle.path, declaration, role, functions);
			if (role !== "accessor" && VALUE_LOCATIONS.has(declaration.kind)) {
				locations.push(declarationKey(handle.path, declaration));
			}
		}
		const result = [...functions];
		this.targetCache.set(cacheKey, result);
		this.externalCache.set(target.id, blocking ?? null);
		this.locationCache.set(cacheKey, locations);
		return { functions: result, blocking, locations };
	}

	private collectDeclarationTargets(path: string, declaration: Node, role: ReferenceRole, into: Set<number>): void {
		const isAccessor = declaration.kind === SyntaxKind.GetAccessor || declaration.kind === SyntaxKind.SetAccessor;
		const key = declarationKey(path, declaration);
		if (role === "accessor") {
			for (const id of this.accessorFunctions.get(key) ?? []) into.add(id);
			if (!isAccessor) return;
		}
		const direct = this.functionByDeclaration.get(key);
		if (direct !== undefined) into.add(direct);
		for (const id of this.assignedFunctions.get(key) ?? []) into.add(id);
		if (INITIALIZER_DECLARATIONS.has(declaration.kind)) {
			for (const id of this.initializerFunctions.get(key) ?? []) {
				into.add(id);
				const constructed = this.classByFieldsFunction.get(id);
				if (constructed !== undefined && role !== "accessor") this.addConstruction(constructed, into);
			}
		}
		const parent = declaration.parent as Node | undefined;
		const member = memberName(declaration);
		if (declaration.kind === SyntaxKind.ClassDeclaration || declaration.kind === SyntaxKind.ClassExpression) {
			if (role === "new" || role === "value" || role === "call") this.addConstruction(key, into);
			return;
		}
		if (parent === undefined || member === undefined) return;
		if (
			(declaration.kind === SyntaxKind.MethodSignature || declaration.kind === SyntaxKind.PropertySignature) &&
			parent.kind === SyntaxKind.InterfaceDeclaration
		) {
			this.addImplementations(declarationKey(path, parent), member, into);
			return;
		}
		if (
			(declaration.kind === SyntaxKind.MethodDeclaration ||
				declaration.kind === SyntaxKind.PropertyDeclaration ||
				declaration.kind === SyntaxKind.GetAccessor ||
				declaration.kind === SyntaxKind.SetAccessor) &&
			(parent.kind === SyntaxKind.ClassDeclaration || parent.kind === SyntaxKind.ClassExpression)
		) {
			this.addImplementations(declarationKey(path, parent), member, into);
		}
	}

	private addConstruction(classKey: string, into: Set<number>): void {
		let current: string | undefined = classKey;
		const seen = new Set<string>();
		while (current !== undefined && !seen.has(current)) {
			seen.add(current);
			const info = this.classes.get(current);
			if (info === undefined) return;
			into.add(info.fields);
			for (const id of info.constructors) into.add(id);
			if (info.constructors.length > 0) return;
			current = info.base;
		}
	}

	/** Every class below `typeKey` (a class or interface) that defines or inherits `member`. */
	private addImplementations(typeKey: string, member: string, into: Set<number>): void {
		for (const classKey of this.subtypes.get(typeKey) ?? []) {
			let current: string | undefined = classKey;
			const seen = new Set<string>();
			while (current !== undefined && !seen.has(current)) {
				seen.add(current);
				const info = this.classes.get(current);
				if (info === undefined) break;
				const found = info.members.get(member);
				if (found !== undefined) {
					for (const id of found) {
						if (!into.has(id)) this.stats.dispatchTargets++;
						into.add(id);
					}
					break;
				}
				current = info.base;
			}
		}
	}

	private typesAt(nodes: readonly Node[]): Array<TsType | undefined> {
		const types: Array<TsType | undefined> = [];
		for (let start = 0; start < nodes.length; start += RESOLVE_BATCH) {
			let batch: ReadonlyArray<TsType | undefined>;
			try {
				batch = this.project.checker.getTypeAtLocation(nodes.slice(start, start + RESOLVE_BATCH));
			} catch {
				batch = new Array(Math.min(RESOLVE_BATCH, nodes.length - start)).fill(undefined);
			}
			types.push(...batch);
		}
		return types;
	}

	private propertyKeys(type: TsType | undefined, name: string): string[] {
		if (type === undefined) return [];
		let property: TsSymbol | undefined;
		try {
			property = this.project.checker.getPropertyOfType(type, name);
		} catch {
			property = undefined;
		}
		const keys: string[] = [];
		for (const handle of property?.declarations ?? []) {
			if (!this.modulePaths.has(handle.path)) continue;
			const declaration = this.resolveHandle(handle);
			if (declaration !== undefined) keys.push(declarationKey(handle.path, declaration));
		}
		return keys;
	}

	private functionsOfSymbol(symbol: TsSymbol | undefined): number[] {
		if (symbol === undefined) return [];
		const ids: number[] = [];
		for (const handle of this.aliased(symbol).declarations) {
			const declaration = this.resolveHandle(handle);
			if (declaration === undefined) continue;
			const key = declarationKey(handle.path, declaration);
			const id = this.functionByDeclaration.get(key);
			if (id !== undefined) ids.push(id);
			for (const initialized of this.initializerFunctions.get(key) ?? []) ids.push(initialized);
		}
		return ids;
	}

	private symbolAt(node: Node): TsSymbol | undefined {
		try {
			return this.project.checker.getSymbolAtLocation(node);
		} catch {
			return undefined;
		}
	}

	private literalMembers(source: Node, path: string): Array<{ readonly name: string; readonly functions: number[] }> {
		let literal: Node | undefined = unwrapExpression(source);
		let literalPath = path;
		if (isIdentifier(literal)) {
			const symbol = this.symbolAt(literal);
			literal = undefined;
			for (const handle of symbol === undefined ? [] : this.aliased(symbol).declarations) {
				const declaration = this.resolveHandle(handle);
				const initializer = (declaration as (Node & { readonly initializer?: Node }) | undefined)?.initializer;
				if (declaration?.kind !== SyntaxKind.VariableDeclaration || initializer === undefined) continue;
				literal = unwrapExpression(initializer);
				literalPath = handle.path;
				break;
			}
		}
		if (literal?.kind !== SyntaxKind.ObjectLiteralExpression) return [];
		const members: Array<{ readonly name: string; readonly functions: number[] }> = [];
		for (const property of (literal as Node & { readonly properties: readonly Node[] }).properties) {
			const name = memberName(property);
			if (name === undefined) continue;
			const functions: number[] = [];
			if (isFunctionLike(property)) {
				const id = this.functionByDeclaration.get(declarationKey(literalPath, property));
				if (id !== undefined) functions.push(id);
			} else if (property.kind === SyntaxKind.ShorthandPropertyAssignment) {
				let symbol: TsSymbol | undefined;
				try {
					symbol = this.project.checker.getShorthandAssignmentValueSymbol(property);
				} catch {
					symbol = undefined;
				}
				functions.push(...this.functionsOfSymbol(symbol));
			} else if (property.kind === SyntaxKind.PropertyAssignment) {
				const value = unwrapExpression((property as Node & { readonly initializer: Node }).initializer);
				const id = this.functionByDeclaration.get(declarationKey(literalPath, value));
				if (id !== undefined) functions.push(id);
				else if (isIdentifier(value) || isPropertyAccessExpression(value)) {
					functions.push(...this.functionsOfSymbol(this.symbolAt(this.resolvableNode(value))));
				}
			}
			if (functions.length > 0) members.push({ name, functions });
		}
		return members;
	}

	private resolveInstalls(): void {
		const targetTypes = this.typesAt(this.prototypeInstalls.map((install) => install.target));
		this.prototypeInstalls.forEach((install, index) => {
			for (const source of install.sources) {
				for (const member of this.literalMembers(source, install.path)) {
					const keys = new Set(this.propertyKeys(targetTypes[index], member.name));
					for (const id of member.functions) {
						const thisParameter = (
							this.functionNodes.get(id) as (Node & { readonly parameters?: readonly Node[] }) | undefined
						)?.parameters?.[0];
						if (thisParameter === undefined || nameText(memberNameNode(thisParameter)) !== "this") continue;
						const [thisType] = this.typesAt([thisParameter]);
						for (const key of this.propertyKeys(thisType, member.name)) keys.add(key);
					}
					for (const key of keys) {
						const list = this.assignedFunctions.get(key) ?? [];
						list.push(...member.functions);
						this.assignedFunctions.set(key, list);
					}
				}
			}
		});
		const propertyTypes = this.typesAt(this.propertyInstalls.map((install) => install.target));
		this.propertyInstalls.forEach((install, index) => {
			const keys = this.propertyKeys(propertyTypes[index], install.name);
			if (keys.length === 0) return;
			for (const member of this.literalMembers(install.descriptor, install.path)) {
				const into = member.name === "value" ? this.assignedFunctions : this.accessorFunctions;
				if (member.name !== "value" && member.name !== "get" && member.name !== "set") continue;
				for (const key of keys) {
					const list = into.get(key) ?? [];
					list.push(...member.functions);
					into.set(key, list);
				}
			}
		});
	}

	private resolveRequires(): void {
		const types = this.typesAt(this.requireCalls.map((call) => call.callee));
		const namespaces = new Map<string, RequiredExport>();
		this.requireCalls.forEach((call, index) => {
			let symbol: TsSymbol | undefined;
			try {
				symbol = types[index]?.getSymbol();
			} catch {
				symbol = undefined;
			}
			if (symbol === undefined || !["Require", "NodeRequire", "RequireFunction"].includes(symbol.name)) return;
			let child = call.call;
			let parent = child.parent as Node | undefined;
			while (parent !== undefined && EXPRESSION_WRAPPERS.has(parent.kind)) {
				child = parent;
				parent = parent.parent as Node | undefined;
			}
			if (parent === undefined) return;
			if (isPropertyAccessExpression(parent) && parent.expression === child) {
				this.requiredMembers.set(parent.name, { specifier: call.specifier, name: nameText(parent.name) });
				return;
			}
			if (parent.kind !== SyntaxKind.VariableDeclaration) return;
			const name = (parent as Node & { readonly name: Node }).name;
			if (isIdentifier(name)) {
				const required = { specifier: call.specifier, name: undefined };
				this.requiredDeclarations.set(declarationKey(call.path, parent), required);
				namespaces.set(name.text, required);
				return;
			}
			if (name.kind !== SyntaxKind.ObjectBindingPattern) return;
			for (const element of (name as Node & { readonly elements: readonly Node[] }).elements) {
				const binding = element as Node & { readonly propertyName?: Node; readonly name: Node };
				const exported = nameText(binding.propertyName) ?? nameText(binding.name);
				if (exported === undefined) continue;
				this.requiredDeclarations.set(declarationKey(call.path, element), {
					specifier: call.specifier,
					name: exported,
				});
			}
		});
		if (namespaces.size === 0) return;
		const members = this.references.filter((reference) => {
			const parent = reference.node.parent as Node | undefined;
			if (parent === undefined || !isPropertyAccessExpression(parent) || parent.name !== reference.node)
				return false;
			const receiver = unwrapExpression(parent.expression);
			return isIdentifier(receiver) && namespaces.has(receiver.text);
		});
		for (const reference of members) {
			const receiver = unwrapExpression((reference.node.parent as Node & { readonly expression: Node }).expression);
			const required = this.requiredExportOf(this.symbolAt(receiver));
			if (required !== undefined && required.name === undefined) {
				this.requiredMembers.set(reference.node, { specifier: required.specifier, name: reference.name });
			}
		}
	}

	private requiredExportOf(symbol: TsSymbol | undefined): RequiredExport | undefined {
		if (symbol === undefined || this.requiredDeclarations.size === 0) return undefined;
		for (const handle of this.aliased(symbol).declarations) {
			if (!this.modulePaths.has(handle.path)) continue;
			const declaration = this.resolveHandle(handle);
			if (declaration === undefined) continue;
			const required = this.requiredDeclarations.get(declarationKey(handle.path, declaration));
			if (required !== undefined) return required;
		}
		return undefined;
	}

	private resolveRegexHolders(): void {
		const pending: number[] = [];
		this.identifierNodes.forEach((node, index) => {
			const name = nameText(node);
			const container = this.identifierContainers[index];
			if (name !== undefined && this.regexHolderNames.has(name) && this.functions[container].kind !== "module") {
				pending.push(index);
			}
		});
		const added = new Set<string>();
		for (let start = 0; start < pending.length; start += RESOLVE_BATCH) {
			const batch = pending.slice(start, start + RESOLVE_BATCH);
			let symbols: ReadonlyArray<TsSymbol | undefined>;
			try {
				symbols = this.project.checker.getSymbolAtLocation(batch.map((index) => this.identifierNodes[index]));
			} catch {
				continue;
			}
			batch.forEach((identifier, index) => {
				const symbol = symbols[index];
				if (symbol === undefined) return;
				const container = this.identifierContainers[identifier];
				for (const handle of this.aliased(symbol).declarations) {
					if (!this.modulePaths.has(handle.path)) continue;
					const declaration = this.resolveHandle(handle);
					if (declaration === undefined) continue;
					for (const use of this.regexHolders.get(declarationKey(handle.path, declaration)) ?? []) {
						const key = `${container}\0${use.file}:${use.line}\0${use.pattern}`;
						if (added.has(key)) continue;
						added.add(key);
						this.functions[container].regexes.push(use);
					}
				}
			});
		}
	}

	private resolveHeritage(): void {
		const pending: Array<{
			readonly from: string;
			readonly node: Node;
			readonly extends: boolean;
			readonly isClass: boolean;
		}> = [];
		for (const info of this.classes.values()) {
			for (const entry of info.heritage)
				pending.push({ from: info.key, node: entry.expression, extends: entry.extends, isClass: true });
		}
		for (const info of this.interfaces.values()) {
			for (const node of info.heritage) pending.push({ from: info.key, node, extends: true, isClass: false });
		}
		const supertypes = new Map<string, Set<string>>();
		for (let start = 0; start < pending.length; start += RESOLVE_BATCH) {
			const batch = pending.slice(start, start + RESOLVE_BATCH);
			const symbols = this.project.checker.getSymbolAtLocation(
				batch.map((entry) => this.resolvableNode(entry.node)),
			);
			batch.forEach((entry, index) => {
				const symbol = symbols[index];
				if (symbol === undefined) return;
				for (const handle of this.aliased(symbol).declarations) {
					if (!this.modulePaths.has(handle.path)) continue;
					const declaration = this.resolveHandle(handle);
					if (declaration === undefined) continue;
					const key = declarationKey(handle.path, declaration);
					if (!this.classes.has(key) && !this.interfaces.has(key)) continue;
					const set = supertypes.get(entry.from) ?? new Set<string>();
					set.add(key);
					supertypes.set(entry.from, set);
					if (entry.isClass && entry.extends && this.classes.has(key)) {
						const info = this.classes.get(entry.from);
						if (info !== undefined) info.base = key;
					}
				}
			});
		}
		for (const classKey of this.classes.keys()) {
			const stack = [classKey];
			const seen = new Set<string>();
			while (stack.length > 0) {
				const current = stack.pop() as string;
				if (seen.has(current)) continue;
				seen.add(current);
				const set = this.subtypes.get(current) ?? new Set<string>();
				set.add(classKey);
				this.subtypes.set(current, set);
				for (const parent of supertypes.get(current) ?? []) stack.push(parent);
			}
		}
	}

	/** Attaches functions assigned to a property or variable to every declaration of that property or variable. */
	private resolveAssignments(): void {
		const pending = this.pendingAssignments;
		for (let start = 0; start < pending.length; start += RESOLVE_BATCH) {
			const batch = pending.slice(start, start + RESOLVE_BATCH);
			const symbols = this.project.checker.getSymbolAtLocation(batch.map((entry) => entry.target));
			batch.forEach((entry, index) => {
				const symbol = symbols[index];
				if (symbol === undefined) return;
				const into: string[] = [];
				for (const handle of this.aliased(symbol).declarations) {
					if (!this.modulePaths.has(handle.path)) continue;
					const declaration = this.resolveHandle(handle);
					if (declaration === undefined) continue;
					const key = declarationKey(handle.path, declaration);
					into.push(key);
					if (entry.functions.length > 0) {
						const list = this.assignedFunctions.get(key) ?? [];
						list.push(...entry.functions);
						this.assignedFunctions.set(key, list);
					}
				}
				if (into.length > 0 && entry.references.length > 0) {
					this.assignmentFlows.push({ into, functions: [], references: entry.references });
				}
			});
		}
	}

	private resolvableNode(node: Node): Node {
		const target = unwrapExpression(node);
		return isPropertyAccessExpression(target) ? target.name : target;
	}

	private resolveReferences(): void {
		this.stats.references = this.references.length;
		const resolved: Array<readonly number[]> = new Array(this.references.length);
		const symbolsByReference: Array<TsSymbol | undefined> = new Array(this.references.length);
		for (let start = 0; start < this.references.length; start += RESOLVE_BATCH) {
			const batch = this.references.slice(start, start + RESOLVE_BATCH);
			const symbols = this.project.checker.getSymbolAtLocation(batch.map((reference) => reference.node));
			batch.forEach((reference, index) => {
				const symbol = symbols[index];
				symbolsByReference[start + index] = symbol;
				resolved[start + index] = this.applyReference(reference, symbol, start + index);
			});
		}
		this.resolveThroughTypes(resolved);
		this.propagateValues(resolved);
		this.applyNameChecks(resolved);
		for (const call of this.calls) this.applySinks(call, resolved, symbolsByReference);
		for (const call of this.calls) this.applyDetachedAsync(call, resolved);
		for (const assignment of this.assignedHandlers) this.applyAssignedHandler(assignment, resolved);
	}

	/**
	 * Functions flow into parameters at call sites, into properties and variables through assignments, and into an
	 * options type's properties through object literals; a call or reference through one of those reaches every
	 * function that can flow there. Solved to a fixed point, then each such reference gains its edges and `resolved`
	 * its functions (so sinks see a registered parameter's functions).
	 */
	private propagateValues(resolved: Array<readonly number[]>): void {
		type Flow = {
			readonly into: readonly string[];
			readonly functions: readonly number[];
			readonly from: readonly string[];
		};
		const flows: Flow[] = [];
		const sourcesOf = (sources: ValueSources) => {
			const functions = [...sources.functions];
			const from: string[] = [];
			for (const index of sources.references) {
				functions.push(...(resolved[index] ?? []));
				from.push(...(this.referenceLocations[index] ?? []));
			}
			return { functions, from };
		};
		for (const call of this.calls) {
			for (const target of resolved[call.callee] ?? []) {
				const parameters = this.functionParameters.get(target);
				if (parameters === undefined || parameters.keys.length === 0) continue;
				call.arguments.forEach((argument, index) => {
					const position = parameters.rest !== -1 && index >= parameters.rest ? parameters.rest : index;
					const key = parameters.keys[position];
					if (key === undefined) return;
					const { functions, from } = sourcesOf(argument);
					if (functions.length > 0 || from.length > 0) flows.push({ into: [key], functions, from });
				});
			}
		}
		for (const assignment of this.assignmentFlows) {
			const { functions, from } = sourcesOf(assignment);
			flows.push({ into: assignment.into, functions, from });
		}
		for (const value of this.objectValueFlows) {
			const { functions, from } = sourcesOf(value);
			flows.push({ into: value.into, functions, from });
		}
		const values = new Map<string, Set<number>>();
		const dependents = new Map<string, number[]>();
		flows.forEach((flow, index) => {
			for (const location of flow.from) {
				const list = dependents.get(location) ?? [];
				list.push(index);
				dependents.set(location, list);
			}
		});
		const queue = flows.map((_, index) => index);
		const queued = new Set(queue);
		while (queue.length > 0) {
			const index = queue.shift() as number;
			queued.delete(index);
			const flow = flows[index];
			const incoming = new Set(flow.functions);
			for (const location of flow.from) for (const id of values.get(location) ?? []) incoming.add(id);
			for (const location of flow.into) {
				const set = values.get(location) ?? new Set<number>();
				const before = set.size;
				for (const id of incoming) set.add(id);
				values.set(location, set);
				if (set.size === before) continue;
				for (const dependent of dependents.get(location) ?? []) {
					if (!queued.has(dependent)) {
						queued.add(dependent);
						queue.push(dependent);
					}
				}
			}
		}
		const parameterOwner = new Map<string, number>();
		for (const [id, parameters] of this.functionParameters)
			for (const key of parameters.keys) parameterOwner.set(key, id);
		this.references.forEach((reference, index) => {
			const locations = this.referenceLocations[index];
			if (locations === undefined || reference.role === "accessor") return;
			const reached = new Set<number>();
			for (const location of locations) for (const id of values.get(location) ?? []) reached.add(id);
			if (reached.size === 0) return;
			const known = new Set(resolved[index] ?? []);
			const added = [...reached].filter((id) => !known.has(id));
			if (added.length === 0) return;
			resolved[index] = [...known, ...added];
			// A function calling or passing on its own parameter runs within its caller's call, and the caller already
			// reaches what it passed. Only a parameter used from a closure that outlives the call, or a stored value,
			// needs edges of its own.
			const ownParameterOnly = locations.every((location) => parameterOwner.get(location) === reference.container);
			if (ownParameterOnly) return;
			this.stats.resolvedThroughFlow++;
			for (const id of added)
				this.addEdge(reference.container, id, reference.role === "value" ? "reference" : "call");
		});
	}

	/**
	 * A callee that resolved to a variable, binding or property with no known function behind it (a destructured
	 * `await import()`, a `const f = cond ? a : b`) is looked up again through its type, whose symbol is the function
	 * declaration when there is one.
	 */
	private resolveThroughTypes(resolved: Array<readonly number[]>): void {
		const pending = this.typeFallbacks;
		for (let start = 0; start < pending.length; start += RESOLVE_BATCH) {
			const batch = pending.slice(start, start + RESOLVE_BATCH);
			const types = this.project.checker.getTypeAtLocation(batch.map((index) => this.references[index].node));
			batch.forEach((referenceIndex, index) => {
				const type = types[index];
				if (type === undefined) return;
				let symbol: TsSymbol | undefined;
				try {
					symbol = type.getSymbol();
				} catch {
					symbol = undefined;
				}
				if (symbol === undefined) return;
				if (symbol.declarations.length > 0) this.typedReferences.add(referenceIndex);
				const reference = this.references[referenceIndex];
				const isFunction = (symbol.flags & (SymbolFlags.Function | SymbolFlags.Method)) !== 0;
				if (reference.role === "value" && !isFunction) return;
				const { functions, blocking } = this.resolveSymbol(symbol, reference.role);
				if (blocking !== undefined && reference.role !== "value") {
					this.functions[reference.container].blocking.push({ line: reference.line, api: blocking });
				}
				for (const id of functions)
					this.addEdge(reference.container, id, reference.role === "value" ? "reference" : "call");
				if (functions.length > 0) {
					resolved[referenceIndex] = [...resolved[referenceIndex], ...functions];
					this.stats.resolvedThroughType++;
				}
			});
		}
	}

	private applyReference(reference: PendingReference, symbol: TsSymbol | undefined, index: number): readonly number[] {
		if (this.detachedReferences.has(index)) return [];
		const required = this.requiredMembers.get(reference.node) ?? (symbol && this.requiredExportOf(symbol));
		if (required !== undefined) {
			const api = classifyRequiredExport(required, required.name ?? reference.name);
			if (api !== undefined) {
				this.functions[reference.container].blocking.push({ line: reference.line, api });
				this.stats.resolvedExternal++;
				return [];
			}
		}
		if (symbol === undefined) {
			this.stats.unresolved++;
			if (reference.role === "call") this.recordUnresolvedBlocking(reference);
			return [];
		}
		const { functions, blocking, locations } = this.resolveSymbol(symbol, reference.role);
		if (locations.length > 0) this.referenceLocations[index] = locations;
		if (functions.length === 0 && blocking === undefined && reference.role !== "accessor") {
			const flags = this.aliased(symbol).flags;
			const variableLike = (flags & (SymbolFlags.Variable | SymbolFlags.Property)) !== 0;
			if (variableLike) this.typeFallbacks.push(index);
		}
		const edge: EdgeKind = reference.role === "value" ? "reference" : "call";
		if (blocking !== undefined) {
			this.functions[reference.container].blocking.push({ line: reference.line, api: blocking });
		}
		if (functions.length > 0) this.stats.resolvedToFunction++;
		else if (blocking !== undefined) this.stats.resolvedExternal++;
		else if (reference.role === "call") this.recordUnresolvedBlocking(reference, symbol, index);
		for (const id of functions) {
			const kind = this.functions[id].kind;
			const dispatched =
				reference.role !== "value" && kind !== "class-fields" && kind !== "constructor" && functions.length > 1;
			this.addEdge(reference.container, id, dispatched ? "dispatch" : edge);
		}
		return functions;
	}

	/**
	 * A call through a variable, parameter or property nothing resolves: its name is the last evidence. Decided after
	 * the type and value-flow passes, which may still find the function or declaration it calls.
	 */
	private recordUnresolvedBlocking(reference: PendingReference, symbol?: TsSymbol, index?: number): void {
		if (symbol !== undefined) {
			const flags = this.aliased(symbol).flags;
			const isVariableLike =
				(flags & (SymbolFlags.Variable | SymbolFlags.Property)) !== 0 &&
				(flags & (SymbolFlags.Function | SymbolFlags.Method)) === 0;
			if (!isVariableLike) return;
			if (index !== undefined) {
				this.pendingNameChecks.push(index);
				return;
			}
		}
		const api = classifyUnresolvedCallName(reference.name);
		if (api !== undefined) this.functions[reference.container].blocking.push({ line: reference.line, api });
	}

	private applyNameChecks(resolved: Array<readonly number[]>): void {
		for (const index of this.pendingNameChecks) {
			if ((resolved[index]?.length ?? 0) > 0 || this.typedReferences.has(index)) continue;
			this.recordUnresolvedBlocking(this.references[index]);
		}
	}

	private applySinks(
		call: PendingCall,
		resolved: Array<readonly number[]>,
		symbols: Array<TsSymbol | undefined>,
	): void {
		const reference = this.references[call.callee];
		const symbol = symbols[call.callee];
		if (symbol === undefined || call.detached) return;
		const match = this.matchSink(symbol, call);
		if (match === undefined) return;
		if (match.continuation && !call.floatingChain) return;
		const callbacks = new Set<number>(call.argumentFunctions);
		for (const index of call.argumentReferences) for (const id of resolved[index] ?? []) callbacks.add(id);
		if (callbacks.size === 0) return;
		this.sinkRegistrations.push({
			registrar: reference.container,
			sink: match.sink,
			line: call.line,
			callbacks: [...callbacks],
			...(match.continuation ? { continuation: true } : {}),
		});
	}

	private applyDetachedAsync(call: PendingCall, resolved: Array<readonly number[]>): void {
		if (!call.floating || call.detached) return;
		const callbacks = (resolved[call.callee] ?? []).filter((id) => this.functions[id].isAsync);
		if (callbacks.length === 0) return;
		this.sinkRegistrations.push({
			registrar: this.references[call.callee].container,
			sink: "detached async call",
			line: call.line,
			callbacks,
			continuation: true,
		});
	}

	private matchSink(symbol: TsSymbol, call: PendingCall): { sink: string; continuation: boolean } | undefined {
		const target = this.aliased(symbol);
		for (const handle of target.declarations) {
			const path = handle.path.replaceAll("\\", "/");
			const declaration = this.resolveHandle(handle);
			if (declaration === undefined) continue;
			const owner = this.ownerName(declaration);
			for (const spec of this.options.sinks) {
				if (!path.endsWith(spec.file)) continue;
				if (!spec.names.includes(target.name)) continue;
				if (spec.owner !== undefined && spec.owner !== owner) continue;
				if (
					spec.events !== undefined &&
					(call.firstArgument === undefined || !spec.events.includes(call.firstArgument))
				)
					continue;
				return {
					sink: `${owner === undefined || owner === "global" ? "" : `${owner}.`}${target.name}`,
					continuation: spec.continuation === true,
				};
			}
		}
		return undefined;
	}

	private applyAssignedHandler(
		assignment: {
			readonly container: number;
			readonly sink: string;
			readonly line: number;
			readonly functions: readonly number[];
			readonly references: readonly number[];
		},
		resolved: Array<readonly number[]>,
	): void {
		const callbacks = new Set<number>(assignment.functions);
		for (const index of assignment.references) for (const id of resolved[index] ?? []) callbacks.add(id);
		if (callbacks.size === 0) return;
		this.sinkRegistrations.push({
			registrar: assignment.container,
			sink: assignment.sink,
			line: assignment.line,
			callbacks: [...callbacks],
		});
	}

	private resolveShorthandValues(): void {
		for (const entry of this.shorthandValues) {
			let symbol: TsSymbol | undefined;
			try {
				symbol = this.project.checker.getShorthandAssignmentValueSymbol(entry.node);
			} catch {
				symbol = undefined;
			}
			if (symbol === undefined) continue;
			const { functions, blocking } = this.resolveSymbol(symbol, "value");
			if (blocking !== undefined) this.functions[entry.container].blocking.push({ line: entry.line, api: blocking });
			for (const id of functions) this.addEdge(entry.container, id, "reference");
		}
	}

	private resolveSuperCalls(): void {
		for (const call of this.superCalls) {
			const base = this.classes.get(call.classKey)?.base;
			if (base === undefined) continue;
			const into = new Set<number>();
			this.addConstruction(base, into);
			for (const id of into) this.addEdge(call.container, id, "call");
		}
	}

	private resolveImports(): void {
		for (let start = 0; start < this.imports.length; start += RESOLVE_BATCH) {
			const batch = this.imports.slice(start, start + RESOLVE_BATCH);
			const symbols = this.project.checker.getSymbolAtLocation(batch.map((entry) => entry.specifier));
			batch.forEach((entry, index) => {
				const symbol = symbols[index];
				if (symbol === undefined) return;
				for (const handle of symbol.declarations) {
					const target = this.modulePaths.get(handle.path);
					if (target === undefined) continue;
					const targetModule = this.modules.get(target);
					if (targetModule === undefined) continue;
					this.addEdge(entry.container, targetModule, "import");
					if (!entry.dynamic) {
						const set = this.staticImports.get(entry.fromModule) ?? new Set<string>();
						set.add(target);
						this.staticImports.set(entry.fromModule, set);
					}
				}
			});
		}
	}
}
