import { access, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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
import { dedupePackages, getPackageIdentity, getPackageSourceString, parseSource } from "./package-manager-source.ts";
import { splitPatterns } from "./package-manager-resource-patterns.ts";
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

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}


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
	await resolvePackageSources(context, packageSources, accumulator, onMissing, { settingsField: "packages" });

	const globalBaseDir = context.agentDir;
	const projectBaseDir = join(context.cwd, CONFIG_DIR_NAME);
	const globalBaseDirs = getBaseDirsForScope(context, "user");
	const projectBaseDirs = getBaseDirsForScope(context, "project");

	for (const resourceType of ["extensions", "skills", "prompts", "themes", "workflows"] as const) {
		const target = getTargetMap(accumulator, resourceType);
		const globalEntries = (globalSettings[resourceType] ?? []) as string[];
		const projectEntries = (projectSettings[resourceType] ?? []) as string[];
		const projectOrigin = context.settingsManager.isFieldInherited("project", resourceType) ? "inherited-pi" : "atomic";
		const globalOrigin = context.settingsManager.isFieldInherited("global", resourceType) ? "inherited-pi" : "atomic";
		await resolveConfiguredLocalEntries(projectEntries, resourceType, target, "project", projectBaseDirs, projectOrigin);
		await resolveConfiguredLocalEntries(globalEntries, resourceType, target, "user", globalBaseDirs, globalOrigin);
	}

	await addAutoDiscoveredResources(context, accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);
	return toResolvedPaths(accumulator);
}

async function resolveConfiguredLocalEntries(
	entries: string[],
	resourceType: "extensions" | "skills" | "prompts" | "themes" | "workflows",
	target: ReturnType<typeof getTargetMap>,
	scope: "project" | "user",
	baseDirs: string[],
	fieldOrigin: "atomic" | "inherited-pi",
): Promise<void> {
	const { plain, patterns } = splitPatterns(entries);
	const relativeEntries = plain.filter((entry) => !isAbsolute(entry) && !entry.startsWith("~"));
	const fixedEntries = plain.filter((entry) => isAbsolute(entry) || entry.startsWith("~"));
	for (const [baseIndex, baseDir] of baseDirs.entries()) {
		const metadata: PathMetadata = {
			source: "local",
			scope,
			origin: "top-level",
			baseDir,
			configurationOrigin: baseIndex === 0 || fieldOrigin === "atomic" ? "atomic" : "inherited-pi",
		};
		await resolveLocalEntries([...relativeEntries, ...patterns], resourceType, target, metadata, baseDir);
		await resolveLocalEntries([...fixedEntries, ...patterns], resourceType, target, {
			...metadata,
			configurationOrigin: fieldOrigin,
		}, baseDir);
	}
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
	options?: { includeProjectLocalResources?: boolean; settingsField?: "packages" },
): Promise<void> {
	for (const { pkg, scope } of sources) {
		const sourceStr = getPackageSourceString(pkg);
		const filter = typeof pkg === "object" ? pkg : undefined;
		const deltaBase = findAutoloadDeltaBase(context, pkg, scope, sources);
		const resolvedSource = deltaBase?.source ?? sourceStr;
		const resolvedScope = deltaBase?.scope ?? scope;
		const parsed = parseSource(resolvedSource);
		const configurationOrigin = options?.settingsField && context.settingsManager.isFieldInherited(scope === "project" ? "project" : "global", options.settingsField)
			? "inherited-pi"
			: options?.settingsField ? "atomic" : undefined;
		const metadata: PathMetadata = { source: sourceStr, scope, origin: "package", configurationOrigin };

		if (parsed.type === "local") {
			for (const [baseIndex, baseDir] of getBaseDirsForScope(context, resolvedScope).entries()) {
				const resolvesFromSettingsBase = options?.settingsField !== undefined
					&& !isAbsolute(parsed.path)
					&& !parsed.path.startsWith("~");
				const localMetadata: PathMetadata = {
					...metadata,
					baseDir,
					configurationOrigin: resolvesFromSettingsBase
						? baseIndex === 0 ? "atomic" : "inherited-pi"
						: configurationOrigin,
				};
				await resolveLocalExtensionSource(parsed, accumulator, filter, localMetadata, baseDir, {
					includeProjectLocalResources: options?.includeProjectLocalResources === true,
				});
			}
			continue;
		}

		const installMissing = async (): Promise<boolean> => {
			if (isOfflineModeEnabled()) return false;
			if (!onMissing) {
				if (context.driver) await context.driver.installParsedSource(parsed, resolvedScope);
				else await installParsedSource(context, parsed, resolvedScope);
				return true;
			}
			const action = await onMissing(sourceStr);
			if (action === "skip") return false;
			if (action === "error") throw new Error(`Missing source: ${sourceStr}`);
			if (context.driver) await context.driver.installParsedSource(parsed, resolvedScope);
			else await installParsedSource(context, parsed, resolvedScope);
			return true;
		};

		if (parsed.type === "npm") {
			let installedPath = getExistingNpmInstallPath(context, parsed, resolvedScope);
			const needsInstall =
				!installedPath || !(await installedNpmMatchesConfiguredVersion(context, parsed, installedPath));
			if (needsInstall) {
				const installed = await installMissing();
				if (!installed) continue;
				installedPath = getExistingNpmInstallPath(context, parsed, resolvedScope);
				if (!installedPath || !(await installedNpmMatchesConfiguredVersion(context, parsed, installedPath))) {
					continue;
				}
			}
			if (!installedPath) continue;
			metadata.baseDir = installedPath;
			await collectPackageResources(installedPath, accumulator, filter, metadata);
			continue;
		}

		let installedPath = getExistingGitInstallPath(context, parsed, resolvedScope) ?? getGitInstallPath(context, parsed, resolvedScope);
		if (!(await exists(installedPath))) {
			const installed = await installMissing();
			if (!installed) continue;
		} else if (resolvedScope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
			if (context.driver) await context.driver.refreshTemporaryGitSource(parsed, sourceStr);
			else await refreshTemporaryGitSource(context, parsed, sourceStr);
		}
		metadata.baseDir = installedPath;
		await collectPackageResources(installedPath, accumulator, filter, metadata);
	}
}

function findAutoloadDeltaBase(
	context: PackageManagerContext,
	pkg: PackageSource,
	scope: SourceScope,
	sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
): { source: string; scope: SourceScope } | undefined {
	if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
	const identity = getPackageIdentity(context, pkg.source, scope);
	const userEntry = sources.find((entry) => entry.scope === "user"
		&& getPackageIdentity(context, getPackageSourceString(entry.pkg), "user") === identity);
	return userEntry ? { source: getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
}

async function resolveLocalExtensionSource(
	source: { type: "local"; path: string },
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
	baseDir: string,
	options?: { includeProjectLocalResources?: boolean },
): Promise<void> {
	const resolved = resolvePathFromBase(source.path, baseDir);
	if (!(await exists(resolved))) return;

	try {
		const stats = await stat(resolved);
		if (stats.isFile()) {
			addResource(accumulator.extensions, resolved, { ...metadata, baseDir: dirname(resolved) }, true);
			return;
		}
		if (stats.isDirectory()) {
			const packageMetadata: PathMetadata = { ...metadata, baseDir: resolved };
			const packageResources = await collectPackageResources(resolved, accumulator, filter, packageMetadata);
			const projectLocalResources = options?.includeProjectLocalResources
				? await collectProjectLocalResources(resolved, accumulator, filter, packageMetadata)
				: false;
			const extensionEntries = await resolveExtensionEntries(resolved);
			const shouldAddDirectoryFallback =
				extensionEntries !== null || (options?.includeProjectLocalResources === true && !projectLocalResources);
			if (!packageResources && shouldAddDirectoryFallback) {
				addResource(accumulator.extensions, resolved, packageMetadata, true);
			}
		}
	} catch {}
}
