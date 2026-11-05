import { execFile, type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "fs";
import { writeFile } from "fs/promises";
import { arch, platform } from "os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import lockfile from "proper-lockfile";
import { setTimeout as delay } from "timers/promises";
import { ENV_OFFLINE, getBinDir, getEnvValue, VERSION } from "../config.js";
import { createChildProcessEnvironment } from "./child-process.ts";
import { createGitEnvironment } from "./git-env.ts";
import {
	attachGitCleanupFailure,
	GIT_MINIMUM_VERSION,
	type GitInstallPhase,
	GitProvisionConfigError,
	type GitProvisionError,
	type GitProvisionPhase,
	GitProvisionTimeoutError,
	type GitRejectedSystemGit,
	GitUnavailableError,
	type GitUnavailableFields,
	isGitProvisionError,
	type SerializedGitProvisionError,
} from "./git-errors.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
	const value = getEnvValue(ENV_OFFLINE);
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, target: string) => string;
}

// Map Node's platform/arch to the release target suffix shared by fd and ripgrep.
// Only x64 and arm64 are mapped. Other architectures (e.g. ARM32 `arm`, `ia32`)
// must not fall back to x86-64 binaries (earendil-works/pi#11209).
function getReleaseTarget(plat: string, architecture: string): string | undefined {
	const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
	if (!archStr) return undefined;
	if (plat === "darwin") return `${archStr}-apple-darwin.tar.gz`;
	if (plat === "linux") return `${archStr}-unknown-linux-musl.tar.gz`;
	if (plat === "win32") return `${archStr}-pc-windows-msvc.zip`;
	return undefined;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, target) => `fd-v${version}-${target}`,
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, target) => `ripgrep-${version}-${target}`,
	},
};

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe", env: createChildProcessEnvironment() });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null;
export function getToolPath(tool: "git", options?: ResolveGitOptions): Promise<string>;
export function getToolPath(tool: "fd" | "rg" | "git", options?: ResolveGitOptions): string | null | Promise<string> {
	if (tool === "git") return resolveGit(options).then((git) => git.path);
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Resolve the latest release version from the release page redirect, avoiding
// the anonymous api.github.com quota shared by corporate proxies and CI runners.
export async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetchWithRetry(
		`https://github.com/${repo}/releases/latest`,
		{ headers: { "User-Agent": getPiUserAgent(VERSION) }, redirect: "manual" },
		{ timeoutMs: NETWORK_TIMEOUT_MS },
	);
	try {
		await response.body?.cancel();
	} catch {
		// Discarding the redirect body is best-effort.
	}
	const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
	if (!location) throw new Error(`Failed to resolve latest ${repo} release: HTTP ${response.status} without redirect`);
	const tag = new URL(location, "https://github.com").pathname.split("/").pop();
	if (!tag || !location.includes("/releases/tag/")) {
		throw new Error(`Failed to resolve latest ${repo} release: unexpected redirect to ${location}`);
	}
	return decodeURIComponent(tag).replace(/^v/, "");
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe", env: createChildProcessEnvironment() });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();
	const target = getReleaseTarget(plat, architecture);
	if (!target) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// fd is pinned on darwin/x64; skip the version lookup there.
	const version =
		tool === "fd" && plat === "darwin" && architecture === "x64" ? "10.3.0" : await getLatestVersion(config.repo);
	const assetName = config.getAssetName(version, target);

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download
	await downloadFile(downloadUrl, archivePath);

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

/** A managed-tool readiness update, reported to the caller that asked. */
export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 *
 * Progress and problems are reported through `onStatus`; the function never
 * writes to the console itself, because in a fullscreen session a console
 * write lands in the alternate screen and corrupts the frame. Callers without
 * a status sink stay silent.
 *
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureTool(
	tool: "fd" | "rg" | "git",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	if (tool === "git") return ensureGit(onStatus);

	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// Prebuilt downloads only exist for the targets mapped in getReleaseTarget.
	if (!getReleaseTarget(platform(), arch())) {
		onStatus?.({
			type: "warning",
			message: `${config.name} not found. Automatic download is not supported on ${platform()}/${arch()}. Install ${config.name} with your system package manager.`,
		});
		return undefined;
	}

	// Tool not found - download it
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		// Include the error cause chain: fetch failures surface as a bare
		// "fetch failed" TypeError with the actionable detail (DNS, TLS,
		// timeout) hidden in the cause. Depth-capped to guard against
		// circular cause chains.
		const messages: string[] = [];
		for (
			let current: unknown = e, depth = 0;
			current instanceof Error && depth < 5;
			current = current.cause, depth++
		) {
			if (!messages.includes(current.message)) messages.push(current.message);
		}
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${messages.length > 0 ? messages.join(": ") : String(e)}`,
		});
		return undefined;
	}
}

// Git is provisioned as a complete distribution (helpers, templates, CA bundle), not a single binary, so it has its
// own pinned release table, layout, and environment.

export type GitTargetKey =
	| "darwin-x64"
	| "darwin-arm64"
	| "linux-x64"
	| "linux-arm64"
	| "linux-arm"
	| "win32-x64"
	| "win32-arm64"
	| "win32-ia32";

export interface GitRelease {
	readonly repo: string;
	readonly tag: string;
	readonly version: string;
	readonly assets: Readonly<Record<GitTargetKey, { readonly name: string; readonly sha256: string }>>;
}

/** The pinned desktop/dugite-native release Atomic provisions; every archive is verified against its SHA-256 here. */
export const GIT_RELEASE: GitRelease = {
	repo: "desktop/dugite-native",
	tag: "v2.56.0-2",
	version: "2.56.0",
	assets: {
		"darwin-x64": {
			name: "dugite-native-v2.56.0-a44aeca-macOS-x64.tar.gz",
			sha256: "52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659",
		},
		"darwin-arm64": {
			name: "dugite-native-v2.56.0-a44aeca-macOS-arm64.tar.gz",
			sha256: "1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7",
		},
		"linux-x64": {
			name: "dugite-native-v2.56.0-a44aeca-ubuntu-x64.tar.gz",
			sha256: "1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9",
		},
		"linux-arm64": {
			name: "dugite-native-v2.56.0-a44aeca-ubuntu-arm64.tar.gz",
			sha256: "d5ce120515bf3013a014e6a918aa87ec0f7a6f5f9687c48d50127e637cb9b6c2",
		},
		"linux-arm": {
			name: "dugite-native-v2.56.0-a44aeca-ubuntu-arm.tar.gz",
			sha256: "7a14edae189f791e64f8d037c8e3830acd648cd1ad891db40c8d6469d33b36cd",
		},
		"win32-x64": {
			name: "dugite-native-v2.56.0-a44aeca-windows-x64.tar.gz",
			sha256: "f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14",
		},
		"win32-arm64": {
			name: "dugite-native-v2.56.0-a44aeca-windows-arm64.tar.gz",
			sha256: "1834e7817589f25f97ae0f309ef4733578a6b8dbd438ed29f898d075e6ead4c2",
		},
		"win32-ia32": {
			name: "dugite-native-v2.56.0-a44aeca-windows-x86.tar.gz",
			sha256: "ef98c4e84c916e95ee1b3c894240f37db264b06265999e841a6eb54822899da4",
		},
	},
};

/** The Linux builds link against glibc 2.34. */
const GIT_GLIBC_MINIMUM = "2.34";
const GIT_PROBE_TIMEOUT_MS = 10_000;
const GIT_STAGING_PREFIX = ".git-staging-";

interface GitProvisionSettings {
	readonly release: GitRelease;
	readonly downloadTimeoutMs: number;
	readonly extractTimeoutMs: number;
	readonly verifyTimeoutMs: number;
	readonly lockWaitTimeoutMs: number;
	readonly lockStaleMs: number;
	readonly lockUpdateMs: number;
	readonly lockPollMs: number;
}

const DEFAULT_GIT_PROVISION_SETTINGS: GitProvisionSettings = {
	release: GIT_RELEASE,
	downloadTimeoutMs: 600_000,
	extractTimeoutMs: 300_000,
	verifyTimeoutMs: 30_000,
	lockWaitTimeoutMs: 900_000,
	lockStaleMs: 20_000,
	lockUpdateMs: 5_000,
	lockPollMs: 250,
};

let gitProvisionSettings = DEFAULT_GIT_PROVISION_SETTINGS;

/** Provision from a test release with short limits while `callback` runs. Not part of the public API. */
export async function withGitProvisionSettingsForTest<T>(
	overrides: Partial<GitProvisionSettings>,
	callback: () => Promise<T>,
): Promise<T> {
	const previous = gitProvisionSettings;
	gitProvisionSettings = { ...previous, ...overrides };
	try {
		return await callback();
	} finally {
		gitProvisionSettings = previous;
	}
}

const GIT_INSTALL_COMMANDS: Readonly<Record<string, string>> = {
	android: "pkg install git",
	freebsd: "pkg install git",
	openbsd: "pkg_add git",
};

export type GitLibc = { readonly family: "glibc"; readonly version?: string } | { readonly family: "musl" };

export interface GitDistributionTarget {
	readonly key: GitTargetKey;
	readonly asset: string;
	readonly sha256: string;
	readonly url: string;
}

type UnsupportedPlatformFields = Extract<GitUnavailableFields, { readonly code: "unsupported-platform" }>;
export type GitTargetResolution =
	| { readonly supported: true; readonly target: GitDistributionTarget }
	| { readonly supported: false; readonly fields: UnsupportedPlatformFields };

/** Where the portable git lives once installed: `<getBinDir()>/git`. */
export function getGitInstallDir(): string {
	return join(TOOLS_DIR, "git");
}

/** Compare major.minor.patch versions; a missing component counts as 0. */
function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (const index of [0, 1, 2]) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** `git version 2.39.5 (Apple Git-154)` → `2.39.5`; undefined when the output is not a git version line. */
export function parseGitVersion(output: string): string | undefined {
	const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
	return match === null ? undefined : `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
}

function supportedArchitecture(plat: string, architecture: string): boolean {
	if (plat === "darwin") return architecture === "x64" || architecture === "arm64";
	if (plat === "linux") return architecture === "x64" || architecture === "arm64" || architecture === "arm";
	return architecture === "x64" || architecture === "arm64" || architecture === "ia32";
}

/** Map a platform, architecture, and (on Linux) libc to the pinned asset, or say why there is none. */
export function getGitDistributionTarget(
	plat: string,
	architecture: string,
	libc: GitLibc | undefined,
	release: GitRelease = GIT_RELEASE,
): GitTargetResolution {
	const unsupported = (
		reason: UnsupportedPlatformFields["reason"],
		extra: { readonly libc?: string; readonly installCommand?: string } = {},
	): GitTargetResolution => ({
		supported: false,
		fields: { code: "unsupported-platform", reason, platform: plat, arch: architecture, ...extra },
	});
	if (plat !== "darwin" && plat !== "linux" && plat !== "win32") {
		const installCommand = GIT_INSTALL_COMMANDS[plat];
		return unsupported("platform", installCommand === undefined ? {} : { installCommand });
	}
	if (libc?.family === "musl") return unsupported("musl", { libc: "musl", installCommand: "apk add git" });
	if (libc?.version !== undefined && compareVersions(libc.version, GIT_GLIBC_MINIMUM) < 0)
		return unsupported("glibc-too-old", { libc: `glibc ${libc.version}` });
	if (!supportedArchitecture(plat, architecture)) return unsupported("architecture");
	const key = `${plat}-${architecture}` as GitTargetKey;
	const asset = release.assets[key];
	return {
		supported: true,
		target: {
			key,
			asset: asset.name,
			sha256: asset.sha256,
			url: `https://github.com/${release.repo}/releases/download/${release.tag}/${asset.name}`,
		},
	};
}

let detectedLibc: GitLibc | undefined;

function muslLoaderPresent(): boolean {
	return ["/lib", "/usr/lib"].some(
		(directory) => existsSync(directory) && readdirSync(directory).some((name) => name.startsWith("ld-musl-")),
	);
}

/** glibc from the runtime report; otherwise musl when its loader exists. */
export function detectLinuxLibc(): GitLibc {
	if (detectedLibc !== undefined) return detectedLibc;
	const report = process.report?.getReport() as { readonly header?: { readonly glibcVersionRuntime?: string } };
	const glibcVersion = report?.header?.glibcVersionRuntime;
	detectedLibc =
		typeof glibcVersion === "string"
			? { family: "glibc", version: glibcVersion }
			: muslLoaderPresent()
				? { family: "musl" }
				: { family: "glibc" };
	return detectedLibc;
}

function hostPlatform(): { readonly platform: string; readonly arch: string } {
	return { platform: platform(), arch: arch() };
}

function currentGitTarget(): GitTargetResolution {
	const plat = platform();
	return getGitDistributionTarget(
		plat,
		arch(),
		plat === "linux" ? detectLinuxLibc() : undefined,
		gitProvisionSettings.release,
	);
}

interface GitDistributionLayout {
	readonly root: string;
	readonly executable: string;
	readonly execPath: string;
	readonly templateDir: string;
	readonly systemConfig?: string;
	readonly caBundle?: string;
	readonly shellPathEntry: string;
}

function windowsGitSubfolder(architecture: string): string {
	if (architecture === "arm64") return "clangarm64";
	return architecture === "ia32" ? "mingw32" : "ucrt64";
}

function gitLayout(root: string, plat: string, architecture: string): GitDistributionLayout {
	if (plat === "win32") {
		const subfolder = join(root, windowsGitSubfolder(architecture));
		return {
			root,
			executable: join(root, "cmd", "git.exe"),
			execPath: join(subfolder, "libexec", "git-core"),
			templateDir: join(subfolder, "share", "git-core", "templates"),
			caBundle: join(subfolder, "etc", "ssl", "certs", "ca-bundle.crt"),
			shellPathEntry: join(root, "cmd"),
		};
	}
	return {
		root,
		executable: join(root, "bin", "git"),
		execPath: join(root, "libexec", "git-core"),
		templateDir: join(root, "share", "git-core", "templates"),
		systemConfig: join(root, "etc", "gitconfig"),
		...(plat === "linux" ? { caBundle: join(root, "ssl", "cacert.pem") } : {}),
		shellPathEntry: join(root, "bin"),
	};
}

function currentGitLayout(root = getGitInstallDir()): GitDistributionLayout {
	return gitLayout(root, platform(), arch());
}

/**
 * The variables a portable git needs. Caller-provided `GIT_CONFIG_SYSTEM` and `GIT_SSL_CAINFO` win; a defaulted
 * `GIT_SSL_CAINFO` takes precedence over `http.sslCAInfo` in git configuration.
 */
function portableGitEnv(layout: GitDistributionLayout, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = { GIT_EXEC_PATH: layout.execPath, GIT_TEMPLATE_DIR: layout.templateDir };
	if (layout.systemConfig !== undefined && !baseEnv.GIT_CONFIG_SYSTEM) env.GIT_CONFIG_SYSTEM = layout.systemConfig;
	if (layout.caBundle !== undefined && !baseEnv.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = layout.caBundle;
	return env;
}

function pathValueOf(env: NodeJS.ProcessEnv): string {
	const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
	return env[key] ?? "";
}

function isWithin(child: string, parent: string): boolean {
	const fromParent = relative(parent, child);
	return fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent);
}

function isExecutableFile(candidate: string, plat: string): boolean {
	const stats = statSync(candidate, { throwIfNoEntry: false });
	return stats?.isFile() === true && (plat === "win32" || (stats.mode & 0o111) !== 0);
}

/** The first git on PATH, ignoring Atomic's own portable copy. */
function findSystemGit(pathValue: string, portableRoot: string, plat: string): string | undefined {
	const executable = plat === "win32" ? "git.exe" : "git";
	for (const entry of pathValue.split(delimiter)) {
		const directory = resolve(entry);
		if (isWithin(directory, portableRoot)) continue;
		const candidate = join(directory, executable);
		if (isExecutableFile(candidate, plat)) return candidate;
	}
	return undefined;
}

function probeGitVersion(executable: string, overrides: Record<string, string> | undefined): string | undefined {
	const result = spawnSync(executable, ["--version"], {
		timeout: GIT_PROBE_TIMEOUT_MS,
		env: createGitEnvironment(overrides, createChildProcessEnvironment()),
	});
	return result.status === 0 ? parseGitVersion(String(result.stdout)) : undefined;
}

/** Undefined when no git is on PATH. */
type SystemGitProbe =
	| undefined
	| { readonly kind: "usable"; readonly path: string; readonly version: string }
	| { readonly kind: "rejected"; readonly rejected: GitRejectedSystemGit };

const systemGitProbes = new Map<string, SystemGitProbe>();
const provisionedGitVersions = new Map<string, string>();
let lastProvisionFailure: GitProvisionError | undefined;

function probeSystemGit(): SystemGitProbe {
	const pathValue = pathValueOf(process.env);
	const root = getGitInstallDir();
	const key = `${root}\0${pathValue}`;
	if (systemGitProbes.has(key)) return systemGitProbes.get(key);
	const path = findSystemGit(pathValue, root, platform());
	const version = path === undefined ? undefined : probeGitVersion(path, undefined);
	const probe: SystemGitProbe =
		path === undefined
			? undefined
			: version === undefined
				? { kind: "rejected", rejected: { path, problem: "probe-failed" } }
				: compareVersions(version, GIT_MINIMUM_VERSION) < 0
					? { kind: "rejected", rejected: { path, problem: "below-minimum", version } }
					: { kind: "usable", path, version };
	systemGitProbes.set(key, probe);
	return probe;
}

function probeProvisionedGit(layout: GitDistributionLayout): string | undefined {
	if (!existsSync(layout.executable)) {
		provisionedGitVersions.delete(layout.executable);
		return undefined;
	}
	const cached = provisionedGitVersions.get(layout.executable);
	if (cached !== undefined) return cached;
	const version = probeGitVersion(layout.executable, portableGitEnv(layout, process.env));
	if (version !== undefined) provisionedGitVersions.set(layout.executable, version);
	return version;
}

export type ResolvedGitSource = "system" | "provisioned";

/** A git executable Atomic can run, and the complete environment to run it with. */
export interface ResolvedGit {
	/** Absolute path of the executable. */
	readonly path: string;
	/** `process.env` plus, for a provisioned git, the portable variables it needs. Pass it as the child's `env`. */
	readonly env: NodeJS.ProcessEnv;
	readonly source: ResolvedGitSource;
	readonly version: string;
}

export interface ResolveGitOptions {
	/** Cancels a download in progress; the promise rejects with `signal.reason`. */
	readonly signal?: AbortSignal;
	/** Receives download progress and non-fatal warnings. */
	readonly onStatus?: (status: ToolStatus) => void;
}

interface GitSelection {
	readonly path: string;
	readonly source: ResolvedGitSource;
	readonly version: string;
	readonly layout?: GitDistributionLayout;
}

type GitLocation =
	| { readonly found: true; readonly selection: GitSelection }
	| { readonly found: false; readonly system: SystemGitProbe; readonly target: GitTargetResolution };

function locateGit(): GitLocation {
	const system = probeSystemGit();
	if (system?.kind === "usable")
		return { found: true, selection: { path: system.path, source: "system", version: system.version } };
	const target = currentGitTarget();
	const layout = currentGitLayout();
	const version = target.supported ? probeProvisionedGit(layout) : undefined;
	if (version !== undefined)
		return { found: true, selection: { path: layout.executable, source: "provisioned", version, layout } };
	return { found: false, system, target };
}

function withRejectedSystemGit(fields: GitUnavailableFields, system: SystemGitProbe): GitUnavailableFields {
	return system?.kind === "rejected" ? { ...fields, systemGit: system.rejected } : fields;
}

/** The reason no git is available without downloading, or undefined when a download may proceed. */
function blockedProvisionFields(location: Extract<GitLocation, { found: false }>): GitUnavailableFields | undefined {
	if (!location.target.supported) return withRejectedSystemGit(location.target.fields, location.system);
	if (isOfflineModeEnabled())
		return withRejectedSystemGit(
			{ code: "offline", offlineVariable: ENV_OFFLINE, ...hostPlatform() },
			location.system,
		);
	return undefined;
}

function toResolvedGit(selection: GitSelection): ResolvedGit {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (selection.layout !== undefined) Object.assign(env, portableGitEnv(selection.layout, process.env));
	return { path: selection.path, env, source: selection.source, version: selection.version };
}

function selectGitSync(): GitSelection {
	const location = locateGit();
	if (location.found) return location.selection;
	const blocked = blockedProvisionFields(location);
	if (blocked !== undefined) throw new GitUnavailableError(blocked);
	throw (
		lastProvisionFailure ??
		new GitUnavailableError(
			withRejectedSystemGit(
				{ code: "not-installed", installDir: getGitInstallDir(), ...hostPlatform() },
				location.system,
			),
		)
	);
}

/**
 * Resolve git without downloading: a system git at or above {@link GIT_MINIMUM_VERSION}, else the provisioned copy.
 * Throws {@link GitUnavailableError} when neither exists; call {@link resolveGit} first to provision one.
 */
export function resolveGitSync(): ResolvedGit {
	return toResolvedGit(selectGitSync());
}

function validateResolveGitOptions(options: ResolveGitOptions): void {
	if (typeof options !== "object" || options === null)
		throw new GitProvisionConfigError({ source: "sdk", field: "options", expected: "an options object" });
	if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
		throw new GitProvisionConfigError({ source: "sdk", field: "signal", expected: "an AbortSignal" });
	if (options.onStatus !== undefined && typeof options.onStatus !== "function")
		throw new GitProvisionConfigError({ source: "sdk", field: "onStatus", expected: "a function" });
}

async function selectGit(options: ResolveGitOptions): Promise<GitSelection> {
	validateResolveGitOptions(options);
	options.signal?.throwIfAborted();
	const location = locateGit();
	if (location.found) return location.selection;
	const blocked = blockedProvisionFields(location);
	if (blocked !== undefined) throw new GitUnavailableError(blocked);
	const layout = currentGitLayout();
	const target = (location.target as Extract<GitTargetResolution, { supported: true }>).target;
	const version = await joinGitProvision(target, layout, location.system, options);
	return { path: layout.executable, source: "provisioned", version, layout };
}

/**
 * Resolve the git Atomic runs: a working system git at or above {@link GIT_MINIMUM_VERSION}, else the provisioned
 * copy under `getBinDir()/git`, else a verified download of the pinned portable git. Rejects with a
 * {@link GitProvisionError} when none is possible, and with `signal.reason` when cancelled.
 */
export async function resolveGit(options: ResolveGitOptions = {}): Promise<ResolvedGit> {
	return toResolvedGit(await selectGit(options));
}

/** The portable environment the resolved git needs: `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, and the CA bundle. Empty for a system git. */
export async function getToolEnv(
	tool: "fd" | "rg" | "git",
	options: ResolveGitOptions = {},
): Promise<Record<string, string>> {
	if (tool !== "git") return {};
	const selection = await selectGit(options);
	return selection.layout === undefined ? {} : portableGitEnv(selection.layout, process.env);
}

async function ensureGit(onStatus: ((status: ToolStatus) => void) | undefined): Promise<string | undefined> {
	try {
		return (await resolveGit({ onStatus })).path;
	} catch (error) {
		if (!isGitProvisionError(error)) throw error;
		onStatus?.({ type: "warning", message: error.message });
		return undefined;
	}
}

/** Git as the tools status surface shows it; resolving never downloads. */
export type GitToolStatus =
	| { readonly source: ResolvedGitSource; readonly version: string; readonly path: string }
	| { readonly source: "unavailable"; readonly error: SerializedGitProvisionError };

export function getGitStatus(): GitToolStatus {
	try {
		const selection = selectGitSync();
		return { source: selection.source, version: selection.version, path: selection.path };
	} catch (error) {
		if (!isGitProvisionError(error)) throw error;
		return { source: "unavailable", error: error.toJSON() };
	}
}

/**
 * The PATH entry and variables that expose the provisioned git to agent shells. Undefined whenever a git is on PATH
 * (even one below the minimum), so a shell never shadows the user's own git.
 */
export function getGitShellEnvironment(
	baseEnv: NodeJS.ProcessEnv,
): { readonly pathEntry: string; readonly env: Record<string, string> } | undefined {
	const layout = currentGitLayout();
	if (findSystemGit(pathValueOf(baseEnv), layout.root, platform()) !== undefined) return undefined;
	if (!existsSync(layout.executable)) return undefined;
	return { pathEntry: layout.shellPathEntry, env: portableGitEnv(layout, baseEnv) };
}

interface SharedGitProvision {
	readonly promise: Promise<string>;
	readonly controller: AbortController;
	readonly listeners: Set<(status: ToolStatus) => void>;
	waiters: number;
}

let sharedGitProvision: SharedGitProvision | undefined;

function startGitProvision(target: GitDistributionTarget, layout: GitDistributionLayout, system: SystemGitProbe) {
	const controller = new AbortController();
	const listeners = new Set<(status: ToolStatus) => void>();
	const emit = (status: ToolStatus): void => {
		for (const listener of listeners) listener(status);
	};
	const shared: SharedGitProvision = {
		controller,
		listeners,
		waiters: 0,
		promise: installGitDistribution(target, layout, system, controller.signal, emit).then(
			(version) => {
				lastProvisionFailure = undefined;
				return version;
			},
			(error) => {
				if (isGitProvisionError(error)) lastProvisionFailure = error;
				throw error;
			},
		),
	};
	void shared.promise.then(
		() => clearSharedGitProvision(shared),
		() => clearSharedGitProvision(shared),
	);
	return shared;
}

function clearSharedGitProvision(shared: SharedGitProvision): void {
	if (sharedGitProvision === shared) sharedGitProvision = undefined;
}

/** Join the in-process download, or start it. The download stops only when every waiter has cancelled. */
function joinGitProvision(
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	system: SystemGitProbe,
	options: ResolveGitOptions,
): Promise<string> {
	if (sharedGitProvision === undefined || sharedGitProvision.controller.signal.aborted)
		sharedGitProvision = startGitProvision(target, layout, system);
	const shared = sharedGitProvision;
	const { signal, onStatus } = options;
	if (onStatus !== undefined) shared.listeners.add(onStatus);
	shared.waiters += 1;
	return new Promise<string>((resolvePromise, rejectPromise) => {
		const leave = (): void => {
			shared.waiters -= 1;
			if (onStatus !== undefined) shared.listeners.delete(onStatus);
			signal?.removeEventListener("abort", onAbort);
		};
		function onAbort(this: AbortSignal): void {
			leave();
			if (shared.waiters === 0) shared.controller.abort(this.reason);
			rejectPromise(this.reason);
		}
		signal?.addEventListener("abort", onAbort);
		shared.promise.then(
			(version) => {
				leave();
				resolvePromise(version);
			},
			(error) => {
				leave();
				rejectPromise(error);
			},
		);
	});
}

function installFailed(
	phase: GitInstallPhase,
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	cause: unknown,
	detail?: string,
): GitUnavailableError {
	return new GitUnavailableError(
		{
			code: "install-failed",
			phase,
			asset: target.asset,
			installDir: layout.root,
			...hostPlatform(),
			...(detail === undefined ? {} : { detail }),
		},
		cause === undefined ? undefined : { cause },
	);
}

function errnoCode(error: unknown): string | undefined {
	return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

type GitInstallLock =
	| { readonly kind: "held"; readonly release: () => Promise<void>; readonly compromised: () => Error | undefined }
	| { readonly kind: "installed"; readonly version: string };

/**
 * Serialize installs across processes so concurrent starts download once. Correctness does not depend on the lock:
 * the distribution is published by an atomic rename, so a holder that is killed, stopped, or loses the lock never
 * exposes a partial install.
 */
async function acquireGitInstallLock(
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	signal: AbortSignal,
	emit: (status: ToolStatus) => void,
): Promise<GitInstallLock> {
	const binDir = dirname(layout.root);
	const lockPath = join(binDir, "git.install.lock");
	const startedAt = Date.now();
	let announced = false;
	for (;;) {
		signal.throwIfAborted();
		let compromised: Error | undefined;
		try {
			const release = await lockfile.lock(binDir, {
				lockfilePath: lockPath,
				realpath: false,
				retries: 0,
				stale: gitProvisionSettings.lockStaleMs,
				update: gitProvisionSettings.lockUpdateMs,
				onCompromised: (error) => {
					compromised = error;
				},
			});
			return { kind: "held", release, compromised: () => compromised };
		} catch (error) {
			if (errnoCode(error) !== "ELOCKED") throw installFailed("stage", target, layout, error, "install lock");
		}
		const version = probeProvisionedGit(layout);
		if (version !== undefined) return { kind: "installed", version };
		const lockStats = statSync(lockPath, { throwIfNoEntry: false });
		if (lockStats !== undefined && lockStats.mtimeMs - Date.now() > gitProvisionSettings.lockStaleMs)
			rmSync(lockPath, { recursive: true, force: true });
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= gitProvisionSettings.lockWaitTimeoutMs)
			throw new GitProvisionTimeoutError({
				phase: "lock",
				timeoutMs: gitProvisionSettings.lockWaitTimeoutMs,
				elapsedMs,
			});
		if (!announced) {
			announced = true;
			emit({ type: "info", message: "Another Atomic process is installing git. Waiting for it to finish..." });
		}
		await delay(gitProvisionSettings.lockPollMs, undefined, { signal });
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoCode(error) !== "ESRCH";
	}
}

/**
 * Remove staging directories whose installer process has exited. Ownership comes from the pid in the name, never
 * from timestamps, so a skewed clock cannot make a live installer's staging look abandoned.
 */
function removeAbandonedStagingDirectories(binDir: string): void {
	for (const entry of readdirSync(binDir)) {
		const owner = /^\.git-staging-(\d+)-/.exec(entry)?.[1];
		if (owner !== undefined && !isProcessAlive(Number(owner)))
			rmSync(join(binDir, entry), { recursive: true, force: true });
	}
}

async function downloadGitArchive(target: GitDistributionTarget, signal: AbortSignal): Promise<Buffer> {
	const startedAt = Date.now();
	const timeout = AbortSignal.timeout(gitProvisionSettings.downloadTimeoutMs);
	try {
		const response = await fetchWithRetry(target.url, {
			headers: { "User-Agent": getPiUserAgent(VERSION) },
			signal: AbortSignal.any([signal, timeout]),
		});
		if (!response.ok)
			throw new GitUnavailableError({
				code: "download-failed",
				asset: target.asset,
				url: target.url,
				httpStatus: response.status,
				...hostPlatform(),
			});
		return Buffer.from(await response.arrayBuffer());
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (timeout.aborted)
			throw new GitProvisionTimeoutError(
				{ phase: "download", timeoutMs: gitProvisionSettings.downloadTimeoutMs, elapsedMs: Date.now() - startedAt },
				{ cause: error },
			);
		if (isGitProvisionError(error)) throw error;
		throw new GitUnavailableError(
			{ code: "download-failed", asset: target.asset, url: target.url, ...hostPlatform() },
			{ cause: error },
		);
	}
}

type BoundedRunResult =
	| { readonly ok: true; readonly stdout: string }
	| { readonly ok: false; readonly detail: string };

function firstLine(text: string): string {
	return text.trim().split(/\r?\n/, 1)[0]!.slice(0, 200);
}

/** Run a provisioning step; cancellation rejects with `signal.reason`, the time limit with a typed timeout. */
function runProvisionStep(
	command: string,
	args: readonly string[],
	options: {
		readonly signal: AbortSignal;
		readonly timeoutMs: number;
		readonly phase: GitProvisionPhase;
		readonly env: NodeJS.ProcessEnv;
	},
): Promise<BoundedRunResult> {
	const startedAt = Date.now();
	const timeout = AbortSignal.timeout(options.timeoutMs);
	return new Promise((resolvePromise, rejectPromise) => {
		execFile(
			command,
			[...args],
			{ env: options.env, maxBuffer: 16 * 1024 * 1024, signal: AbortSignal.any([options.signal, timeout]) },
			(error, stdout, stderr) => {
				if (options.signal.aborted) {
					rejectPromise(options.signal.reason);
					return;
				}
				if (timeout.aborted) {
					rejectPromise(
						new GitProvisionTimeoutError(
							{ phase: options.phase, timeoutMs: options.timeoutMs, elapsedMs: Date.now() - startedAt },
							{ cause: error },
						),
					);
					return;
				}
				if (error === null) {
					resolvePromise({ ok: true, stdout });
					return;
				}
				const status = typeof error.code === "number" ? `exited with status ${error.code}` : String(error.code);
				const reason = stderr === "" ? "" : `: ${firstLine(stderr)}`;
				resolvePromise({ ok: false, detail: `${command.split(/[\\/]/).pop()} ${status}${reason}` });
			},
		);
	});
}

function gitTarCommand(): string {
	return platform() === "win32" ? getWindowsTarCommand() : "tar";
}

async function extractGitArchive(
	archivePath: string,
	destination: string,
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	signal: AbortSignal,
): Promise<void> {
	const result = await runProvisionStep(gitTarCommand(), ["xzf", archivePath, "-C", destination], {
		signal,
		timeoutMs: gitProvisionSettings.extractTimeoutMs,
		phase: "extract",
		env: createChildProcessEnvironment(),
	});
	if (!result.ok) throw installFailed("extract", target, layout, undefined, result.detail);
}

/** Fail unless every path the archive lists exists in the staged tree, so an extraction that was interfered with is never published. */
async function verifyStagedEntries(
	archivePath: string,
	stagedRoot: string,
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	signal: AbortSignal,
): Promise<void> {
	const listing = await runProvisionStep(gitTarCommand(), ["tzf", archivePath], {
		signal,
		timeoutMs: gitProvisionSettings.verifyTimeoutMs,
		phase: "verify",
		env: createChildProcessEnvironment(),
	});
	if (!listing.ok) throw installFailed("verify", target, layout, undefined, listing.detail);
	const missing = listing.stdout
		.split(/\r?\n/)
		.filter((entry) => lstatSync(join(stagedRoot, entry), { throwIfNoEntry: false }) === undefined);
	if (missing.length > 0)
		throw installFailed(
			"verify",
			target,
			layout,
			undefined,
			`${missing.length} archive entries are missing from the staged tree, including ${missing[0]}`,
		);
}

async function verifyGitDistribution(
	staged: GitDistributionLayout,
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	signal: AbortSignal,
): Promise<string> {
	if (!existsSync(staged.executable))
		throw installFailed(
			"verify",
			target,
			layout,
			undefined,
			`${relative(staged.root, staged.executable)} is missing from the archive`,
		);
	const result = await runProvisionStep(staged.executable, ["--version"], {
		signal,
		timeoutMs: gitProvisionSettings.verifyTimeoutMs,
		phase: "verify",
		env: createGitEnvironment(portableGitEnv(staged, process.env), createChildProcessEnvironment()),
	});
	if (!result.ok) throw installFailed("verify", target, layout, undefined, result.detail);
	const version = parseGitVersion(result.stdout);
	if (version === undefined)
		throw installFailed("verify", target, layout, undefined, "git --version printed no version");
	return version;
}

/** Publish the staged distribution with one rename. A healthy install published first by another process wins. */
function promoteGitDistribution(
	stagedRoot: string,
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
): string | undefined {
	try {
		renameSync(stagedRoot, layout.root);
		return undefined;
	} catch (error) {
		if (!existsSync(layout.root)) throw installFailed("promote", target, layout, error);
	}
	const existing = probeProvisionedGit(layout);
	if (existing !== undefined) return existing;
	try {
		rmSync(layout.root, { recursive: true, force: true });
		renameSync(stagedRoot, layout.root);
		return undefined;
	} catch (error) {
		throw installFailed("promote", target, layout, error);
	}
}

function describeSystemGitForStatus(system: SystemGitProbe): string {
	if (system?.kind !== "rejected") return "git not found.";
	return system.rejected.problem === "below-minimum"
		? `git ${system.rejected.version} at ${system.rejected.path} is older than ${GIT_MINIMUM_VERSION}.`
		: `git at ${system.rejected.path} did not report a usable version.`;
}

async function installGitDistribution(
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	system: SystemGitProbe,
	signal: AbortSignal,
	emit: (status: ToolStatus) => void,
): Promise<string> {
	const binDir = dirname(layout.root);
	try {
		mkdirSync(binDir, { recursive: true });
	} catch (error) {
		throw installFailed("stage", target, layout, error);
	}
	const lock = await acquireGitInstallLock(target, layout, signal, emit);
	if (lock.kind === "installed") return lock.version;
	let primary: unknown;
	try {
		const existing = probeProvisionedGit(layout);
		if (existing !== undefined) return existing;
		return await installUnderLock(target, layout, system, signal, emit);
	} catch (error) {
		primary = error;
		throw error;
	} finally {
		const compromised = lock.compromised();
		try {
			if (compromised === undefined) await lock.release();
		} catch (releaseError) {
			if (primary === undefined)
				emit({
					type: "warning",
					message: `Could not release the git install lock: ${firstLine(String(releaseError))}`,
				});
			else attachGitCleanupFailure(primary, releaseError);
		}
	}
}

async function installUnderLock(
	target: GitDistributionTarget,
	layout: GitDistributionLayout,
	system: SystemGitProbe,
	signal: AbortSignal,
	emit: (status: ToolStatus) => void,
): Promise<string> {
	const binDir = dirname(layout.root);
	let staging: string;
	try {
		removeAbandonedStagingDirectories(binDir);
		staging = mkdtempSync(join(binDir, `${GIT_STAGING_PREFIX}${process.pid}-`));
	} catch (error) {
		throw installFailed("stage", target, layout, error);
	}
	let primary: unknown;
	try {
		emit({
			type: "info",
			message: `${describeSystemGitForStatus(system)} Downloading portable git ${gitProvisionSettings.release.version}...`,
		});
		const archive = await downloadGitArchive(target, signal);
		const actualSha256 = createHash("sha256").update(archive).digest("hex");
		if (actualSha256 !== target.sha256)
			throw new GitUnavailableError({
				code: "checksum-mismatch",
				asset: target.asset,
				url: target.url,
				expectedSha256: target.sha256,
				actualSha256,
				...hostPlatform(),
			});
		const archivePath = join(staging, target.asset);
		const stagedRoot = join(staging, "git");
		try {
			await writeFile(archivePath, archive);
			mkdirSync(stagedRoot);
		} catch (error) {
			throw installFailed("stage", target, layout, error);
		}
		await extractGitArchive(archivePath, stagedRoot, target, layout, signal);
		const stagedLayout = gitLayout(stagedRoot, platform(), arch());
		const version = await verifyGitDistribution(stagedLayout, target, layout, signal);
		await verifyStagedEntries(archivePath, stagedRoot, target, layout, signal);
		signal.throwIfAborted();
		const winner = promoteGitDistribution(stagedRoot, target, layout);
		if (winner !== undefined) return winner;
		provisionedGitVersions.set(layout.executable, version);
		emit({ type: "info", message: `git ${version} installed to ${layout.root}` });
		return version;
	} catch (error) {
		primary = error;
		throw error;
	} finally {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch (cleanupError) {
			if (primary === undefined)
				emit({
					type: "warning",
					message: `Could not remove the git staging directory ${staging}: ${firstLine(String(cleanupError))}`,
				});
			else attachGitCleanupFailure(primary, cleanupError);
		}
	}
}
