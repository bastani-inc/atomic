import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";
import { normalizePath } from "./utils/paths.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	return undefined;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageName = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", [
					"install",
					"-g",
					"--ignore-scripts",
					"--config.minimumReleaseAge=0",
					updatePackageName,
				]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", updatePackageName]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", [
					"install",
					"-g",
					"--ignore-scripts",
					"--minimum-release-age=0",
					updatePackageName,
				]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				updatePackageName,
			]);
			const uninstallStep =
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/earendil-works/pi-mono/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updatePackageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly).
	// This runs before package.json app config is read, so the env var name is hardcoded.
	const envDir = process.env.ATOMIC_PACKAGE_DIR ?? process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json <appName>Config, with piConfig as a legacy shim)
// =============================================================================

interface AppConfig {
	name?: string;
	configDir?: string;
	changelogUrl?: string;
}

interface PackageJson extends Record<string, unknown> {
	name?: string;
	version?: string;
	piConfig?: AppConfig;
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

function appNameFromPackageName(packageName: string | undefined): string | undefined {
	const localName = packageName?.split("/").pop()?.trim();
	return localName && localName.length > 0 ? localName : undefined;
}

function readAppConfig(packageJson: PackageJson, appName: string | undefined): AppConfig | undefined {
	if (appName) {
		const appConfig = packageJson[`${appName}Config`];
		if (appConfig && typeof appConfig === "object" && !Array.isArray(appConfig)) {
			return appConfig as AppConfig;
		}
	}
	return packageJson.piConfig;
}

export const PACKAGE_NAME: string = pkg.name || "@bastani/atomic";
const packageAppName = appNameFromPackageName(PACKAGE_NAME);
const appConfig = readAppConfig(pkg, packageAppName);
export const APP_NAME: string = appConfig?.name || packageAppName || "pi";
export const APP_TITLE: string = appConfig?.name !== undefined || APP_NAME !== "pi" ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = appConfig?.configDir || (APP_NAME === "pi" ? ".pi" : `.${APP_NAME}`);
export const LEGACY_CONFIG_DIR_NAME = ".pi";
export const CONFIG_DIR_NAMES: readonly string[] =
	CONFIG_DIR_NAME === LEGACY_CONFIG_DIR_NAME ? [CONFIG_DIR_NAME] : [CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME];
export const VERSION: string = pkg.version || "0.0.0";
export const CHANGELOG_URL: string | undefined = appConfig?.changelogUrl?.trim() || undefined;

const ENV_PREFIX = APP_NAME.toUpperCase();
export const LEGACY_ENV_PREFIX = "PI";

// e.g., ATOMIC_CODING_AGENT_DIR (with PI_CODING_AGENT_DIR as a compatibility alias)
export const ENV_AGENT_DIR = `${ENV_PREFIX}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${ENV_PREFIX}_CODING_AGENT_SESSION_DIR`;
export const ENV_PACKAGE_DIR = `${ENV_PREFIX}_PACKAGE_DIR`;
export const ENV_OFFLINE = `${ENV_PREFIX}_OFFLINE`;
export const ENV_SKIP_VERSION_CHECK = `${ENV_PREFIX}_SKIP_VERSION_CHECK`;
export const ENV_STARTUP_BENCHMARK = `${ENV_PREFIX}_STARTUP_BENCHMARK`;
export const ENV_TELEMETRY = `${ENV_PREFIX}_TELEMETRY`;
export const ENV_SHARE_VIEWER_URL = `${ENV_PREFIX}_SHARE_VIEWER_URL`;
export const ENV_CLEAR_ON_SHRINK = `${ENV_PREFIX}_CLEAR_ON_SHRINK`;
export const ENV_HARDWARE_CURSOR = `${ENV_PREFIX}_HARDWARE_CURSOR`;
export const ENV_TIMING = `${ENV_PREFIX}_TIMING`;
export const ENV_CODEX_FAST_MODE = `${ENV_PREFIX}_CODEX_FAST_MODE`;
export const WORKFLOW_STAGE_SUBAGENT_GUARD_ENV = `${ENV_PREFIX}_WORKFLOW_STAGE_SUBAGENT_GUARD`;

export interface CodexFastModeEnvironmentSettings {
	chat?: boolean;
	workflow?: boolean;
}

function parseCodexFastModeEnvBoolean(value: string | undefined): boolean | undefined {
	switch (value?.trim().toLowerCase()) {
		case "1":
		case "true":
		case "enabled":
		case "on":
			return true;
		case "0":
		case "false":
		case "disabled":
		case "off":
			return false;
		default:
			return undefined;
	}
}

export function serializeCodexFastModeEnvironmentSettings(settings: Required<CodexFastModeEnvironmentSettings>): string {
	return `chat=${settings.chat ? "1" : "0"};workflow=${settings.workflow ? "1" : "0"}`;
}

export function parseCodexFastModeEnvironmentSettings(value: string | undefined): CodexFastModeEnvironmentSettings | undefined {
	if (!value) return undefined;
	const settings: CodexFastModeEnvironmentSettings = {};
	for (const part of value.split(/[;,]/)) {
		const separatorIndex = part.indexOf("=");
		if (separatorIndex === -1) continue;
		const key = part.slice(0, separatorIndex).trim();
		const parsedValue = parseCodexFastModeEnvBoolean(part.slice(separatorIndex + 1));
		if (parsedValue === undefined) continue;
		if (key === "chat") settings.chat = parsedValue;
		if (key === "workflow") settings.workflow = parsedValue;
	}
	return settings.chat !== undefined || settings.workflow !== undefined ? settings : undefined;
}

export function getCodexFastModeEnvironmentSettings(): CodexFastModeEnvironmentSettings | undefined {
	return parseCodexFastModeEnvironmentSettings(getEnvValue(ENV_CODEX_FAST_MODE));
}

export function setCodexFastModeEnvironmentSettings(settings: Required<CodexFastModeEnvironmentSettings>): void {
	setEnvValue(ENV_CODEX_FAST_MODE, serializeCodexFastModeEnvironmentSettings(settings));
}

export function getEnvNames(name: string): string[] {
	if (ENV_PREFIX === LEGACY_ENV_PREFIX || !name.startsWith(`${ENV_PREFIX}_`)) return [name];
	return [name, `${LEGACY_ENV_PREFIX}_${name.slice(ENV_PREFIX.length + 1)}`];
}

export function getEnvValue(name: string): string | undefined {
	for (const candidate of getEnvNames(name)) {
		const value = process.env[candidate];
		if (value !== undefined) return value;
	}
	return undefined;
}

export function hasEnvValue(name: string): boolean {
	return getEnvValue(name) !== undefined;
}

export function setEnvValue(name: string, value: string): void {
	process.env[name] = value;
}

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = getEnvValue(ENV_SHARE_VIEWER_URL) || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.atomic/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.atomic/agent/) */
export function getAgentDir(): string {
	const envDir = getEnvValue(ENV_AGENT_DIR);
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get the legacy pi agent config directory (e.g., ~/.pi/agent/) */
export function getLegacyAgentDir(): string {
	return join(homedir(), LEGACY_CONFIG_DIR_NAME, "agent");
}

/** Get agent config directories in precedence order (primary first, then legacy). */
export function getAgentDirs(): string[] {
	const primary = getAgentDir();
	if (hasEnvValue(ENV_AGENT_DIR) || CONFIG_DIR_NAME === LEGACY_CONFIG_DIR_NAME) {
		return [primary];
	}
	const legacy = getLegacyAgentDir();
	return legacy === primary ? [primary] : [primary, legacy];
}

/** Get user config root directories in precedence order (primary first, then legacy). */
export function getUserConfigDirs(): string[] {
	return CONFIG_DIR_NAMES.map((name) => join(homedir(), name));
}

/** Get project config directories in precedence order (primary first, then legacy). */
export function getProjectConfigDirs(cwd: string): string[] {
	return CONFIG_DIR_NAMES.map((name) => join(cwd, name));
}

/** Get a path inside every user config root directory. */
export function getUserConfigPaths(...segments: string[]): string[] {
	return getUserConfigDirs().map((dir) => join(dir, ...segments));
}

/** Get a path inside every agent config directory. */
export function getAgentConfigPaths(...segments: string[]): string[] {
	return getAgentDirs().map((dir) => join(dir, ...segments));
}

/** Get a path inside every project config directory. */
export function getProjectConfigPaths(cwd: string, ...segments: string[]): string[] {
	return getProjectConfigDirs(cwd).map((dir) => join(dir, ...segments));
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
