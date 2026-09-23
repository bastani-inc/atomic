import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripBom } from "../utils/text.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import type { PathMetadata } from "./package-manager.ts";

export type ExtensionPackageWarning = { path: string; warning: string };

const HOST_PROVIDED_EXTENSION_PACKAGES = new Set([
	"@bastani/atomic",
	"@bastani/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);

export function collectExtensionPackageWarnings(
	extensionPaths: string[],
	metadataByPath: Map<string, PathMetadata>,
): ExtensionPackageWarning[] {
	const warnings: ExtensionPackageWarning[] = [];
	const packageRoots = new Set(
		extensionPaths
			.map((extensionPath) => metadataByPath.get(extensionPath)?.packageRoot)
			.filter((packageRoot): packageRoot is string => packageRoot !== undefined),
	);
	for (const packageRoot of packageRoots) {
		const packageJsonPath = join(packageRoot, "package.json");
		if (!existsSync(packageJsonPath)) continue;
		const dependencies = readManifestDependencies(packageJsonPath);
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

function readManifestDependencies(packageJsonPath: string): Record<string, string> | undefined {
	const manifest: { dependencies?: object | null } = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
	const dependencies = manifest.dependencies;
	if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) return undefined;
	return dependencies as Record<string, string>;
}

export function mergeExtensionWarnings(result: LoadExtensionsResult, warnings: ExtensionPackageWarning[]): void {
	result.warnings = [
		...new Map([...(result.warnings ?? []), ...warnings].map((warning) => [warning.path, warning])).values(),
	];
}
