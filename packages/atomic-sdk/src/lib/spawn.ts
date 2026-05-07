/**
 * Shared spawn utilities for postinstall and lifecycle scripts.
 *
 * Provides a thin async wrapper around Bun.spawn and a PATH-prepend helper,
 * eliminating duplication across postinstall-playwright, postinstall-liteparse, etc.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface SpawnResult {
  success: boolean;
  details: string;
  stdout?: string;
  stderr?: string;
}

export interface RunCommandOptions {
  /** When true, stdout/stderr are inherited so the user sees live output. */
  inherit?: boolean;
}

/**
 * Run a command asynchronously and collect its output.
 * Returns a result object instead of throwing on failure.
 *
 * When `inherit` is true, output streams directly to the terminal so the
 * user can follow installation progress in real time.
 */
export async function runCommand(cmd: string[], options?: RunCommandOptions): Promise<SpawnResult> {
  try {
    if (options?.inherit) {
      const proc = Bun.spawn({
        cmd,
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
      const exitCode = await proc.exited;
      return { success: exitCode === 0, details: "" };
    }

    const proc = Bun.spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const [stderr, stdout, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const trimmedStdout = stdout.trim();
    const trimmedStderr = stderr.trim();
    return {
      success: exitCode === 0,
      details: trimmedStderr.length > 0 ? trimmedStderr : trimmedStdout,
      stdout: trimmedStdout,
      stderr: trimmedStderr,
    };
  } catch (error) {
    return {
      success: false,
      details: error instanceof Error ? error.message : String(error),
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Prepend a directory to the PATH environment variable (if not already present).
 */
export function prependPath(directory: string): void {
  const pathDelimiter = process.platform === "win32" ? ";" : ":";
  const currentPath = process.env.PATH ?? "";
  const entries = currentPath.split(pathDelimiter);
  const alreadyPresent = process.platform === "win32"
    ? entries.some((entry) => entry.toLowerCase() === directory.toLowerCase())
    : entries.includes(directory);
  if (!alreadyPresent) {
    process.env.PATH = directory + pathDelimiter + currentPath;
  }
}

function windowsAtomicBinDir(): string {
  return join(getHomeDir(), ".atomic", "bin");
}

export function resolveCommandFromCurrentPath(cmd: string): string | null {
  return Bun.which(cmd, { PATH: process.env.PATH ?? "" });
}

export type MuxBinaryName = "tmux" | "psmux" | "pmux";

export function requiredMuxBinaryCandidatesForPlatform(
  platform: NodeJS.Platform = process.platform,
): MuxBinaryName[] {
  return platform === "win32" ? ["psmux", "pmux"] : ["tmux"];
}

export function isMuxBinaryRequiredForPlatform(
  binary: MuxBinaryName,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return requiredMuxBinaryCandidatesForPlatform(platform).includes(binary);
}

export function hasRequiredMuxBinary(): boolean {
  return requiredMuxBinaryCandidatesForPlatform().some(
    (candidate) => resolveCommandFromCurrentPath(candidate),
  );
}

function prependPathIfDirectory(directory: string | undefined): void {
  if (!directory || !existsSync(directory)) return;
  prependPath(directory);
}

function prependWindowsMuxInstallPaths(): void {
  if (process.platform !== "win32") return;

  const home = getHomeDir();
  prependPathIfDirectory(
    process.env.SCOOP ? join(process.env.SCOOP, "shims") : undefined,
  );
  prependPathIfDirectory(home ? join(home, "scoop", "shims") : undefined);
  prependPathIfDirectory(
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
      : undefined,
  );
  prependPathIfDirectory(
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps")
      : undefined,
  );
  prependPathIfDirectory(
    process.env.ChocolateyInstall
      ? join(process.env.ChocolateyInstall, "bin")
      : undefined,
  );
  prependPathIfDirectory("C:\\ProgramData\\chocolatey\\bin");
  prependPathIfDirectory(home ? join(home, ".cargo", "bin") : undefined);
  prependPathIfDirectory(windowsAtomicBinDir());
}

function prependBunInstallPaths(): void {
  const home = getHomeDir();
  prependPathIfDirectory(process.env.BUN_INSTALL_BIN);
  prependPathIfDirectory(
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin") : undefined,
  );
  prependPathIfDirectory(home ? join(home, ".bun", "bin") : undefined);

  if (process.platform !== "win32") return;

  prependPathIfDirectory(
    process.env.SCOOP ? join(process.env.SCOOP, "shims") : undefined,
  );
  prependPathIfDirectory(home ? join(home, "scoop", "shims") : undefined);
  prependPathIfDirectory(
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
      : undefined,
  );
  prependPathIfDirectory(
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps")
      : undefined,
  );
}

function mergePath(pathValue: string): void {
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const entry of pathValue.split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed) prependPath(trimmed);
  }
}

async function refreshWindowsPathFromRegistry(): Promise<void> {
  if (process.platform !== "win32") return;

  const shell = resolveCommandFromCurrentPath("powershell") ??
    resolveCommandFromCurrentPath("pwsh");
  if (!shell) return;

  const readRegistryPath =
    "$paths = @([Environment]::GetEnvironmentVariable('Path','Process'), " +
    "[Environment]::GetEnvironmentVariable('Path','User'), " +
    "[Environment]::GetEnvironmentVariable('Path','Machine')) | " +
    "Where-Object { $_ }; $paths -join ';'";

  const result = await runCommand([
    shell,
    "-NoProfile",
    "-Command",
    readRegistryPath,
  ]);
  if (result.success && result.stdout) {
    mergePath(result.stdout);
  }
}

async function refreshWindowsMuxPath(): Promise<void> {
  prependWindowsMuxInstallPaths();
  await refreshWindowsPathFromRegistry();
  prependWindowsMuxInstallPaths();
}

async function refreshWindowsBunPath(): Promise<void> {
  prependBunInstallPaths();
  await refreshWindowsPathFromRegistry();
  prependBunInstallPaths();
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  assets: GitHubReleaseAsset[];
}

export function psmuxReleaseAssetSuffix(
  arch: NodeJS.Architecture = process.arch,
): string | null {
  switch (arch) {
    case "x64":
      return "windows-x64.zip";
    case "ia32":
      return "windows-x86.zip";
    case "arm64":
      return "windows-arm64.zip";
    default:
      return null;
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function persistWindowsUserPath(directory: string): Promise<SpawnResult> {
  const shell = resolveCommandFromCurrentPath("powershell") ??
    resolveCommandFromCurrentPath("pwsh");
  if (!shell) return { success: true, details: "" };

  const script =
    `$dir = ${powershellLiteral(directory)}; ` +
    "$current = [Environment]::GetEnvironmentVariable('Path','User'); " +
    "$entries = if ([string]::IsNullOrWhiteSpace($current)) { @() } else { $current -split ';' }; " +
    "$expandedDir = [Environment]::ExpandEnvironmentVariables($dir) -replace '[\\\\/]+$',''; " +
    "$hasDir = $false; " +
    "foreach ($entry in $entries) { " +
    "  $expandedEntry = [Environment]::ExpandEnvironmentVariables($entry).Trim().Trim('\"') -replace '[\\\\/]+$',''; " +
    "  if ($expandedEntry -ieq $expandedDir) { $hasDir = $true; break } " +
    "} " +
    "if (-not $hasDir) { " +
    "  $next = (@($entries) + @($dir) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ';'; " +
    "  [Environment]::SetEnvironmentVariable('Path', $next, 'User'); " +
    "}";

  return runCommand([shell, "-NoProfile", "-Command", script]);
}

async function installPsmuxFromGitHubRelease(): Promise<SpawnResult> {
  try {
    const suffix = psmuxReleaseAssetSuffix();
    if (!suffix) {
      return {
        success: false,
        details: `No psmux release asset is available for ${process.arch}.`,
      };
    }

    const response = await fetch(
      "https://api.github.com/repos/psmux/psmux/releases/latest",
      { headers: { "Accept": "application/vnd.github+json" } },
    );
    if (!response.ok) {
      return {
        success: false,
        details: `Could not fetch latest psmux release: ${response.status} ${response.statusText}`,
      };
    }

    const release = await response.json() as GitHubRelease;
    const asset = release.assets.find((item) => item.name.endsWith(suffix));
    if (!asset) {
      return {
        success: false,
        details: `Latest psmux release does not include a ${suffix} asset.`,
      };
    }

    const archiveResponse = await fetch(asset.browser_download_url);
    if (!archiveResponse.ok) {
      return {
        success: false,
        details: `Could not download ${asset.name}: ${archiveResponse.status} ${archiveResponse.statusText}`,
      };
    }

    const tempDir = mkdtempSync(join(tmpdir(), "atomic-psmux-"));
    const zipPath = join(tempDir, asset.name);
    const extractDir = join(tempDir, "extract");
    const installDir = windowsAtomicBinDir();

    try {
      await Bun.write(zipPath, await archiveResponse.arrayBuffer());
      mkdirSync(extractDir, { recursive: true });
      mkdirSync(installDir, { recursive: true });

      const shell = resolveCommandFromCurrentPath("powershell") ??
        resolveCommandFromCurrentPath("pwsh");
      if (!shell) {
        return {
          success: false,
          details: "PowerShell is required to expand the psmux release archive.",
        };
      }

      const expand = await runCommand([
        shell,
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${powershellLiteral(zipPath)} -DestinationPath ${powershellLiteral(extractDir)} -Force`,
      ]);
      if (!expand.success) return expand;

      for (const binary of ["psmux.exe", "pmux.exe", "tmux.exe"]) {
        const source = join(extractDir, binary);
        if (existsSync(source)) {
          copyFileSync(source, join(installDir, binary));
        }
      }

      prependPath(installDir);
      const persistResult = await persistWindowsUserPath(installDir);
      if (!persistResult.success) return persistResult;

      return hasRequiredMuxBinary()
        ? { success: true, details: "" }
        : {
            success: false,
            details: `Downloaded psmux but no psmux binary was found in ${installDir}.`,
          };
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  } catch (error) {
    return {
      success: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the user's home directory.
 * Uses Node.js os.homedir() which handles cross-platform resolution
 * (HOME on Unix, USERPROFILE on Windows, and fallback to passwd on Linux).
 */
export function getHomeDir(): string {
  return homedir();
}

/**
 * Options for the user-facing ensure* installers.
 *
 * `quiet: true` captures subprocess output instead of streaming it to the
 * terminal, so a higher-level spinner UI (see auto-sync's `runSteps`) can
 * own the display. Failures collected in the captured buffer are thrown
 * out of the ensure* function so the spinner can mark the step red and
 * surface the captured tail in its summary.
 *
 * Default (`quiet: false`) preserves the historical inherit-stdout
 * behavior used by the ad-hoc fallbacks in chat.ts / workflow.ts.
 */
export interface EnsureOptions {
  quiet?: boolean;
}

/**
 * Install one or more global packages via a single `bun install -g` call.
 * Uses `--trust` to allow postinstall lifecycle scripts (required by
 * packages like @playwright/cli).
 *
 * Combining multiple packages into one invocation is important: Bun's
 * global linker is not safe to run concurrently — two parallel
 * `bun install -g` processes race to create the same symlinks in the
 * shared global store, causing EEXIST errors for transitive deps that
 * both packages (or the already-installed @bastani/atomic) share.
 */
export async function upgradeGlobalPackages(pkgs: string[]): Promise<void> {
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    throw new Error(`bun is not available to install ${pkgs.join(", ")}.`);
  }
  const versioned = pkgs.map((p) => (p.includes("@latest") ? p : `${p}@latest`));
  const result = await runCommand([bunPath, "install", "-g", "--trust", ...versioned]);
  if (!result.success) {
    throw new Error(`Failed to install ${pkgs.join(", ")}: ${result.details}`);
  }
}

/** Upgrade @playwright/cli, @llamaindex/liteparse, and @ast-grep/cli globally in one pass. */
export async function upgradeGlobalToolPackages(): Promise<void> {
  return upgradeGlobalPackages([
    "@playwright/cli",
    "@llamaindex/liteparse",
    "@ast-grep/cli",
  ]);
}

/**
 * Ensure a terminal multiplexer (tmux on Unix, psmux on Windows) is installed.
 * No-op when already present on PATH.
 *
 * When `quiet: true`, subprocess output is captured instead of inherited
 * so an outer spinner UI owns the display. On failure the captured tail
 * is re-thrown as the error message.
 */
export async function ensureTmuxInstalled(options: EnsureOptions = {}): Promise<void> {
  const quiet = options.quiet ?? false;
  const inherit = !quiet;

  // Check for the platform-native multiplexer binary.
  if (hasRequiredMuxBinary()) return;

  let capturedDetails = "";
  const record = (result: SpawnResult) => {
    if (!result.success && result.details) {
      capturedDetails = result.details;
    }
  };

  if (process.platform === "win32") {
    // Windows: install psmux
    const winget = resolveCommandFromCurrentPath("winget");
    if (winget) {
      const result = await runCommand([
        winget,
        "install",
        "--id",
        "marlocarlo.psmux",
        "--exact",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ], { inherit });
      record(result);
      if (result.success) {
        await refreshWindowsMuxPath();
        if (hasRequiredMuxBinary()) return;
      }
    }

    const scoop = resolveCommandFromCurrentPath("scoop");
    if (scoop) {
      await runCommand([scoop, "bucket", "add", "psmux", "https://github.com/psmux/scoop-psmux"], { inherit });
      const result = await runCommand([scoop, "install", "psmux"], { inherit });
      record(result);
      if (result.success) {
        await refreshWindowsMuxPath();
        if (hasRequiredMuxBinary()) return;
      }
    }

    const choco = resolveCommandFromCurrentPath("choco");
    if (choco) {
      const result = await runCommand([choco, "install", "psmux", "-y", "--no-progress"], { inherit });
      record(result);
      if (result.success) {
        await refreshWindowsMuxPath();
        if (hasRequiredMuxBinary()) return;
      }
    }

    const cargo = resolveCommandFromCurrentPath("cargo");
    if (cargo) {
      const result = await runCommand([cargo, "install", "psmux"], { inherit });
      record(result);
      if (result.success) {
        const home = getHomeDir();
        if (home) prependPath(join(home, ".cargo", "bin"));
        await refreshWindowsMuxPath();
        if (hasRequiredMuxBinary()) return;
      }
    }

    const directResult = await installPsmuxFromGitHubRelease();
    record(directResult);
    if (directResult.success) return;

    throw new Error(
      capturedDetails || "Could not install psmux automatically.",
    );
  }

  // Unix / macOS
  if (process.platform === "darwin") {
    const brew = resolveCommandFromCurrentPath("brew");
    if (brew) {
      const result = await runCommand([brew, "install", "tmux"], { inherit });
      record(result);
      if (result.success && resolveCommandFromCurrentPath("tmux")) return;
    }
  }

  // Linux package managers
  const shell = Bun.which("bash") ?? Bun.which("sh");
  if (!shell) {
    throw new Error("Neither bash nor sh is available to install tmux.");
  }

  // Drop `sudo` when we're already root or `sudo` isn't on PATH. Slim
  // container images (`node:lts-alpine`, `node:slim`, distroless variants)
  // run as uid 0 with no sudo installed, so `sudo apk add tmux` would fail
  // with `sudo: command not found` before ever reaching the package manager.
  const isRoot = process.getuid?.() === 0;
  const sudo = isRoot || !resolveCommandFromCurrentPath("sudo") ? "" : "sudo ";

  const managers: string[] = [
    `command -v apt-get >/dev/null 2>&1 && ${sudo}apt-get update -qq && ${sudo}apt-get install -y tmux`,
    `command -v dnf >/dev/null 2>&1 && ${sudo}dnf install -y tmux`,
    `command -v yum >/dev/null 2>&1 && ${sudo}yum install -y tmux`,
    `command -v pacman >/dev/null 2>&1 && ${sudo}pacman -Sy --noconfirm tmux`,
    `command -v zypper >/dev/null 2>&1 && ${sudo}zypper --non-interactive install tmux`,
    `command -v apk >/dev/null 2>&1 && ${sudo}apk add --no-cache tmux`,
  ];

  for (const script of managers) {
    record(await runCommand([shell, "-lc", script], { inherit }));
    if (resolveCommandFromCurrentPath("tmux")) return;
  }

  throw new Error(
    capturedDetails || "Could not install tmux — no supported package manager succeeded.",
  );
}

/**
 * Ensure bun is installed and available on PATH.
 * No-op when already present.
 */
export async function ensureBunInstalled(): Promise<void> {
  if (resolveCommandFromCurrentPath("bun")) return;

  if (process.platform === "win32") {
    // Windows
    const winget = resolveCommandFromCurrentPath("winget");
    if (winget) {
      const result = await runCommand([winget, "install", "Oven-sh.Bun", "--accept-source-agreements", "--accept-package-agreements"], { inherit: true });
      if (result.success) {
        await refreshWindowsBunPath();
        if (resolveCommandFromCurrentPath("bun")) return;
      }
    }

    const scoop = resolveCommandFromCurrentPath("scoop");
    if (scoop) {
      const result = await runCommand([scoop, "install", "bun"], { inherit: true });
      if (result.success) {
        await refreshWindowsBunPath();
        if (resolveCommandFromCurrentPath("bun")) return;
      }
    }

    const shell = resolveCommandFromCurrentPath("powershell") ??
      resolveCommandFromCurrentPath("pwsh");
    if (shell) {
      const result = await runCommand([
        shell,
        "-NoProfile",
        "-Command",
        "irm bun.sh/install.ps1 | iex",
      ], { inherit: true });
      if (result.success) {
        await refreshWindowsBunPath();
        if (resolveCommandFromCurrentPath("bun")) return;
      }
    }

    throw new Error("Could not install bun automatically.");
  }

  // Unix / macOS
  const shell = resolveCommandFromCurrentPath("bash") ??
    resolveCommandFromCurrentPath("sh");
  if (shell) {
    const result = await runCommand(
      [shell, "-lc", "curl -fsSL https://bun.sh/install | bash"],
      { inherit: true },
    );
    if (result.success) {
      prependBunInstallPaths();
      if (resolveCommandFromCurrentPath("bun")) return;
    }
  }

  // macOS Homebrew fallback
  if (process.platform === "darwin") {
    const brew = resolveCommandFromCurrentPath("brew");
    if (brew) {
      const result = await runCommand([brew, "install", "oven-sh/bun/bun"], { inherit: true });
      if (result.success) {
        prependBunInstallPaths();
        if (resolveCommandFromCurrentPath("bun")) return;
      }
    }
  }

  throw new Error("Could not install bun automatically.");
}

/**
 * Ensure tmux/psmux is installed. Used as a ToolingStep in the update pipeline.
 * Does not attempt version upgrades — just ensures the tool exists.
 */
export async function upgradeTmux(): Promise<void> {
  await ensureTmuxInstalled();
}

/**
 * Upgrade bun to the latest version, or install if missing.
 */
export async function upgradeBun(): Promise<void> {
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    await ensureBunInstalled();
    return;
  }
  const result = await runCommand([bunPath, "upgrade"]);
  if (!result.success) {
    throw new Error(`bun upgrade failed: ${result.details}`);
  }
}

// ---------------------------------------------------------------------------
// Shared tooling-setup helpers (used by postinstall and update commands)
// ---------------------------------------------------------------------------

export class ToolingSetupError extends Error {
  constructor(public readonly failures: string[]) {
    const list = failures.map((f) => `  - ${f}`).join("\n");
    super(
      `Tooling setup failed:\n${list}\n\n` +
      `Re-run \`bun install\` to retry, or install the failed tools manually.`,
    );
    this.name = "ToolingSetupError";
  }
}

export interface ToolingStep {
  label: string;
  fn: () => Promise<unknown>;
}

export function collectFailures(
  steps: ToolingStep[],
  results: PromiseSettledResult<unknown>[],
): string[] {
  const failures: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === "rejected") {
      const reason = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
      const label = steps[i]?.label ?? `step ${i}`;
      failures.push(`${label}: ${reason}`);
    }
  }
  return failures;
}
