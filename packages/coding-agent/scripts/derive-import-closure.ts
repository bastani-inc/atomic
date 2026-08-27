import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import type { BuiltinPackageDirName } from "../src/core/builtin-install-layout.js";

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

function relativeImports(path: string): string[] {
	const imports = new Set<string>();
	const visit = (value: SyntaxValue | undefined): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		if (
			value.type === "ImportDeclaration" ||
			value.type === "ExportNamedDeclaration" ||
			value.type === "ExportAllDeclaration"
		) {
			const specifier = value.source;
			if (typeof specifier === "object" && !Array.isArray(specifier) && specifier?.value?.startsWith(".")) {
				imports.add(specifier.value);
			}
		} else if (value.type === "TSImportType") {
			const specifier = value.argument;
			if (typeof specifier === "object" && !Array.isArray(specifier) && specifier?.value?.startsWith(".")) {
				imports.add(specifier.value);
			}
		} else if (value.type === "ImportExpression") {
			const specifier = value.source;
			if (typeof specifier === "object" && !Array.isArray(specifier) && specifier?.value?.startsWith(".")) {
				imports.add(specifier.value);
			}
		}
		for (const [key, child] of Object.entries(value)) {
			if (key !== "loc" && key !== "extra") visit(child);
		}
	};
	visit(parse(readFileSync(path, "utf8"), { sourceType: "module", plugins: ["typescript"] }) as object as SyntaxNode);
	return [...imports];
}

function resolveRelativeImport(importer: string, specifier: string): string | undefined {
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
		for (const specifier of relativeImports(path)) {
			const unresolvedPath = resolve(dirname(path), specifier);
			if (!inside(resolvedPackageRoot, unresolvedPath)) {
				throw new Error(`Relative import ${specifier} from ${relativePath} escapes the package root`);
			}
			const dependency = resolveRelativeImport(path, specifier);
			if (dependency === undefined) {
				throw new Error(`Unresolved relative import ${specifier} from ${relativePath}`);
			}
			if (!pathIsSkipped(resolvedPackageRoot, dependency)) {
				const dependencyRelativePath = normalizedRelativePath(resolvedPackageRoot, dependency);
				closure.add(dependencyRelativePath);
				if (dependency.endsWith(".ts") && !visited.has(dependencyRelativePath)) pending.push(dependency);
			}
		}
	}
	return closure;
}
