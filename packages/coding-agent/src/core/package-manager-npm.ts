import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { maxSatisfying, rcompare, satisfies } from "semver";
import { APP_NAME, CONFIG_DIR_NAME, getProjectConfigDirs } from "../config.ts";
import { markPathIgnoredByCloudSync } from "../utils/paths.ts";
import { NETWORK_TIMEOUT_MS } from "./package-manager-constants.ts";
import { runCommand, runCommandCapture, runCommandSync } from "./package-manager-command.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import { getNpmInstallRoot } from "./package-manager-paths.ts";
import type { InstalledSourceScope, NpmSource, PackageManagerContext, SourceScope } from "./package-manager-types.ts";

export function getNpmCommand(context: PackageManagerContext): { command: string; args: string[] } {
	const configuredCommand = context.settingsManager.getNpmCommand();
	if (!configuredCommand || configuredCommand.length === 0) {
		return { command: "npm", args: [] };
	}
	const [command, ...args] = configuredCommand;
	if (!command) {
		throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
	}
	return { command, args };
}

export function getPackageManagerName(context: PackageManagerContext): string {
	const npmCommand = getNpmCommand(context);
	const commandParts = [npmCommand.command, ...npmCommand.args];
	const separatorIndex = commandParts.lastIndexOf("--");
	const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
	return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
}

export async function runNpmCommand(
	context: PackageManagerContext,
	args: string[],
	options?: { cwd?: string },
): Promise<void> {
	const npmCommand = getNpmCommand(context);
	if (context.driver) {
		await context.driver.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
		return;
	}
	await runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
}

export function runNpmCommandSync(context: PackageManagerContext, args: string[]): string {
	const npmCommand = getNpmCommand(context);
	if (context.driver) {
		return context.driver.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}
	return runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
}

export function getGitDependencyInstallArgs(context: PackageManagerContext): string[] {
	const configuredCommand = context.settingsManager.getNpmCommand();
	if (configuredCommand && configuredCommand.length > 0) {
		return ["install"];
	}
	return ["install", "--omit=dev"];
}

export function getNpmInstallArgs(
	context: PackageManagerContext,
	specs: string[],
	installRoot: string,
): string[] {
	const packageManagerName = getPackageManagerName(context);
	if (packageManagerName === "bun") {
		return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
	}
	if (packageManagerName === "pnpm") {
		return [
			"install",
			...specs,
			"--prefix",
			installRoot,
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
		];
	}
	return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
}

export async function installNpm(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
	temporary: boolean,
): Promise<void> {
	const installRoot = getNpmInstallRoot(context, scope, temporary);
	ensureNpmProject(installRoot);
	await runNpmCommand(context, getNpmInstallArgs(context, [source.spec], installRoot));
}

export async function uninstallNpm(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
): Promise<void> {
	const installRoot = getNpmInstallRoot(context, scope, false);
	if (!existsSync(installRoot)) {
		return;
	}
	if (getPackageManagerName(context) === "bun") {
		await runNpmCommand(context, ["uninstall", source.name, "--cwd", installRoot]);
		return;
	}
	await runNpmCommand(context, ["uninstall", source.name, "--prefix", installRoot]);
}

export async function installNpmBatch(
	context: PackageManagerContext,
	specs: string[],
	scope: InstalledSourceScope,
): Promise<void> {
	const installRoot = getNpmInstallRoot(context, scope, false);
	ensureNpmProject(installRoot);
	await runNpmCommand(context, getNpmInstallArgs(context, specs, installRoot));
}

function ensureNpmProject(installRoot: string): void {
	if (!existsSync(installRoot)) {
		mkdirSync(installRoot, { recursive: true });
	}
	markPathIgnoredByCloudSync(installRoot);
	ensureGitIgnore(installRoot);
	const packageJsonPath = join(installRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		const pkgJson = { name: `${APP_NAME}-extensions`, private: true };
		writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
	}
}

export function ensureGitIgnore(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
	}
}

export function getManagedNpmInstallPath(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
): string {
	if (scope === "temporary") {
		return join(getNpmInstallRoot(context, scope, true), "node_modules", source.name);
	}
	if (scope === "project") {
		return join(context.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
	}
	return join(context.agentDir, "npm", "node_modules", source.name);
}

export function getGlobalNpmRoot(context: PackageManagerContext): string {
	const npmCommand = getNpmCommand(context);
	const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
	if (context.globalNpmRoot && context.globalNpmRootCommandKey === commandKey) {
		return context.globalNpmRoot;
	}
	if (getPackageManagerName(context) === "bun") {
		const binDir = runNpmCommandSync(context, ["pm", "bin", "-g"]).trim();
		context.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
	} else {
		context.globalNpmRoot = runNpmCommandSync(context, ["root", "-g"]).trim();
	}
	context.globalNpmRootCommandKey = commandKey;
	return context.globalNpmRoot;
}

function getPnpmGlobalPackagePath(context: PackageManagerContext, packageName: string): string | undefined {
	if (getPackageManagerName(context) !== "pnpm") {
		return undefined;
	}
	const output = runNpmCommandSync(context, ["list", "-g", "--depth", "0", "--json"]);
	const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
	for (const entry of entries) {
		const path = entry.dependencies?.[packageName]?.path;
		if (path) return path;
	}
	return undefined;
}

function getLegacyGlobalNpmInstallPath(context: PackageManagerContext, source: NpmSource): string | undefined {
	try {
		const pnpmPath = getPnpmGlobalPackagePath(context, source.name);
		if (pnpmPath) return pnpmPath;
		const globalRoot = context.driver?.getGlobalNpmRoot ? context.driver.getGlobalNpmRoot() : getGlobalNpmRoot(context);
		return join(globalRoot, source.name);
	} catch {
		return undefined;
	}
}

export function getNpmInstallPath(context: PackageManagerContext, source: NpmSource, scope: SourceScope): string {
	const managedPath = getManagedNpmInstallPath(context, source, scope);
	if (scope !== "user" || existsSync(managedPath)) {
		return managedPath;
	}
	const legacyPath = getLegacyGlobalNpmInstallPath(context, source);
	return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
}

export function getExistingNpmInstallPath(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
): string | undefined {
	const candidates = [getNpmInstallPath(context, source, scope)];
	if (scope === "project") {
		for (const configDir of getProjectConfigDirs(context.cwd)) {
			candidates.push(join(configDir, "npm", "node_modules", source.name));
		}
	}
	for (const candidate of Array.from(new Set(candidates))) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export async function installedNpmMatchesConfiguredVersion(
	context: PackageManagerContext,
	source: NpmSource,
	installedPath: string,
): Promise<boolean> {
	const installedVersion = getInstalledNpmVersion(installedPath);
	if (!installedVersion) return false;
	if (source.range) return satisfies(installedVersion, source.range);
	if (source.version !== undefined) {
		if (isOfflineModeEnabled()) return true;
		try {
			const targetVersion = await getLatestNpmVersion(context, source.spec);
			return installedVersion === targetVersion;
		} catch {
			return false;
		}
	}
	return true;
}

export async function npmHasAvailableUpdate(
	context: PackageManagerContext,
	source: NpmSource,
	installedPath: string,
): Promise<boolean> {
	if (isOfflineModeEnabled()) return false;
	const installedVersion = getInstalledNpmVersion(installedPath);
	if (!installedVersion) return false;
	try {
		const targetVersion = await getLatestNpmVersion(context, source.version ? source.spec : source.name, source.range);
		return targetVersion !== installedVersion;
	} catch {
		return false;
	}
}

export function getInstalledNpmVersion(installedPath: string): string | undefined {
	const packageJsonPath = join(installedPath, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { version?: string };
		return pkg.version;
	} catch {
		return undefined;
	}
}

export async function getLatestNpmVersion(
	context: PackageManagerContext,
	packageSpec: string,
	range?: string,
): Promise<string> {
	const npmCommand = getNpmCommand(context);
	const stdout = context.driver
		? await context.driver.runCommandCapture(npmCommand.command, [...npmCommand.args, "view", packageSpec, "version", "--json"], {
				cwd: context.cwd,
				timeoutMs: NETWORK_TIMEOUT_MS,
			})
		: await runCommandCapture(npmCommand.command, [...npmCommand.args, "view", packageSpec, "version", "--json"], {
				cwd: context.cwd,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
	const raw = stdout.trim();
	if (!raw) throw new Error("Empty response from npm view");
	const parsed = JSON.parse(raw) as string | string[];
	if (typeof parsed === "string") return parsed;
	if (Array.isArray(parsed)) {
		const versions = parsed.filter((value) => typeof value === "string" && value.length > 0);
		const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
		if (latest) return latest;
	}
	throw new Error("Unexpected response from npm view");
}
