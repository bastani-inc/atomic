import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "@babel/parser";
import { test } from "vitest";
import { moduleDir, readText } from "../helpers/runtime.js";

/**
 * Pool, coordinator, handoff and infrastructure code decides what a failure is by its type and code, never by its
 * message (#4327). This scan rejects message classification in every form the pool once used: equality, prefix and
 * substring checks, regular expressions, lookups keyed by a message, aliases of a message and text derived from one or
 * from an error (`String(error)`, `${error}`, `error.toString()`, `.stack`, string methods, casts, `??` and ternaries),
 * IPC errors flattened to their message, compared to text or rebuilt from it, and the retired classifier symbols and
 * message strings. Presenting a message (a health notice, a run's error text) and wrapping a non-error stay allowed.
 */

const root = join(moduleDir(import.meta.url), "../..");
const workflows = join(root, "packages/workflows/src");

const RETIRED = new Set([
	"FAULT_PATTERNS",
	"workflowInfrastructureFault",
	"asWorkflowInfrastructureError",
	"infrastructureFaultMessage",
	"failedOnInfrastructureFault",
	"STALE_WORK_LEASE",
	"BUSY_SESSION",
	"isRootLeaseLost",
]);
const TEXT_TESTS = new Set([
	"startsWith",
	"endsWith",
	"includes",
	"indexOf",
	"lastIndexOf",
	"match",
	"matchAll",
	"search",
	"localeCompare",
]);
const COMPARISONS = new Set(["===", "!==", "==", "!="]);

type Node = { readonly type: string; readonly loc?: { readonly start: { readonly line: number } } } & Record<
	string,
	unknown
>;

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function children(node: Node): Node[] {
	const found: Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
		if (Array.isArray(value)) for (const item of value) if (isNode(item)) found.push(item);
		if (isNode(value)) found.push(value);
	}
	return found;
}

function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	for (const child of children(node)) walk(child, visit);
}

function propertyName(node: Node): string | undefined {
	if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return undefined;
	const property = node.property as Node;
	if (node.computed !== true && property.type === "Identifier") return property.name as string;
	if (property.type === "StringLiteral") return property.value as string;
	return undefined;
}

function unwrap(node: Node): Node {
	let current = node;
	while (
		current.type === "TSAsExpression" ||
		current.type === "TSNonNullExpression" ||
		current.type === "ParenthesizedExpression" ||
		current.type === "TSSatisfiesExpression"
	)
		current = current.expression as Node;
	return current;
}

function isAbsent(comparison: Node): boolean {
	return [comparison.left, comparison.right].some((side) => {
		const operand = unwrap(side as Node);
		return operand.type === "NullLiteral" || (operand.type === "Identifier" && operand.name === "undefined");
	});
}

function isStringParameter(node: Node): boolean {
	const annotation = (node.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined;
	return node.type === "Identifier" && annotation?.type === "TSStringKeyword";
}

/** String methods whose result still carries the text they were called on. */
const TEXT_TRANSFORMS = new Set([
	"toLowerCase",
	"toUpperCase",
	"toLocaleLowerCase",
	"toLocaleUpperCase",
	"trim",
	"trimStart",
	"trimEnd",
	"slice",
	"substring",
	"replace",
	"replaceAll",
	"normalize",
	"split",
	"at",
]);
/** Functions that render a value as text: `inspect(error)` and `format(error)` read an error's message. */
const TEXT_RENDERERS = new Set(["inspect", "format"]);
/** Names the pool's errors and refusals go by: `String(error)`, `${error}` and `error.toString()` read their text. */
const ERROR_NAMES = /^(e|err|error|cause|failure|refusal|rejection|thrown|reason)$/;
/** Message text, by the strings the pool once classified by. Scanned sources never spell them again. */
const RETIRED_TEXT = [
	"Stale work lease",
	"Pool not initialized",
	"Stale lease for run",
	"outside the work subtree",
	"already processing",
];

function keyName(key: Node): string | undefined {
	if (key.type === "Identifier") return key.name as string;
	if (key.type === "StringLiteral") return key.value as string;
	return undefined;
}

/** Identifiers that hold an error: catch parameters, and bindings with an error's usual names. */
function errorBindings(program: Node): Set<string> {
	const bound = new Set<string>();
	walk(program, (node) => {
		if (node.type === "CatchClause" && isNode(node.param) && node.param.type === "Identifier")
			bound.add(node.param.name as string);
		if (node.type === "Identifier" && ERROR_NAMES.test(node.name as string)) bound.add(node.name as string);
	});
	return bound;
}

interface TextSources {
	/** Identifiers bound to a message's text, however it was derived. */
	readonly messages: Set<string>;
	/** Identifiers bound to an IPC message's `error` member. */
	readonly ipcErrors: Set<string>;
	readonly errors: Set<string>;
}

/** Whether `value` is an error's message, or text derived from it or from an error. */
function derivesFromMessage(value: unknown, sources: TextSources): boolean {
	if (!isNode(value)) return false;
	const node = unwrap(value);
	const derived = (child: unknown) => derivesFromMessage(child, sources);
	switch (node.type) {
		case "Identifier":
			return sources.messages.has(node.name as string);
		case "MemberExpression":
		case "OptionalMemberExpression": {
			const property = propertyName(node);
			return property === "message" || property === "stack";
		}
		case "LogicalExpression":
			return derived(node.left) || derived(node.right);
		case "ConditionalExpression":
			return derived(node.consequent) || derived(node.alternate);
		case "BinaryExpression":
			return node.operator === "+" && (derived(node.left) || derived(node.right));
		case "TemplateLiteral":
			return (node.expressions as Node[]).some((expression) => {
				const inner = unwrap(expression);
				return derived(inner) || (inner.type === "Identifier" && sources.errors.has(inner.name as string));
			});
		case "CallExpression":
		case "OptionalCallExpression": {
			const callee = unwrap(node.callee as Node);
			const [first] = node.arguments as Node[];
			const fromError = (argument: Node) =>
				derived(argument) || (argument.type === "Identifier" && sources.errors.has(argument.name as string));
			const named = callee.type === "Identifier" ? (callee.name as string) : propertyName(callee);
			if (named !== undefined && TEXT_RENDERERS.has(named))
				return (node.arguments as Node[]).some((argument) => fromError(unwrap(argument)));
			const receiver = isNode(callee.object) ? unwrap(callee.object) : undefined;
			if (named === "get" && receiver?.type === "Identifier" && receiver.name === "Reflect") {
				const key = (node.arguments as Node[])[1];
				return key !== undefined && isText(key) && /^(message|stack)$/.test(textOf(unwrap(key)));
			}
			if (callee.type === "Identifier") {
				if (callee.name === "String" && first !== undefined) return fromError(unwrap(first));
				return /message/i.test(callee.name as string);
			}
			const method = propertyName(callee);
			const object = isNode(callee.object) ? unwrap(callee.object) : undefined;
			if (method === "toString")
				return (
					object !== undefined &&
					(derived(object) || (object.type === "Identifier" && sources.errors.has(object.name as string)))
				);
			return method !== undefined && TEXT_TRANSFORMS.has(method) && derived(object);
		}
		default:
			return false;
	}
}

/** The parameter names of each function the file names: declarations, and functions bound to a `const`. */
function declaredFunctions(program: Node): Map<string, readonly (string | undefined)[]> {
	const functions = new Map<string, readonly (string | undefined)[]>();
	const parameters = (fn: Node) =>
		(fn.params as Node[]).map((parameter) =>
			parameter.type === "Identifier" ? (parameter.name as string) : undefined,
		);
	walk(program, (node) => {
		if (node.type === "FunctionDeclaration" && isNode(node.id))
			functions.set(node.id.name as string, parameters(node));
		if (node.type === "VariableDeclarator" && isNode(node.id) && node.id.type === "Identifier" && isNode(node.init)) {
			const init = unwrap(node.init);
			if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")
				functions.set(node.id.name as string, parameters(init));
		}
	});
	return functions;
}

/**
 * Names bound to message text, to a fixpoint: `const m = e.message`, `{ message } = e`, `{ message: m } = e`,
 * `const text = String(error)`, `message: string` parameters, parameters a call in the file passes such text to, and
 * anything derived from those; and names bound to an IPC message's `error` member.
 */
function textSources(program: Node): TextSources {
	const sources: TextSources = { messages: new Set(), ipcErrors: new Set(), errors: errorBindings(program) };
	walk(program, (node) => {
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression" ||
			node.type === "ClassMethod"
		)
			for (const parameter of node.params as Node[])
				if (isStringParameter(parameter) && /message/i.test(parameter.name as string))
					sources.messages.add(parameter.name as string);
	});
	const functions = declaredFunctions(program);
	for (let size = -1; size !== sources.messages.size + sources.ipcErrors.size; ) {
		size = sources.messages.size + sources.ipcErrors.size;
		walk(program, (node) => {
			if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
			const callee = unwrap(node.callee as Node);
			const parameters = callee.type === "Identifier" ? functions.get(callee.name as string) : undefined;
			(node.arguments as Node[]).forEach((argument, index) => {
				const parameter = parameters?.[index];
				if (parameter !== undefined && derivesFromMessage(argument, sources)) sources.messages.add(parameter);
			});
		});
		walk(program, (node) => {
			if (node.type !== "VariableDeclarator" && node.type !== "AssignmentExpression") return;
			const target = (node.type === "VariableDeclarator" ? node.id : node.left) as Node;
			const value = (node.type === "VariableDeclarator" ? node.init : node.right) as Node | null;
			if (target.type === "Identifier" && value) {
				if (derivesFromMessage(value, sources)) sources.messages.add(target.name as string);
				if (propertyName(unwrap(value)) === "error") sources.ipcErrors.add(target.name as string);
			}
			if (target.type === "ObjectPattern")
				for (const property of target.properties as Node[]) {
					if (property.type !== "ObjectProperty") continue;
					const bound = unwrap(property.value as Node);
					const name = keyName(property.key as Node);
					if ((name === "message" || name === "stack") && bound.type === "Identifier")
						sources.messages.add(bound.name as string);
				}
		});
	}
	return sources;
}

function textOf(node: Node): string {
	if (node.type === "StringLiteral") return node.value as string;
	return (node.quasis as Node[]).map((quasi) => (quasi.value as { readonly raw: string }).raw).join("");
}

function isText(node: Node): boolean {
	const operand = unwrap(node);
	return operand.type === "StringLiteral" || operand.type === "TemplateLiteral";
}

function isIpcError(node: Node, sources: TextSources): boolean {
	const operand = unwrap(node);
	return (
		propertyName(operand) === "error" ||
		(operand.type === "Identifier" && sources.ipcErrors.has(operand.name as string))
	);
}

interface Violation {
	readonly line: number;
	readonly rule: string;
}

/** Message classification in `source`, by rule and line. */
function messageClassification(source: string): Violation[] {
	const program = parse(source, { sourceType: "module", plugins: ["typescript"], allowReturnOutsideFunction: true })
		.program as unknown as Node;
	const sources = textSources(program);
	const isMessage = (value: unknown): boolean => derivesFromMessage(value, sources);
	const violations: Violation[] = [];
	const report = (node: Node, rule: string) => violations.push({ line: node.loc?.start.line ?? 0, rule });
	walk(program, (node) => {
		if (node.type === "Identifier" && RETIRED.has(node.name as string)) report(node, "retired-symbol");
		const text =
			node.type === "StringLiteral"
				? (node.value as string)
				: node.type === "TemplateElement"
					? ((node.value as { readonly raw: string }).raw ?? "")
					: undefined;
		if (text !== undefined && RETIRED_TEXT.some((retired) => text.includes(retired))) report(node, "retired-text");
		// A comparison with `undefined` or `null` asks whether a message is there, not what it says.
		if (node.type === "BinaryExpression" && COMPARISONS.has(node.operator as string) && !isAbsent(node)) {
			if (isMessage(node.left) || isMessage(node.right)) report(node, "message-equality");
			else if (
				(isIpcError(node.left as Node, sources) && isText(node.right as Node)) ||
				(isIpcError(node.right as Node, sources) && isText(node.left as Node))
			)
				report(node, "ipc-error-compared-to-text");
		}
		if (node.type === "BinaryExpression" && node.operator === "in" && isMessage(node.left))
			report(node, "message-membership");
		if (node.type === "SwitchStatement" && isMessage(node.discriminant)) report(node, "message-switch");
		if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && node.computed === true)
			if (isMessage(node.property)) report(node, "message-membership");
		if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
			const callee = unwrap(node.callee as Node);
			const method = propertyName(callee);
			const args = node.arguments as Node[];
			if (method !== undefined && TEXT_TESTS.has(method) && isMessage(callee.object))
				report(node, "message-text-test");
			else if (
				(method === "has" || method === "includes" || method === "indexOf" || method === "get") &&
				args.some(isMessage)
			)
				report(node, "message-membership");
			if ((method === "test" || method === "exec") && args.some(isMessage)) report(node, "message-regex");
		}
		if (node.type === "ObjectProperty" && keyName(node.key as Node) === "error" && isMessage(node.value))
			report(node, "ipc-error-as-message");
		if (node.type === "NewExpression" && unwrap(node.callee as Node).type === "Identifier") {
			const [first] = node.arguments as Node[];
			if ((node.callee as Node).name === "Error" && first && isIpcError(first, sources))
				report(node, "ipc-error-rebuilt-from-text");
		}
	});
	return violations;
}

function typescriptFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return typescriptFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** Pool, coordinator, handoff and infrastructure code: every rule applies. */
function poolInventory(): string[] {
	return [
		...typescriptFiles(join(workflows, "workers")),
		...[
			"durable/journal/sql-pool-queue.ts",
			"durable/journal/sql-pool-usage.ts",
			"durable/journal/sql-shared-pool.ts",
			"durable/journal/pool-remote-journal.ts",
			"durable/journal/pool-mutations.ts",
			"durable/journal/pool-checkpoint-index.ts",
			"durable/journal/pool-stage-usage.ts",
			"shared/workflow-infrastructure-error.ts",
			"shared/worker-pool-errors.ts",
			"shared/error-codec.ts",
			"shared/error-cause-chain.ts",
		].map((path) => join(workflows, path)),
	].sort();
}

test("the scan rejects every form of message classification and allows presenting a message (#4327)", () => {
	const rejected: readonly (readonly [string, string])[] = [
		["if (error.message === STALE) throw error;", "message-equality"],
		['if ("Stale work lease" !== error["message"]) return;', "message-equality"],
		["const stale = /stale/i.test(error.message);", "message-regex"],
		["const found = PATTERN.exec((error as Error).message);", "message-regex"],
		['const text = error.message;\nif (text.startsWith("Stale")) throw error;', "message-text-test"],
		["const { message } = error;\nswitch (message) {\n\tcase 'x':\n\t\tbreak;\n}", "message-switch"],
		["const { message: said } = error;\nif (said === 'x') {}", "message-equality"],
		['if (\n\terror\n\t\t.message\n\t\t.includes("Stale")\n) {}', "message-text-test"],
		["function fault(message: string) {\n\treturn PATTERNS.find(([p]) => p.test(message));\n}", "message-regex"],
		['port.send({ kind: "reply", error: error.message });', "ipc-error-as-message"],
		["pending.reject(new Error(reply.error));", "ipc-error-rebuilt-from-text"],
		['import { workflowInfrastructureFault } from "./x.js";', "retired-symbol"],
		["const STALE_WORK_LEASE = 'Stale work lease';", "retired-symbol"],
		["error.message?.match(/x/);", "message-text-test"],
		["if (/Stale work/.test(String(error))) return;", "message-regex"],
		[`if (\`\${error}\`.includes("Stale")) return;`, "message-text-test"],
		['if (error.toString().startsWith("Error: Stale")) return;', "message-text-test"],
		['if (errorMessage(error).includes("stale")) return;', "message-text-test"],
		['const text = reply.error;\nif (text === "stale") return;', "ipc-error-compared-to-text"],
		['if (/stale/i.test(error.stack ?? "")) return;', "message-regex"],
		['const reason = String(failure);\nif (reason.includes("stale")) return;', "message-text-test"],
		[
			"function fault(text: string) {}\ntry {} catch (e) {\n\tconst said = e.message;\n\tPATTERN.test(said);\n}",
			"message-regex",
		],
		['if (error.message.toLowerCase() === "stale work lease") return;', "message-equality"],
		[
			'function isStale(text: string) {\n\treturn text.startsWith("Stale");\n}\ntry {} catch (e) {\n\tisStale(e.message);\n}',
			"message-text-test",
		],
		["const isStale = (text) => /stale/.test(text);\nisStale(String(failure));", "message-regex"],
		['if (Reflect.get(error, "message") === "stale") return;', "message-equality"],
		['if (inspect(error).includes("stale")) return;', "message-text-test"],
		['if (util.format("%s", failure).startsWith("Stale")) return;', "message-text-test"],
		['if (STALE_RE.test((error as Error)?.message ?? "")) return;', "message-regex"],
		["if (KNOWN.has(error.message)) return;", "message-membership"],
		["const kind = KINDS[error.message.trim()];", "message-membership"],
		["if (error.message in KINDS) return;", "message-membership"],
		['const retired = "Stale work lease";', "retired-text"],
		[`throw new Error(\`Pool not initialized for \${root}\`);`, "retired-text"],
	];
	for (const [source, rule] of rejected)
		assert.ok(
			messageClassification(source).some((violation) => violation.rule === rule),
			`${rule} not found in: ${source}`,
		);
	const allowed = [
		'this.reportHealth(log, error.message + "; the worker was retired and replaced");',
		"store.recordNotice({ level: 'warning', message: error.message });",
		'if (event.message.role === "assistant") started.add(handle);',
		'if (message.kind === "control") return;',
		"endPooledChild(store, work.childRunId, error.message);",
		'throw new Error("Stage chat is closed.");',
		"if (isStaleWorkLeaseError(error)) throw error;",
		'if (error.code === "stale_work_lease") throw error;',
		"if (command.message === undefined) throw new Error('missing');",
		"const { message } = command;\nif (message !== undefined && message !== null) send(message);",
		"const reason = /^\\d+$/.test(entry);",
		`reportHealth(log, \`\${e.message}; the worker was retired and replaced\`);`,
		'recordNotice({ message: e.message ?? "" });',
		"throw new Error(String(error));",
		"const failure = error instanceof Error ? error : new Error(String(error));",
		'port.send({ kind: "reply", error: serializeError(error) });',
		'port.send({ kind: "reply", error: result.error });',
		"if (reply.error !== undefined) throw rehydrateError(reply.error);",
		'tracePooledWatch("settled", { error: name, code });',
		`const label = \`\${work.id}:\${error.code}\`;`,
		"function notify(text: string) {\n\tlog.write(text);\n}\nnotify(error.message);",
		'if (Reflect.get(error, "code") === "stale_work_lease") return;',
		"log.write(inspect(error));",
	];
	for (const source of allowed) assert.deepEqual(messageClassification(source), [], source);
});

test("no pool, coordinator, handoff or infrastructure source classifies failures by message (#4327)", async () => {
	const inventory = poolInventory();
	const names = inventory.map((path) => relative(workflows, path).split(sep).join("/"));
	for (const expected of [
		"workers/pool-coordinator.ts",
		"workers/local-pool.ts",
		"workers/local-worker.ts",
		"workers/stage-handoff.ts",
		"workers/stage-watch.ts",
		"workers/resource-admission.ts",
		"durable/journal/sql-pool-queue.ts",
		"shared/workflow-infrastructure-error.ts",
	])
		assert.ok(names.includes(expected), `${expected} is scanned`);
	assert.ok(inventory.length > 40, `the scan covers the whole pool (${inventory.length} files)`);
	const found: string[] = [];
	for (const path of inventory)
		for (const { line, rule } of messageClassification(await readText(path)))
			found.push(`${relative(root, path)}:${line} ${rule}`);
	assert.deepEqual(found, []);
});

test("shared failure classification no longer reaches for the retired infrastructure message classifier (#4327)", async () => {
	for (const path of ["shared/workflow-failures-decisions.ts", "shared/workflow-failures-classifier.ts"]) {
		const retired = messageClassification(await readText(join(workflows, path))).filter(
			(violation) => violation.rule === "retired-symbol",
		);
		assert.deepEqual(retired, [], path);
	}
});
