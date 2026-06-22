import { existsSync } from "node:fs";
import { getBaseDirsForScope, resolvePathFromBase } from "./package-manager-paths.ts";
import { getExistingGitInstallPath } from "./package-manager-git.ts";
import { getExistingNpmInstallPath } from "./package-manager-npm.ts";
import {
	getPackageSourceString,
	normalizePackageSourceForSettings,
	packageSourcesMatch,
	parseSource,
} from "./package-manager-source.ts";
import type { ConfiguredPackage, PackageManagerContext, SourceScope } from "./package-manager-types.ts";

export function addSourceToSettings(
	context: PackageManagerContext,
	source: string,
	options?: { local?: boolean },
): boolean {
	const scope: SourceScope = options?.local ? "project" : "user";
	const currentSettings =
		scope === "project" ? context.settingsManager.getProjectSettings() : context.settingsManager.getGlobalSettings();
	const currentPackages = currentSettings.packages ?? [];
	const normalizedSource = normalizePackageSourceForSettings(context, source, scope);
	const matchIndex = currentPackages.findIndex((existing) => packageSourcesMatch(context, existing, source, scope));
	if (matchIndex !== -1) {
		const existing = currentPackages[matchIndex];
		if (getPackageSourceString(existing) === normalizedSource) {
			return false;
		}
		const nextPackages = [...currentPackages];
		nextPackages[matchIndex] = typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
		if (scope === "project") {
			context.settingsManager.setProjectPackages(nextPackages);
		} else {
			context.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	const nextPackages = [...currentPackages, normalizedSource];
	if (scope === "project") {
		context.settingsManager.setProjectPackages(nextPackages);
	} else {
		context.settingsManager.setPackages(nextPackages);
	}
	return true;
}

export function removeSourceFromSettings(
	context: PackageManagerContext,
	source: string,
	options?: { local?: boolean },
): boolean {
	const scope: SourceScope = options?.local ? "project" : "user";
	const currentSettings =
		scope === "project" ? context.settingsManager.getProjectSettings() : context.settingsManager.getGlobalSettings();
	const currentPackages = currentSettings.packages ?? [];
	const nextPackages = currentPackages.filter((existing) => !packageSourcesMatch(context, existing, source, scope));
	const changed = nextPackages.length !== currentPackages.length;
	if (!changed) return false;
	if (scope === "project") {
		context.settingsManager.setProjectPackages(nextPackages);
	} else {
		context.settingsManager.setPackages(nextPackages);
	}
	return true;
}

export function getInstalledPath(
	context: PackageManagerContext,
	source: string,
	scope: "user" | "project",
): string | undefined {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return getExistingNpmInstallPath(context, parsed, scope);
	}
	if (parsed.type === "git") {
		return getExistingGitInstallPath(context, parsed, scope);
	}
	for (const baseDir of getBaseDirsForScope(context, scope)) {
		const path = resolvePathFromBase(parsed.path, baseDir);
		if (existsSync(path)) return path;
	}
	return undefined;
}

export function listConfiguredPackages(context: PackageManagerContext): ConfiguredPackage[] {
	const globalSettings = context.settingsManager.getGlobalSettings();
	const projectSettings = context.settingsManager.getProjectSettings();
	const configuredPackages: ConfiguredPackage[] = [];

	for (const pkg of globalSettings.packages ?? []) {
		const source = getPackageSourceString(pkg);
		configuredPackages.push({
			source,
			scope: "user",
			filtered: typeof pkg === "object",
			installedPath: getInstalledPath(context, source, "user"),
		});
	}

	for (const pkg of projectSettings.packages ?? []) {
		const source = getPackageSourceString(pkg);
		configuredPackages.push({
			source,
			scope: "project",
			filtered: typeof pkg === "object",
			installedPath: getInstalledPath(context, source, "project"),
		});
	}

	return configuredPackages;
}

