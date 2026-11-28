#!/usr/bin/env node
// Use the pinned TypeScript checker's symbols, not same-name declarations that may be shadowed.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";
import * as ts from "typescript/unstable/ast";
import { API, SymbolFlags } from "typescript/unstable/sync";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = resolve(ROOT, "scripts/timer-audit.tsconfig.json");
const MAX_NATIVE_DELAY = 2_147_483_647;
const timerNames = new Set(["setTimeout", "setInterval", "timeout"]);

/** @typedef {import('typescript/unstable/ast').Node} Node */
/** @typedef {import('typescript/unstable/sync').Checker} Checker */
/** @typedef {import('typescript/unstable/sync').Symbol} Symbol */

/** @param {Node} node @param {(node: Node) => void} visit */
function walk(node, visit) {
	visit(node);
	node.forEachChild((child) => {
		walk(child, visit);
	});
}

/** @param {Checker} checker @param {Symbol | undefined} symbol */
function dereference(checker, symbol) {
	return symbol && (symbol.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

/** @param {Node} expression */
function symbolNode(expression) {
	if (ts.isPropertyAccessExpression(expression)) return expression.name;
	if (ts.isElementAccessExpression(expression)) return expression.argumentExpression;
	return expression;
}

/** @param {Checker} checker @param {Symbol | undefined} symbol @param {Set<Symbol>} [seen] @returns {number | undefined} */
function delayPosition(checker, symbol, seen = new Set()) {
	symbol = dereference(checker, symbol);
	if (!symbol || seen.has(symbol)) return undefined;
	seen.add(symbol);
	if (timerNames.has(symbol.name)) {
		for (const declaration of symbol.declarations) {
			const file = declaration.path.replaceAll("\\", "/");
			if (
				!/\/@types\/node\/(?:timers(?:\/|\.d\.ts$)|globals\.d\.ts$|web-globals\/abortcontroller\.d\.ts$)|\/lib\.dom\.d\.ts$|\/lib\.webworker\.d\.ts$/.test(
					file,
				)
			)
				continue;
			return symbol.name === "timeout" || file.includes("/timers/promises") ? 0 : 1;
		}
	}
	const declaration = symbol.valueDeclaration?.resolve();
	if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
		return delayPosition(checker, checker.getSymbolAtLocation(symbolNode(declaration.initializer)), seen);
	}
	if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
		const owner = declaration.parent.parent;
		if (ts.isVariableDeclaration(owner) && owner.initializer) {
			const source = checker.getTypeAtLocation(owner.initializer);
			const member = declaration.propertyName ?? declaration.name;
			if (source && (ts.isIdentifier(member) || ts.isStringLiteral(member))) {
				return delayPosition(checker, checker.getPropertyOfType(source, member.text), seen);
			}
		}
	}
	return undefined;
}

/** @param {import('typescript/unstable/sync').Type | undefined} type @returns {number[]} */
function literalNumbers(type) {
	if (type?.isNumberLiteralType()) return [type.value];
	if (type?.isUnionType()) {
		const parts = type.types.map(literalNumbers);
		if (parts.every((part) => part.length > 0)) return parts.flat();
	}
	return [];
}

/** @param {Checker} checker @param {Node} node @param {Set<Symbol>} [seen] @returns {number[]} */
function values(checker, node, seen = new Set()) {
	if (ts.isNumericLiteral(node)) return [Number(node.text)];
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		node.kind === ts.SyntaxKind.TypeAssertionExpression
	) {
		return values(checker, node.expression, seen);
	}
	if (ts.isConditionalExpression(node)) {
		const a = values(checker, node.whenTrue, seen);
		const b = values(checker, node.whenFalse, seen);
		return a.length && b.length ? [...a, ...b] : [];
	}
	if (ts.isBinaryExpression(node)) {
		const left = values(checker, node.left, seen);
		const right = values(checker, node.right, seen);
		return left.flatMap((a) =>
			right.map((b) => {
				switch (node.operatorToken.kind) {
					case ts.SyntaxKind.PlusToken:
						return a + b;
					case ts.SyntaxKind.MinusToken:
						return a - b;
					case ts.SyntaxKind.AsteriskToken:
						return a * b;
					case ts.SyntaxKind.SlashToken:
						return a / b;
					case ts.SyntaxKind.AsteriskAsteriskToken:
						return a ** b;
					default:
						return NaN;
				}
			}),
		);
	}
	if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
		const symbol = dereference(checker, checker.getSymbolAtLocation(symbolNode(node)));
		const declaration = symbol?.valueDeclaration?.resolve();
		if (symbol && !seen.has(symbol) && declaration) {
			if (
				ts.isVariableDeclaration(declaration) &&
				declaration.parent.flags & ts.NodeFlags.Const &&
				declaration.initializer
			) {
				return values(checker, declaration.initializer, new Set([...seen, symbol]));
			}
			const constant = checker.getConstantValue(node);
			if (typeof constant === "number") return [constant];
			return literalNumbers(checker.getTypeAtLocation(node));
		}
	}
	return [];
}

/** @param {string} root @param {string} config @param {readonly string[]} files @param {boolean} [all] */
export function scanNativeTimers(root, config, files, all = false) {
	const api = new API({ cwd: root });
	try {
		const snapshot = api.updateSnapshot({ openProjects: [config] });
		try {
			const project = snapshot.getProject(config);
			if (!project) throw new Error(`Timer guard cannot open ${config}`);
			const { checker } = project;
			return files.flatMap((file) => {
				const path = resolve(root, file);
				const source = project.program.getSourceFile(path);
				if (!source) throw new Error(`Timer guard cannot read ${file} through ${config}`);
				const calls = [];
				walk(source, (node) => {
					if (ts.isCallExpression(node)) calls.push(node);
				});
				const symbols = calls.length
					? checker.getSymbolAtLocation(calls.map((node) => symbolNode(node.expression)))
					: [];
				return calls.flatMap((node, i) => {
					const index = delayPosition(checker, symbols[i]);
					if (index === undefined) return [];
					const spread = node.arguments.slice(0, index + 1).find(ts.isSpreadElement);
					const delay = spread ?? node.arguments[index];
					const candidates = delay ? values(checker, delay) : [];
					const constant =
						!delay ||
						(candidates.length > 0 && candidates.every((value) => value >= 0 && value <= MAX_NATIVE_DELAY));
					if (!all && constant) return [];
					const expression = delay?.getText().replace(/\s+/g, " ") ?? "(omitted)";
					return [
						{ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, expression, constant },
					];
				});
			});
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

export function auditNativeTimers(all = false) {
	// The helper owns native timers; the export viewer's vendored libraries are not Atomic source.
	const files = globSync(
		[
			"packages/*/src/**/*.{ts,js,mjs,cjs}",
			"!packages/timers/src/**",
			"!packages/coding-agent/src/core/export-html/vendor/**",
		],
		{ cwd: ROOT },
	).sort();
	return scanNativeTimers(ROOT, CONFIG, files, all);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	for (const { file, line, expression } of auditNativeTimers(process.argv.includes("--all")))
		console.log(`${file}:${line}: ${expression}`);
}
