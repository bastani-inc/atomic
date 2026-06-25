import { existsSync } from "node:fs";
import { runWithConcurrency } from "./package-manager-command.ts";
import { GIT_UPDATE_CONCURRENCY, UPDATE_CHECK_CONCURRENCY } from "./package-manager-constants.ts";
import { getExistingGitInstallPath, gitHasAvailableUpdate, installGit, removeGit, updateGit } from "./package-manager-git.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import {
	getInstalledNpmVersion,
	getManagedNpmInstallPath,
	getLatestNpmVersion,
	getNpmInstallPath,
	installNpm,
	installNpmBatch,
	npmHasAvailableUpdate,
	uninstallNpm,
} from "./package-manager-npm.ts";
import { resolveManagerPath } from "./package-manager-paths.ts";
import { withProgress } from "./package-manager-progress.ts";
import {
	assertProjectTrustedForScope,
	buildNoMatchingPackageMessage,
	dedupePackages,
	getPackageIdentity,
	getPackageSourceString,
	parseSource,
} from "./package-manager-source.ts";
import type {
	ConfiguredUpdateSource,
	GitUpdateTarget,
	InstalledSourceScope,
	NpmSource,
	NpmUpdateTarget,
	PackageManagerContext,
	PackageUpdate,
	ParsedSource,
	SourceScope,
} from "./package-manager-types.ts";

export async function install(
	context: PackageManagerContext,
	source: string,
	options?: { local?: boolean },
): Promise<void> {
	const parsed = parseSource(source);
	const scope: SourceScope = options?.local ? "project" : "user";
	assertProjectTrustedForScope(context, scope);
	await withProgress(context, "install", source, `Installing ${source}...`, async () => {
		if (parsed.type === "npm") {
			await installNpm(context, parsed, scope, false);
			return;
		}
		if (parsed.type === "git") {
			await installGit(context, parsed, scope);
			return;
		}
		if (parsed.type === "local") {
			const resolved = resolveManagerPath(context, parsed.path);
			if (!existsSync(resolved)) {
				throw new Error(`Path does not exist: ${resolved}`);
			}
			return;
		}
		throw new Error(`Unsupported install source: ${source}`);
	});
}

export async function remove(
	context: PackageManagerContext,
	source: string,
	options?: { local?: boolean },
): Promise<void> {
	const parsed = parseSource(source);
	const scope: SourceScope = options?.local ? "project" : "user";
	assertProjectTrustedForScope(context, scope);
	await withProgress(context, "remove", source, `Removing ${source}...`, async () => {
		if (parsed.type === "npm") {
			await uninstallNpm(context, parsed, scope);
			return;
		}
		if (parsed.type === "git") {
			await removeGit(context, parsed, scope);
			return;
		}
		if (parsed.type === "local") return;
		throw new Error(`Unsupported remove source: ${source}`);
	});
}

export async function update(context: PackageManagerContext, source?: string): Promise<void> {
	const globalSettings = context.settingsManager.getGlobalSettings();
	const projectSettings = context.settingsManager.getProjectSettings();
	const identity = source ? getPackageIdentity(context, source) : undefined;
	let matched = false;
	const updateSources: ConfiguredUpdateSource[] = [];

	for (const pkg of globalSettings.packages ?? []) {
		const sourceStr = getPackageSourceString(pkg);
		if (identity && getPackageIdentity(context, sourceStr, "user") !== identity) continue;
		matched = true;
		updateSources.push({ source: sourceStr, scope: "user" });
	}
	for (const pkg of projectSettings.packages ?? []) {
		const sourceStr = getPackageSourceString(pkg);
		if (identity && getPackageIdentity(context, sourceStr, "project") !== identity) continue;
		matched = true;
		updateSources.push({ source: sourceStr, scope: "project" });
	}

	if (source && !matched) {
		throw new Error(
			buildNoMatchingPackageMessage(context, source, [
				...(globalSettings.packages ?? []),
				...(projectSettings.packages ?? []),
			]),
		);
	}
	await updateConfiguredSources(context, updateSources);
}

export async function installParsedSource(
	context: PackageManagerContext,
	parsed: ParsedSource,
	scope: SourceScope,
): Promise<void> {
	if (parsed.type === "npm") {
		await installNpm(context, parsed, scope, scope === "temporary");
		return;
	}
	if (parsed.type === "git") {
		await installGit(context, parsed, scope);
	}
}

async function updateConfiguredSources(
	context: PackageManagerContext,
	sources: ConfiguredUpdateSource[],
): Promise<void> {
	if (isOfflineModeEnabled() || sources.length === 0) return;

	const npmCandidates: NpmUpdateTarget[] = [];
	const gitCandidates: GitUpdateTarget[] = [];
	for (const entry of sources) {
		const parsed = parseSource(entry.source);
		if (parsed.type === "npm") {
			if (!parsed.pinned) npmCandidates.push({ ...entry, parsed });
		} else if (parsed.type === "git") {
			gitCandidates.push({ ...entry, parsed });
		}
	}

	const npmCheckTasks = npmCandidates.map((entry) => async () => ({
		entry,
		shouldUpdate: await shouldUpdateNpmSource(context, entry.parsed, entry.scope),
	}));
	const npmCheckResults = await runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
	const userNpmUpdates: NpmUpdateTarget[] = [];
	const projectNpmUpdates: NpmUpdateTarget[] = [];
	for (const result of npmCheckResults) {
		if (!result.shouldUpdate) continue;
		if (result.entry.scope === "user") userNpmUpdates.push(result.entry);
		else projectNpmUpdates.push(result.entry);
	}

	const tasks: Promise<void>[] = [];
	if (userNpmUpdates.length > 0) tasks.push(updateNpmBatch(context, userNpmUpdates, "user"));
	if (projectNpmUpdates.length > 0) tasks.push(updateNpmBatch(context, projectNpmUpdates, "project"));
	if (gitCandidates.length > 0) {
		const gitTasks = gitCandidates.map(
			(entry) => async () =>
				withProgress(context, "update", entry.source, `Updating ${entry.source}...`, async () => {
					if (context.driver) await context.driver.updateGit(entry.parsed, entry.scope);
					else await updateGit(context, entry.parsed, entry.scope);
				}),
		);
		tasks.push(runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
	}
	await Promise.all(tasks);
}

async function shouldUpdateNpmSource(
	context: PackageManagerContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): Promise<boolean> {
	const installedPath = getManagedNpmInstallPath(context, source, scope);
	const installedVersion = existsSync(installedPath) ? getInstalledNpmVersion(installedPath) : undefined;
	if (!installedVersion) return true;
	try {
		const targetVersion = await getLatestNpmVersion(context, source.version ? source.spec : source.name, source.range);
		return targetVersion !== installedVersion;
	} catch {
		return true;
	}
}

async function updateNpmBatch(
	context: PackageManagerContext,
	sources: NpmUpdateTarget[],
	scope: InstalledSourceScope,
): Promise<void> {
	if (sources.length === 0) return;
	const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
	const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
	const specs = sources.map((entry) => (entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`));

	await withProgress(context, "update", sourceLabel, message, async () => {
		await installNpmBatch(context, specs, scope);
	});
}

export async function checkForAvailableUpdates(context: PackageManagerContext): Promise<PackageUpdate[]> {
	if (isOfflineModeEnabled()) return [];

	const globalSettings = context.settingsManager.getGlobalSettings();
	const projectSettings = context.settingsManager.getProjectSettings();
	const allPackages = [
		...(projectSettings.packages ?? []).map((pkg) => ({ pkg, scope: "project" as const })),
		...(globalSettings.packages ?? []).map((pkg) => ({ pkg, scope: "user" as const })),
	];
	const packageSources = dedupePackages(context, allPackages);
	const checks = packageSources
		.filter((entry): entry is { pkg: typeof entry.pkg; scope: InstalledSourceScope } => entry.scope !== "temporary")
		.map((entry) => async (): Promise<PackageUpdate | undefined> => {
			const source = getPackageSourceString(entry.pkg);
			const parsed = parseSource(source);
			if (parsed.type === "local" || parsed.pinned) return undefined;

			if (parsed.type === "npm") {
				const installedPath = getNpmInstallPath(context, parsed, entry.scope);
				if (!existsSync(installedPath)) return undefined;
				const hasUpdate = await npmHasAvailableUpdate(context, parsed, installedPath);
				if (!hasUpdate) return undefined;
				return { source, displayName: parsed.name, type: "npm", scope: entry.scope };
			}

			const installedPath = getExistingGitInstallPath(context, parsed, entry.scope);
			if (!installedPath) return undefined;
			const hasUpdate = context.driver
				? await context.driver.gitHasAvailableUpdate(installedPath)
				: await gitHasAvailableUpdate(context, installedPath);
			if (!hasUpdate) return undefined;
			return { source, displayName: `${parsed.host}/${parsed.path}`, type: "git", scope: entry.scope };
		});

	const results = await runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
	return results.filter((result): result is PackageUpdate => result !== undefined);
}
