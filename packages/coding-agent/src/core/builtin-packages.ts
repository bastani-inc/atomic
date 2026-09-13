import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPackageDir } from "../config.js";
import { moduleDirFromMetaUrl } from "../utils/split-launcher.ts";
import { stripBom } from "../utils/text.ts";
import { type BuiltinPackageDirName, requiredEntriesForBuiltin } from "./builtin-install-layout.ts";

interface BuiltinPackageDescriptor {
	readonly packageName: string;
	readonly distDirName: BuiltinPackageDirName;
	readonly mandatory: boolean;
	readonly requiredEntries: readonly string[];
	readonly sourceCandidates: (context: BuiltinPackageCandidateContext) => string[];
}

interface BuiltinPackageCandidateContext {
	readonly here: string;
	readonly packageDir: string;
	readonly isSourceCheckout: boolean;
}

export interface BuiltinPackageLocation {
	readonly packageName: string;
	readonly distDirName: BuiltinPackageDirName;
	readonly packageDir: string;
}

interface WorkspaceBuiltinSpec {
	readonly packageName: string;
	readonly workspaceDirName: BuiltinPackageDirName;
	readonly distDirName: BuiltinPackageDirName;
}

const WORKSPACE_BUILTINS: readonly (WorkspaceBuiltinSpec & { mandatory?: boolean })[] = [
	{ packageName: "@bastani/workflows", workspaceDirName: "workflows", distDirName: "workflows" },
	{ packageName: "@bastani/subagents", workspaceDirName: "subagents", distDirName: "subagents" },
	{ packageName: "@bastani/mcp", workspaceDirName: "mcp", distDirName: "mcp" },
	{ packageName: "@bastani/web-access", workspaceDirName: "web-access", distDirName: "web-access" },
	{ packageName: "@bastani/intercom", workspaceDirName: "intercom", distDirName: "intercom", mandatory: true },
	{ packageName: "@bastani/feedback", workspaceDirName: "feedback", distDirName: "feedback" },
];

const BUILTIN_PACKAGES: readonly BuiltinPackageDescriptor[] = WORKSPACE_BUILTINS.map(
	(spec): BuiltinPackageDescriptor => ({
		packageName: spec.packageName,
		distDirName: spec.distDirName,
		mandatory: spec.mandatory === true,
		requiredEntries: requiredEntriesForBuiltin(spec.distDirName),
		sourceCandidates: ({ here, packageDir, isSourceCheckout }) =>
			isSourceCheckout
				? [join(packageDir, "..", spec.workspaceDirName), join(here, "..", "..", "..", spec.workspaceDirName)]
				: [],
	}),
);

function readPackageName(packageJsonPath: string): string | undefined {
	try {
		const pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { name?: string };
		return pkg.name;
	} catch {
		return undefined;
	}
}

function isPackageDir(dir: string, descriptor: BuiltinPackageDescriptor): boolean {
	return (
		descriptor.requiredEntries.some((entry) => existsSync(join(dir, entry))) &&
		readPackageName(join(dir, "package.json")) === descriptor.packageName
	);
}

function firstExistingPackageDir(candidates: string[], descriptor: BuiltinPackageDescriptor): string | undefined {
	const seen = new Set<string>();

	for (const candidate of candidates) {
		const resolved = resolve(candidate);
		if (seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);
		if (isPackageDir(resolved, descriptor)) {
			return resolved;
		}
	}

	return undefined;
}

function distCandidates(context: BuiltinPackageCandidateContext, descriptor: BuiltinPackageDescriptor): string[] {
	const { here, packageDir } = context;
	return [
		join(here, "..", "builtin", descriptor.distDirName),
		join(packageDir, "builtin", descriptor.distDirName),
		join(packageDir, "dist", "builtin", descriptor.distDirName),
	];
}
function getBuiltinPackageCandidateContext(): BuiltinPackageCandidateContext {
	const packageDir = getPackageDir();
	// In the split launcher the bundled import.meta.url is a foreign-OS build
	// path; fall back to the package dir (the executable dir), where `builtin/`
	// sits, so distCandidates still resolves.
	const context: BuiltinPackageCandidateContext = {
		here: moduleDirFromMetaUrl(import.meta.url),
		packageDir,
		isSourceCheckout: false,
	};
	return {
		...context,
		isSourceCheckout: existsSync(join(context.packageDir, "src", "main.ts")),
	};
}

/** Atomic-owned builtin package roots paired with their verified descriptors. */
export function getBuiltinPackageLocations(): BuiltinPackageLocation[] {
	const context = getBuiltinPackageCandidateContext();
	return BUILTIN_PACKAGES.flatMap((descriptor) => {
		const packageDir = firstExistingPackageDir(
			[...descriptor.sourceCandidates(context), ...distCandidates(context, descriptor)],
			descriptor,
		);
		return packageDir
			? [{ packageName: descriptor.packageName, distDirName: descriptor.distDirName, packageDir }]
			: [];
	});
}

/**
 * Built-in pi package roots shipped with this Atomic distribution.
 *
 * Development layout:
 *   packages/coding-agent/src/core -> packages/<builtin>
 *
 * npm/dist layout:
 *   packages/coding-agent/dist/core -> packages/coding-agent/dist/builtin/<package>
 *
 * Bun binary layout:
 *   process executable dir -> builtin/<package>
 */
export function getBuiltinPackagePaths(): string[] {
	return getBuiltinPackageLocations().map(({ packageDir }) => packageDir);
}

/** Built-in package roots whose extensions Atomic must load in every model session. */
export function getMandatoryBuiltinPackagePaths(): string[] {
	const context = getBuiltinPackageCandidateContext();
	return BUILTIN_PACKAGES.filter((descriptor) => descriptor.mandatory).flatMap((descriptor) => {
		const packageDir = firstExistingPackageDir(
			[...descriptor.sourceCandidates(context), ...distCandidates(context, descriptor)],
			descriptor,
		);
		return packageDir ? [packageDir] : [];
	});
}

/** Trusted extension entries resolved from Atomic's mandatory bundled packages. */
export function getMandatoryBuiltinExtensionPaths(): string[] {
	return getMandatoryBuiltinPackagePaths().flatMap((packageDir) => {
		try {
			const manifest = JSON.parse(stripBom(readFileSync(join(packageDir, "package.json"), "utf-8"))) as {
				atomic?: { extensions?: string[] };
				pi?: { extensions?: string[] };
			};
			return (manifest.atomic?.extensions ?? manifest.pi?.extensions ?? []).map((entry) =>
				resolve(packageDir, entry),
			);
		} catch {
			return [];
		}
	});
}
