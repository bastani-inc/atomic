/**
 * Duration-headroom guard for the repository's vitest suites.
 *
 * A fixed per-test timeout cannot detect drift: a test that creeps from 30 % to
 * 95 % of its budget looks identical to a healthy one until a slow runner tips
 * it over and the suite flakes. Only the *ratio* of duration to budget carries
 * that signal, so this module reads vitest's JSON reporter, resolves each test's
 * effective timeout, and reports the tests closest to their budget.
 *
 * Timeout resolution mirrors vitest's own precedence: an explicit third argument
 * on the declaration wins, otherwise the project's resolved `testTimeout`
 * applies. When no budget can be resolved from the command the gate stays
 * disabled and only the duration table is emitted -- a suite that never declared
 * a budget must not be judged against one it did not choose.
 *
 * It previously scraped Bun's human-readable `(pass) name [Nms]` stdout. That
 * scored 4288 of 4417 unit tests: 127 passing tests print no duration at all,
 * and 67 files' tests were attributed to the wrong file because Bun files
 * barrel-re-exported tests under the importing header. The JSON reporter emits a
 * record per test with its own file, so the gate now covers the whole suite and
 * `blind` finally means what it says.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

/** Emit a warning once a test consumes this share of its effective timeout. */
export const WARN_RATIO = 0.4;
/** vitest's built-in per-test timeout, used only for reporting an unset budget. */
export const VITEST_DEFAULT_TIMEOUT_MS = 5000;

export interface DurationSample {
	file: string;
	name: string;
	fullName: string;
	status: "pass" | "fail";
	durationMs: number;
}

export interface BudgetedSample extends DurationSample {
	timeoutMs: number;
	ratio: number;
	explicit: boolean;
	/**
	 * The test declares its own timeout but the guard could not evaluate it
	 * statically. Its budget is unknown, so it is never scored against the suite
	 * default (`timeoutMs` and `ratio` are 0) and is reported separately.
	 */
	unresolved: boolean;
}

export interface DurationGuardReport {
	enabled: boolean;
	defaultTimeoutMs: number | undefined;
	ranTests: number;
	blind: boolean;
	samples: BudgetedSample[];
	warnings: BudgetedSample[];
	/** Tests with an explicit timeout the guard could not evaluate, so their headroom is unmeasured. */
	unresolved: BudgetedSample[];
}

/** The subset of vitest's JSON reporter this guard reads. */
interface VitestAssertion {
	ancestorTitles?: string[];
	title?: string;
	fullName?: string;
	status?: string;
	duration?: number | null;
}

interface VitestFileResult {
	name?: string;
	assertionResults?: VitestAssertion[];
}

interface VitestReport {
	numTotalTests?: number;
	testResults?: VitestFileResult[];
}

/**
 * Every completed test in a vitest JSON report, as a duration sample.
 *
 * Skipped and pending tests are excluded: they carry no duration and scoring a
 * zero against a budget would dilute the table with rows that cannot drift.
 * They still count towards `ranTests`, which is what distinguishes "nothing to
 * measure" from "the harness produced no measurements".
 */
export function parseVitestReport(json: string, rootDir: string = process.cwd()): DurationSample[] {
	const report = JSON.parse(json) as VitestReport;
	const samples: DurationSample[] = [];
	for (const result of report.testResults ?? []) {
		const absolute = result.name ?? "";
		const file = (isAbsolute(absolute) ? relative(rootDir, absolute) : absolute).replaceAll("\\", "/");
		for (const assertion of result.assertionResults ?? []) {
			if (assertion.status !== "passed" && assertion.status !== "failed") continue;
			const title = assertion.title ?? "";
			const scopes = assertion.ancestorTitles ?? [];
			// vitest's `fullName` joins the scope path with a space; the explicit
			// per-test budgets below are keyed by the `scope > name` form, so the
			// path is rebuilt rather than trusted.
			const fullName = [...scopes, title].filter((part) => part !== "").join(" > ");
			samples.push({
				file,
				name: title,
				fullName,
				status: assertion.status === "passed" ? "pass" : "fail",
				durationMs: assertion.duration ?? 0,
			});
		}
	}
	return samples;
}

/** Tests vitest reported, whether or not each produced a duration. */
export function reportedTestCount(json: string): number {
	const report = JSON.parse(json) as VitestReport;
	if (typeof report.numTotalTests === "number") return report.numTotalTests;
	return (report.testResults ?? []).reduce((total, result) => total + (result.assertionResults?.length ?? 0), 0);
}

type Program = ReturnType<typeof parse>["program"];
type Statement = Program["body"][number];
type Expression = Extract<Statement, { type: "ExpressionStatement" }>["expression"];
type CallExpression = Extract<Expression, { type: "CallExpression" }>;
type Callee = CallExpression["callee"];
type Argument = CallExpression["arguments"][number];
type MemberObject = Extract<Expression, { type: "MemberExpression" }>["object"];
type ObjectMember = Extract<Expression, { type: "ObjectExpression" }>["properties"][number];
type PropertyValue = Extract<ObjectMember, { type: "ObjectProperty" }>["value"];

/** Chained members that leave a `test`/`describe` declarer callable with the same arguments. */
const PLAIN_MODIFIERS = new Set([
	"only",
	"skip",
	"todo",
	"fails",
	"failing",
	"serial",
	"concurrent",
	"sequential",
	"shuffle",
]);
/** Members called with arguments that return a declarer: `test.skipIf(cond)(...)`, `test.extend({...})(...)`. */
const CONDITION_MODIFIERS = new Set(["skipIf", "runIf", "extend"]);
/** Members called with a case table that return a declarer: `test.each(rows)(...)`. */
const TABLE_MODIFIERS = new Set(["each", "for"]);
const ROOT_DECLARERS = new Map<string, Declarer["kind"]>([
	["test", "test"],
	["it", "test"],
	["describe", "describe"],
	["suite", "describe"],
]);

interface Declarer {
	kind: "test" | "describe";
	/** The case table of a `.each`/`.for` declarer, whose rows expand the title. */
	table?: Expression;
}

/** A timeout argument the scan found: its value, or `undefined` when it could not be evaluated. */
interface DeclaredTimeout {
	value: number | undefined;
}

/**
 * Explicit per-test budgets by qualified `scope > name`, plus those declared but
 * not statically evaluable. Titles only known at run time (template literals,
 * dynamic `.each` tables) are matched by `patterns` against the reported name.
 */
export interface DeclaredBudgets {
	timeouts: Map<string, number>;
	unresolved: Set<string>;
	patterns: { pattern: RegExp; timeoutMs: number | undefined }[];
}

/** A test or suite title: exact text, or a regular-expression source for a title only known at run time. */
type Title = { exact: string } | { pattern: string };

interface ModuleScope {
	file: string | undefined;
	/** `const` initialisers by name; `undefined` marks a name declared more than once. */
	constants: Map<string, Expression | undefined>;
	/** Local import bindings to the module and exported name they read. */
	imports: Map<string, { source: string; name: string }>;
	/** Exported name to the local binding that provides it. */
	exports: Map<string, string>;
}

function parseModule(source: string, file: string | undefined): Program | undefined {
	try {
		return parse(source, {
			sourceType: "module",
			plugins: file?.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
			errorRecovery: true,
		}).program;
	} catch {
		return undefined;
	}
}

/**
 * Visit every statement and expression a test declaration can sit in: top-level
 * statements, blocks, loops, conditionals, and callback bodies passed to calls.
 */
function visit(
	node: Statement | Expression | Argument | Callee | null | undefined,
	onCall: (call: CallExpression, descend: () => void) => void,
	onConstant: (name: string, init: Expression) => void,
): void {
	if (!node) return;
	const walk = (child: Statement | Expression | Argument | Callee | null | undefined): void =>
		visit(child, onCall, onConstant);
	switch (node.type) {
		case "ExpressionStatement":
			walk(node.expression);
			return;
		case "BlockStatement":
			for (const statement of node.body) walk(statement);
			return;
		case "IfStatement":
			walk(node.consequent);
			walk(node.alternate);
			return;
		case "ForStatement":
		case "ForInStatement":
		case "ForOfStatement":
		case "WhileStatement":
		case "DoWhileStatement":
		case "LabeledStatement":
			walk(node.body);
			return;
		case "TryStatement":
			walk(node.block);
			if (node.handler) walk(node.handler.body);
			walk(node.finalizer);
			return;
		case "ExportNamedDeclaration":
			walk(node.declaration);
			return;
		case "VariableDeclaration":
			for (const declarator of node.declarations) {
				if (!declarator.init) continue;
				if (node.kind === "const" && declarator.id.type === "Identifier")
					onConstant(declarator.id.name, declarator.init);
				walk(declarator.init);
			}
			return;
		case "AwaitExpression":
		case "UnaryExpression":
			walk(node.argument);
			return;
		case "ArrowFunctionExpression":
		case "FunctionExpression":
			walk(node.body);
			return;
		case "FunctionDeclaration":
			walk(node.body);
			return;
		case "CallExpression":
			onCall(node, () => {
				walk(node.callee);
				for (const argument of node.arguments) walk(argument);
			});
			return;
		default:
			return;
	}
}

function moduleScope(program: Program, file: string | undefined): ModuleScope {
	const scope: ModuleScope = { file, constants: new Map(), imports: new Map(), exports: new Map() };
	const addConstant = (name: string, init: Expression): void => {
		scope.constants.set(name, scope.constants.has(name) ? undefined : init);
	};
	for (const statement of program.body) {
		if (statement.type === "ImportDeclaration") {
			for (const specifier of statement.specifiers) {
				if (specifier.type !== "ImportSpecifier") continue;
				const imported =
					specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
				scope.imports.set(specifier.local.name, { source: statement.source.value, name: imported });
			}
		} else if (statement.type === "ExportNamedDeclaration") {
			if (statement.declaration?.type === "VariableDeclaration") {
				for (const declarator of statement.declaration.declarations) {
					if (declarator.id.type === "Identifier") scope.exports.set(declarator.id.name, declarator.id.name);
				}
			}
			if (!statement.source) {
				for (const specifier of statement.specifiers) {
					if (specifier.type !== "ExportSpecifier") continue;
					const exported =
						specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value;
					const local = specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value;
					scope.exports.set(exported, local);
				}
			}
		}
		visit(statement, (_call, descend) => descend(), addConstant);
	}
	return scope;
}

/** Resolve a relative import specifier to the TypeScript source Bun and vitest would load. */
function resolveImport(from: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = resolve(dirname(from), specifier);
	const stem = base.replace(/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/u, "");
	const candidates = [
		base.replace(/\.js$/u, ".ts"),
		base.replace(/\.mjs$/u, ".mts"),
		base.replace(/\.js$/u, ".tsx"),
		base,
		`${stem}.ts`,
		join(stem, "index.ts"),
	];
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * Evaluate a timeout expression without executing source: numeric literals,
 * arithmetic, parentheses, TypeScript assertions, and `const` bindings declared
 * in the file or imported from a relative module. Anything else is unresolved.
 */
class ConstantEvaluator {
	private readonly modules = new Map<string, ModuleScope | undefined>();

	evaluate(
		expression: Expression | PropertyValue,
		scope: ModuleScope,
		seen: Set<string> = new Set(),
	): number | undefined {
		switch (expression.type) {
			case "NumericLiteral":
				return expression.value;
			case "ParenthesizedExpression":
			case "TSAsExpression":
			case "TSSatisfiesExpression":
			case "TSNonNullExpression":
			case "TSTypeAssertion":
				return this.evaluate(expression.expression, scope, seen);
			case "UnaryExpression": {
				const operand = this.evaluate(expression.argument, scope, seen);
				if (operand === undefined) return undefined;
				if (expression.operator === "-") return -operand;
				return expression.operator === "+" ? operand : undefined;
			}
			case "BinaryExpression": {
				if (expression.left.type === "PrivateName") return undefined;
				const left = this.evaluate(expression.left, scope, seen);
				const right = this.evaluate(expression.right, scope, seen);
				if (left === undefined || right === undefined) return undefined;
				switch (expression.operator) {
					case "+":
						return left + right;
					case "-":
						return left - right;
					case "*":
						return left * right;
					case "/":
						return left / right;
					case "%":
						return left % right;
					case "**":
						return left ** right;
					default:
						return undefined;
				}
			}
			case "Identifier":
				return this.binding(expression.name, scope, seen);
			default:
				return undefined;
		}
	}

	private binding(name: string, scope: ModuleScope, seen: Set<string>): number | undefined {
		const key = `${scope.file ?? "<source>"}#${name}`;
		if (seen.has(key)) return undefined;
		const next = new Set(seen).add(key);
		const init = scope.constants.get(name);
		if (init) return this.evaluate(init, scope, next);
		const imported = scope.imports.get(name);
		if (!imported || !scope.file) return undefined;
		const path = resolveImport(scope.file, imported.source);
		const target = path === undefined ? undefined : this.module(path);
		const local = target?.exports.get(imported.name);
		return target && local !== undefined ? this.binding(local, target, next) : undefined;
	}

	private module(path: string): ModuleScope | undefined {
		if (!this.modules.has(path)) {
			const program = parseModule(readFileSync(path, "utf8"), path);
			this.modules.set(path, program ? moduleScope(program, path) : undefined);
		}
		return this.modules.get(path);
	}
}

function unwrapExpression(node: Argument | undefined): Expression | undefined {
	if (!node || node.type === "SpreadElement" || node.type === "ArgumentPlaceholder") return undefined;
	return node;
}

/**
 * Escape every RegExp metacharacter, backslash included, so title text is only
 * ever matched literally.
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A title's text with each run-time placeholder (`%s`, `$name`, a template slot) widened to a wildcard. */
function placeholderPattern(parts: string[], table: boolean): string {
	const text = (part: string): string =>
		table
			? part
					.split(/(%%|%[sdifjoOc#$]|\$[A-Za-z_][\w.]*)/u)
					.map((piece, index) => (index % 2 === 0 ? escapeRegExp(piece) : piece === "%%" ? "%" : ".+?"))
					.join("")
			: escapeRegExp(part);
	return parts.map(text).join(".+?");
}

function titleParts(node: Argument | undefined): string[] | undefined {
	if (node?.type === "StringLiteral") return [node.value];
	if (node?.type !== "TemplateLiteral") return undefined;
	const parts = node.quasis.map((quasi) => quasi.value.cooked);
	return parts.every((part): part is string => typeof part === "string") ? parts : undefined;
}

/** Expand only literal scalar tables and %s titles, never executing a test module. */
function tableTitles(table: Expression, title: string): string[] | undefined {
	let rows = table;
	while (rows.type === "TSAsExpression" || rows.type === "TSSatisfiesExpression") rows = rows.expression;
	if (rows.type !== "ArrayExpression") return undefined;
	if (title.replace(/%%|%s/gu, "").includes("%")) return undefined;
	const names: string[] = [];
	for (const row of rows.elements) {
		if (row?.type !== "StringLiteral" && row?.type !== "NumericLiteral" && row?.type !== "BooleanLiteral") {
			return undefined;
		}
		let used = false;
		names.push(
			title.replace(/%%|%s/gu, (token) => {
				if (token === "%%") return "%";
				if (used) return token;
				used = true;
				return String(row.value);
			}),
		);
	}
	return names;
}

/** `process.platform === "win32" ? A : B` picks its branch for the platform the guard runs on, as the suite did. */
function platformBranch(expression: Expression): Expression {
	if (expression.type !== "ConditionalExpression" || expression.test.type !== "BinaryExpression") return expression;
	const { operator, left, right } = expression.test;
	if (!["===", "!==", "==", "!="].includes(operator) || left.type === "PrivateName") return expression;
	const isPlatform = (side: Expression): boolean =>
		side.type === "MemberExpression" &&
		!side.computed &&
		side.object.type === "Identifier" &&
		side.object.name === "process" &&
		side.property.type === "Identifier" &&
		side.property.name === "platform";
	const literal = left.type === "StringLiteral" ? left : right.type === "StringLiteral" ? right : undefined;
	if (!literal || !(isPlatform(left) || isPlatform(right))) return expression;
	const equal = process.platform === literal.value;
	return platformBranch(equal === operator.startsWith("=") ? expression.consequent : expression.alternate);
}

/**
 * Map each declared test to its explicit timeout, keyed by the fully qualified
 * `scope > name` it is reported under, and list the declared timeouts that could
 * not be evaluated statically.
 *
 * The key is always qualified. Recording a scoped declaration under its bare
 * terminal name too would lend that budget to a same-named test in a sibling
 * scope that declared none, scoring it against a timeout it never had.
 *
 * The source is parsed, never executed. A declaration is a call whose callee is
 * `test`, `it`, `describe`, `suite`, or a local alias bound to one, followed by
 * any chain of vitest modifiers (`.skip`, `.concurrent`, `.skipIf(cond)`,
 * `.runIf(cond)`, `.each(rows)`, ...). Its budget is the numeric third argument
 * or the `timeout` of an options object, else the nearest enclosing suite's,
 * which is how vitest itself inherits suite options. Callbacks nested inside a
 * test, such as a `setTimeout` or a poll helper, are never declarations.
 */
export function declaredBudgets(source: string, file?: string): DeclaredBudgets {
	const budgets: DeclaredBudgets = { timeouts: new Map(), unresolved: new Set(), patterns: [] };
	const program = parseModule(source, file);
	if (!program) return budgets;
	const scope = moduleScope(program, file);
	const evaluator = new ConstantEvaluator();
	const aliases = new Map<string, Declarer["kind"]>();

	const declarer = (callee: Callee | MemberObject): Declarer | undefined => {
		if (callee.type === "Identifier") {
			const kind = ROOT_DECLARERS.get(callee.name) ?? aliases.get(callee.name);
			return kind ? { kind } : undefined;
		}
		if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
			const base = declarer(callee.object);
			return base && PLAIN_MODIFIERS.has(callee.property.name) ? base : undefined;
		}
		if (
			callee.type === "CallExpression" &&
			callee.callee.type === "MemberExpression" &&
			!callee.callee.computed &&
			callee.callee.property.type === "Identifier"
		) {
			const base = declarer(callee.callee.object);
			const modifier = callee.callee.property.name;
			if (!base) return undefined;
			if (CONDITION_MODIFIERS.has(modifier)) return base;
			const table = unwrapExpression(callee.arguments[0]);
			if (TABLE_MODIFIERS.has(modifier) && table && !base.table) return { ...base, table };
		}
		return undefined;
	};
	const aliasKind = (init: Expression): Declarer["kind"] | undefined => {
		if (init.type === "ConditionalExpression") return aliasKind(init.consequent) ?? aliasKind(init.alternate);
		if (init.type === "LogicalExpression") return aliasKind(init.left) ?? aliasKind(init.right);
		return declarer(init)?.kind;
	};
	for (const [name, init] of scope.constants) {
		const kind = init ? aliasKind(init) : undefined;
		if (kind) aliases.set(name, kind);
	}

	const evaluateTimeout = (expression: Expression | PropertyValue): DeclaredTimeout | undefined => {
		const chosen = expression.type === "ConditionalExpression" ? platformBranch(expression) : expression;
		// `cond ? BUDGET : undefined` declares no budget on the branch vitest takes here.
		if (chosen.type === "Identifier" && chosen.name === "undefined") return undefined;
		return { value: evaluator.evaluate(chosen, scope) };
	};
	const timeoutOf = (call: CallExpression): DeclaredTimeout | undefined => {
		const third = unwrapExpression(call.arguments[2]);
		if (third && third.type !== "ArrowFunctionExpression" && third.type !== "FunctionExpression") {
			return evaluateTimeout(third);
		}
		const options = unwrapExpression(call.arguments[1]);
		if (options?.type !== "ObjectExpression") return undefined;
		for (const property of options.properties) {
			if (property.type !== "ObjectProperty" || property.computed) continue;
			const key = property.key.type === "Identifier" ? property.key.name : undefined;
			if (key !== "timeout") continue;
			return evaluateTimeout(property.value);
		}
		return undefined;
	};
	const titlesOf = (call: CallExpression, found: Declarer): Title[] | undefined => {
		const parts = titleParts(call.arguments[0]);
		if (!parts) return undefined;
		const [only] = parts;
		if (parts.length === 1 && only !== undefined) {
			if (!found.table) return [{ exact: only }];
			const expanded = tableTitles(found.table, only);
			if (expanded) return expanded.map((exact) => ({ exact }));
		}
		return [{ pattern: placeholderPattern(parts, found.table !== undefined) }];
	};
	const record = (key: Title[], timeout: DeclaredTimeout): void => {
		const value = timeout.value !== undefined && Number.isFinite(timeout.value) ? timeout.value : undefined;
		if (!key.every((part): part is { exact: string } => "exact" in part)) {
			const source = key.map((part) => ("exact" in part ? escapeRegExp(part.exact) : part.pattern)).join(" > ");
			budgets.patterns.push({ pattern: new RegExp(`^${source}$`, "u"), timeoutMs: value });
			return;
		}
		const exact = key.map((part) => part.exact).join(" > ");
		if (value === undefined) {
			if (!budgets.timeouts.has(exact)) budgets.unresolved.add(exact);
			return;
		}
		budgets.unresolved.delete(exact);
		const previous = budgets.timeouts.get(exact);
		budgets.timeouts.set(exact, previous === undefined ? value : Math.min(previous, value));
	};

	/** Enclosing suites as the title(s) each can report under; `undefined` when a title cannot be read. */
	const scopes: (Title[] | undefined)[] = [];
	const suiteTimeouts: (DeclaredTimeout | undefined)[] = [];
	const qualified = (titles: Title[]): Title[][] | undefined => {
		let paths: Title[][] = [[]];
		for (const level of scopes) {
			if (!level) return undefined;
			paths = paths.flatMap((path) => level.map((title) => [...path, title]));
		}
		return paths.flatMap((path) => titles.map((title) => [...path, title]));
	};
	const onCall = (call: CallExpression, descend: () => void): void => {
		const found = call.callee.type === "V8IntrinsicIdentifier" ? undefined : declarer(call.callee);
		if (!found) {
			descend();
			return;
		}
		const titles = titlesOf(call, found);
		const own = timeoutOf(call);
		if (found.kind === "describe") {
			scopes.push(titles);
			suiteTimeouts.push(own);
			for (const argument of call.arguments) visit(argument, onCall, () => {});
			scopes.pop();
			suiteTimeouts.pop();
			return;
		}
		let inherited = own;
		for (let level = suiteTimeouts.length - 1; inherited === undefined && level >= 0; level--) {
			inherited = suiteTimeouts[level];
		}
		const keys = titles ? qualified(titles) : undefined;
		if (inherited && keys) for (const key of keys) record(key, inherited);
	};
	for (const statement of program.body) visit(statement, onCall, () => {});
	return budgets;
}

/** Explicit per-test budgets by qualified `scope > name`; see {@link declaredBudgets}. */
export function declaredTimeouts(source: string, file?: string): Map<string, number> {
	return declaredBudgets(source, file).timeouts;
}

type ExplicitBudget = { kind: "explicit"; timeoutMs: number } | { kind: "unresolved" };

/**
 * Look a sample's explicit budget up by its qualified name. There is
 * deliberately no bare-name fallback: a declaration this scan could not qualify
 * degrades to the suite default rather than borrowing the budget of a same-named
 * test declared elsewhere in the file.
 */
function timeoutIndex(rootDir: string): (file: string, fullName: string) => ExplicitBudget | undefined {
	const cache = new Map<string, DeclaredBudgets>();
	return (file, fullName) => {
		if (!file) return undefined;
		let declared = cache.get(file);
		if (!declared) {
			const path = resolve(rootDir, file);
			declared = existsSync(path)
				? declaredBudgets(readFileSync(path, "utf8"), path)
				: { timeouts: new Map(), unresolved: new Set(), patterns: [] };
			cache.set(file, declared);
		}
		const timeoutMs = declared.timeouts.get(fullName);
		if (timeoutMs !== undefined) return { kind: "explicit", timeoutMs };
		if (declared.unresolved.has(fullName)) return { kind: "unresolved" };
		// A run-time title can match more than one declaration; keep the tightest budget, as for exact names.
		const matches = declared.patterns.filter((entry) => entry.pattern.test(fullName));
		const resolved = matches.flatMap((entry) => (entry.timeoutMs === undefined ? [] : [entry.timeoutMs]));
		if (resolved.length > 0) return { kind: "explicit", timeoutMs: Math.min(...resolved) };
		return matches.length > 0 ? { kind: "unresolved" } : undefined;
	};
}

/** Minimal shape of a resolved vitest config, enough to find a project's budget. */
interface VitestConfigShape {
	test?: { name?: string; testTimeout?: number; projects?: VitestConfigShape[] };
}

// Windows resolves executables through PATHEXT, which is conventionally
// uppercase (`.EXE;.CMD`), and its filesystems match names case-insensitively.
// The binary checks must match the same way, or a resolved `bun.EXE` head is
// not recognised as the runtime and the gate silently disables on Windows.
const NPM_BINARY = /^(?:npm|npx)(?:\.cmd|\.exe)?$/iu;
const VITEST_BINARY = /^vitest(?:\.cmd|\.exe)?$/iu;
const BUN_BINARY = /^bunx?(?:\.exe)?$/iu;

function flag(args: string[], name: string): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
		if (arg === name && args[index + 1]) return args[index + 1];
	}
	return undefined;
}

/** Resolve `npm run [--workspace=X] <script>` to its manifest directory and name. */
function scriptInvocation(command: string[]): { cwd: string; name: string } | undefined {
	if (!NPM_BINARY.test(basename(command[0] ?? ""))) return undefined;
	const rest = command.slice(1);
	if (rest[0] !== "run") return undefined;
	const workspace = flag(rest, "--workspace") ?? flag(rest, "-w");
	const name = rest.slice(1).find((arg) => !arg.startsWith("-") && arg !== workspace);
	if (!name) return undefined;
	// Workspace names are resolved through the root manifest's `workspaces` glob
	// only in the one shape this repository uses.
	const cwd =
		workspace === undefined
			? "."
			: workspace.startsWith("@bastani/")
				? `packages/${workspace === "@bastani/atomic" ? "coding-agent" : workspace.slice("@bastani/".length)}`
				: workspace;
	return { cwd, name };
}

async function readConfiguredTimeout(
	rootDir: string,
	cwd: string,
	project: string | undefined,
): Promise<number | undefined> {
	for (const candidate of ["vitest.config.ts", "vitest.config.mts", "vitest.config.js"]) {
		const path = resolve(rootDir, cwd, candidate);
		if (!existsSync(path)) continue;
		const module = (await import(pathToFileURL(path).href)) as { default?: VitestConfigShape };
		const config = module.default;
		if (!config?.test) return undefined;
		const projects = config.test.projects ?? [];
		if (project !== undefined) {
			const match = projects.find((entry) => entry.test?.name === project);
			return match?.test?.testTimeout ?? config.test.testTimeout;
		}
		// No `--project`: every project must agree, or the suite has no single
		// budget to score against and the gate stays off rather than picking one.
		if (projects.length > 0) {
			const budgets = new Set(projects.map((entry) => entry.test?.testTimeout));
			return budgets.size === 1 ? [...budgets][0] : undefined;
		}
		return config.test.testTimeout;
	}
	return undefined;
}

/**
 * Resolve the per-test budget a command actually runs with, following one
 * `npm run <script>` indirection into package.json and then into the vitest
 * config that script selects. Returns undefined when the command declares no
 * budget, which disables the gate rather than inventing one.
 *
 * Only a vitest invocation is read for a budget, whichever runtime hosts it: a
 * leading `bun`/`bunx` (with its own flags, and an optional `run`/`x`) is the
 * runtime, not the command. A command that is not vitest has no `testTimeout`,
 * and scoring its output against one would report drift against a ceiling
 * nothing enforces.
 */
export async function resolveDefaultTimeoutMs(
	command: string[],
	rootDir: string = process.cwd(),
): Promise<number | undefined> {
	let args = command;
	let cwd = ".";
	const script = scriptInvocation(command);
	if (script) {
		const manifestPath = resolve(rootDir, script.cwd, "package.json");
		if (!existsSync(manifestPath)) return undefined;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> };
		const line = manifest.scripts?.[script.name];
		if (!line) return undefined;
		args = line.split(/\s+/u).filter((part) => part !== "");
		cwd = script.cwd;
	}
	let head = args[0] ?? "";
	if (NPM_BINARY.test(basename(head)) && basename(head).startsWith("npx")) {
		args = args.slice(1).filter((arg) => arg !== "--no-install" && arg !== "-y");
		head = args[0] ?? "";
	}
	// `bun --bun vitest ...` is still a vitest invocation, and the one the
	// Bun runtime a suite may be launched with. Dropping the runtime
	// prefix keeps the gate on for it; without this the guard would read `bun`,
	// find no budget, and silently stop scoring the suite that needs Bun most.
	//
	// Only the runtime's *own* leading flags are dropped. Filtering every `-`
	// argument would also swallow the `--project` that selects the budget, and
	// the gate would then average whichever projects happened to agree.
	if (BUN_BINARY.test(basename(head))) {
		args = args.slice(1);
		while (args[0]?.startsWith("-")) args = args.slice(1);
		if (args[0] === "run" || args[0] === "x") args = args.slice(1);
		head = args[0] ?? "";
	}
	if (!VITEST_BINARY.test(basename(head))) return undefined;
	return readConfiguredTimeout(rootDir, cwd, flag(args.slice(1), "--project"));
}

/** Join durations to budgets and identify samples needing a warning. */
export function evaluateDurations(
	reportJson: string,
	defaultTimeoutMs: number | undefined,
	rootDir: string = process.cwd(),
): DurationGuardReport {
	const lookup = timeoutIndex(rootDir);
	const samples: BudgetedSample[] = [];
	for (const sample of parseVitestReport(reportJson, rootDir)) {
		const explicitBudget = lookup(sample.file, sample.fullName);
		if (explicitBudget?.kind === "unresolved") {
			samples.push({ ...sample, timeoutMs: 0, explicit: true, unresolved: true, ratio: 0 });
			continue;
		}
		const timeoutMs = explicitBudget?.timeoutMs ?? defaultTimeoutMs ?? VITEST_DEFAULT_TIMEOUT_MS;
		samples.push({
			...sample,
			timeoutMs,
			explicit: explicitBudget !== undefined,
			unresolved: false,
			ratio: timeoutMs > 0 ? sample.durationMs / timeoutMs : 0,
		});
	}
	samples.sort((left, right) => right.ratio - left.ratio);
	const enabled = defaultTimeoutMs !== undefined;
	const warnings = enabled ? samples.filter((sample) => sample.ratio >= WARN_RATIO) : [];
	const unresolved = samples.filter((sample) => sample.unresolved);
	// A suite that ran tests yet yielded no durations has not been measured. An
	// empty sample set is otherwise indistinguishable from a healthy run, which
	// is exactly how a silently disabled gate survives. Under the JSON reporter
	// this can only mean the harness broke: it emits a record per test.
	const ranTests = reportedTestCount(reportJson);
	const blind = enabled && ranTests > 0 && samples.length === 0;
	return { enabled, defaultTimeoutMs, ranTests, blind, samples, warnings, unresolved };
}

function row(sample: BudgetedSample): string {
	const cell = (value: string): string => value.replaceAll("|", "\\|");
	const percent = sample.unresolved ? "n/a" : `${(sample.ratio * 100).toFixed(1)} %`;
	const budget = `${sample.unresolved ? "unresolved" : `${sample.timeoutMs} ms`}${sample.explicit ? " (explicit)" : ""}`;
	return `| ${percent} | ${sample.durationMs.toFixed(2)} ms | ${budget} | ${cell(sample.file)} | ${cell(sample.fullName)} |`;
}

/** Render the slowest samples as a Markdown table for artifacts and summaries. */
export function renderDurationTable(report: DurationGuardReport, limit = 40): string {
	const header = [
		`Default per-test timeout: ${report.defaultTimeoutMs === undefined ? "not declared (gate disabled)" : `${report.defaultTimeoutMs} ms`}`,
		`Warn at ${WARN_RATIO * 100} % of budget; duration headroom is advisory. Samples: ${report.samples.length} of ${report.ranTests} test(s) run.`,
		"",
		"| Budget used | Duration | Timeout | File | Test |",
		"|---|---|---|---|---|",
	];
	// Unresolved budgets sort last (their ratio is unknown), so list them after the slowest rows.
	const scored = report.samples.filter((sample) => !sample.unresolved).slice(0, limit);
	const rows = [...scored, ...report.unresolved].map(row);
	const empty = report.blind
		? "| n/a | n/a | n/a | n/a | tests ran but the reporter emitted no durations |"
		: "| n/a | n/a | n/a | n/a | no duration samples parsed |";
	return [...header, ...(rows.length > 0 ? rows : [empty])].join("\n");
}
