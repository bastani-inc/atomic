import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gt, maxSatisfying, rcompare, satisfies } from "semver";
import { APP_NAME, CONFIG_DIR_NAME, getProjectConfigDirs } from "../config.js";
import { pathExists as exists } from "../utils/path-exists.js";
import { markPathIgnoredByCloudSync } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { runCommand, runCommandCapture, runCommandSync } from "./package-manager-command.ts";
import { NETWORK_TIMEOUT_MS } from "./package-manager-constants.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import { withInstallLock } from "./package-manager-lock.ts";
import { getNpmInstallRoot } from "./package-manager-paths.ts";
import type {
	InstalledSourceScope,
	NpmSource,
	PackageLocationContext,
	PackageManagerContext,
	SourceScope,
} from "./package-manager-types.ts";

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
	const normalizeCommandName = (command: string): string => basename(command).replace(/\.(cmd|exe)$/i, "");
	const supportedPackageManagers = new Set(["npm", "pnpm", "bun"]);
	const directCommand = normalizeCommandName(npmCommand.command);
	const separatorIndex = npmCommand.args.lastIndexOf("--");
	if (separatorIndex >= 0) {
		const wrappedCommand = npmCommand.args[separatorIndex + 1];
		return wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;
	}
	if (supportedPackageManagers.has(directCommand)) return directCommand;

	const wrappedPackageManagers = [
		...new Set(npmCommand.args.map(normalizeCommandName).filter((command) => supportedPackageManagers.has(command))),
	];
	if (wrappedPackageManagers.length > 1) {
		throw new Error(`Ambiguous npmCommand package managers: ${wrappedPackageManagers.join(", ")}`);
	}
	return wrappedPackageManagers[0] ?? directCommand;
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

function runNpmCommandCapture(context: PackageManagerContext, args: string[]): Promise<string> {
	const npmCommand = getNpmCommand(context);
	const options = { timeoutMs: NETWORK_TIMEOUT_MS };
	return context.driver
		? context.driver.runCommandCapture(npmCommand.command, [...npmCommand.args, ...args], options)
		: runCommandCapture(npmCommand.command, [...npmCommand.args, ...args], options);
}

export function getGitDependencyInstallArgs(context: PackageManagerContext): string[] {
	switch (getPackageManagerName(context)) {
		case "bun":
			return ["install", "--omit=dev", "--omit=peer"];
		case "pnpm":
			return [
				"install",
				"--prod",
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		case "npm":
			return ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"];
		default:
			return ["install"];
	}
}

export async function getNpmInstallArgs(
	context: PackageManagerContext,
	specs: string[],
	root: string,
): Promise<string[]> {
	// npm writes broken nested package-lock.json paths when --prefix goes through a symlink.
	const installRoot = (await exists(root)) ? await realpath(root) : root;
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
	// npm audit fix would run without --legacy-peer-deps and install Atomic peers, so skip audit advice.
	return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps", "--no-audit", "--no-fund"];
}

export async function installNpm(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
	temporary: boolean,
): Promise<void> {
	const installRoot = await getNpmInstallRoot(context, scope, temporary);
	await withInstallLock(installRoot, async () => {
		await ensureNpmProject(installRoot);
		await runNpmCommand(context, await getNpmInstallArgs(context, [source.spec], installRoot));
	});
}

export async function uninstallNpm(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
): Promise<void> {
	const root = await getNpmInstallRoot(context, scope, false);
	if (!(await exists(root))) {
		return;
	}
	// npm writes broken nested package-lock.json paths when --prefix goes through a symlink.
	const installRoot = await realpath(root);
	await withInstallLock(root, async () => {
		if (getPackageManagerName(context) === "bun") {
			await runNpmCommand(context, ["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		const args = ["uninstall", source.name, "--prefix", installRoot];
		if (getPackageManagerName(context) !== "pnpm") args.push("--no-audit", "--no-fund");
		await runNpmCommand(context, args);
	});
}

export async function installNpmBatch(
	context: PackageManagerContext,
	specs: string[],
	scope: InstalledSourceScope,
): Promise<void> {
	const installRoot = await getNpmInstallRoot(context, scope, false);
	await withInstallLock(installRoot, async () => {
		await ensureNpmProject(installRoot);
		await runNpmCommand(context, await getNpmInstallArgs(context, specs, installRoot));
	});
}

async function ensureNpmProject(installRoot: string): Promise<void> {
	if (!(await exists(installRoot))) {
		await mkdir(installRoot, { recursive: true });
	}
	await markPathIgnoredByCloudSync(installRoot);
	await ensureGitIgnore(installRoot);
	const packageJsonPath = join(installRoot, "package.json");
	if (!(await exists(packageJsonPath))) {
		const pkgJson = { name: `${APP_NAME}-extensions`, private: true };
		await writeFile(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
	}
}

export async function ensureGitIgnore(dir: string): Promise<void> {
	if (!(await exists(dir))) {
		await mkdir(dir, { recursive: true });
	}
	const ignorePath = join(dir, ".gitignore");
	if (!(await exists(ignorePath))) {
		await writeFile(ignorePath, "*\n!.gitignore\n", "utf-8");
	}
}

export function getManagedNpmInstallPath(
	context: PackageLocationContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): string {
	if (scope === "project") {
		return join(context.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
	}
	return join(context.agentDir, "npm", "node_modules", source.name);
}

function globalNpmRootCommandKey(context: PackageManagerContext): string {
	const npmCommand = getNpmCommand(context);
	return [npmCommand.command, ...npmCommand.args].join("\0");
}

function globalNpmRootQuery(context: PackageManagerContext): { args: string[]; root: (output: string) => string } {
	if (getPackageManagerName(context) === "bun") {
		return {
			args: ["pm", "bin", "-g"],
			root: (output) => join(dirname(output.trim()), "install", "global", "node_modules"),
		};
	}
	return { args: ["root", "-g"], root: (output) => output.trim() };
}

export function getGlobalNpmRoot(context: PackageManagerContext): string {
	const commandKey = globalNpmRootCommandKey(context);
	if (context.globalNpmRoot && context.globalNpmRootCommandKey === commandKey) {
		return context.globalNpmRoot;
	}
	const query = globalNpmRootQuery(context);
	context.globalNpmRoot = query.root(runNpmCommandSync(context, query.args));
	context.globalNpmRootCommandKey = commandKey;
	return context.globalNpmRoot;
}

const globalNpmRootLookups = new WeakMap<PackageManagerContext, { commandKey: string; root: Promise<string> }>();

async function getGlobalNpmRootAsync(context: PackageManagerContext): Promise<string> {
	const commandKey = globalNpmRootCommandKey(context);
	if (context.globalNpmRoot && context.globalNpmRootCommandKey === commandKey) {
		return context.globalNpmRoot;
	}
	const pending = globalNpmRootLookups.get(context);
	if (pending?.commandKey === commandKey) return pending.root;
	const query = globalNpmRootQuery(context);
	const root = runNpmCommandCapture(context, query.args).then((output) => {
		context.globalNpmRoot = query.root(output);
		context.globalNpmRootCommandKey = commandKey;
		return context.globalNpmRoot;
	});
	globalNpmRootLookups.set(context, { commandKey, root });
	try {
		return await root;
	} finally {
		if (globalNpmRootLookups.get(context)?.root === root) globalNpmRootLookups.delete(context);
	}
}

const PNPM_GLOBAL_LIST_ARGS = ["list", "-g", "--depth", "0", "--json"];

function pnpmGlobalPackagePath(output: string, packageName: string): string | undefined {
	const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
	for (const entry of entries) {
		const path = entry.dependencies?.[packageName]?.path;
		if (path) return path;
	}
	return undefined;
}

function getLegacyGlobalNpmInstallPath(context: PackageManagerContext, source: NpmSource): string | undefined {
	try {
		if (getPackageManagerName(context) === "pnpm") {
			const pnpmPath = pnpmGlobalPackagePath(runNpmCommandSync(context, PNPM_GLOBAL_LIST_ARGS), source.name);
			if (pnpmPath) return pnpmPath;
		}
		const globalRoot = context.driver?.getGlobalNpmRoot
			? context.driver.getGlobalNpmRoot()
			: getGlobalNpmRoot(context);
		return join(globalRoot, source.name);
	} catch {
		return undefined;
	}
}

async function getLegacyGlobalNpmInstallPathAsync(
	context: PackageManagerContext,
	source: NpmSource,
): Promise<string | undefined> {
	try {
		if (getPackageManagerName(context) === "pnpm") {
			const output = await runNpmCommandCapture(context, PNPM_GLOBAL_LIST_ARGS);
			const pnpmPath = pnpmGlobalPackagePath(output, source.name);
			if (pnpmPath) return pnpmPath;
		}
		return join(await getGlobalNpmRootAsync(context), source.name);
	} catch {
		return undefined;
	}
}

export function getNpmInstallPath(
	context: PackageManagerContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): string {
	const managedPath = getManagedNpmInstallPath(context, source, scope);
	if (scope !== "user" || existsSync(managedPath)) {
		return managedPath;
	}
	const legacyPath = getLegacyGlobalNpmInstallPath(context, source);
	return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
}

export async function getNpmInstallPathAsync(
	context: PackageManagerContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): Promise<string> {
	const managedPath = getManagedNpmInstallPath(context, source, scope);
	if (scope !== "user" || (await exists(managedPath))) {
		return managedPath;
	}
	const legacyPath = await getLegacyGlobalNpmInstallPathAsync(context, source);
	return legacyPath && (await exists(legacyPath)) ? legacyPath : managedPath;
}

export async function getTemporaryNpmInstallPath(context: PackageLocationContext, source: NpmSource): Promise<string> {
	return join(await getNpmInstallRoot(context, "temporary", true), "node_modules", source.name);
}

export async function findExistingNpmInstallPath(
	context: PackageManagerContext,
	source: NpmSource,
	scope: SourceScope,
): Promise<string | undefined> {
	if (scope !== "temporary") return getExistingNpmInstallPathAsync(context, source, scope);
	const path = await getTemporaryNpmInstallPath(context, source);
	return (await exists(path)) ? path : undefined;
}

function npmInstallCandidates(
	context: PackageManagerContext,
	source: NpmSource,
	scope: InstalledSourceScope,
	installPath: string,
): string[] {
	const candidates = [installPath];
	if (scope === "project") {
		for (const configDir of getProjectConfigDirs(context.cwd)) {
			candidates.push(join(configDir, "npm", "node_modules", source.name));
		}
	}
	return Array.from(new Set(candidates));
}

export function getExistingNpmInstallPath(
	context: PackageManagerContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): string | undefined {
	return npmInstallCandidates(context, source, scope, getNpmInstallPath(context, source, scope)).find((candidate) =>
		existsSync(candidate),
	);
}

export async function getExistingNpmInstallPathAsync(
	context: PackageManagerContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): Promise<string | undefined> {
	const installPath = await getNpmInstallPathAsync(context, source, scope);
	for (const candidate of npmInstallCandidates(context, source, scope, installPath)) {
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

export async function installedNpmMatchesConfiguredVersion(
	context: PackageManagerContext,
	source: NpmSource,
	installedPath: string,
): Promise<boolean> {
	const installedVersion = await getInstalledNpmVersion(installedPath);
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
	const installedVersion = await getInstalledNpmVersion(installedPath);
	if (!installedVersion) return false;
	try {
		const targetVersion = await getLatestNpmVersion(
			context,
			source.version ? source.spec : source.name,
			source.range,
		);
		return gt(targetVersion, installedVersion);
	} catch {
		return false;
	}
}

export async function getInstalledNpmVersion(installedPath: string): Promise<string | undefined> {
	const packageJsonPath = join(installedPath, "package.json");
	if (!(await exists(packageJsonPath))) return undefined;
	try {
		const content = await readFile(packageJsonPath, "utf-8");
		const pkg = JSON.parse(stripBom(content)) as { version?: string };
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
		? await context.driver.runCommandCapture(
				npmCommand.command,
				[...npmCommand.args, "view", packageSpec, "version", "--json"],
				{
					cwd: context.cwd,
					timeoutMs: NETWORK_TIMEOUT_MS,
				},
			)
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
