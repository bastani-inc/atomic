import { lstat, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { resolvePackageDirFrom } from "./config-package-identity.ts";
import { alternateRuntimeBase, ensureCacheDirectory, ensureCacheDirectoryAsync } from "./config-runtime-cache.ts";
import { getHomeDir, normalizePath } from "./utils/paths.ts";
import { isSplitLauncherRuntime, moduleFileFromMetaUrl } from "./utils/split-launcher.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = moduleFileFromMetaUrl(import.meta.url, "app.js");
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path).
 * Split Windows/macOS/Linux release launchers also set ATOMIC_CODING_AGENT before importing the sidecar app bundle.
 */
const bunFsMarkers = ["$bunfs", "~BUN", "%7EBUN"];
// Check process.argv[1] as well as import.meta.url: in a CJS (bytecode) bundle
// import.meta.url is rewritten to the original source path, but argv[1] still
// points into Bun's virtual filesystem.
export const isBunBinary =
	isSplitLauncherRuntime() ||
	[import.meta.url, process.argv[1] ?? ""].some((candidate) =>
		bunFsMarkers.some((marker) => candidate.includes(marker)),
	);

/**
 * Detect if we're running from a single-file bundle produced by `bun run bundle:dev`.
 * The bundle build inlines this env var via `--define`, so it is a compile-time
 * constant there and undefined everywhere else.
 */
export const isBundledBuild = process.env.ATOMIC_BUNDLED_BUILD === "1";

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

const modulePackageDir = isBunBinary ? undefined : resolvePackageDirFrom(__dirname);

// =============================================================================
// Install Method Detection
// =============================================================================

import {
	detectInstallMethodForRuntime,
	getSelfUpdateCommandForRuntime,
	getSelfUpdateUnavailableInstructionForRuntime,
	getUpdateInstructionForRuntime,
	makeSelfUpdateCommandStep,
	type SelfUpdateCommand,
	type SelfUpdateRuntime,
} from "./config-self-update.ts";
import { pathExists } from "./utils/path-exists.ts";

export type { InstallMethod, SelfUpdateCommand, SelfUpdateTarget } from "./config-self-update.ts";

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
	updateTarget: import("./config-self-update.ts").SelfUpdateTarget = { packageName, installSpec: packageName },
): import("./config-self-update.ts").SelfUpdateCommand | undefined {
	return getSelfUpdateCommandForRuntime(selfUpdateRuntime(), packageName, npmCommand, updateTarget);
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updateTarget: import("./config-self-update.ts").SelfUpdateTarget = { packageName, installSpec: packageName },
): string {
	return getSelfUpdateUnavailableInstructionForRuntime(selfUpdateRuntime(), packageName, npmCommand, updateTarget);
}

/**
 * The self-update command configured by the user: `ATOMIC_SELF_UPDATE_COMMAND` (or its `PI_SELF_UPDATE_COMMAND`
 * alias; whitespace-separated argv, no quoting), else the global `selfUpdateCommand` setting. Overrides
 * install-method detection.
 */
export function getConfiguredSelfUpdateArgv(setting: string[] | undefined): string[] | undefined {
	const fromEnv = getEnvValue(ENV_SELF_UPDATE_COMMAND)?.trim().split(/\s+/).filter(Boolean);
	if (fromEnv?.length) return fromEnv;
	return setting?.length ? setting : undefined;
}

/** Fill the `{packageName}`, `{version}`, and `{installSpec}` placeholders of a configured self-update command. */
export function makeConfiguredSelfUpdateCommand(
	argv: string[],
	release: { packageName: string; version: string },
): SelfUpdateCommand {
	const values: Record<string, string> = {
		packageName: release.packageName,
		version: release.version,
		installSpec: `${release.packageName}@${release.version}`,
	};
	const [command = "", ...args] = argv.map((arg) =>
		arg.replace(/\{(packageName|version|installSpec)\}/g, (_, name: string) => values[name]),
	);
	return makeSelfUpdateCommandStep(command, args);
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
 * - For source (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly).
	// This runs before package.json app config is read, so the env var name is hardcoded.
	const envDir = process.env.ATOMIC_PACKAGE_DIR ?? process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary || modulePackageDir === undefined) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname to the Atomic app package. Prebundled
	// companion extensions ship under dist/builtin/<name>/ with their own
	// package.json; stopping at the first one made APP_NAME "workflows".
	return modulePackageDir;
}

/**
 * Resolve the root that contains source-layout assets for non-binary runtimes.
 * Ordinary source and compiled modules already live in src/ or dist/, so use
 * their module directory directly. Bundled development builds and explicit
 * package-directory overrides instead need to select a package-root layout.
 */
function getModuleAssetRoot(): string {
	const hasPackageDirOverride = !!(process.env.ATOMIC_PACKAGE_DIR || process.env.PI_PACKAGE_DIR);
	if (!isBundledBuild && !hasPackageDirOverride) {
		return __dirname;
	}
	const packageDir = getPackageDir();
	return packageAssetRoots.get(packageDir) ?? findPackageAssetRoot(packageDir);
}

async function getModuleAssetRootAsync(): Promise<string> {
	const hasPackageDirOverride = !!(process.env.ATOMIC_PACKAGE_DIR || process.env.PI_PACKAGE_DIR);
	if (!isBundledBuild && !hasPackageDirOverride) {
		return __dirname;
	}
	const packageDir = getPackageDir();
	const known = packageAssetRoots.get(packageDir);
	if (known !== undefined) return known;
	const root = join(packageDir, (await pathExists(join(packageDir, "src"))) ? "src" : "dist");
	packageAssetRoots.set(packageDir, root);
	return root;
}

const packageAssetRoots = new Map<string, string>();

function findPackageAssetRoot(packageDir: string): string {
	const root = join(packageDir, existsSync(join(packageDir, "src")) ? "src" : "dist");
	packageAssetRoots.set(packageDir, root);
	return root;
}

if (isBundledBuild || process.env.ATOMIC_PACKAGE_DIR || process.env.PI_PACKAGE_DIR) {
	findPackageAssetRoot(getPackageDir());
}

/** Codemode workers and wasm live beside Atomic's split/development bundle. */
let codemodeWorkerDataUrl: URL | undefined;
let quickJSWasmPath: string | undefined;

export function getCodemodeWorkerUrl(): URL | undefined {
	if (codemodeWorkerDataUrl) return codemodeWorkerDataUrl;
	const worker = isBunBinary
		? join(getPackageDir(), "codemode-worker.js")
		: isBundledBuild
			? join(dirname(resolve(process.argv[1])), "codemode-worker.js")
			: join(getModuleAssetRoot(), "codemode-worker.js");
	if (!isBunBinary && !isBundledBuild && !existsSync(worker)) return undefined;
	// A self-contained worker survives replacement or removal of the running install.
	codemodeWorkerDataUrl ??= new URL(`data:text/javascript;base64,${readFileSync(worker).toString("base64")}`);
	return codemodeWorkerDataUrl;
}

export async function getCodemodeWorkerUrlAsync(): Promise<URL | undefined> {
	if (codemodeWorkerDataUrl) return codemodeWorkerDataUrl;
	const worker = isBunBinary
		? join(getPackageDir(), "codemode-worker.js")
		: isBundledBuild
			? join(dirname(resolve(process.argv[1])), "codemode-worker.js")
			: join(await getModuleAssetRootAsync(), "codemode-worker.js");
	if (!isBunBinary && !isBundledBuild && !(await pathExists(worker))) return undefined;
	const content = await readFile(worker);
	codemodeWorkerDataUrl ??= new URL(`data:text/javascript;base64,${content.toString("base64")}`);
	return codemodeWorkerDataUrl;
}

export function getQuickJSWasmPath(): string {
	quickJSWasmPath ??= isBunBinary
		? join(getPackageDir(), "quickjs.wasm")
		: isBundledBuild
			? join(dirname(resolve(process.argv[1])), "quickjs.wasm")
			: createRequire(__filename).resolve("quickjs-wasi/quickjs.wasm");
	return quickJSWasmPath;
}

export type InstallChange = { kind: "updated"; version: string } | { kind: "removed" };

export function detectInstallChange(packageJsonPath = startupPackageJsonPath): InstallChange | undefined {
	if (isBunBinary || !packageJsonPath) return undefined;
	let installed: PackageJson;
	try {
		installed = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installChangeOf(installed);
}

export async function detectInstallChangeAsync(
	packageJsonPath = startupPackageJsonPath,
): Promise<InstallChange | undefined> {
	if (isBunBinary || !packageJsonPath) return undefined;
	let installed: PackageJson;
	try {
		installed = JSON.parse(stripBom(await readFile(packageJsonPath, "utf-8"))) as PackageJson;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installChangeOf(installed);
}

function installChangeOf(installed: PackageJson): InstallChange | undefined {
	return installed.version && installed.version !== VERSION
		? { kind: "updated", version: installed.version }
		: undefined;
}
/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	return join(getModuleAssetRoot(), "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For source (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	return join(getModuleAssetRoot(), "core", "export-html");
}

export async function getExportTemplateDirAsync(): Promise<string> {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	return join(await getModuleAssetRootAsync(), "core", "export-html");
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
 * - For source (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	return join(getModuleAssetRoot(), "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

export async function getBundledInteractiveAssetPathAsync(name: string): Promise<string> {
	const assetsDir = isBunBinary
		? join(getPackageDir(), "assets")
		: join(await getModuleAssetRootAsync(), "modes", "interactive", "assets");
	return join(assetsDir, name);
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
let startupPackageJsonPath: string | undefined;
try {
	const packageJsonPath = getPackageJsonPath();
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	startupPackageJsonPath = packageJsonPath;
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
export const ENV_MODEL_CATALOG_URL = `${ENV_PREFIX}_MODEL_CATALOG_URL`;
export const ENV_CLEAR_ON_SHRINK = `${ENV_PREFIX}_CLEAR_ON_SHRINK`;
export const ENV_HARDWARE_CURSOR = `${ENV_PREFIX}_HARDWARE_CURSOR`;
export const ENV_CLIPBOARD_OSC52 = `${ENV_PREFIX}_CLIPBOARD_OSC52`;
export const ENV_TIMING = `${ENV_PREFIX}_TIMING`;
export const ENV_HEAP_MB = `${ENV_PREFIX}_HEAP_MB`;
export const ENV_CODEMODE_MAX_WORKERS = `${ENV_PREFIX}_CODEMODE_MAX_WORKERS`;
export const ENV_SELF_UPDATE_COMMAND = `${ENV_PREFIX}_SELF_UPDATE_COMMAND`;
export const ENV_STDIN_TIMEOUT_MS = `${ENV_PREFIX}_STDIN_TIMEOUT_MS`;
export const ENV_DEBUG = `${ENV_PREFIX}_DEBUG`;
export const WORKFLOW_STAGE_SUBAGENT_GUARD_ENV = `${ENV_PREFIX}_WORKFLOW_STAGE_SUBAGENT_GUARD`;
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

const DEFAULT_SHARE_VIEWER_URL = "https://bastani.ai/session/";

export const VERSION_ADOPTION_ENDPOINT =
	"https://atomic-version-adoption.bastani-atomic.workers.dev/v1/version-adoption";

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

/** Model config paths from highest to lowest precedence: Atomic project/global, then Pi project/global. */
export function getModelsConfigPaths(cwd: string, agentDir: string = getAgentDir(), includeProject = true): string[] {
	const globalPaths =
		agentDir === getAgentDir() ? getAgentConfigPaths("models.json") : [join(agentDir, "models.json")];
	if (!includeProject) return globalPaths;
	const projectPaths = getProjectConfigPaths(cwd, "models.json");
	const paths: string[] = [];
	for (let index = 0; index < Math.max(projectPaths.length, globalPaths.length); index++) {
		if (projectPaths[index]) paths.push(projectPaths[index]);
		if (globalPaths[index]) paths.push(globalPaths[index]);
	}
	return [...new Set(paths)];
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

/** The file name of a blueprint inside a `.atomic` directory. */
export const BLUEPRINT_FILE_NAME = "blueprint.yaml";

/** Get path to the global blueprint, which replaces the `resume.setupCommand` setting: `~/.atomic/agent/blueprint.yaml`. */
export function getGlobalBlueprintPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, BLUEPRINT_FILE_NAME);
}

/** Get path to the blueprint of a repository root or workspace directory: `<dir>/.atomic/blueprint.yaml`. */
export function getProjectBlueprintPath(dir: string): string {
	return join(dir, CONFIG_DIR_NAME, BLUEPRINT_FILE_NAME);
}

/** Get path to the directory that caches the GitHub Actions blueprint `uses` steps fetched, per owner, repository and ref. */
export function getBlueprintActionsDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "blueprint-actions");
}

const EXTENSION_TRANSPILE_CACHE_FORMAT = "ts-source-specifiers";

/**
 * Get path to the extension transpile cache directory (jiti fsCache).
 * Scoped by version and transform format so neither a release upgrade nor a
 * loader transform change reads stale transpiled output. Lives under the agent
 * directory of the load that uses it, which defaults to the one in effect now.
 */
export function getExtensionTranspileCacheDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cache", "jiti", `${VERSION}+${EXTENSION_TRANSPILE_CACHE_FORMAT}`);
}

let cliRuntime = false;

/** SDK hosts may explicitly choose TMPDIR for session tool output. CLI runs always use Atomic's scratch. */
export function useCliRuntimeStorage(): void {
	cliRuntime = true;
}
export function useManagedSessionScratch(): boolean {
	return cliRuntime || !process.env.TMPDIR;
}

/** Leave space for a Git index, editor filename, or session component below a long Windows agent directory. */
export function getRuntimeScratchCache(agent = getAgentDir()): string {
	const cache = resolve(agent, "cache");
	if (process.platform === "win32" && cache.length > 150 && process.env.LOCALAPPDATA) {
		const short = resolve(process.env.LOCALAPPDATA, "Atomic", "cache");
		if (short.length < cache.length) return short;
	}
	return cache;
}

/** Private scratch shared by the operations of this process, removed on exit. */
export async function getRuntimeScratchDir(checkout?: {
	readonly root: string;
	readonly gitDir?: string;
}): Promise<string> {
	const cache = getRuntimeScratchCache();
	const storage = await import("./config-runtime-scratch.ts");
	return storage.runtimeScratchDirectory(checkout ? await storage.checkoutScratchCache(cache, checkout) : cache);
}

const CACHE_GENERATION_MS = 30 * 24 * 60 * 60 * 1000;
const prunedRuntimeCaches = new Set<string>();
let reportedRuntimeFallback = false;

export function reportRuntimeStorageFallback(): void {
	if (reportedRuntimeFallback) return;
	reportedRuntimeFallback = true;
	process.stderr.write(
		"Atomic cannot write private runtime storage in the agent directory; using temporary storage instead.\n",
	);
}

/** Sweep Node's content files off the startup path, at most daily in the usual case. Keep recently read bytecode. */
async function pruneNodeBytecode(parent: string): Promise<void> {
	const now = Date.now();
	const marker = join(parent, ".last-pruned");
	try {
		await writeFile(marker, "", { flag: "wx", mode: 0o600 });
	} catch {
		const info = await lstat(marker);
		if (!info.isFile() || now - info.mtimeMs < 86_400_000) return;
		await utimes(marker, new Date(now), new Date(now));
	}
	const cutoff = now - 2 * CACHE_GENERATION_MS;
	for (const version of await readdir(parent, { withFileTypes: true })) {
		if (!version.isDirectory() || !/^v\d+\.\d+\.\d+-/.test(version.name)) continue;
		const dir = join(parent, version.name);
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !/^[a-f0-9]{8}$/.test(entry.name)) continue;
			const file = join(dir, entry.name);
			const info = await lstat(file).catch(() => undefined);
			if (info?.isFile() && Math.max(info.mtimeMs, info.atimeMs) < cutoff) await rm(file, { force: true });
		}
	}
}

/** A bounded lifetime for reusable bytecode. Pruning never scans individual modules on startup. */
function cacheLocation(kind: "node" | "workflows", alternateBase?: string) {
	const base = alternateBase ?? resolve(getAgentDir());
	const agent = alternateBase ? join(base, process.platform === "win32" ? "Atomic" : APP_NAME) : base;
	const parent =
		kind === "node" ? resolve(agent, "cache", "node") : resolve(getExtensionTranspileCacheDir(agent), "workflows");
	const generation = Math.floor(Date.now() / CACHE_GENERATION_MS);
	const current = kind === "node" ? parent : join(parent, String(generation));
	return {
		kind,
		base,
		current,
		parent,
		generation,
		alternate: alternateBase !== undefined,
		ignored: join(agent, "cache", kind === "node" ? "node" : "jiti"),
	};
}
function scheduleCachePruning({ kind, current, parent, generation }: ReturnType<typeof cacheLocation>): void {
	if (!prunedRuntimeCaches.has(current)) {
		prunedRuntimeCaches.add(current);
		setTimeout(() => {
			if (kind === "node") void pruneNodeBytecode(parent).catch(() => {});
			void readdir(parent, { withFileTypes: true })
				.then(async (entries) => {
					for (const entry of entries) {
						if (entry.isDirectory() && /^\d+$/.test(entry.name) && Number(entry.name) < generation - 1) {
							await rm(join(parent, entry.name), { recursive: true, force: true }).catch(() => {});
						}
					}
				})
				.catch(() => {});
		}, 10_000).unref();
	}
}

export function getRuntimeCacheDir(kind: "node" | "workflows", alternateBase?: string): string {
	const location = cacheLocation(kind, alternateBase);
	ensureCacheDirectory(location.base, location.current, location.alternate, location.ignored);
	scheduleCachePruning(location);
	return location.current;
}

function cacheBases(): (string | undefined)[] {
	const alternate = alternateRuntimeBase();
	return alternate ? [undefined, alternate] : [undefined];
}

/** Each cache must actually open before we stop trying other trusted locations. */
export function* runtimeCacheDirectories(kind: "node" | "workflows"): Generator<string> {
	for (const base of cacheBases()) {
		try {
			yield getRuntimeCacheDir(kind, base);
		} catch {
			/* Refused path; never ask the loader to write there. */
		}
		reportRuntimeStorageFallback();
	}
}

function workflowCacheEnabled(): boolean {
	let enabled = true;
	for (const value of [process.env.JITI_CACHE, process.env.JITI_FS_CACHE]) {
		if (value !== undefined) {
			try {
				enabled = Boolean(JSON.parse(value));
			} catch {
				/* jiti ignores invalid values. */
			}
		}
	}
	return enabled;
}

/** Async discovery does not block the interactive host while checking cache permissions. */
export async function withWorkflowTranspileCacheAsync<T extends { options: { fsCache?: boolean | string } }>(
	create: (dir: string | boolean) => T,
): Promise<T> {
	if (!workflowCacheEnabled()) return create(false);
	for (const base of cacheBases()) {
		const location = cacheLocation("workflows", base);
		try {
			await ensureCacheDirectoryAsync(location.base, location.current, location.alternate, location.ignored);
		} catch {
			reportRuntimeStorageFallback();
			continue;
		}
		scheduleCachePruning(location);
		const loader = create(location.current);
		if (loader.options.fsCache !== false) return loader;
		reportRuntimeStorageFallback();
	}
	return create(true);
}

/** jiti silently disables its cache for a refused directory; retain its normal temp fallback instead. */
export function withWorkflowTranspileCache<T extends { options: { fsCache?: boolean | string } }>(
	create: (dir: string | boolean) => T,
	honorEnvironment = true,
): T {
	if (honorEnvironment && !workflowCacheEnabled()) return create(false);
	for (const dir of runtimeCacheDirectories("workflows")) {
		const loader = create(dir);
		if (loader.options.fsCache !== false) return loader;
	}
	return create(true);
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
