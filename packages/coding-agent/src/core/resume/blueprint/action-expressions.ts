export type ExpressionObject = { [key: string]: ExpressionValue };
export type ExpressionValue = null | boolean | number | string | ExpressionValue[] | ExpressionObject;

/** What an expression can read. A context name that is not in `roots` is unsupported, never empty. */
export interface ExpressionContext {
	readonly roots: { readonly [name: string]: ExpressionValue };
	/** Whether an earlier step failed, which decides `success()` and `failure()`. */
	readonly failed: boolean;
}

/** An expression uses syntax, a context, a property or a function this evaluator does not implement, or is malformed. */
export class ExpressionError extends Error {
	override readonly name = "ExpressionError" as const;
	readonly problem: string;

	constructor(source: string, problem: string, options?: ErrorOptions) {
		super(`${problem} in "${source.trim().slice(0, 80)}"`, options);
		this.problem = problem;
	}
}

const closedObjects = new WeakMap<ExpressionObject, string>();

/** An object whose properties are all known: reading another one is an unsupported property, not null. */
export function closedObject(label: string, properties: ExpressionObject): ExpressionObject {
	closedObjects.set(properties, label);
	return properties;
}

type Punctuation = "(" | ")" | "[" | "]" | "." | "," | "!" | "==" | "!=" | "&&" | "||";
type Token =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "symbol"; readonly value: Punctuation };

type Node =
	| { readonly kind: "literal"; readonly value: ExpressionValue }
	| { readonly kind: "context"; readonly name: string }
	| { readonly kind: "member"; readonly object: Node; readonly property: string }
	| { readonly kind: "index"; readonly object: Node; readonly index: Node }
	| { readonly kind: "call"; readonly name: string; readonly args: readonly Node[] }
	| { readonly kind: "not"; readonly operand: Node }
	| { readonly kind: "equality"; readonly negated: boolean; readonly left: Node; readonly right: Node }
	| { readonly kind: "logical"; readonly operator: "&&" | "||"; readonly left: Node; readonly right: Node };

const TOKEN_PATTERN =
	/(?<number>-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?))|(?<string>'(?:[^']|'')*')|(?<name>[a-z_][a-z0-9_-]*)|(?<symbol>==|!=|&&|\|\||[()[\].,!])/iy;

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	const pattern = new RegExp(TOKEN_PATTERN);
	let position = 0;
	for (;;) {
		while (/\s/.test(source.charAt(position))) position++;
		if (position >= source.length) return tokens;
		pattern.lastIndex = position;
		const groups = pattern.exec(source)?.groups;
		if (groups === undefined) {
			throw new ExpressionError(source, `unsupported syntax near "${source.slice(position, position + 12)}"`);
		}
		position = pattern.lastIndex;
		if (groups.number !== undefined) tokens.push({ kind: "number", value: Number(groups.number) });
		else if (groups.string !== undefined) {
			tokens.push({ kind: "string", value: groups.string.slice(1, -1).replaceAll("''", "'") });
		} else if (groups.name !== undefined) tokens.push({ kind: "name", value: groups.name });
		else tokens.push({ kind: "symbol", value: groups.symbol as Punctuation });
	}
}

interface FunctionDefinition {
	readonly min: number;
	readonly max: number;
	readonly call: (args: ExpressionValue[], context: ExpressionContext, source: string) => ExpressionValue;
}

const STATUS_FUNCTIONS: ReadonlySet<string> = new Set(["always", "success", "failure", "cancelled"]);

const FUNCTIONS: Readonly<Record<string, FunctionDefinition>> = {
	contains: {
		min: 2,
		max: 2,
		call: ([search, item]) =>
			Array.isArray(search)
				? search.some((element) => looselyEqual(element, item))
				: toText(search).toLowerCase().includes(toText(item).toLowerCase()),
	},
	startswith: {
		min: 2,
		max: 2,
		call: ([text, prefix]) => toText(text).toLowerCase().startsWith(toText(prefix).toLowerCase()),
	},
	endswith: {
		min: 2,
		max: 2,
		call: ([text, suffix]) => toText(text).toLowerCase().endsWith(toText(suffix).toLowerCase()),
	},
	format: {
		min: 1,
		max: Number.POSITIVE_INFINITY,
		call: ([template, ...values], _context, source) => formatText(source, toText(template), values),
	},
	join: {
		min: 1,
		max: 2,
		call: ([values, separator]) =>
			Array.isArray(values)
				? values.map(toText).join(separator === undefined ? "," : toText(separator))
				: toText(values),
	},
	tojson: { min: 1, max: 1, call: ([value]) => JSON.stringify(value, null, 2) },
	fromjson: {
		min: 1,
		max: 1,
		call: ([text], _context, source) => {
			try {
				return JSON.parse(toText(text)) as ExpressionValue;
			} catch (error) {
				throw new ExpressionError(source, "fromJSON was given text that is not JSON", { cause: error });
			}
		},
	},
	always: { min: 0, max: 0, call: () => true },
	success: { min: 0, max: 0, call: (_args, context) => !context.failed },
	failure: { min: 0, max: 0, call: (_args, context) => context.failed },
	cancelled: { min: 0, max: 0, call: () => false },
};

function formatText(source: string, template: string, values: readonly ExpressionValue[]): string {
	let result = "";
	for (let position = 0; position < template.length; position++) {
		const character = template.charAt(position);
		const next = template.charAt(position + 1);
		if (character === "{" && next === "{") {
			result += "{";
			position++;
		} else if (character === "}" && next === "}") {
			result += "}";
			position++;
		} else if (character === "{") {
			const close = template.indexOf("}", position);
			const index = close === -1 ? "" : template.slice(position + 1, close);
			if (!/^\d+$/.test(index) || Number(index) >= values.length) {
				throw new ExpressionError(source, "format was given a placeholder it cannot fill");
			}
			result += toText(values[Number(index)] ?? null);
			position = close;
		} else if (character === "}") {
			throw new ExpressionError(source, "format was given an unmatched }");
		} else result += character;
	}
	return result;
}

function parse(source: string): Node {
	const tokens = tokenize(source);
	let position = 0;

	function fail(problem: string): never {
		throw new ExpressionError(source, problem);
	}

	function takeSymbol(...symbols: Punctuation[]): Punctuation | undefined {
		const token = tokens[position];
		if (token?.kind !== "symbol" || !symbols.includes(token.value)) return undefined;
		position++;
		return token.value;
	}

	function expectSymbol(symbol: Punctuation): void {
		if (takeSymbol(symbol) === undefined) fail(`expected "${symbol}"`);
	}

	function parseCall(name: string): Node {
		const key = name.toLowerCase();
		const definition = Object.hasOwn(FUNCTIONS, key) ? FUNCTIONS[key] : undefined;
		if (definition === undefined) return fail(`unsupported function ${name}`);
		const args: Node[] = [];
		if (takeSymbol(")") === undefined) {
			args.push(parseOr());
			while (takeSymbol(",") !== undefined) args.push(parseOr());
			expectSymbol(")");
		}
		if (args.length < definition.min || args.length > definition.max) {
			fail(`${name} was given ${args.length} arguments`);
		}
		return { kind: "call", name: key, args };
	}

	function parsePrimary(): Node {
		const token = tokens[position++];
		if (token === undefined) return fail("expected a value");
		if (token.kind === "number" || token.kind === "string") return { kind: "literal", value: token.value };
		if (token.kind === "name") {
			const keyword = token.value.toLowerCase();
			if (keyword === "true") return { kind: "literal", value: true };
			if (keyword === "false") return { kind: "literal", value: false };
			if (keyword === "null") return { kind: "literal", value: null };
			return takeSymbol("(") === undefined ? { kind: "context", name: token.value } : parseCall(token.value);
		}
		if (token.value !== "(") return fail(`unexpected "${token.value}"`);
		const inner = parseOr();
		expectSymbol(")");
		return inner;
	}

	function parsePostfix(): Node {
		let node = parsePrimary();
		for (;;) {
			if (takeSymbol(".") !== undefined) {
				const property = tokens[position++];
				if (property?.kind !== "name") return fail('expected a property name after "."');
				node = { kind: "member", object: node, property: property.value };
			} else if (takeSymbol("[") !== undefined) {
				const index = parseOr();
				expectSymbol("]");
				node = { kind: "index", object: node, index };
			} else return node;
		}
	}

	function parseUnary(): Node {
		return takeSymbol("!") === undefined ? parsePostfix() : { kind: "not", operand: parseUnary() };
	}

	function parseEquality(): Node {
		let left = parseUnary();
		for (let operator = takeSymbol("==", "!="); operator !== undefined; operator = takeSymbol("==", "!=")) {
			left = { kind: "equality", negated: operator === "!=", left, right: parseUnary() };
		}
		return left;
	}

	function parseAnd(): Node {
		let left = parseEquality();
		while (takeSymbol("&&") !== undefined) left = { kind: "logical", operator: "&&", left, right: parseEquality() };
		return left;
	}

	function parseOr(): Node {
		let left = parseAnd();
		while (takeSymbol("||") !== undefined) left = { kind: "logical", operator: "||", left, right: parseAnd() };
		return left;
	}

	const tree = parseOr();
	if (position < tokens.length) fail("unexpected input after the expression");
	return tree;
}

function typeOf(value: ExpressionValue): "null" | "array" | "boolean" | "number" | "string" | "object" {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value as "boolean" | "number" | "string" | "object";
}

/** GitHub's conversion of a value to text: objects and arrays are not rendered. */
export function toText(value: ExpressionValue | undefined): string {
	switch (typeOf(value ?? null)) {
		case "null":
			return "";
		case "array":
			return "Array";
		case "object":
			return "Object";
		default:
			return String(value);
	}
}

function toNumber(value: ExpressionValue): number {
	switch (typeOf(value)) {
		case "null":
			return 0;
		case "boolean":
			return value === true ? 1 : 0;
		case "number":
			return value as number;
		case "string":
			return (value as string).trim() === "" ? 0 : Number(value);
		default:
			return Number.NaN;
	}
}

function isTruthy(value: ExpressionValue): boolean {
	return !(value === null || value === false || value === 0 || value === "" || Number.isNaN(value));
}

function looselyEqual(left: ExpressionValue, right: ExpressionValue | undefined): boolean {
	const other = right ?? null;
	if (typeof left === "string" && typeof other === "string") return left.toLowerCase() === other.toLowerCase();
	if (typeOf(left) === typeOf(other)) return left === other;
	const leftType = typeOf(left);
	const otherType = typeOf(other);
	if (leftType === "object" || leftType === "array" || otherType === "object" || otherType === "array") return false;
	return toNumber(left) === toNumber(other);
}

function lookup(object: ExpressionObject, name: string): ExpressionValue | undefined {
	if (Object.hasOwn(object, name)) return object[name];
	const lowered = name.toLowerCase();
	for (const [key, value] of Object.entries(object)) if (key.toLowerCase() === lowered) return value;
	return undefined;
}

function readProperty(source: string, value: ExpressionValue, name: string): ExpressionValue {
	if (typeOf(value) !== "object") return null;
	const object = value as ExpressionObject;
	const found = lookup(object, name);
	if (found !== undefined) return found;
	const label = closedObjects.get(object);
	if (label !== undefined) throw new ExpressionError(source, `unsupported property ${label}.${name}`);
	return null;
}

function evaluate(node: Node, context: ExpressionContext, source: string): ExpressionValue {
	switch (node.kind) {
		case "literal":
			return node.value;
		case "context": {
			const root = lookup(context.roots, node.name);
			if (root === undefined) throw new ExpressionError(source, `unsupported context ${node.name}`);
			return root;
		}
		case "member":
			return readProperty(source, evaluate(node.object, context, source), node.property);
		case "index": {
			const object = evaluate(node.object, context, source);
			const index = evaluate(node.index, context, source);
			if (Array.isArray(object)) return typeof index === "number" ? (object[index] ?? null) : null;
			return typeof index === "string" ? readProperty(source, object, index) : null;
		}
		case "call": {
			const args = node.args.map((arg) => evaluate(arg, context, source));
			return (FUNCTIONS[node.name] as FunctionDefinition).call(args, context, source);
		}
		case "not":
			return !isTruthy(evaluate(node.operand, context, source));
		case "equality": {
			const equal = looselyEqual(evaluate(node.left, context, source), evaluate(node.right, context, source));
			return node.negated ? !equal : equal;
		}
		case "logical": {
			const left = evaluate(node.left, context, source);
			if (isTruthy(left) === (node.operator === "||")) return left;
			return evaluate(node.right, context, source);
		}
	}
}

function usesStatusFunction(node: Node): boolean {
	switch (node.kind) {
		case "call":
			return STATUS_FUNCTIONS.has(node.name) || node.args.some(usesStatusFunction);
		case "member":
			return usesStatusFunction(node.object);
		case "index":
			return usesStatusFunction(node.object) || usesStatusFunction(node.index);
		case "not":
			return usesStatusFunction(node.operand);
		case "equality":
		case "logical":
			return usesStatusFunction(node.left) || usesStatusFunction(node.right);
		default:
			return false;
	}
}

/** The value of one expression, the text between `${{` and `}}`. */
export function evaluateExpression(source: string, context: ExpressionContext): ExpressionValue {
	return evaluate(parse(source), context, source);
}

function findClose(text: string, from: number): number {
	let quoted = false;
	for (let position = from; position < text.length; position++) {
		const character = text.charAt(position);
		if (character === "'") quoted = !quoted;
		else if (!quoted && character === "}" && text.charAt(position + 1) === "}") return position;
	}
	return -1;
}

/** `template` with every `${{ expression }}` replaced by the text of its value. */
export function interpolate(template: string, context: ExpressionContext): string {
	let result = "";
	let position = 0;
	for (;;) {
		const start = template.indexOf("${{", position);
		if (start === -1) return result + template.slice(position);
		const end = findClose(template, start + 3);
		if (end === -1) throw new ExpressionError(template.slice(start), 'unterminated "${{"');
		result += template.slice(position, start) + toText(evaluateExpression(template.slice(start + 3, end), context));
		position = end + 2;
	}
}

/**
 * Whether an `if` condition holds, with or without the `${{ }}` around it. A condition without a status function also
 * requires that no earlier step failed, as in GitHub.
 */
export function evaluateCondition(condition: string, context: ExpressionContext): boolean {
	const trimmed = condition.trim();
	const wrapped = trimmed.startsWith("${{") && findClose(trimmed, 3) === trimmed.length - 2;
	const source = wrapped ? trimmed.slice(3, -2) : trimmed;
	const tree = parse(source);
	const holds = isTruthy(evaluate(tree, context, source));
	return usesStatusFunction(tree) ? holds : !context.failed && holds;
}
