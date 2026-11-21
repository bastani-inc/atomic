/**
 * Atomic's forks of pi's packages, each with the earlier names extensions may still import it by. The loader maps
 * every legacy name, and every subpath of it, to the same host module as Atomic's own name, so existing extensions keep
 * sharing the running host's instances.
 */
export const FORKED_PACKAGE_LEGACY_NAMES: Readonly<Record<string, readonly string[]>> = {
	"@bastani/atomic-ai": ["@bastani/pi-ai", "@earendil-works/pi-ai", "@mariozechner/pi-ai"],
	"@bastani/atomic-agent-core": ["@earendil-works/pi-agent-core", "@mariozechner/pi-agent-core"],
	"@bastani/atomic-tui": ["@earendil-works/pi-tui", "@mariozechner/pi-tui"],
	"@bastani/atomic-codemode": ["@earendil-works/pi-codemode", "@mariozechner/pi-codemode"],
	"@bastani/atomic-schema": ["@earendil-works/pi-schema", "@mariozechner/pi-schema"],
	"@bastani/atomic-telemetry": ["@earendil-works/pi-telemetry", "@mariozechner/pi-telemetry"],
};

/** Every package name, Atomic's and legacy, that resolves to one of Atomic's forked packages. */
export const FORKED_PACKAGE_NAMES: readonly string[] = Object.entries(FORKED_PACKAGE_LEGACY_NAMES).flatMap(
	([name, legacyNames]) => [name, ...legacyNames],
);

function forkedPackageOf(specifier: string): { name: string; subpath: string } | undefined {
	for (const name of Object.keys(FORKED_PACKAGE_LEGACY_NAMES)) {
		if (specifier === name || specifier.startsWith(`${name}/`)) {
			return { name, subpath: specifier.slice(name.length) };
		}
	}
	return undefined;
}

/**
 * Adds every legacy name of each forked-package specifier in `modules`, keeping key order: each specifier is followed
 * by its legacy forms, so a subpath listed before its package root still precedes every root.
 */
export function withLegacyPackageNames<T>(modules: Record<string, T>): Record<string, T> {
	const result: Record<string, T> = {};
	for (const [specifier, value] of Object.entries(modules)) {
		result[specifier] = value;
		const forked = forkedPackageOf(specifier);
		if (!forked) continue;
		for (const legacyName of FORKED_PACKAGE_LEGACY_NAMES[forked.name] ?? []) {
			result[`${legacyName}${forked.subpath}`] = value;
		}
	}
	return result;
}

/**
 * TypeBox's public subpaths. Atomic bundles one copy of TypeBox in `@bastani/atomic-ai/utils/typebox/`, and every
 * `typebox` specifier an extension imports resolves to it.
 */
export const TYPEBOX_SUBPATHS = [
	"",
	"/compile",
	"/error",
	"/format",
	"/guard",
	"/schema",
	"/system",
	"/type",
	"/value",
] as const;

/** Workspace directory under `packages/` of each forked package. */
export const FORKED_PACKAGE_WORKSPACE_DIRS: Readonly<Record<string, string>> = {
	"@bastani/atomic-ai": "ai",
	"@bastani/atomic-agent-core": "agent",
	"@bastani/atomic-tui": "tui",
	"@bastani/atomic-codemode": "codemode",
	"@bastani/atomic-schema": "schema",
	"@bastani/atomic-telemetry": "telemetry",
};

type ExportTarget = string | { import?: string; default?: string };

/** The fields of a forked package's manifest that decide which files its specifiers load. */
export interface ForkedPackageManifest {
	main?: string;
	exports?: Record<string, ExportTarget>;
}

/**
 * File aliases for every specifier a forked package's manifest exposes, rooted at `packageRoot`. jiti matches aliases
 * by prefix, so each subpath needs its own key: without one, `<name>/<subpath>` resolves below the root entry file.
 * A wildcard export (`./api/*`) maps its directory, and a package without an exports map exposes its `dist` directory.
 */
export function forkedPackageExportAliases(
	name: string,
	packageRoot: string,
	manifest: ForkedPackageManifest,
	join: (...segments: string[]) => string,
): Record<string, string> {
	const aliases: Record<string, string> = {};
	if (!manifest.exports) {
		aliases[`${name}/dist`] = join(packageRoot, "dist");
		if (manifest.main) aliases[name] = join(packageRoot, manifest.main);
		return aliases;
	}
	for (const [key, value] of Object.entries(manifest.exports)) {
		const target = typeof value === "string" ? value : (value.import ?? value.default);
		if (!target) continue;
		if (key.endsWith("/*")) {
			const star = target.indexOf("*");
			aliases[`${name}${key.slice(1, -2)}`] = join(packageRoot, target.slice(0, star).replace(/\/$/u, ""));
			continue;
		}
		aliases[key === "." ? name : `${name}${key.slice(1)}`] = join(packageRoot, target);
	}
	return aliases;
}
