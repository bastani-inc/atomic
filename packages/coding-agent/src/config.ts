import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getHomeDir, normalizePath } from "./utils/paths.ts";

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

import {
	detectInstallMethodForRuntime,
	getSelfUpdateCommandForRuntime,
	getSelfUpdateUnavailableInstructionForRuntime,
	getUpdateInstructionForRuntime,
	type SelfUpdateRuntime,
} from "./config-self-update.ts";
export type { InstallMethod, SelfUpdateCommand } from "./config-self-update.ts";

function selfUpdateRuntime(): SelfUpdateRuntime {
	return {
		isBunBinary,
		isBunRuntime,
		moduleDir: __dirname,
		getPackageDir,
	};
}

export function detectInstallMethod(): import("./config-self-update.ts").InstallMethod {
	return detectInstallMethodForRuntime(selfUpdateRuntime());
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): import("./config-self-update.ts").SelfUpdateCommand | undefined {
	return getSelfUpdateCommandForRuntime(selfUpdateRuntime(), packageName, npmCommand, updatePackageName);
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): string {
	return getSelfUpdateUnavailableInstructionForRuntime(selfUpdateRuntime(), packageName, npmCommand, updatePackageName);
}

export function getUpdateInstruction(packageName: string): string {
	return getUpdateInstructionForRuntime(selfUpdateRuntime(), packageName);
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
	return join(getHomeDir(), CONFIG_DIR_NAME, "agent");
}

/** Get the legacy pi agent config directory (e.g., ~/.pi/agent/) */
export function getLegacyAgentDir(): string {
	return join(getHomeDir(), LEGACY_CONFIG_DIR_NAME, "agent");
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
	return CONFIG_DIR_NAMES.map((name) => join(getHomeDir(), name));
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
