#!/usr/bin/env node
// Report native timer calls whose delay is not a known in-range constant.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { VISITOR_KEYS } from "@babel/types";
import { globSync } from "tinyglobby";

const MAX_NATIVE_DELAY = 2_147_483_647;
const nativeTimers = new Set(["setTimeout", "setInterval"]);
const nodeTimers = /^(?:node:)?timers(\/promises)?$/;

/** @param {import('@babel/types').Node} node @param {(node: import('@babel/types').Node) => void} visit */
function walk(node, visit) {
	visit(node);
	for (const key of VISITOR_KEYS[node.type] ?? []) {
		const children = node[key];
		if (Array.isArray(children)) {
			for (const child of children) if (child) walk(child, visit);
		} else if (children) {
			walk(children, visit);
		}
	}
}

/** @param {import('@babel/types').Node | null | undefined} node */
function name(node) {
	return node?.type === "Identifier" ? node.name : node?.type === "StringLiteral" ? node.value : undefined;
}

/**
 * Only literal/const arithmetic is known: arbitrary calls (including Math.min), mutable values,
 * member lookups, settings and parameters must use the helper or have a specific exemption.
 * @param {import('@babel/types').Node | null | undefined} node
 * @param {Map<string, import('@babel/types').Node | null>} constants
 * @param {Set<string>} [visiting]
 * @returns {number[]}
 */
function values(node, constants, visiting = new Set()) {
	if (node?.type === "NumericLiteral") return [node.value];
	if (node?.type === "Identifier" && !visiting.has(node.name)) {
		return values(constants.get(node.name), constants, new Set([...visiting, node.name]));
	}
	if (node?.type === "ConditionalExpression") {
		const a = values(node.consequent, constants, visiting);
		const b = values(node.alternate, constants, visiting);
		return a.length && b.length ? [...a, ...b] : [];
	}
	if (node?.type === "BinaryExpression") {
		const left = values(node.left, constants, visiting);
		const right = values(node.right, constants, visiting);
		if (!left.length || !right.length) return [];
		return left.flatMap((a) =>
			right.map((b) => {
				switch (node.operator) {
					case "+":
						return a + b;
					case "-":
						return a - b;
					case "*":
						return a * b;
					case "/":
						return a / b;
					case "**":
						return a ** b;
					default:
						return NaN;
				}
			}),
		);
	}
	return [];
}

/** @param {string} source @param {string} file */
export function scanNativeTimers(source, file) {
	if (!/\b(?:setTimeout|setInterval|AbortSignal)\b/.test(source)) return [];
	const { program } = parse(source, {
		sourceType: "unambiguous",
		plugins: file.endsWith(".ts") ? ["typescript", "decorators-legacy"] : [],
	});
	const constants = new Map();
	const timers = new Map([
		["setTimeout", 1],
		["setInterval", 1],
	]);
	const namespaces = new Map([
		["globalThis", 1],
		["global", 1],
		["window", 1],
		["self", 1],
	]);
	for (const node of program.body) {
		const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
		if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
			for (const binding of declaration.declarations) {
				if (binding.id.type === "Identifier") constants.set(binding.id.name, binding.init ?? null);
			}
		}
		if (node.type !== "ImportDeclaration") continue;
		const module = nodeTimers.exec(node.source.value);
		if (!module) continue;
		const delayPosition = module[1] ? 0 : 1;
		for (const binding of node.specifiers) {
			if (binding.type !== "ImportSpecifier") namespaces.set(binding.local.name, delayPosition);
			else if (nativeTimers.has(name(binding.imported))) timers.set(binding.local.name, delayPosition);
		}
	}
	const sites = [];
	walk(program, (node) => {
		if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
		const { callee } = node;
		let index;
		if (callee.type === "Identifier") index = timers.get(callee.name);
		else if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
			const object = name(callee.object);
			const member = name(callee.property);
			if (object === "AbortSignal" && member === "timeout") index = 0;
			else if (nativeTimers.has(member)) index = namespaces.get(object);
		}
		if (index === undefined) return;
		const delay = node.arguments[index];
		const candidates = values(delay, constants);
		if (!delay || (candidates.length && candidates.every((value) => value >= 0 && value <= MAX_NATIVE_DELAY))) return;
		const expression = source.slice(delay.start, delay.end).replace(/\s+/g, " ");
		sites.push({ file, line: node.loc.start.line, expression });
	});
	return sites;
}

export function auditNativeTimers() {
	const cwd = fileURLToPath(new URL("..", import.meta.url));
	return globSync(["packages/*/src/**/*.{ts,js,mjs,cjs}", "!packages/timers/src/**"], { cwd })
		.sort()
		.flatMap((file) => scanNativeTimers(readFileSync(resolve(cwd, file), "utf8"), file));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	for (const { file, line, expression } of auditNativeTimers()) console.log(`${file}:${line}: ${expression}`);
}
