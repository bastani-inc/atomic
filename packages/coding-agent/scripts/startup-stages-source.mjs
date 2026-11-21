// How the startup-stages build reads a module's source (write-startup-stages.mjs): its static imports, whether it awaits
// at its top level, and where its trace marker goes.
import { parse } from "acorn";

/**
 * Where the trace's marker goes in a module's source, and what goes before it: after a `#!` line, and in a CommonJS
 * module after its directives (`"use strict"`), which only count at its start, ended with a `;` in case they were not.
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

/** An ES module's static import specifiers in source order (`import`, `export … from`), and whether it awaits at its top level. */
export function readModule(source) {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
	const specifiers = [];
	for (const node of program.body) {
		if (
			(node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") &&
			node.source
		)
			specifiers.push(node.source.value);
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
