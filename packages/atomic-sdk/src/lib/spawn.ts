/**
 * Shared spawn utilities for postinstall and lifecycle scripts.
 *
 * Provides a thin async wrapper around Bun.spawn and a PATH-prepend helper,
 * eliminating duplication across postinstall-playwright, postinstall-liteparse, etc.
 */

import {
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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


export function resolveCommandFromCurrentPath(cmd: string): string | null {
  return Bun.which(cmd, { PATH: process.env.PATH ?? "" });
}


function prependPathIfDirectory(directory: string | undefined): void {
  if (!directory || !existsSync(directory)) return;
  prependPath(directory);
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

async function refreshWindowsBunPath(): Promise<void> {
  prependBunInstallPaths();
  await refreshWindowsPathFromRegistry();
  prependBunInstallPaths();
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
 * Ensure uv (and uvx) is installed and available on PATH.
 * No-op when already present.
 *
 * When `quiet: true`, subprocess output is captured instead of inherited
 * so an outer spinner UI owns the display. On failure the captured tail
 * is re-thrown as the error message.
 */
export async function ensureUvInstalled(options: EnsureOptions = {}): Promise<void> {
  if (hasUv()) return;

  const inherit = !(options.quiet ?? false);
  const installCmd = process.platform === "win32"
    ? ["powershell", "-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"]
    : ["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"];

  const result = await runCommand(installCmd, { inherit });
  if (result.success) {
    if (process.platform === "win32") {
      await refreshWindowsUvPath();
    } else {
      prependUvInstallPaths();
    }
  }

  if (hasUv()) return;

  // Install command exited successfully but the binary still isn't on PATH —
  // surface the canonical install locations so the user can either add the
  // right one to their shell profile or set UV_INSTALL_DIR. See
  // https://docs.astral.sh/uv/reference/installer/ and
  // https://docs.astral.sh/uv/reference/storage/#executable-directory.
  const candidates = uvInstallPathCandidates();
  const candidateList = candidates.length > 0
    ? candidates.map((p) => `  - ${p}`).join("\n")
    : "  (no candidate paths resolved; set $HOME or $UV_INSTALL_DIR)";
  const shellHint = process.platform === "win32"
    ? "[Environment]::SetEnvironmentVariable('Path', \"$env:USERPROFILE\\.local\\bin;$env:Path\", 'User')"
    : "export PATH=\"$HOME/.local/bin:$PATH\"   # add to ~/.bashrc, ~/.zshrc, etc.";

  throw new Error(
    [
      result.details || "uv install completed but binary not found on PATH.",
      "",
      "Looked for `uv` / `uvx` in:",
      candidateList,
      "",
      "Add the directory containing `uv` to your PATH, or re-run the",
      "installer with UV_INSTALL_DIR set to a directory already on PATH.",
      "",
      `Shell example: ${shellHint}`,
    ].join("\n"),
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
