import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "@babel/parser";
import { type Node, type TraversalAncestors, traverse } from "@babel/types";
import { test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const staticCatalogGetters = new Set([
	"getModel",
	"getBuiltinModel",
	"getImageModel",
	"getBuiltinImageModel",
	"getBuiltinClassifierModel",
]);

function isModelCatalogModule(path: string): boolean {
	return (
		/^@(?:bastani\/(?:atomic|pi)-ai|earendil-works\/pi-ai|mariozechner\/pi-ai)(?:\/|$)/.test(path) ||
		/^\.{1,2}\/.*\bsrc\/(?:compat|providers\/all|image-models|index)\.[cm]?[jt]s$/.test(path)
	);
}

function importedName(node: Node): string | undefined {
	if (node.type === "Identifier") return node.name;
	if (node.type === "StringLiteral") return node.value;
	return undefined;
}

function isLiteralId(node: Node): boolean {
	switch (node.type) {
		case "StringLiteral":
		case "TemplateLiteral":
			return true;
		case "TSAsExpression":
		case "TSTypeAssertion":
		case "TSSatisfiesExpression":
		case "TSNonNullExpression":
			return isLiteralId(node.expression);
		default:
			return false;
	}
}

function typedCatalogCalls(source: string, file: string): string[] {
	const ast = parse(source, {
		sourceType: "unambiguous",
		plugins: /\.[jt]sx$/.test(file) ? ["typescript", "jsx"] : ["typescript"],
	});
	const namespaceImports = new Set<string>();
	const getterImports = new Set<string>();
	const generatedRecords = new Set<string>();
	for (const declaration of ast.program.body) {
		if (declaration.type !== "ImportDeclaration") continue;
		const source = declaration.source.value;
		const catalogModule = isModelCatalogModule(source);
		const generatedModule = /(?:\.models|\/models\.generated)\.[cm]?[jt]s$/.test(source);
		for (const specifier of declaration.specifiers) {
			if (catalogModule && specifier.type === "ImportNamespaceSpecifier") namespaceImports.add(specifier.local.name);
			if (specifier.type !== "ImportSpecifier") continue;
			const name = importedName(specifier.imported) ?? "";
			if (catalogModule && staticCatalogGetters.has(name)) getterImports.add(specifier.local.name);
			if (generatedModule && /(?:^|_)MODELS$/.test(name)) generatedRecords.add(specifier.local.name);
		}
	}
	function isGeneratedRecord(node: Node): boolean {
		if (node.type === "Identifier") return generatedRecords.has(node.name);
		return (
			(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
			isGeneratedRecord(node.object)
		);
	}
	const failures: string[] = [];
	traverse(ast, {
		enter(node: Node, _ancestors: TraversalAncestors) {
			if (
				(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
				node.computed &&
				isGeneratedRecord(node.object) &&
				isLiteralId(node.property)
			)
				failures.push(`${file}:${node.loc?.start.line ?? 1}`);
			if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
			const modelId = node.arguments[1];
			if (!modelId || !isLiteralId(modelId)) return;
			const call = node.callee;
			const named = call.type === "Identifier" && getterImports.has(call.name);
			const namespaced =
				(call.type === "MemberExpression" || call.type === "OptionalMemberExpression") &&
				call.object.type === "Identifier" &&
				namespaceImports.has(call.object.name) &&
				staticCatalogGetters.has(importedName(call.property) ?? "");
			if (named || namespaced) failures.push(`${file}:${node.loc?.start.line ?? 1}`);
		},
	});
	return failures;
}

test("detects renamed and namespace catalog getters and generated map keys, not fixture or runtime lookups", () => {
	const source = `
import { getModel as catalogModel } from "@bastani/atomic-ai/compat";
import * as catalog from "../src/providers/all.ts";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { MODELS as generated } from "../src/models.generated.ts";
catalogModel(provider, "claude-example" as never);
catalog.getBuiltinImageModel("openrouter", "example/image");
generated.cerebras["example"];
registry.getModel(provider, "claude-example");
getFixtureModel("anthropic", "claude-example");
`;
	assert.deepEqual(typedCatalogCalls(source, "example.test.ts"), [
		"example.test.ts:6",
		"example.test.ts:7",
		"example.test.ts:8",
	]);
});

test("tests do not use typed getters with literal IDs from the generated model catalog", () => {
	const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((path) => /(?:^|\/)(?:test|typetests)\//.test(path) && /\.[cm]?[jt]sx?$/.test(path));
	const failures: string[] = [];
	for (const file of files) {
		const source = readFileSync(resolve(root, file), "utf8");
		if (!source.includes("MODELS") && ![...staticCatalogGetters].some((getter) => source.includes(getter))) continue;
		failures.push(...typedCatalogCalls(source, file));
	}
	assert.deepEqual(
		failures,
		[],
		"Use a checked-in model fixture or an untyped optional catalog lookup with a skip reason",
	);
});
