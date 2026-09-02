/**
 * Static possible-stage discovery (slice 2, decisions D1/D2/D10).
 *
 * Derives, from a workflow definition's source files, the set of stage targets
 * the run can possibly materialize, without executing anything:
 *
 *   - `<ctx>.stage(name)` / `<ctx>.task(name, ...)` contribute their name.
 *   - `<ctx>.chain([...])` / `<ctx>.parallel([...])` contribute each step's
 *     `name:` field (inline arrays, local step arrays, and `.map(...)` step
 *     builders).
 *   - `<ctx>.workflow(childDef, { stageName })` contributes the boundary stage
 *     (default `workflow:<child-normalizedName>`) and nests the child
 *     definition's own stages under that boundary segment, following the child
 *     through relative imports and the builtin export barrel
 *     (`@bastani/atomic/workflows/builtin` / `@bastani/workflows/builtin`).
 *   - `<ctx>.tool(name, args, fn)` marks the definition as having tracked work
 *     without advertising a chat-stage target.
 *
 * `<ctx>` is whatever identifier the run callback binds (`ctx`,
 * `workflowCtx`, …) plus local rebindings seeded from it; calls may be awaited
 * or wrapped. Dynamic names become glob patterns (D2): a template literal maps
 * each hole to `*` (`orchestrator-${i}` → `orchestrator-*`); a bare identifier
 * or call expression maps to `*`, keeping any enclosing static prefix/suffix.
 *
 * Implementation per the D1 refinement (2026-09-02): no parser library exists
 * at runtime (`typescript`, `@babel/*`, `acorn`, and `oxc-*` are unavailable
 * in the shipped package and A1 forbids new dependencies), so this module is
 * a dependency-free, tolerant lexer over Node built-ins only. It skips
 * comments, string literals, and regex-like tokens, and understands template
 * literals with nested `${...}`. The scan never throws: a read, recognition,
 * or resolution failure contributes a warning and a partial (or empty)
 * result, so launch is never blocked. The acceptance bar is deterministic
 * output over the real builtin sources and a nested fixture, not full-language
 * fidelity.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeWorkflowName } from "../workflows/identity.js";

/** Mirror of the engine's child-nesting default (`engine/run.ts` `opts.config?.maxDepth ?? 4`). */
const DEFAULT_MAX_DEPTH = 4;

/** Builtin barrel specifiers whose named exports resolve into the package's own builtin directory. */
const BUILTIN_BARREL_SPECIFIERS: ReadonlySet<string> = new Set([
	"@bastani/atomic/workflows/builtin",
	"@bastani/workflows/builtin",
]);

/** Prefix of `.../builtin/<name>` subpath specifiers. */
const BUILTIN_SUBPATH_PREFIXES = ["@bastani/atomic/workflows/builtin/", "@bastani/workflows/builtin/"];

const TRACKED_NODE_METHODS: ReadonlySet<string> = new Set(["stage", "task", "chain", "parallel", "workflow", "tool"]);

export interface PossibleStagesScanOptions {
	/**
	 * Maximum workflow nesting depth considered, mirroring the engine's
	 * configured `maxDepth`: the entry file is depth 0 and a child definition
	 * at depth `d` is scanned only when `d < maxDepth`.
	 */
	readonly maxDepth?: number;
}

export interface PossibleStagesScanResult {
	/** Sorted, de-duplicated possible stage target paths (literals, globs, nested paths). */
	readonly stages: readonly string[];
	/** Whether the source contains any call site that can create a tracked graph node. */
	readonly hasTrackedNodes: boolean;
	/** Non-fatal scan warnings in deterministic traversal order. */
	readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Scan a workflow definition source file (plus its local module closure and
 * imported child definitions) for possible stage targets. The result is
 * deterministic for a given file set: stage paths are sorted and warnings
 * follow the deterministic traversal order.
 */
export function scanPossibleStagesFromSource(
	entrySourcePath: string,
	options: PossibleStagesScanOptions = {},
): PossibleStagesScanResult {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const scanner = new PossibleStagesScanner(maxDepth);
	scanner.scanSubtree(resolve(entrySourcePath), "", 0, [resolve(entrySourcePath)]);
	return {
		hasTrackedNodes: scanner.hasTrackedNodes,
		stages: [...scanner.stages].sort(),
		warnings: scanner.warnings,
	};
}

/**
 * Resolve a builtin definition name (export key of the builtin barrel, e.g.
 * `adversarialVerification` or already-kebab `open-claude-design`) to its
 * source file, probing both the raw and kebab forms with `.ts` then `.js`
 * extensions. The `.js` probe covers the shipped layout, where builtin
 * entries exist as bundled chunks beside the extension bundle.
 */
export function resolveBuiltinDefinitionSource(name: string): string | undefined {
	const builtinDir = fileURLToPath(new URL("../../builtin/", import.meta.url));
	for (const stem of [name, kebabCase(name)]) {
		for (const extension of [".ts", ".js"]) {
			const candidate = join(builtinDir, `${stem}${extension}`);
			if (isFileSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Validate a persisted possible-stages value; anything but a string array yields `undefined`. */
export function coercePossibleStages(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const stages: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return undefined;
		stages.push(entry);
	}
	return stages;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind = "ident" | "punct" | "string" | "template";

interface Token {
	readonly kind: TokenKind;
	/** Identifier text, punctuation, unquoted string value, or raw template text. */
	readonly value: string;
}

/**
 * Tolerant tokenizer: skips whitespace, comments, and regex-like tokens;
 * emits identifiers, punctuation (with `?.` and `=>` fused), string values,
 * and whole template literals (raw text, including `${...}` spans).
 */
function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	let lastSignificant: "none" | "ident" | "value" | "close" | "other" = "none";
	while (index < source.length) {
		const char = source[index]!;
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			if (newline < 0) break;
			index = newline + 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const close = source.indexOf("*/", index + 2);
			index = close < 0 ? source.length : close + 2;
			continue;
		}
		if (char === '"' || char === "'") {
			const end = skipString(source, index, char);
			tokens.push({
				kind: "string",
				value: unquoteString(source.slice(index + 1, Math.max(index + 1, end - 1))),
			});
			lastSignificant = "value";
			index = end;
			continue;
		}
		if (char === "`") {
			const end = skipTemplate(source, index);
			tokens.push({ kind: "template", value: source.slice(index, end) });
			lastSignificant = "value";
			index = end;
			continue;
		}
		if (char === "/" && regexCanStart(lastSignificant)) {
			const end = skipRegexLike(source, index);
			if (end !== undefined) {
				lastSignificant = "value";
				index = end;
				continue;
			}
		}
		if (isIdentChar(char)) {
			const start = index;
			while (index < source.length && isIdentChar(source[index]!)) index += 1;
			tokens.push({ kind: "ident", value: source.slice(start, index) });
			lastSignificant = "ident";
			continue;
		}
		if (char === "?" && source[index + 1] === ".") {
			tokens.push({ kind: "punct", value: "?." });
			lastSignificant = "other";
			index += 2;
			continue;
		}
		if (char === "=" && source[index + 1] === ">") {
			tokens.push({ kind: "punct", value: "=>" });
			lastSignificant = "other";
			index += 2;
			continue;
		}
		tokens.push({ kind: "punct", value: char });
		lastSignificant = ")[]}".includes(char) ? "close" : "other";
		index += 1;
	}
	return tokens;
}

function isIdentChar(char: string): boolean {
	return /[A-Za-z0-9_$]/.test(char);
}

/** Regex literal heuristics: `/` opens a regex only in expression position. */
function regexCanStart(lastSignificant: "none" | "ident" | "value" | "close" | "other"): boolean {
	if (lastSignificant === "none") return true;
	if (lastSignificant === "ident" || lastSignificant === "value" || lastSignificant === "close") return false;
	return true;
}

/** Returns the index after a regex literal starting at `index`, or `undefined` when it is not one. */
function skipRegexLike(source: string, index: number): number | undefined {
	let cursor = index + 1;
	let inClass = false;
	while (cursor < source.length) {
		const char = source[cursor]!;
		if (char === "\\") {
			cursor += 2;
			continue;
		}
		if (char === "\n") return undefined;
		if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) {
			cursor += 1;
			while (cursor < source.length && isIdentChar(source[cursor]!)) cursor += 1;
			return cursor;
		}
		cursor += 1;
	}
	return undefined;
}

/** Returns the index just past a string literal starting at its quote. */
function skipString(source: string, index: number, quote: string): number {
	let cursor = index + 1;
	while (cursor < source.length) {
		const char = source[cursor]!;
		if (char === "\\") {
			cursor += 2;
			continue;
		}
		if (char === quote) return cursor + 1;
		if (char === "\n") return cursor;
		cursor += 1;
	}
	return cursor;
}

/** Returns the index just past a template literal, tracking nested `${...}` groups. */
function skipTemplate(source: string, index: number): number {
	let cursor = index + 1;
	let groupDepth = 0;
	while (cursor < source.length) {
		const char = source[cursor]!;
		if (char === "\\") {
			cursor += 2;
			continue;
		}
		if (groupDepth === 0 && char === "`") return cursor + 1;
		if (char === "$" && source[cursor + 1] === "{") {
			groupDepth += 1;
			cursor += 2;
			continue;
		}
		if (char === "}" && groupDepth > 0) {
			groupDepth -= 1;
			cursor += 1;
			continue;
		}
		if (groupDepth > 0 && (char === '"' || char === "'" || char === "`")) {
			cursor = char === "`" ? skipTemplate(source, cursor) : skipString(source, cursor, char);
			continue;
		}
		if (groupDepth > 0 && char === "/" && source[cursor + 1] === "/") {
			const newline = source.indexOf("\n", cursor);
			cursor = newline < 0 ? source.length : newline;
			continue;
		}
		if (groupDepth > 0 && char === "/" && source[cursor + 1] === "*") {
			const close = source.indexOf("*/", cursor + 2);
			cursor = close < 0 ? source.length : close + 2;
			continue;
		}
		cursor += 1;
	}
	return cursor;
}

/** Unquote a tokenized string body, handling common, unicode, and hex escapes. */
function unquoteString(body: string): string {
	return body.replace(/\\(u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[\s\S])/g, (_, sequence: string) => {
		if (sequence.startsWith("u") || sequence.startsWith("x")) {
			const hex = sequence.replace(/^[ux]\{?|\}$/g, "");
			const code = Number.parseInt(hex, 16);
			return Number.isNaN(code) ? "" : String.fromCodePoint(code);
		}
		switch (sequence) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "\n":
				return "";
			default:
				return sequence;
		}
	});
}

/**
 * Map a template literal's raw text to a glob pattern: each top-level
 * `${...}` span becomes `*`, static text is kept verbatim.
 */
function templateToPattern(raw: string): string {
	const body = raw.slice(1, -1);
	let pattern = "";
	let cursor = 0;
	while (cursor < body.length) {
		const hole = body.indexOf("${", cursor);
		if (hole < 0) {
			pattern += body.slice(cursor);
			break;
		}
		pattern += body.slice(cursor, hole);
		let depth = 1;
		let scan = hole + 2;
		while (scan < body.length && depth > 0) {
			const char = body[scan]!;
			if (char === "{") depth += 1;
			else if (char === "}") depth -= 1;
			scan += 1;
		}
		pattern += "*";
		cursor = scan;
	}
	pattern = pattern.replace(/\\([$`\\])/g, "$1");
	// Adjacent holes span one stage name; `**` would read as any-depth (D6).
	pattern = pattern.replace(/\*{2,}/g, "*");
	return pattern.trim().length > 0 ? pattern : "*";
}

// ---------------------------------------------------------------------------
// Scanned file units
// ---------------------------------------------------------------------------

interface LocalStepFactory {
	readonly params: readonly string[];
	/** Token slice of the object literal the factory returns (`{ ... }` inclusive). */
	readonly object: readonly Token[];
}

interface ImportBinding {
	readonly specifier: string;
	/** Imported export name; `undefined` for default and namespace imports. */
	readonly importedName?: string;
}

interface FileUnit {
	readonly tokens: readonly Token[];
	readonly imports: ReadonlyMap<string, ImportBinding>;
	readonly ctxLike: ReadonlySet<string>;
	readonly localArrays: ReadonlyMap<string, readonly (readonly Token[])[]>;
	/** Variable-declaration initializers, for `.map(...)` step-builder recovery. */
	readonly localInits: ReadonlyMap<string, readonly Token[]>;
	readonly localStepFactories: ReadonlyMap<string, LocalStepFactory>;
	readonly localValues: ReadonlyMap<string, Token>;
	/** Authored `name` of the file's default-exported definition, when statically visible. */
	readonly definitionName: string | undefined;
	/** True when the file contains a bare workflow-definition call (wrapper chunks do not). */
	readonly hasWorkflowCall: boolean;
	/** Local names that invoke the workflow factory (builtin keywords + import aliases). */
	readonly workflowNames: ReadonlySet<string>;
}

function buildFileUnit(path: string, warnings: string[]): FileUnit | undefined {
	let source: string;
	try {
		source = readFileSync(path, "utf-8");
	} catch (error) {
		warnings.push(`possible-stages: failed to read ${path}: ${errorMessage(error)}`);
		return undefined;
	}
	const tokens = tokenize(source);
	const localValues = collectLocalValues(tokens);
	const imports = collectImports(tokens);
	collectExportFroms(tokens, imports);
	const workflowNames = new Set<string>(["workflow", "defineWorkflow"]);
	for (const [local, binding] of imports) {
		if (binding.importedName === "workflow") workflowNames.add(local);
	}
	return {
		tokens,
		imports,
		ctxLike: collectCtxLikeIdentifiers(tokens),
		localArrays: collectLocalArrays(tokens),
		localInits: collectLocalInits(tokens),
		localStepFactories: collectLocalStepFactories(tokens),
		localValues,
		definitionName: collectDefinitionName(tokens, localValues, workflowNames),
		hasWorkflowCall: tokens.some((_, index) => isBareWorkflowCall(tokens, index, workflowNames)),
		workflowNames,
	};
}

/** Record `export { a, default as b } from "spec"` re-export bindings. */
function collectExportFroms(tokens: readonly Token[], imports: Map<string, ImportBinding>): void {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.kind !== "ident" || token.value !== "export") continue;
		if (tokens[index + 1]?.kind === "ident" && tokens[index + 1]!.value === "type") continue;
		const brace = tokens[index + 1];
		if (brace?.kind !== "punct" || brace.value !== "{") continue;
		const clause = parseImportClause(tokens, index + 1);
		if (clause === undefined) continue;
		let cursor = clause.next;
		const from = tokens[cursor];
		if (from?.kind !== "ident" || from.value !== "from") continue;
		cursor += 1;
		const specifierToken = tokens[cursor];
		if (specifierToken?.kind !== "string") continue;
		for (const entry of clause.specifiers) {
			imports.set(entry.local, {
				specifier: specifierToken.value,
				...(entry.importedName !== undefined ? { importedName: entry.importedName } : {}),
			});
		}
	}
}

function collectImports(tokens: readonly Token[]): Map<string, ImportBinding> {
	const imports = new Map<string, ImportBinding>();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.kind !== "ident" || token.value !== "import") continue;
		let cursor = index + 1;
		const typeOnly = tokens[cursor]?.kind === "ident" && tokens[cursor]!.value === "type";
		if (typeOnly) cursor += 1;
		const specifiers: { local: string; importedName?: string }[] = [];
		let specifier = "";
		while (cursor < tokens.length) {
			const current = tokens[cursor]!;
			if (current.kind === "string") {
				specifier = current.value;
				cursor += 1;
				break;
			}
			if (current.kind === "punct" && current.value === ";") {
				cursor += 1;
				break;
			}
			if (current.kind === "ident" && current.value === "from") {
				cursor += 1;
				continue;
			}
			const clause = parseImportClause(tokens, cursor);
			if (clause === undefined) break;
			specifiers.push(...clause.specifiers);
			cursor = clause.next;
		}
		if (specifier.length === 0 || typeOnly) continue;
		for (const entry of specifiers) {
			imports.set(entry.local, {
				specifier,
				...(entry.importedName !== undefined ? { importedName: entry.importedName } : {}),
			});
		}
	}
	return imports;
}

/** Parse `{ a, b as c }`, `* as ns`, or a plain default identifier starting at `cursor`. */
function parseImportClause(
	tokens: readonly Token[],
	cursor: number,
): { specifiers: { local: string; importedName?: string }[]; next: number } | undefined {
	const first = tokens[cursor];
	if (first === undefined) return undefined;
	if (first.kind === "punct" && first.value === "{") {
		const specifiers: { local: string; importedName?: string }[] = [];
		let index = cursor + 1;
		while (index < tokens.length) {
			const token = tokens[index]!;
			if (token.kind === "punct" && token.value === "}") return { specifiers, next: index + 1 };
			if (token.kind !== "ident") return undefined;
			const importedName = token.value;
			let local = importedName;
			const maybeAs = tokens[index + 1];
			if (maybeAs?.kind === "ident" && maybeAs.value === "as") {
				const localToken = tokens[index + 2];
				if (localToken?.kind !== "ident") return undefined;
				local = localToken.value;
				index += 2;
			}
			specifiers.push({ local, importedName });
			index += 1;
			const comma = tokens[index];
			if (comma?.kind === "punct" && comma.value === ",") index += 1;
		}
		return undefined;
	}
	if (first.kind === "punct" && first.value === "*") {
		const as = tokens[cursor + 1];
		const ns = tokens[cursor + 2];
		if (as?.kind === "ident" && as.value === "as" && ns?.kind === "ident") {
			return { specifiers: [{ local: ns.value }], next: cursor + 3 };
		}
		return undefined;
	}
	if (first.kind === "ident") {
		const comma = tokens[cursor + 1];
		if (comma?.kind === "punct" && comma.value === ",") {
			return { specifiers: [{ local: first.value }], next: cursor + 2 };
		}
		return { specifiers: [{ local: first.value }], next: cursor + 1 };
	}
	return undefined;
}

/**
 * Identifiers that behave like the workflow run context: the run callback's
 * parameter, the literal `ctx`, and local `const`/`let` rebindings whose
 * initializer mentions a known context identifier.
 */
function collectCtxLikeIdentifiers(tokens: readonly Token[]): Set<string> {
	const ctxLike = new Set<string>(["ctx"]);
	const runParam = findRunCallbackParameter(tokens);
	if (runParam !== undefined) ctxLike.add(runParam);
	for (let round = 0; round < 8 && ctxLike.size < 32; round += 1) {
		let grew = false;
		for (let index = 0; index < tokens.length; index += 1) {
			const declaration = matchVariableDeclaration(tokens, index);
			if (declaration === undefined) continue;
			index = declaration.end - 1;
			const { name, init } = declaration;
			if (ctxLike.has(name)) continue;
			if (init.some((token) => token.kind === "ident" && ctxLike.has(token.value))) {
				ctxLike.add(name);
				grew = true;
			}
		}
		if (!grew) break;
	}
	return ctxLike;
}

function findRunCallbackParameter(tokens: readonly Token[]): string | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.kind !== "ident" || token.value !== "run") continue;
		let cursor = index + 1;
		if (tokens[cursor]?.kind === "punct" && tokens[cursor]!.value === ":") {
			cursor += 1;
			if (tokens[cursor]?.kind === "ident" && tokens[cursor]!.value === "async") cursor += 1;
		}
		const open = tokens[cursor];
		if (open?.kind !== "punct" || open.value !== "(") continue;
		const param = tokens[cursor + 1];
		if (param?.kind === "ident") return param.value;
	}
	return undefined;
}

interface VariableDeclarationMatch {
	readonly name: string;
	readonly init: readonly Token[];
	/** Index just past the last token of the declaration. */
	readonly end: number;
}

/** Match `const|let <name>[type annotation] = <init>;` with a bounded type-annotation skip. */
function matchVariableDeclaration(tokens: readonly Token[], index: number): VariableDeclarationMatch | undefined {
	const keyword = tokens[index];
	if (keyword?.kind !== "ident" || (keyword.value !== "const" && keyword.value !== "let")) return undefined;
	const name = tokens[index + 1];
	if (name?.kind !== "ident") return undefined;
	let cursor = index + 2;
	let depth = 0;
	let lookedAhead = 0;
	while (cursor < tokens.length && lookedAhead < 32) {
		const token = tokens[cursor]!;
		if (token.kind === "punct") {
			if ("([{".includes(token.value)) depth += 1;
			else if (")]}".includes(token.value)) {
				if (depth === 0) return undefined;
				depth -= 1;
			} else if (token.value === "=" && depth === 0) {
				break;
			} else if (token.value === ";" && depth === 0) {
				return undefined;
			}
		}
		cursor += 1;
		lookedAhead += 1;
	}
	const equals = tokens[cursor];
	if (equals?.kind !== "punct" || equals.value !== "=") return undefined;
	const init: Token[] = [];
	cursor += 1;
	while (cursor < tokens.length) {
		const token = tokens[cursor]!;
		if (token.kind === "punct") {
			if ("([{".includes(token.value)) depth += 1;
			else if (")]}".includes(token.value)) {
				if (depth === 0) {
					init.push(token);
					cursor += 1;
					break;
				}
				depth -= 1;
			} else if (token.value === ";" && depth === 0) {
				cursor += 1;
				break;
			}
		}
		init.push(token);
		cursor += 1;
	}
	return { name: name.value, init, end: cursor };
}

/** `const id = [...]` initializers, as top-level element token slices. */
function collectLocalArrays(tokens: readonly Token[]): Map<string, readonly (readonly Token[])[]> {
	const arrays = new Map<string, readonly (readonly Token[])[]>();
	for (let index = 0; index < tokens.length; index += 1) {
		const declaration = matchVariableDeclaration(tokens, index);
		if (declaration === undefined) continue;
		index = declaration.end - 1;
		if (declaration.init[0]?.kind === "punct" && declaration.init[0]!.value === "[") {
			arrays.set(declaration.name, arrayElements(declaration.init));
		}
	}
	return arrays;
}

/** `const id = (a, b) => ({ ... })` (or `=> { return {...}; }`) factories for step elements. */
function collectLocalStepFactories(tokens: readonly Token[]): Map<string, LocalStepFactory> {
	const factories = new Map<string, LocalStepFactory>();
	for (let index = 0; index < tokens.length; index += 1) {
		const declaration = matchVariableDeclaration(tokens, index);
		if (declaration === undefined) continue;
		index = declaration.end - 1;
		const factory = stepFactoryFromInit(declaration.init);
		if (factory !== undefined) factories.set(declaration.name, factory);
	}
	return factories;
}

function stepFactoryFromInit(init: readonly Token[]): LocalStepFactory | undefined {
	let cursor = 0;
	const open = init[cursor];
	if (open?.kind !== "punct" || open.value !== "(") return undefined;
	const params: string[] = [];
	cursor += 1;
	while (cursor < init.length) {
		const token = init[cursor]!;
		if (token.kind === "punct" && token.value === ")") {
			cursor += 1;
			break;
		}
		if (token.kind === "ident") params.push(token.value);
		cursor += 1;
	}
	const arrow = init[cursor];
	if (arrow?.kind !== "punct" || arrow.value !== "=>") return undefined;
	cursor += 1;
	const after = init[cursor];
	if (after?.kind === "punct" && after.value === "(") {
		const wrapped = balancedRange(init, cursor, "(", ")");
		if (wrapped === undefined) return undefined;
		const objectTokens = wrapped.slice(1, -1);
		if (objectTokens[0]?.kind === "punct" && objectTokens[0]!.value === "{") {
			return { params, object: objectTokens };
		}
		return undefined;
	}
	if (after?.kind === "punct" && after.value === "{") {
		for (let scan = cursor + 1; scan < init.length; scan += 1) {
			const token = init[scan]!;
			if (token.kind === "punct" && token.value === "}") break;
			if (token.kind === "ident" && token.value === "return") {
				const brace = init[scan + 1];
				if (brace?.kind === "punct" && brace.value === "{") {
					const object = balancedRange(init, scan + 1, "{", "}");
					if (object !== undefined) return { params, object };
				}
			}
		}
	}
	return undefined;
}

/** `const id = "literal"` / `` const id = `template` `` values. */
function collectLocalValues(tokens: readonly Token[]): Map<string, Token> {
	const values = new Map<string, Token>();
	for (let index = 0; index < tokens.length; index += 1) {
		const declaration = matchVariableDeclaration(tokens, index);
		if (declaration === undefined) continue;
		index = declaration.end - 1;
		const only = declaration.init.length === 1 ? declaration.init[0] : undefined;
		if (only?.kind === "string" || only?.kind === "template") values.set(declaration.name, only);
	}
	return values;
}

/** Every `const|let` initializer slice, keyed by the declared name. */
function collectLocalInits(tokens: readonly Token[]): Map<string, readonly Token[]> {
	const inits = new Map<string, readonly Token[]>();
	for (let index = 0; index < tokens.length; index += 1) {
		const declaration = matchVariableDeclaration(tokens, index);
		if (declaration === undefined) continue;
		index = declaration.end - 1;
		inits.set(declaration.name, declaration.init);
	}
	return inits;
}

/**
 * Authored `name` of a file's workflow definition, recognized from the first
 * `workflow({ name: "...", ... })` call — whether reached via
 * `export default workflow(...)`, a named export, or a local const re-exported
 * as default. Bundled chunk wrappers (e.g. `export { x_default as default }`)
 * carry no visible call and yield `undefined`.
 */
/** A bare (non-member) `workflow(`/`defineWorkflow(` call, type arguments allowed. */
function isBareWorkflowCall(tokens: readonly Token[], index: number, workflowNames: ReadonlySet<string>): boolean {
	const token = tokens[index];
	if (token === undefined) return false;
	if (token.kind !== "ident" || !workflowNames.has(token.value)) return false;
	const previous = tokens[index - 1];
	// `function workflow(` declares the factory; only invocations count.
	if (previous?.kind === "ident" && previous.value === "function") return false;
	if (previous?.kind === "punct" && (previous.value === "." || previous.value === "?.")) return false;
	let cursor = index + 1;
	if (tokens[cursor]?.kind === "punct" && tokens[cursor]!.value === "<") {
		const close = matchBracket(tokens, cursor, "<", ">");
		if (close === undefined) return false;
		cursor = close + 1;
	}
	const open = tokens[cursor];
	return open?.kind === "punct" && open.value === "(";
}

/**
 * Authored `name` of the file's workflow definition, recognized from the first
 * bare `workflow({ name: ... })` call — `export default workflow(...)`, a
 * named export, or an aliased default all match; bundled chunk wrappers
 * (pure re-exports) carry no call and yield `undefined`. A literal, static
 * template, or local-const name resolves; anything else is invisible.
 */
function collectDefinitionName(
	tokens: readonly Token[],
	localValues: ReadonlyMap<string, Token>,
	workflowNames: ReadonlySet<string>,
): string | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		if (!isBareWorkflowCall(tokens, index, workflowNames)) continue;
		let cursor = index + 1;
		if (tokens[cursor]?.kind === "punct" && tokens[cursor]!.value === "<") {
			const close = matchBracket(tokens, cursor, "<", ">");
			if (close === undefined) return undefined;
			cursor = close + 1;
		}
		const inner = balancedRange(tokens, cursor, "(", ")");
		if (inner === undefined || inner.length < 3) return undefined;
		const nameToken = directObjectFieldValue(inner.slice(1, -1), "name");
		if (nameToken?.kind === "string") return nameToken.value;
		if (nameToken?.kind === "template" && !nameToken.value.includes("${")) {
			return nameToken.value.slice(1, -1);
		}
		if (nameToken?.kind === "ident") {
			const local = localValues.get(nameToken.value);
			if (local?.kind === "string") return local.value;
			if (local?.kind === "template" && !local.value.includes("${")) {
				return local.value.slice(1, -1);
			}
		}
		return undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

class PossibleStagesScanner {
	readonly stages = new Set<string>();
	hasTrackedNodes = false;
	readonly warnings: string[] = [];
	private readonly maxDepth: number;
	private readonly units = new Map<string, FileUnit | undefined>();
	/** Context-like aliases (e.g. `designContext`) seen anywhere in this scan, so helper
	 * modules that receive the context under another name still resolve its stage calls. */
	private readonly aliasPool = new Set<string>();

	constructor(maxDepth: number) {
		this.maxDepth = maxDepth;
	}

	/**
	 * Scan one definition subtree: the entry file plus its transitive local
	 * (relative-import) closure, all attributed to `boundaryPrefix`. Nested
	 * `ctx.workflow` child definitions are scanned as their own subtrees under
	 * their boundary segment, bounded by the workflow nesting depth.
	 */
	scanSubtree(entryPath: string, boundaryPrefix: string, depth: number, ancestorStack: readonly string[]): void {
		let rootPath = entryPath;
		const entryUnit = this.unitFor(entryPath);
		if (entryUnit !== undefined && !entryUnit.hasWorkflowCall) {
			// Shipped-layout wrapper entry (e.g. `export { x_default as default
			// }`): the definition lives in the module the wrapper re-exports, so
			// the subtree roots there instead of scanning an empty wrapper.
			const behind = relativeImportTargets(entryUnit, entryPath)
				.map((target) => ({ target, unit: this.unitFor(target) }))
				.find((entry) => entry.unit?.hasWorkflowCall === true);
			if (behind?.target !== undefined) rootPath = behind.target;
		}
		const queue = [rootPath];
		const visited = new Set<string>([entryPath, rootPath]);
		const ordered: string[] = [];
		// Phase one loads every file of the local closure so context aliases
		// from any file (e.g. `const designContext = ctx` in a runner) are
		// known before stage calls are extracted anywhere.
		while (queue.length > 0) {
			const path = queue.shift()!;
			const unit = this.unitFor(path);
			if (unit === undefined) continue;
			ordered.push(path);
			for (const target of relativeImportTargets(unit, path)) {
				if (visited.has(target)) continue;
				visited.add(target);
				// Modules containing a workflow-definition call are child
				// definitions, not helpers: they are scanned only through their
				// ctx.workflow boundary so their stages nest under it instead of
				// leaking into the parent's own stage set.
				const targetUnit = this.unitFor(target);
				if (targetUnit === undefined) continue;
				if (targetUnit.hasWorkflowCall) continue;
				queue.push(target);
			}
			for (const alias of unit.ctxLike) {
				this.aliasPool.add(alias);
			}
		}
		for (const path of ordered) {
			const unit = this.units.get(path);
			if (unit === undefined) continue;
			this.scanUnit(unit, path, boundaryPrefix, depth, ancestorStack);
		}
	}

	private unitFor(path: string): FileUnit | undefined {
		if (this.units.has(path)) return this.units.get(path);
		const unit = buildFileUnit(path, this.warnings);
		this.units.set(path, unit);
		return unit;
	}

	private scanUnit(
		unit: FileUnit,
		path: string,
		boundaryPrefix: string,
		depth: number,
		ancestorStack: readonly string[],
	): void {
		const tokens = unit.tokens;
		this.collectNamedStageRecords(tokens, boundaryPrefix);
		let index = 0;
		while (index < tokens.length) {
			const call = matchCtxCall(tokens, index, this.aliasPool);
			if (call === undefined) {
				index += 1;
				continue;
			}
			this.handleCtxCall(call, unit, path, boundaryPrefix, depth, ancestorStack);
			index = call.argsOpen + 1;
		}
	}

	private handleCtxCall(
		call: CtxCall,
		unit: FileUnit,
		path: string,
		boundaryPrefix: string,
		depth: number,
		ancestorStack: readonly string[],
	): void {
		this.hasTrackedNodes = true;
		if (call.method === "tool") return;
		if (call.method === "workflow") {
			this.handleWorkflowCall(call, unit, path, boundaryPrefix, depth, ancestorStack);
			return;
		}
		if (call.method === "chain" || call.method === "parallel") {
			for (const name of this.stepNamesForStepsCall(call, unit, path)) {
				this.stages.add(joinBoundary(boundaryPrefix, name));
			}
			return;
		}
		const nameArgument = firstArgumentTokens(call, unit.tokens);
		if (nameArgument === undefined || nameArgument.length === 0) return;
		this.stages.add(joinBoundary(boundaryPrefix, argumentNamePattern(nameArgument, unit)));
	}

	private handleWorkflowCall(
		call: CtxCall,
		unit: FileUnit,
		path: string,
		boundaryPrefix: string,
		depth: number,
		ancestorStack: readonly string[],
	): void {
		const args = splitTopLevelArguments(call, unit.tokens);
		const childReference = args[0];
		if (childReference === undefined || childReference.length === 0) return;
		const optionsTokens = args[1];
		const explicitStage = optionsTokens === undefined ? undefined : objectFieldValue(optionsTokens, "stageName");
		const binding =
			childReference.length === 1 && childReference[0]!.kind === "ident"
				? unit.imports.get(childReference[0]!.value)
				: undefined;
		// D2: a statically unknown child reference (member/call expression) maps
		// to a glob boundary; imported names fall back to their kebab form,
		// matching the engine's normalized names for camelCase barrel exports.
		const fallbackName =
			childReference.length === 1 && childReference[0]!.kind === "ident"
				? (binding?.importedName ?? childReference[0]!.value)
				: "*";
		const childPath = this.resolveChildPath(binding, path);
		// Bundled wrapper chunk (e.g. `export { x_default as default }`): the
		// definition itself lives in the module the wrapper re-exports, so the
		// boundary name and the subtree follow that chain instead of the empty
		// wrapper.
		let subtreeEntry = childPath;
		if (childPath !== undefined) {
			const childUnit = this.unitFor(childPath);
			if (childUnit !== undefined && !childUnit.hasWorkflowCall) {
				const definitionBehindWrapper = relativeImportTargets(childUnit, childPath)
					.map((target) => ({ target, unit: this.unitFor(target) }))
					.find((entry) => entry.unit?.hasWorkflowCall === true);
				if (definitionBehindWrapper?.target !== undefined) subtreeEntry = definitionBehindWrapper.target;
			}
		}
		let boundaryName: string;
		if (explicitStage !== undefined) {
			boundaryName = argumentNamePattern(explicitStage, unit);
		} else {
			const authoredName = subtreeEntry === undefined ? undefined : this.unitFor(subtreeEntry)?.definitionName;
			// The engine normalizes the authored name verbatim; only the binding
			// fallback kebab-cases (camelCase barrel exports map to their kebab
			// builtin names). A statically unknown reference maps to a glob (D2).
			const normalized =
				authoredName !== undefined
					? safeNormalize(authoredName)
					: fallbackName === "*"
						? "*"
						: safeNormalize(kebabCase(fallbackName));
			if (authoredName === undefined) {
				this.warnings.push(
					`possible-stages: child definition name for ctx.workflow at ${path} was not statically visible; using "${normalized}" as the boundary segment`,
				);
			}
			boundaryName = `workflow:${normalized}`;
		}
		this.stages.add(joinBoundary(boundaryPrefix, boundaryName));
		if (childPath === undefined) {
			this.warnings.push(
				`possible-stages: ctx.workflow child at ${path} could not be resolved to a source file; its stages were not scanned`,
			);
			return;
		}
		const childDepth = depth + 1;
		if (childDepth >= this.maxDepth) return;
		// Import cycles: both the resolved import and the descended definition
		// module block re-descent (wrapper-mediated cycles included).
		if (subtreeEntry === undefined || ancestorStack.includes(childPath) || ancestorStack.includes(subtreeEntry)) {
			return;
		}
		this.scanSubtree(subtreeEntry, joinBoundary(boundaryPrefix, boundaryName), childDepth, [
			...ancestorStack,
			childPath,
			subtreeEntry,
		]);
	}

	private resolveChildPath(binding: ImportBinding | undefined, importingFile: string): string | undefined {
		if (binding === undefined) return undefined;
		const specifier = binding.specifier;
		if (BUILTIN_BARREL_SPECIFIERS.has(specifier)) {
			const stem = binding.importedName;
			if (stem === undefined) return undefined;
			const resolved = resolveBuiltinDefinitionSource(stem);
			if (resolved === undefined) {
				this.warnings.push(`possible-stages: builtin definition "${stem}" has no source file to scan`);
			}
			return resolved;
		}
		const subpath = BUILTIN_SUBPATH_PREFIXES.find((prefix) => specifier.startsWith(prefix));
		if (subpath !== undefined) {
			const rest = specifier.slice(subpath.length);
			const stem = rest.length > 0 ? rest : binding.importedName;
			if (stem === undefined) return undefined;
			return resolveBuiltinDefinitionSource(stem);
		}
		return resolveRelativeSpecifier(specifier, importingFile);
	}

	/** Step `name:` patterns for a `chain`/`parallel` call's first argument. */
	private stepNamesForStepsCall(call: CtxCall, unit: FileUnit, path: string): readonly string[] {
		const first = firstArgumentTokens(call, unit.tokens);
		if (first === undefined || first.length === 0) return [];
		const head = first[0]!;
		if (head.kind === "punct" && head.value === "[") {
			const names: string[] = [];
			for (const element of arrayElements(first)) {
				names.push(...this.stepNameFromElement(element, unit));
			}
			return names;
		}
		if (head.kind === "ident" && first.length === 1) {
			const localArray = unit.localArrays.get(head.value);
			if (localArray !== undefined) {
				const names: string[] = [];
				for (const element of localArray) names.push(...this.stepNameFromElement(element, unit));
				return names;
			}
			const localInit = unit.localInits.get(head.value);
			if (localInit !== undefined) {
				const mapped = stepNamesThroughMapCall(localInit, unit);
				if (mapped !== undefined) return mapped;
			}
			const localValue = unit.localValues.get(head.value);
			if (localValue?.kind === "string") return [localValue.value];
			if (localValue?.kind === "template") return [templateToPattern(localValue.value)];
			this.warnings.push(
				`possible-stages: ${call.method} steps argument "${head.value}" at ${path} is not statically visible; its step names were not extracted`,
			);
			return [];
		}
		const mapped = stepNamesThroughMapCall(first, unit);
		if (mapped !== undefined) return mapped;
		this.warnings.push(
			`possible-stages: ${call.method} steps argument at ${path} is not statically visible; its step names were not extracted`,
		);
		return [];
	}

	/** Step name from one array element: object literal or local factory call. */
	private stepNameFromElement(element: readonly Token[], unit: FileUnit): readonly string[] {
		if (element.length === 0) return [];
		const head = element[0]!;
		if (head.kind === "punct" && head.value === "{") {
			const name = directObjectFieldValue(element, "name");
			if (name !== undefined) return [patternFromValueToken(name, [], unit)];
			return [];
		}
		if (head.kind === "ident") {
			const factory = unit.localStepFactories.get(head.value);
			if (factory !== undefined) {
				return [patternFromFactory(factory, splitCallArguments(element), unit)];
			}
			const nested = unit.localArrays.get(head.value);
			if (nested !== undefined) {
				const names: string[] = [];
				for (const entry of nested) names.push(...this.stepNameFromElement(entry, unit));
				return names;
			}
		}
		return [];
	}

	/**
	 * Collect objects carrying both `name:` and `stageName:` string or
	 * template fields; they denote stage-target records (e.g. goal's
	 * `reviewer-error` fallback step).
	 */
	private collectNamedStageRecords(tokens: readonly Token[], boundaryPrefix: string): void {
		interface ObjectFrame {
			/** Group depth at which this object's direct properties live. */
			readonly directDepth: number;
			name: string | undefined;
			stageName: string | undefined;
		}
		const stack: ObjectFrame[] = [];
		let groupDepth = 0;
		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index]!;
			if (token.kind === "punct") {
				if (token.value === "{") {
					stack.push({ directDepth: groupDepth + 1, name: undefined, stageName: undefined });
					groupDepth += 1;
					continue;
				}
				if (token.value === "}") {
					const frame = stack.pop();
					groupDepth = Math.max(0, groupDepth - 1);
					if (frame !== undefined && frame.name !== undefined && frame.stageName !== undefined) {
						this.stages.add(joinBoundary(boundaryPrefix, frame.name));
					}
					continue;
				}
				if (token.value === "(" || token.value === "[") {
					groupDepth += 1;
					continue;
				}
				if (token.value === ")" || token.value === "]") {
					groupDepth = Math.max(0, groupDepth - 1);
					continue;
				}
				continue;
			}
			const frame = stack[stack.length - 1];
			if (frame === undefined || frame.directDepth !== groupDepth) continue;
			if (token.value !== "name" && token.value !== "stageName") continue;
			if (token.kind !== "ident") continue;
			const colon = tokens[index + 1];
			const value = tokens[index + 2];
			if (colon?.kind !== "punct" || colon.value !== ":") continue;
			if (value?.kind !== "string" && value?.kind !== "template") continue;
			const pattern = value.kind === "string" ? value.value : templateToPattern(value.value);
			if (token.value === "name") frame.name = pattern;
			else frame.stageName = pattern;
		}
	}
}

function joinBoundary(prefix: string, segment: string): string {
	return prefix.length > 0 ? `${prefix}/${segment}` : segment;
}

interface CtxCall {
	readonly method: "stage" | "task" | "chain" | "parallel" | "workflow" | "tool";
	/** Index of the `(` token opening the argument list. */
	readonly argsOpen: number;
}

/** Match `<ctxLike>.<method>(`, allowing `<...>` type arguments and one alias hop. */
function matchCtxCall(tokens: readonly Token[], index: number, ctxLike: ReadonlySet<string>): CtxCall | undefined {
	const head = tokens[index];
	if (head?.kind !== "ident") return undefined;
	const dot = tokens[index + 1];
	if (dot?.kind === "punct" && (dot.value === "." || dot.value === "?.")) {
		const method = tokens[index + 2];
		if (method?.kind === "ident" && TRACKED_NODE_METHODS.has(method.value) && ctxLike.has(head.value)) {
			return ctxCallAt(tokens, index + 2, method.value as CtxCall["method"]);
		}
	}
	// Aliased chain: `<any>.<ctxAlias>.<method>(` (e.g. `args.designContext.task(...)`),
	// where the alias is any context-like identifier seen in this scan.
	if (dot?.kind === "punct" && (dot.value === "." || dot.value === "?.")) {
		const alias = tokens[index + 2];
		const secondDot = tokens[index + 3];
		const method = tokens[index + 4];
		if (
			alias?.kind === "ident" &&
			ctxLike.has(alias.value) &&
			secondDot?.kind === "punct" &&
			(secondDot.value === "." || secondDot.value === "?.") &&
			method?.kind === "ident" &&
			TRACKED_NODE_METHODS.has(method.value)
		) {
			return ctxCallAt(tokens, index + 4, method.value as CtxCall["method"]);
		}
	}
	return undefined;
}

function ctxCallAt(tokens: readonly Token[], methodIndex: number, method: CtxCall["method"]): CtxCall | undefined {
	let cursor = methodIndex + 1;
	if (tokens[cursor]?.kind === "punct" && tokens[cursor]!.value === "<") {
		const close = matchBracket(tokens, cursor, "<", ">");
		if (close === undefined) return undefined;
		cursor = close + 1;
	}
	const open = tokens[cursor];
	if (open?.kind !== "punct" || open.value !== "(") return undefined;
	return { method, argsOpen: cursor };
}

/** Top-level argument token slices of a call whose `(` is at `argsOpen`. */
function splitTopLevelArguments(call: CtxCall, tokens: readonly Token[]): readonly (readonly Token[])[] {
	const close = matchBracket(tokens, call.argsOpen, "(", ")");
	if (close === undefined) return [];
	const args: Token[][] = [];
	let depth = 0;
	let current: Token[] = [];
	for (let index = call.argsOpen + 1; index < close; index += 1) {
		const token = tokens[index]!;
		if (token.kind === "punct") {
			if ("([{".includes(token.value)) depth += 1;
			else if (")]}".includes(token.value)) depth -= 1;
			else if (token.value === "," && depth === 0) {
				args.push(current);
				current = [];
				continue;
			}
		}
		current.push(token);
	}
	if (current.length > 0) args.push(current);
	return args;
}

function firstArgumentTokens(call: CtxCall, tokens: readonly Token[]): readonly Token[] | undefined {
	return splitTopLevelArguments(call, tokens)[0];
}

/** Stage-name pattern (D2) for a `stage`/`task`/`stageName` token slice. */
function argumentNamePattern(tokens: readonly Token[], unit: FileUnit): string {
	const only = tokens.length === 1 ? tokens[0] : undefined;
	if (only?.kind === "string") return only.value;
	if (only?.kind === "template") return templateToPattern(only.value);
	if (only?.kind === "ident") {
		const local = unit.localValues.get(only.value);
		if (local?.kind === "string") return local.value;
		if (local?.kind === "template") return templateToPattern(local.value);
		return "*";
	}
	if (only?.kind === "punct" && only.value === "(") {
		const inner = tokens.slice(1, -1);
		if (inner.length === 1 && inner[0]!.kind === "string") return inner[0]!.value;
	}
	return "*";
}

/**
 * Extract step names from `<receiver>.map((item, index) => ({ name: ... }))`
 * — expression body, block body with `return`, or a local factory call in
 * the callback body.
 */
function stepNamesThroughMapCall(tokens: readonly Token[], unit: FileUnit): readonly string[] | undefined {
	for (let index = 0; index < tokens.length - 1; index += 1) {
		const token = tokens[index]!;
		if (token.kind !== "ident" || token.value !== "map") continue;
		const open = tokens[index + 1];
		if (open?.kind !== "punct" || open.value !== "(") continue;
		const close = matchBracket(tokens, index + 1, "(", ")");
		if (close === undefined) return undefined;
		return stepNamesFromMapCallback(tokens.slice(index + 2, close), unit);
	}
	return undefined;
}

function stepNamesFromMapCallback(inner: readonly Token[], unit: FileUnit): readonly string[] | undefined {
	const params: string[] = [];
	let cursor = 0;
	if (inner[0]?.kind === "punct" && inner[0]!.value === "(") {
		cursor += 1;
		while (cursor < inner.length) {
			const token = inner[cursor]!;
			if (token.kind === "punct" && token.value === ")") {
				cursor += 1;
				break;
			}
			if (token.kind === "ident") params.push(token.value);
			cursor += 1;
		}
	} else if (inner[0]?.kind === "ident") {
		params.push(inner[0]!.value);
		cursor = 1;
	}
	const arrow = inner[cursor];
	if (arrow?.kind !== "punct" || arrow.value !== "=>") return [];
	cursor += 1;
	const body = inner[cursor];
	if (body === undefined) return [];
	if (body.kind === "punct" && body.value === "(") {
		const wrapped = balancedRange(inner, cursor, "(", ")");
		if (wrapped === undefined) return undefined;
		const object = wrapped.slice(1, -1);
		if (object[0]?.kind === "punct" && object[0]!.value === "{") {
			const name = directObjectFieldValue(object, "name");
			if (name !== undefined) return [patternFromValueToken(name, params, unit)];
		}
		// Recognized steps-object without a name field: contributes nothing.
		return [];
	}
	if (body.kind === "punct" && body.value === "{") {
		const block = balancedRange(inner, cursor, "{", "}");
		if (block === undefined) return undefined;
		for (let scan = 1; scan < block.length - 1; scan += 1) {
			const token = block[scan]!;
			if (token.kind === "ident" && token.value === "return") {
				const brace = block[scan + 1];
				if (brace?.kind === "punct" && brace.value === "{") {
					const object = balancedRange(block, scan + 1, "{", "}");
					if (object === undefined) return undefined;
					const name = directObjectFieldValue(object, "name");
					if (name !== undefined) return [patternFromValueToken(name, params, unit)];
				}
			}
		}
		// Block body without a returned object literal: unrecognized builder.
		return undefined;
	}
	if (body.kind === "ident") {
		const factory = unit.localStepFactories.get(body.value);
		if (factory !== undefined) {
			return [patternFromFactory(factory, splitCallArguments(inner.slice(cursor)), unit)];
		}
	}
	// Unrecognized callback body (e.g. `steps[index]`): signal the caller to warn.
	return undefined;
}

function patternFromFactory(
	factory: LocalStepFactory,
	callArguments: readonly (readonly Token[])[],
	unit: FileUnit,
): string {
	const name = directObjectFieldValue(factory.object, "name");
	if (name === undefined) return "*";
	if (name.kind === "ident") {
		const parameterIndex = factory.params.indexOf(name.value);
		const argument = parameterIndex >= 0 ? callArguments[parameterIndex] : undefined;
		if (argument !== undefined && argument.length > 0) return argumentNamePattern(argument, unit);
		return "*";
	}
	return patternFromValueToken(name, factory.params, unit);
}

function patternFromValueToken(token: Token, params: readonly string[], unit: FileUnit): string {
	if (token.kind === "string") return token.value;
	if (token.kind === "template") return templateToPattern(token.value);
	if (token.kind === "ident") {
		if (params.includes(token.value)) return "*";
		const local = unit.localValues.get(token.value);
		if (local?.kind === "string") return local.value;
		if (local?.kind === "template") return templateToPattern(local.value);
	}
	return "*";
}

// ---------------------------------------------------------------------------
// Token-slice helpers
// ---------------------------------------------------------------------------

/** Index of the token matching the bracket opened at `open`, or `undefined`. */
function matchBracket(tokens: readonly Token[], open: number, openChar: string, closeChar: string): number | undefined {
	let depth = 0;
	for (let index = open; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.kind !== "punct") continue;
		if (token.value === openChar) depth += 1;
		else if (token.value === closeChar) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return undefined;
}

/** Token slice from `open` through its matching bracket, inclusive. */
function balancedRange(
	tokens: readonly Token[],
	open: number,
	openChar: string,
	closeChar: string,
): readonly Token[] | undefined {
	const close = matchBracket(tokens, open, openChar, closeChar);
	if (close === undefined) return undefined;
	return tokens.slice(open, close + 1);
}

/** Top-level element slices of an array-literal token slice (`[ ... ]` inclusive). */
function arrayElements(arrayTokens: readonly Token[]): readonly (readonly Token[])[] {
	const elements: Token[][] = [];
	let depth = 0;
	let current: Token[] = [];
	for (const token of arrayTokens.slice(1, -1)) {
		if (token.kind === "punct") {
			if ("([{".includes(token.value)) depth += 1;
			else if (")]}".includes(token.value)) depth -= 1;
			else if (token.value === "," && depth === 0) {
				if (current.length > 0) elements.push(current);
				current = [];
				continue;
			}
		}
		current.push(token);
	}
	if (current.length > 0) elements.push(current);
	return elements;
}

/** Argument slices of a call whose `(` is at `openIndex`. */
/** Argument slices of a call whose head (identifier) starts the slice. */
function splitCallArguments(tokens: readonly Token[]): readonly (readonly Token[])[] {
	const open = tokens.findIndex((token) => token.kind === "punct" && token.value === "(");
	if (open < 0) return [];
	return splitTopLevelArguments({ method: "stage", argsOpen: open }, tokens);
}
/** Value token of `key:` at the direct level of an object-literal slice (`{ ... }` inclusive). */
function directObjectFieldValue(object: readonly Token[], key: string): Token | undefined {
	let depth = 0;
	for (let index = 1; index < object.length - 1; index += 1) {
		const token = object[index]!;
		if (token.kind === "punct") {
			if ("([{".includes(token.value)) {
				depth += 1;
				continue;
			}
			if (")]}".includes(token.value)) {
				depth -= 1;
				continue;
			}
		}
		if (depth !== 0) continue;
		if (token.kind === "ident" && token.value === key) {
			const next = object[index + 1];
			const value = object[index + 2];
			if (next?.kind === "punct" && next.value === ":" && value !== undefined) return value;
			// Shorthand property (`{ name, ... }`): the key token stands for the
			// value so factory parameter substitution can resolve it.
			if (next?.kind === "punct" && (next.value === "," || next.value === "}")) return token;
		}
	}
	return undefined;
}

/** `key:` value token slice from a token slice containing one object literal. */
function objectFieldValue(tokens: readonly Token[], key: string): readonly Token[] | undefined {
	const open = tokens.findIndex((token) => token.kind === "punct" && token.value === "{");
	if (open < 0) return undefined;
	const object = balancedRange(tokens, open, "{", "}");
	if (object === undefined) return undefined;
	const value = directObjectFieldValue(object, key);
	return value === undefined ? undefined : [value];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function relativeImportTargets(unit: FileUnit, importingFile: string): readonly string[] {
	const targets: string[] = [];
	for (const binding of unit.imports.values()) {
		const resolved = resolveRelativeSpecifier(binding.specifier, importingFile);
		if (resolved !== undefined) targets.push(resolved);
	}
	return [...new Set(targets)].sort();
}

/** Resolve a relative specifier to an existing file, probing TS/JS conventions. */
function resolveRelativeSpecifier(specifier: string, importingFile: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const candidates: string[] = [];
	if (specifier.endsWith(".js")) {
		candidates.push(join(dirname(importingFile), `${specifier.slice(0, -3)}.ts`));
	}
	candidates.push(
		join(dirname(importingFile), specifier),
		join(dirname(importingFile), `${specifier}.ts`),
		join(dirname(importingFile), `${specifier}.js`),
		join(dirname(importingFile), specifier, "index.ts"),
		join(dirname(importingFile), specifier, "index.js"),
	);
	return candidates.find((candidate) => isFileSync(candidate));
}

function isFileSync(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		readFileSync(path, { flag: "r" });
		return true;
	} catch {
		return false;
	}
}

function safeNormalize(name: string): string {
	try {
		return normalizeWorkflowName(name);
	} catch {
		return "";
	}
}

function kebabCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
