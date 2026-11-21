// How the startup-stages build reads a module's source (write-startup-stages.mjs): its static imports, whether it awaits
// at its top level, and where its trace marker goes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";

/**
 * Where the trace's marker goes in a module's source, and what goes before it: after a `#!` line, and in a CommonJS
 * module after its directives (`"use strict"`), which only count at its start, ended with a `;` in case they were not.
 */
/**
 * @param {string} source
 * @param {string} format
 * @returns {{ at: number, before: string }}
 */
export function markerPlace(source, format) {
	const lineEnd = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
	if (format !== "commonjs") return { at: lineEnd, before: "" };
	try {
		const program = parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowHashBang: true,
			allowReturnOutsideFunction: true,
		});
		let end = lineEnd;
		for (const node of program.body) {
			if (node.type !== "ExpressionStatement" || typeof node.directive !== "string") break;
			end = node.end;
		}
		return { at: end, before: end > lineEnd ? ";" : "" };
	} catch {
		return { at: lineEnd, before: "" };
	}
}

/**
 * An ES module's static import specifiers in source order (`import`, `export … from`), and whether it awaits at its top
 * level.
 * @param {string} source
 * @returns {{ specifiers: string[], topLevelAwait: boolean }}
 */
export function readModule(source) {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
	const specifiers = [];
	for (const node of program.body) {
		if (
			(node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") &&
			node.source
		)
			specifiers.push(String(node.source.value));
	}
	// Everything that runs while the module runs: not the bodies of functions, and not what a class runs later (its
	// fields' values and static blocks, where an await cannot appear); a class's base, computed keys and decorators run
	// with the module.
	const awaits = (node) => {
		if (!node || typeof node.type !== "string") return false;
		if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|StaticBlock)$/.test(node.type)) return false;
		if (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await)) return true;
		if (node.type === "VariableDeclaration" && node.kind === "await using") return true;
		if (node.type === "PropertyDefinition")
			return (node.computed && awaits(node.key)) || (node.decorators ?? []).some(awaits);
		return Object.entries(node).some(([key, value]) =>
			key === "loc" ? false : Array.isArray(value) ? value.some(awaits) : value !== null && typeof value === "object" && awaits(value),
		);
	};
	return { specifiers, topLevelAwait: program.body.some(awaits) };
}

/**
 * The specifiers of a module's `import("…")` calls with a literal specifier, in source order.
 * @param {string} source
 * @returns {string[]}
 */
export function dynamicImports(source) {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
	const specifiers = [];
	const visit = (node) => {
		if (!node || typeof node.type !== "string") return;
		if (node.type === "ImportExpression" && node.source.type === "Literal" && typeof node.source.value === "string")
			specifiers.push(node.source.value);
		for (const [key, value] of Object.entries(node)) {
			if (key === "loc") continue;
			if (Array.isArray(value)) value.forEach(visit);
			else if (value !== null && typeof value === "object") visit(value);
		}
	};
	visit(program);
	return specifiers;
}

/**
 * `cli.js`'s own imports, as it makes them: what it imports before the stages load (its static imports, the prewarm,
 * the early editor) and the session's entry modules it imports at once (`Promise.all`) after them: its `import()`
 * calls before and after the one of the stage loader, whatever the build named the files.
 */
/**
 * @param {string} dist
 * @returns {{ before: string[], loader: string, entries: string[] }}
 */
export function cliImports(dist) {
	const cliUrl = pathToFileURL(join(dist, "cli.js")).href;
	const source = readFileSync(join(dist, "cli.js"), "utf8");
	// A bare name resolves from this module as from cli.js: both are inside this package.
	const resolve = (specifier) =>
		specifier.startsWith(".") ? new URL(specifier, cliUrl).href : import.meta.resolve(specifier);
	const dynamic = dynamicImports(source);
	const loader = dynamic.findIndex((specifier) => /(^|\/)startup-stages[^/]*\.js$/.test(specifier));
	if (loader === -1) throw new Error("cli.js does not import the startup stage loader");
	return {
		before: [...readModule(source).specifiers, ...dynamic.slice(0, loader)].map(resolve),
		loader: resolve(dynamic[loader]),
		entries: dynamic.slice(loader + 1).map(resolve),
	};
}
