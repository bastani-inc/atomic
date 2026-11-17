import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_NAME } from "../config.js";
import { pathExists as exists } from "../utils/path-exists.js";
import { stripBom } from "../utils/text.ts";
import { FORKED_PACKAGE_NAMES } from "./extensions/forked-package-names.ts";
import type { Extension, LoadExtensionsResult } from "./extensions/types.ts";
import type { PackageInstallFailure, PathMetadata } from "./package-manager.ts";

export type ExtensionPackageWarning = { path: string; warning: string };

const HOST_PROVIDED_EXTENSION_PACKAGES = new Set([
	"@bastani/atomic",
	...FORKED_PACKAGE_NAMES,
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
	"@sinclair/typebox",
	"typebox",
]);

export async function collectExtensionPackageWarnings(
	extensionPaths: string[],
	metadataByPath: Map<string, PathMetadata>,
): Promise<ExtensionPackageWarning[]> {
	const warnings: ExtensionPackageWarning[] = [];
	const packageRoots = new Set(
		extensionPaths
			.map((extensionPath) => metadataByPath.get(extensionPath)?.packageRoot)
			.filter((packageRoot): packageRoot is string => packageRoot !== undefined),
	);
	for (const packageRoot of packageRoots) {
		const packageJsonPath = join(packageRoot, "package.json");
		if (!(await exists(packageJsonPath))) continue;
		const dependencies = await readManifestDependencies(packageJsonPath);
		if (!dependencies) continue;
		const hostDependencies = Object.keys(dependencies)
			.filter((name) => HOST_PROVIDED_EXTENSION_PACKAGES.has(name))
			.sort();
		if (hostDependencies.length === 0) continue;
		warnings.push({
			path: packageJsonPath,
			warning: `Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: ${hostDependencies.join(", ")}. Installed copies can bypass the extension loader and create duplicate runtime modules.`,
		});
	}
	return warnings;
}

async function readManifestDependencies(packageJsonPath: string): Promise<Record<string, string> | undefined> {
	const manifest: { dependencies?: object | null } = JSON.parse(stripBom(await readFile(packageJsonPath, "utf-8")));
	const dependencies = manifest.dependencies;
	if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) return undefined;
	return dependencies as Record<string, string>;
}

/** Describe a package that was skipped because it could not be installed, including how to drop it. */
function describePackageInstallFailure(failure: PackageInstallFailure): string {
	const hint =
		failure.scope === "temporary"
			? "Check the source and try again."
			: `Run "${APP_NAME} remove ${failure.source}${failure.scope === "project" ? " --local" : ""}" to remove it from settings.json.`;
	return `failed to install (${failure.message}). ${hint}`;
}

/** One-line startup warning for a package that could not be installed. */
export function formatPackageInstallWarning(failure: PackageInstallFailure): string {
	return `Extension package "${failure.source}": ${describePackageInstallFailure(failure)}`;
}

export function collectPackageInstallWarnings(
	...failures: Array<PackageInstallFailure[] | undefined>
): ExtensionPackageWarning[] {
	return failures.flatMap((entries) =>
		(entries ?? []).map((failure) => ({ path: failure.source, warning: describePackageInstallFailure(failure) })),
	);
}

/** One warning per extension that registered a tool name more than once. */
function collectDuplicateToolWarnings(extensions: readonly Extension[]): ExtensionPackageWarning[] {
	return extensions.flatMap((extension) => {
		const names = [...(extension.duplicateToolNames ?? [])];
		if (names.length === 0) return [];
		const list = names.map((name) => `"${name}"`).join(", ");
		const noun = names.length === 1 ? "tool" : "tools";
		return [
			{ path: extension.path, warning: `registers ${noun} ${list} more than once; the last registration is used.` },
		];
	});
}

/** Add `warnings` and the duplicate-tool warnings of the loaded extensions to the result, one per path. */
export function mergeExtensionWarnings(result: LoadExtensionsResult, warnings: ExtensionPackageWarning[]): void {
	const merged = [...(result.warnings ?? []), ...warnings, ...collectDuplicateToolWarnings(result.extensions)];
	result.warnings = [...new Map(merged.map((warning) => [warning.path, warning])).values()];
}
