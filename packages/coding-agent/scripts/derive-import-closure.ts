import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import type { BuiltinPackageDirName } from "../src/core/builtin-install-layout.js";

// This build-time walker intentionally remains separate from test/unit/module-graph-walker.ts. The latter models
// the complete runtime loader graph for tests, while production packaging code must not import from the test tree.
// This narrower walker follows relative filesystem edges only, but matches the test walker by failing closed when a
// direct import or require specifier cannot be determined statically.

// Only packages whose kept raw TypeScript runs directly from the filesystem participate. The intercom broker is
// spawned as its own jiti process, so it has no host aliases or virtualModules fallback. Workflows is deliberately
// excluded: its installed authoring surface prunes raw sources for issue #1208, and tracing it would resurrect them.
export const INSTALLED_IMPORT_CLOSURE_ROOTS: Partial<Record<BuiltinPackageDirName, readonly string[]>> = {
	intercom: ["broker/"],
};

const SKIPPED_ENTRY_NAMES = new Set([
	"node_modules",
	".git",
	".github",
	"coverage",
	".nyc_output",
	".DS_Store",
	".turbo",
	".vite",
	".vitest",
	"test",
	"tests",
]);

interface SyntaxNode {
	[key: string]: SyntaxValue | undefined;
	type?: string;
	value?: string;
}

type SyntaxValue = string | number | boolean | null | SyntaxNode | SyntaxValue[];

export function shouldSkipBuiltinCopyEntry(name: string): boolean {
	return (
		SKIPPED_ENTRY_NAMES.has(name) ||
		name.endsWith(".test.ts") ||
		name.endsWith(".test.mjs") ||
		name.endsWith(".spec.ts") ||
		name.endsWith(".map")
	);
}

function inside(parent: string, path: string): boolean {
	const fromParent = relative(parent, path);
	return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function stringLiteralValue(value: SyntaxValue | undefined): string | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.value === "string"
		? value.value
		: undefined;
}

function isIdentifier(value: SyntaxValue | undefined, name: string): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		value.type === "Identifier" &&
		value.name === name
	);
}

function requireSpecifier(value: SyntaxNode, path: string): string | undefined {
	if (value.type !== "CallExpression" || !isIdentifier(value.callee, "require")) return undefined;
	const argument = Array.isArray(value.arguments) ? value.arguments[0] : undefined;
	const specifier = stringLiteralValue(argument);
	if (specifier === undefined) {
		throw new Error(`Non-literal require() specifier in ${path}`);
	}
	return specifier;
}

export function relativeImportSpecifiers(path: string): string[] {
	const imports = new Set<string>();
	const visit = (value: SyntaxValue | undefined): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		let specifier: string | undefined;
		if (
			value.type === "ImportDeclaration" ||
			value.type === "ExportNamedDeclaration" ||
			value.type === "ExportAllDeclaration"
		) {
			specifier = stringLiteralValue(value.source);
		} else if (value.type === "TSImportType") {
			// Babel 8 stores this on `source`; `argument` is the explicit fallback for older parser majors.
			specifier = stringLiteralValue(value.source) ?? stringLiteralValue(value.argument);
		} else if (value.type === "ImportExpression") {
			specifier = stringLiteralValue(value.source);
			if (specifier === undefined) {
				// Packaging cannot prove a computed edge is safe. Fail closed instead of silently pruning its target.
				throw new Error(`Non-literal import() specifier in ${path}`);
			}
		} else if (value.type === "CallExpression" && isIdentifier(value.callee, "Import")) {
			const argument = Array.isArray(value.arguments) ? value.arguments[0] : undefined;
			specifier = stringLiteralValue(argument);
			if (specifier === undefined) throw new Error(`Non-literal import() specifier in ${path}`);
		} else {
			specifier = requireSpecifier(value, path);
		}
		if (specifier?.startsWith(".")) imports.add(specifier);
		for (const [key, child] of Object.entries(value)) {
			if (key !== "loc" && key !== "extra") visit(child);
		}
	};
	visit(parse(readFileSync(path, "utf8"), { sourceType: "module", plugins: ["typescript"] }) as object as SyntaxNode);
	return [...imports];
}

export function resolveRelativeImport(importer: string, specifier: string): string | undefined {
	const emittedPath = resolve(dirname(importer), specifier);
	const sourcePath = emittedPath
		.replace(/\.mjs$/u, ".mts")
		.replace(/\.cjs$/u, ".cts")
		.replace(/\.jsx$/u, ".tsx")
		.replace(/\.js$/u, ".ts");
	return [sourcePath, emittedPath, `${emittedPath}.ts`, join(emittedPath, "index.ts")].find(
		(path) => existsSync(path) && statSync(path).isFile(),
	);
}

function normalizedRelativePath(parent: string, path: string): string {
	return relative(parent, path).split("\\").join("/");
}

function pathIsSkipped(packageRoot: string, path: string): boolean {
	return normalizedRelativePath(packageRoot, path).split("/").some(shouldSkipBuiltinCopyEntry);
}

/**
 * Derive every source file transitively reached by relative imports from raw TypeScript files beneath the roots.
 * Imports cannot escape the package, and excluded test/build paths are never copied.
 */
export function deriveImportClosure(packageRoot: string, roots: readonly string[]): ReadonlySet<string> {
	const resolvedPackageRoot = resolve(packageRoot);
	const pending: string[] = [];
	const visited = new Set<string>();
	const closure = new Set<string>();

	const addRootFiles = (path: string): void => {
		if (!inside(resolvedPackageRoot, path) || !existsSync(path) || pathIsSkipped(resolvedPackageRoot, path)) return;
		const stats = statSync(path);
		if (stats.isDirectory()) {
			for (const entry of readdirSync(path)) addRootFiles(join(path, entry));
		} else if (stats.isFile() && path.endsWith(".ts")) {
			pending.push(path);
		}
	};
	for (const root of roots) addRootFiles(resolve(resolvedPackageRoot, root));

	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined) break;
		const relativePath = normalizedRelativePath(resolvedPackageRoot, path);
		if (visited.has(relativePath)) continue;
		visited.add(relativePath);
		closure.add(relativePath);
		for (const specifier of relativeImportSpecifiers(path)) {
			const unresolvedPath = resolve(dirname(path), specifier);
			if (!inside(resolvedPackageRoot, unresolvedPath)) {
				throw new Error(`Relative import ${specifier} from ${relativePath} escapes the package root`);
			}
			const dependency = resolveRelativeImport(path, specifier);
			if (dependency === undefined) {
				throw new Error(`Unresolved relative import ${specifier} from ${relativePath}`);
			}
			const dependencyRelativePath = normalizedRelativePath(resolvedPackageRoot, dependency);
			if (pathIsSkipped(resolvedPackageRoot, dependency)) {
				throw new Error(
					`Relative import ${specifier} from ${relativePath} resolves to excluded path ${dependencyRelativePath}`,
				);
			}
			closure.add(dependencyRelativePath);
			if (dependency.endsWith(".ts") && !visited.has(dependencyRelativePath)) pending.push(dependency);
		}
	}
	return closure;
}
