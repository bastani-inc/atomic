import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { getGitInstallPath } from "./package-manager-paths.ts";
import { addAutoDiscoveredResources, collectProjectLocalResources } from "./package-manager-auto-resources.ts";
import { getExistingGitInstallPath, refreshTemporaryGitSource } from "./package-manager-git.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import { getExistingNpmInstallPath, installedNpmMatchesConfiguredVersion } from "./package-manager-npm.ts";
import { getBaseDirsForScope, resolvePathFromBase } from "./package-manager-paths.ts";
import { createAccumulator, addResource, getTargetMap, toResolvedPaths } from "./package-manager-resource-accumulator.ts";
import { collectPackageResources, resolveLocalEntries } from "./package-manager-resource-collector.ts";
import { resolveExtensionEntries } from "./package-manager-resource-files.ts";
import { dedupePackages, getPackageSourceString, parseSource } from "./package-manager-source.ts";
import { installParsedSource } from "./package-manager-operations.ts";
import type {
	MissingSourceAction,
	PackageFilter,
	PackageManagerContext,
	PathMetadata,
	ResolvedPaths,
	ResolveExtensionSourcesOptions,
	ResourceAccumulator,
	SourceScope,
} from "./package-manager-types.ts";
import type { PackageSource } from "./settings-manager.ts";

export async function resolvePackages(
	context: PackageManagerContext,
	onMissing?: (source: string) => Promise<MissingSourceAction>,
): Promise<ResolvedPaths> {
	const accumulator = createAccumulator();
	const globalSettings = context.settingsManager.getGlobalSettings();
	const projectSettings = context.settingsManager.getProjectSettings();
	const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];

	for (const pkg of projectSettings.packages ?? []) {
		allPackages.push({ pkg, scope: "project" });
	}
	for (const pkg of globalSettings.packages ?? []) {
		allPackages.push({ pkg, scope: "user" });
	}

	const packageSources = dedupePackages(context, allPackages);
	await resolvePackageSources(context, packageSources, accumulator, onMissing);

	const globalBaseDir = context.agentDir;
	const projectBaseDir = join(context.cwd, CONFIG_DIR_NAME);
	const globalBaseDirs = getBaseDirsForScope(context, "user");
	const projectBaseDirs = getBaseDirsForScope(context, "project");

	for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
		const target = getTargetMap(accumulator, resourceType);
		const globalEntries = (globalSettings[resourceType] ?? []) as string[];
		const projectEntries = (projectSettings[resourceType] ?? []) as string[];
		for (const baseDir of projectBaseDirs) {
			resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{ source: "local", scope: "project", origin: "top-level", baseDir },
				baseDir,
			);
		}
		for (const baseDir of globalBaseDirs) {
			resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{ source: "local", scope: "user", origin: "top-level", baseDir },
				baseDir,
			);
		}
	}

	addAutoDiscoveredResources(context, accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);
	return toResolvedPaths(accumulator);
}

export async function resolveExtensionSources(
	context: PackageManagerContext,
	sources: PackageSource[],
	options?: ResolveExtensionSourcesOptions,
): Promise<ResolvedPaths> {
	const accumulator = createAccumulator();
	const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
	const packageSources = sources.map((source) => ({ pkg: source, scope }));
	await resolvePackageSources(context, packageSources, accumulator, undefined, {
		includeProjectLocalResources: options?.includeProjectLocalResources === true,
	});
	return toResolvedPaths(accumulator);
}

async function resolvePackageSources(
	context: PackageManagerContext,
	sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	accumulator: ResourceAccumulator,
	onMissing?: (source: string) => Promise<MissingSourceAction>,
	options?: { includeProjectLocalResources?: boolean },
): Promise<void> {
	for (const { pkg, scope } of sources) {
		const sourceStr = getPackageSourceString(pkg);
		const filter = typeof pkg === "object" ? pkg : undefined;
		const parsed = parseSource(sourceStr);
		const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

		if (parsed.type === "local") {
			for (const baseDir of getBaseDirsForScope(context, scope)) {
				resolveLocalExtensionSource(parsed, accumulator, filter, { ...metadata, baseDir }, baseDir, {
					includeProjectLocalResources: options?.includeProjectLocalResources === true,
				});
			}
			continue;
		}

		const installMissing = async (): Promise<boolean> => {
			if (isOfflineModeEnabled()) return false;
			if (!onMissing) {
				if (context.driver) await context.driver.installParsedSource(parsed, scope);
				else await installParsedSource(context, parsed, scope);
				return true;
			}
			const action = await onMissing(sourceStr);
			if (action === "skip") return false;
			if (action === "error") throw new Error(`Missing source: ${sourceStr}`);
			if (context.driver) await context.driver.installParsedSource(parsed, scope);
			else await installParsedSource(context, parsed, scope);
			return true;
		};

		if (parsed.type === "npm") {
			let installedPath = getExistingNpmInstallPath(context, parsed, scope);
			const needsInstall =
				!installedPath || !(await installedNpmMatchesConfiguredVersion(context, parsed, installedPath));
			if (needsInstall) {
				const installed = await installMissing();
				if (!installed) continue;
				installedPath = getExistingNpmInstallPath(context, parsed, scope);
				if (!installedPath || !(await installedNpmMatchesConfiguredVersion(context, parsed, installedPath))) {
					continue;
				}
			}
			if (!installedPath) continue;
			metadata.baseDir = installedPath;
			collectPackageResources(installedPath, accumulator, filter, metadata);
			continue;
		}

		let installedPath = getExistingGitInstallPath(context, parsed, scope) ?? getGitInstallPath(context, parsed, scope);
		if (!existsSync(installedPath)) {
			const installed = await installMissing();
			if (!installed) continue;
		} else if (scope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
			if (context.driver) await context.driver.refreshTemporaryGitSource(parsed, sourceStr);
			else await refreshTemporaryGitSource(context, parsed, sourceStr);
		}
		metadata.baseDir = installedPath;
		collectPackageResources(installedPath, accumulator, filter, metadata);
	}
}

function resolveLocalExtensionSource(
	source: { type: "local"; path: string },
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
	baseDir: string,
	options?: { includeProjectLocalResources?: boolean },
): void {
	const resolved = resolvePathFromBase(source.path, baseDir);
	if (!existsSync(resolved)) return;

	try {
		const stats = statSync(resolved);
		if (stats.isFile()) {
			addResource(accumulator.extensions, resolved, { ...metadata, baseDir: dirname(resolved) }, true);
			return;
		}
		if (stats.isDirectory()) {
			const packageMetadata: PathMetadata = { ...metadata, baseDir: resolved };
			const packageResources = collectPackageResources(resolved, accumulator, filter, packageMetadata);
			const projectLocalResources = options?.includeProjectLocalResources
				? collectProjectLocalResources(resolved, accumulator, filter, packageMetadata)
				: false;
			const extensionEntries = resolveExtensionEntries(resolved);
			const shouldAddDirectoryFallback =
				extensionEntries !== null || (options?.includeProjectLocalResources === true && !projectLocalResources);
			if (!packageResources && shouldAddDirectoryFallback) {
				addResource(accumulator.extensions, resolved, packageMetadata, true);
			}
		}
	} catch {}
}
