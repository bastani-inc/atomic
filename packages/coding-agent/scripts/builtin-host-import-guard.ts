import { type ImportDeclaration, parse } from "acorn";
import { codeStringArrayLiteral, codeStringLiteral } from "./code-string-literal.mjs";

/**
 * A builtin extension's bundle imports Atomic's own modules (`@bastani/atomic`, `@bastani/atomic-ai`, ...) from the
 * process that loads it, which an in-place update can leave older than the bundle: a `/reload` after `npm install -g`
 * loads the new bundle against the modules the process started with. On Windows and under Bun the extension loader
 * evaluates a reloaded bundle through jiti, where a name such a module lacks reads as `undefined` instead of failing to
 * link, so the extension would start and fail later wherever it calls the name. The guard checks the bundle's named imports first and fails the load with
 * the restart message `loadOnDemand` gives (`src/utils/updated-install.ts`), before any of the bundle's own code runs.
 * Only named imports are checked: a namespace import (`import * as`) is how code reads a name it can do without, and
 * what a default import reads depends on how the module is loaded.
 */
export interface HostImportGuard {
	/** The builtin's directory name, as the extension loader names it in its own restart message. */
	readonly label: string;
	/** The version of `@bastani/atomic` this bundle was built with. */
	readonly version: string;
	/** Whether a bare specifier is one of the host's modules, which the loader provides from the running process. */
	readonly isHostSpecifier: (specifier: string) => boolean;
}

/** `source` (an ES module) with the guard before its own code, or as it is when it names no host export. */
export function withHostImportGuard(source: string, guard: HostImportGuard): string {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
	const named = new Map<string, Set<string>>();
	for (const node of program.body) {
		if (node.type !== "ImportDeclaration") continue;
		const specifier = String((node as ImportDeclaration).source.value);
		if (!guard.isHostSpecifier(specifier)) continue;
		for (const imported of (node as ImportDeclaration).specifiers) {
			if (imported.type !== "ImportSpecifier") continue;
			const name = imported.imported.type === "Identifier" ? imported.imported.name : String(imported.imported.value);
			if (name === "default") continue;
			const names = named.get(specifier) ?? new Set<string>();
			names.add(name);
			named.set(specifier, names);
		}
	}
	if (named.size === 0) return source;
	// The host package itself says which version and application name the process runs.
	const specifiers = ["@bastani/atomic", ...[...named.keys()].filter((specifier) => specifier !== "@bastani/atomic")];
	const imports = specifiers.map(
		(specifier, index) => `import * as __atomicHostImport${index} from ${codeStringLiteral(specifier)};`,
	);
	const checks = specifiers
		.filter((specifier) => named.has(specifier))
		.map(
			(specifier) =>
				`[__atomicHostImport${specifiers.indexOf(specifier)}, ${codeStringLiteral(specifier)}, ${codeStringArrayLiteral([...named.get(specifier)!].sort())}]`,
		);
	const restart = codeStringLiteral(
		` was updated to ${guard.version} while this session was running; restart it to keep using the ${guard.label} extension.`,
	);
	return [
		...imports,
		"{",
		"\tconst missing = [];",
		`\tfor (const [namespace, specifier, names] of [${checks.join(", ")}])`,
		"\t\tfor (const name of names)",
		"\t\t\tif (!(name in namespace)) missing.push(`The requested module '${specifier}' does not provide an export named '${name}'`);",
		"\tif (missing.length > 0) {",
		'\t\tconst application = typeof __atomicHostImport0.APP_NAME === "string" ? __atomicHostImport0.APP_NAME : "atomic";',
		`\t\tif (__atomicHostImport0.VERSION !== ${codeStringLiteral(guard.version)}) missing.unshift(application + ${restart});`,
		'\t\tthrow new Error(missing.join("\\n"));',
		"\t}",
		"}",
		source,
	].join("\n");
}

/** Whether `specifier` matches one of `patterns`, where a trailing `/*` matches any subpath. */
export function matchesSpecifierPattern(specifier: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) =>
		pattern.endsWith("/*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern,
	);
}
