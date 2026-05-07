/**
 * `atomic install` — self-installation entry point.
 *
 * Modeled on Claude Code's `claude install` subcommand: the bootstrap
 * scripts (install.ps1 / install.cmd / install.sh) download a verified
 * binary into a temp dir and then invoke the binary with `install` as
 * its only argument. This subcommand performs the actual placement,
 * PATH wiring, mux-binary discovery, and completions setup.
 *
 *   download → verify → run `<temp>/atomic install`
 *                          ├─ copy self → install dir
 *                          ├─ persist install dir to user PATH
 *                          ├─ detect tmux/psmux; persist its dir if found
 *                          ├─ write completions cache + rc-file source line
 *                          └─ print summary
 *
 * Idempotent: re-running is safe and will reconcile drift (missing
 * completions cache, PATH entries removed, etc.).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, appendFileSync, chmodSync, unlinkSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { detectInstallMethod, type InstallMethod } from "./install-method.ts";
import {
    bashCompletionScript,
    zshCompletionScript,
    fishCompletionScript,
    powershellCompletionScript,
    type Shell,
} from "../../completions/index.ts";

const COMPLETION_SCRIPTS: Record<Shell, string> = {
    bash: bashCompletionScript,
    zsh: zshCompletionScript,
    fish: fishCompletionScript,
    powershell: powershellCompletionScript,
};

export const RC_MARKER = "# Atomic CLI completions (cached)";
export const PATH_RC_MARKER = "# Atomic CLI PATH";

export interface InstallOptions {
    /** Skip the shell-completions step. */
    readonly noCompletions?: boolean;
}

interface InstallPaths {
    readonly binDir: string;
    readonly binPath: string;
    readonly completionsDir: string;
}

function isWindows(): boolean {
    return osPlatform() === "win32";
}

export function getInstallPaths(): InstallPaths {
    if (isWindows()) {
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        const binDir = join(localAppData, "atomic", "bin");
        return {
            binDir,
            binPath: join(binDir, "atomic.exe"),
            completionsDir: join(homedir(), ".atomic", "completions"),
        };
    }
    const binDir = join(homedir(), ".local", "bin");
    return {
        binDir,
        binPath: join(binDir, "atomic"),
        completionsDir: join(homedir(), ".atomic", "completions"),
    };
}

// ── Self-copy ──────────────────────────────────────────────────────────────

/**
 * Copy the running binary (process.execPath) into the install dir.
 *
 * Atomic move pattern (mirroring Claude Code's installer.ts
 * `atomicMoveToInstallPath`): copy to a per-process temp file next
 * to the final path, chmod, then rename. Direct rename from the
 * source would EXDEV across filesystems; copy-then-rename is portable.
 * A crash mid-install leaves a `.tmp.<pid>.<ts>` orphan rather than a
 * half-written binary at the target path — the orphan is reaped by
 * `cleanupOldArtifacts()` at the end of the next install.
 *
 * Windows can't delete or overwrite a running .exe, so any existing
 * binary at the destination is renamed to `atomic.exe.old.<ts>`
 * before the new one rolls in. Stale `.old.*` files are reaped on
 * next install.
 */
function copyBinary(paths: InstallPaths): void {
    const source = process.execPath;
    const sourceResolved = resolve(source);
    const destResolved = resolve(paths.binPath);

    if (sourceResolved.toLowerCase() === destResolved.toLowerCase()) {
        // Already running from the install location (e.g. user re-ran
        // `atomic install` after a previous install). Nothing to copy.
        return;
    }

    if (!existsSync(paths.binDir)) {
        mkdirSync(paths.binDir, { recursive: true });
    }

    if (isWindows() && existsSync(paths.binPath)) {
        const archivedPath = `${paths.binPath}.old.${Date.now()}`;
        try {
            renameSync(paths.binPath, archivedPath);
        } catch (err) {
            throw new Error(
                `Failed to archive existing atomic.exe at ${paths.binPath}: ${(err as Error).message}. ` +
                "If atomic is currently running, close it and retry.",
            );
        }
    }

    const tempPath = `${paths.binPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        copyFileSync(source, tempPath);
        if (!isWindows()) {
            chmodSync(tempPath, 0o755);
        }
        renameSync(tempPath, paths.binPath);
    } catch (err) {
        // Best-effort temp cleanup so a failed install doesn't leave
        // garbage behind for the reaper to find.
        try { unlinkSync(tempPath); } catch { /* ignore */ }
        throw err;
    }
}

// ── Reaper ─────────────────────────────────────────────────────────────────

/**
 * Reap leftover install artifacts. Mirrors the relevant parts of Claude
 * Code's `cleanupOldVersions()`:
 *
 *   - `atomic.exe.old.<digits>` — Windows running-exe archives left
 *     behind when a previous install renamed-then-copied. Once the
 *     archived process exits, Windows releases the file handle and
 *     we can unlink it on the next install.
 *   - `<binPath>.tmp.<pid>.<ts>` — orphan atomic-move temps from a
 *     prior crashed install. We only unlink temps older than 1 hour
 *     so we don't race a concurrent install that's still mid-copy.
 *
 * Best-effort: any failure is logged at debug level and swallowed —
 * leftover artifacts are cosmetic, not load-bearing.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;
const OLD_BINARY_PATTERN = /^atomic(?:\.exe)?\.old\.\d+$/;
const TMP_INSTALL_PATTERN = /^atomic(?:\.exe)?\.tmp\.\d+\.\d+$/;

export interface CleanupResult {
    readonly oldBinariesRemoved: number;
    readonly tempFilesRemoved: number;
}

export function cleanupOldArtifacts(binDir: string, now: number = Date.now()): CleanupResult {
    let oldBinariesRemoved = 0;
    let tempFilesRemoved = 0;

    let entries: string[];
    try {
        entries = readdirSync(binDir);
    } catch {
        return { oldBinariesRemoved, tempFilesRemoved };
    }

    for (const entry of entries) {
        const entryPath = join(binDir, entry);

        if (OLD_BINARY_PATTERN.test(entry)) {
            // The original process that locked this file may have exited;
            // try unlink. On Windows, if the handle is still held, EBUSY
            // is non-fatal — we'll catch it again next install.
            try {
                unlinkSync(entryPath);
                oldBinariesRemoved++;
            } catch { /* still locked or gone — ignore */ }
            continue;
        }

        if (TMP_INSTALL_PATTERN.test(entry)) {
            // 1-hour threshold matches Claude Code's reaper. Avoids racing
            // a concurrent install whose temp is still in flight.
            try {
                const stats = statSync(entryPath);
                if (now - stats.mtime.getTime() > ONE_HOUR_MS) {
                    unlinkSync(entryPath);
                    tempFilesRemoved++;
                }
            } catch { /* ignore */ }
            continue;
        }
    }

    return { oldBinariesRemoved, tempFilesRemoved };
}

// ── Persistent PATH writes ─────────────────────────────────────────────────

export function pathContains(pathValue: string, dir: string, sep: string): boolean {
    if (!pathValue) return false;
    const normalized = isWindows() ? dir.toLowerCase() : dir;
    return pathValue.split(sep).some((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return false;
        return (isWindows() ? trimmed.toLowerCase() : trimmed) === normalized;
    });
}

/**
 * Persist a directory to the user's PATH so it survives shell restarts.
 *
 * Windows: writes HKCU\Environment\Path via `[Environment]::SetEnvironmentVariable`,
 * which broadcasts WM_SETTINGCHANGE so other apps pick up the change.
 * Unix: appends an idempotent snippet to the user's shell rc files.
 *
 * Returns true if PATH was modified, false if `dir` was already on PATH.
 */
function persistPathEntry(dir: string): boolean {
    if (isWindows()) {
        return persistWindowsPath(dir);
    }
    return persistUnixPath(dir);
}

function persistWindowsPath(dir: string): boolean {
    // Read current user PATH from registry (not from process.env, which
    // mixes machine + user PATH and adds session-local entries).
    const readScript = `[Environment]::GetEnvironmentVariable('Path', 'User')`;
    const current = runPowerShell(readScript);
    if (current === null) {
        throw new Error("Could not read user PATH from registry");
    }

    if (pathContains(current, dir, ";")) {
        return false;
    }

    const newValue = current && !current.endsWith(";") ? `${current};${dir}` : `${current}${dir}`;
    // Use a here-string + base64 to dodge PowerShell quoting hazards.
    const writeScript = `[Environment]::SetEnvironmentVariable('Path', $env:_ATOMIC_NEW_PATH, 'User')`;
    const result = runPowerShell(writeScript, { _ATOMIC_NEW_PATH: newValue });
    if (result === null) {
        throw new Error(`Could not write user PATH to registry (tried to add ${dir})`);
    }

    // Update current process so the rest of `atomic install` sees the new dir.
    process.env.PATH = `${process.env.PATH ?? ""};${dir}`;
    return true;
}

function persistUnixPath(dir: string): boolean {
    const rcFiles = userShellRcFiles();
    let modified = false;
    for (const { path: rcPath, shell } of rcFiles) {
        if (rcSnippetAlreadyPresent(rcPath, dir)) continue;
        appendPathRcSnippet(rcPath, shell, dir);
        modified = true;
    }
    // Update current process so subsequent steps see it.
    if (!pathContains(process.env.PATH ?? "", dir, ":")) {
        process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    }
    return modified;
}

interface ShellRcFile {
    readonly path: string;
    readonly shell: Shell | "sh";
}

function userShellRcFiles(): ShellRcFile[] {
    const home = homedir();
    const detected = detectUserShell();
    const files: ShellRcFile[] = [];
    if (detected === "bash" || detected === null) {
        files.push({ path: join(home, ".bashrc"), shell: "bash" });
    }
    if (detected === "zsh" || detected === null) {
        files.push({ path: join(home, ".zshrc"), shell: "zsh" });
    }
    if (detected === "fish" || detected === null) {
        files.push({ path: join(home, ".config", "fish", "config.fish"), shell: "fish" });
    }
    if (detected === null) {
        files.push({ path: join(home, ".profile"), shell: "sh" });
    }
    return files;
}

function detectUserShell(): Shell | null {
    if (isWindows()) return "powershell";
    // 1. `$SHELL` is the conventional source. Some environments leave it
    //    unset — notably the GitHub-hosted `ubuntu-24.04-arm` runner image
    //    (actions/runner-images#11414), minimal containers, and some init
    //    systems that don't run a login shell.
    const env = process.env.SHELL ?? "";
    const fromEnv = parseShellPath(env);
    if (fromEnv) return fromEnv;
    // 2. Fall back to /etc/passwd for the current user. Cheap and works
    //    even when $SHELL is empty.
    const fromPasswd = parseShellPath(loginShellFromPasswd() ?? "");
    if (fromPasswd) return fromPasswd;
    // 3. Last resort: bash. The completions cache file is harmless if the
    //    user runs a different shell — they can still source it manually.
    return "bash";
}

function parseShellPath(path: string): Shell | null {
    const base = path.split("/").pop() ?? "";
    if (base === "bash") return "bash";
    if (base === "zsh") return "zsh";
    if (base === "fish") return "fish";
    return null;
}

function loginShellFromPasswd(): string | null {
    try {
        const uid = process.getuid?.();
        if (uid === undefined) return null;
        const passwd = readFileSync("/etc/passwd", "utf8");
        for (const line of passwd.split("\n")) {
            const parts = line.split(":");
            if (parts.length < 7) continue;
            if (Number(parts[2]) === uid) return parts[6] ?? null;
        }
    } catch {
        // ignore — fall through to caller's default.
    }
    return null;
}

export function rcSnippetAlreadyPresent(rcPath: string, dir: string): boolean {
    if (!existsSync(rcPath)) return false;
    const content = readFileSync(rcPath, "utf8");
    return content.includes(PATH_RC_MARKER) && content.includes(dir);
}

export function appendPathRcSnippet(rcPath: string, shell: Shell | "sh", dir: string): void {
    if (!existsSync(rcPath)) {
        mkdirSync(dirname(rcPath), { recursive: true });
        writeFileSync(rcPath, "");
    }
    const snippet =
        shell === "fish"
            ? `\n${PATH_RC_MARKER}\nfish_add_path "${dir}"\n`
            : `\n${PATH_RC_MARKER}\ncase ":$PATH:" in\n    *":${dir}:"*) ;;\n    *) export PATH="${dir}:$PATH" ;;\nesac\n`;
    appendFileSync(rcPath, snippet);
}

type PSHost = "powershell.exe" | "pwsh.exe";

function runPowerShell(
    script: string,
    extraEnv: Record<string, string> = {},
    bin: PSHost = "powershell.exe",
): string | null {
    // Use Bun.spawnSync — same shape as node:child_process.spawnSync but
    // Bun-native, avoiding a node-compat shim hop. Wrapped in try/catch
    // because Bun.spawnSync throws ENOENT synchronously on Windows when
    // `bin` cannot be resolved on PATH (notably when `pwsh.exe` is not
    // installed and we're probing for it). Returning null lets callers
    // treat "host absent" the same as "host present but errored".
    try {
        const result = Bun.spawnSync({
            cmd: [bin, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            env: { ...process.env, ...extraEnv } as Record<string, string>,
            stdout: "pipe",
            stderr: "pipe",
        });
        if (result.exitCode !== 0) return null;
        return result.stdout.toString().replace(/\r?\n$/, "");
    } catch {
        return null;
    }
}

/**
 * Probe each PowerShell host's `$PROFILE.CurrentUserCurrentHost` and return
 * paths for whichever editions are actually present:
 *   - `powershell.exe` (Windows PowerShell 5.1) → Documents\WindowsPowerShell\...
 *   - `pwsh.exe`       (PowerShell 7+)          → Documents\PowerShell\...
 * The two paths don't overlap, so a wrapper installed under one edition is
 * invisible to the other. Probe by spawning each binary directly — `Bun.which`
 * with explicit PATHEXT handling has been unreliable from the compiled atomic
 * binary on Windows runners (returns null even when pwsh.exe is on system
 * PATH), so we just try the spawn and trust the success/failure result.
 */
function detectPSProfiles(): string[] {
    if (!isWindows()) return [];
    const paths: string[] = [];
    for (const bin of ["powershell.exe", "pwsh.exe"] as const) {
        const p = runPowerShell("$PROFILE.CurrentUserCurrentHost", {}, bin);
        if (p) paths.push(p);
    }
    return paths;
}

// ── tmux/psmux detection ───────────────────────────────────────────────────

interface MuxDetection {
    readonly binary: string | null;
    readonly directory: string | null;
    readonly onPath: boolean;
}

function detectMuxBinary(): MuxDetection {
    const candidates = isWindows() ? ["psmux", "pmux"] : ["tmux"];
    const ext = isWindows() ? ".exe" : "";

    // 1. Already on PATH?
    for (const name of candidates) {
        const found = Bun.which(name, { PATH: process.env.PATH ?? "" });
        if (found) return { binary: name, directory: dirname(found), onPath: true };
    }

    // 2. Search well-known install locations.
    const searchDirs = wellKnownMuxInstallDirs();
    for (const dir of searchDirs) {
        for (const name of candidates) {
            const candidate = join(dir, `${name}${ext}`);
            if (existsSync(candidate)) {
                return { binary: name, directory: dir, onPath: false };
            }
        }
    }

    return { binary: null, directory: null, onPath: false };
}

export function wellKnownMuxInstallDirs(): string[] {
    const home = homedir();
    if (isWindows()) {
        const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
        const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
        const dirs = [
            // Scoop
            process.env.SCOOP ? join(process.env.SCOOP, "shims") : null,
            join(home, "scoop", "shims"),
            // WinGet
            join(localAppData, "Microsoft", "WinGet", "Links"),
            // Common manual install spots
            join(programFiles, "psmux"),
            join(localAppData, "Programs", "psmux"),
            // Chocolatey
            process.env.ChocolateyInstall ? join(process.env.ChocolateyInstall, "bin") : null,
            "C:\\ProgramData\\chocolatey\\bin",
        ];
        return dirs.filter((d): d is string => d !== null);
    }
    return [
        "/opt/homebrew/bin",  // macOS Apple Silicon
        "/usr/local/bin",     // macOS Intel + Linux manual
        "/usr/bin",           // Linux distro
        "/snap/bin",          // Linux snap
        "/opt/local/bin",     // MacPorts
    ];
}

// ── Completions ────────────────────────────────────────────────────────────

interface CompletionInstall {
    readonly cachePath: string;
    readonly rcPaths: readonly string[];
    readonly shell: Shell;
}

function installCompletions(paths: InstallPaths): CompletionInstall | null {
    const shell = detectUserShell();
    if (shell === null) return null;

    if (!existsSync(paths.completionsDir)) {
        mkdirSync(paths.completionsDir, { recursive: true });
    }

    const ext: Record<Shell, string> = { bash: "bash", zsh: "zsh", fish: "fish", powershell: "ps1" };
    const cachePath = join(paths.completionsDir, `atomic.${ext[shell]}`);
    writeFileSync(cachePath, COMPLETION_SCRIPTS[shell], "utf8");

    if (shell === "fish") {
        // Fish auto-loads from ~/.config/fish/completions/, so write there directly too.
        const fishDir = join(homedir(), ".config", "fish", "completions");
        mkdirSync(fishDir, { recursive: true });
        writeFileSync(join(fishDir, "atomic.fish"), COMPLETION_SCRIPTS.fish, "utf8");
        return { cachePath, rcPaths: [], shell };
    }

    const rcPaths = completionsRcPaths(shell);
    for (const rcPath of rcPaths) {
        ensureCompletionsSourcedFromRc(rcPath, shell, cachePath);
    }
    return { cachePath, rcPaths, shell };
}

function completionsRcPaths(shell: Shell): readonly string[] {
    if (shell === "powershell") {
        return detectPSProfiles();
    }
    const home = homedir();
    if (shell === "bash") return [join(home, ".bashrc")];
    if (shell === "zsh") return [join(home, ".zshrc")];
    return [];
}

export function ensureCompletionsSourcedFromRc(rcPath: string, shell: Shell, cachePath: string): void {
    if (!existsSync(rcPath)) {
        mkdirSync(dirname(rcPath), { recursive: true });
        writeFileSync(rcPath, "");
    }
    const content = readFileSync(rcPath, "utf8");

    // Strip legacy eval-based snippet so we don't end up sourcing both.
    const legacyPattern = shell === "powershell"
        ? /atomic completions powershell \| Invoke-Expression/
        : /eval "\$\(atomic completions [a-z]+\)"/;
    if (legacyPattern.test(content)) {
        const cleaned = content
            .split("\n")
            .filter((line) => !legacyPattern.test(line) && line !== "# Atomic CLI completions")
            .join("\n");
        writeFileSync(rcPath, cleaned);
    }

    if (readFileSync(rcPath, "utf8").includes(RC_MARKER)) return;

    const snippet = shell === "powershell"
        ? `\n${RC_MARKER}\nif (Test-Path "${cachePath}") { . "${cachePath}" }\n`
        : `\n${RC_MARKER}\n[ -f "${cachePath}" ] && source "${cachePath}"\n`;
    appendFileSync(rcPath, snippet);
}

// ── Uninstall ──────────────────────────────────────────────────────────────

/**
 * Strip a marker-bracketed snippet from an rc file. Mirrors Claude Code's
 * `cleanupShellAliases` filter pattern: read lines, drop the marker line
 * plus the body that follows it (until the next blank/comment break), and
 * write back if anything changed.
 *
 * For atomic, the snippets we wrote in `installCommand` look like:
 *
 *   # Atomic CLI PATH                        ← marker
 *   case ":$PATH:" in                        ← bash body
 *       *":<dir>:"*) ;;
 *       *) export PATH="<dir>:$PATH" ;;
 *   esac
 *
 *   # Atomic CLI completions (cached)        ← marker
 *   [ -f "<cache>" ] && source "<cache>"    ← single-line body
 */
export function stripRcSnippet(rcPath: string, marker: string): boolean {
    if (!existsSync(rcPath)) return false;
    const content = readFileSync(rcPath, "utf8");
    if (!content.includes(marker)) return false;

    const lines = content.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        if (line === marker) {
            // Skip the marker. Then skip subsequent lines until we hit a
            // blank line or a line that's clearly outside the block (a
            // line that doesn't start with whitespace, a quote, or one of
            // our known body keywords). 6 lines is the worst case (bash
            // case/esac block).
            i++;
            let consumed = 0;
            while (i < lines.length && consumed < 6) {
                const next = lines[i] ?? "";
                if (next === "") { i++; break; }
                if (next.startsWith("#") && next !== marker) break;
                i++;
                consumed++;
            }
            continue;
        }
        out.push(line);
        i++;
    }

    // Collapse a trailing run of blank lines we may have left behind.
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    writeFileSync(rcPath, out.join("\n") + (out.length > 0 ? "\n" : ""));
    return true;
}

function removeWindowsPath(dir: string): boolean {
    const readScript = `[Environment]::GetEnvironmentVariable('Path', 'User')`;
    const current = runPowerShell(readScript);
    if (current === null || !pathContains(current, dir, ";")) return false;

    const filtered = current
        .split(";")
        .filter((entry) => entry.trim().length > 0 && entry.toLowerCase() !== dir.toLowerCase())
        .join(";");
    const writeScript = `[Environment]::SetEnvironmentVariable('Path', $env:_ATOMIC_NEW_PATH, 'User')`;
    runPowerShell(writeScript, { _ATOMIC_NEW_PATH: filtered });
    return true;
}

export interface UninstallOptions {
    /** Also remove ~/.atomic/ (config, completions cache, downloads). */
    readonly purge?: boolean;
    /** Test seam — inject detector to avoid mock.module pollution. */
    readonly detectInstall?: () => InstallMethod;
}

const PM_REMOVE_HINT: Record<"bun" | "npm" | "pnpm" | "yarn", string> = {
    bun:  "bun remove -g @bastani/atomic",
    npm:  "npm uninstall -g @bastani/atomic",
    pnpm: "pnpm remove -g @bastani/atomic",
    yarn: "yarn global remove @bastani/atomic",
};

function uninstallBinary(paths: InstallPaths): void {
    // 1. Remove the launcher binary (and any leftover .old.*/.tmp.*).
    if (existsSync(paths.binPath)) {
        try {
            if (resolve(process.execPath).toLowerCase() === resolve(paths.binPath).toLowerCase() && isWindows()) {
                // We're running from the install location on Windows —
                // can't unlink, so archive for the next reaper.
                renameSync(paths.binPath, `${paths.binPath}.old.${Date.now()}`);
                process.stdout.write(`  ✓ archived running launcher (will be reaped on next install)\n`);
            } else {
                unlinkSync(paths.binPath);
                process.stdout.write(`  ✓ removed launcher at ${paths.binPath}\n`);
            }
        } catch (err) {
            process.stderr.write(`  ! could not remove launcher: ${(err as Error).message}\n`);
        }
    }

    cleanupOldArtifacts(paths.binDir);

    // 2. Strip rc-file snippets (PATH + completions, idempotent).
    const rcCandidates = [
        join(homedir(), ".bashrc"),
        join(homedir(), ".zshrc"),
        join(homedir(), ".config", "fish", "config.fish"),
        join(homedir(), ".profile"),
    ];
    if (isWindows()) {
        // Strip from every PowerShell edition's profile — a prior install
        // may have written to either or both.
        for (const psProfile of detectPSProfiles()) {
            rcCandidates.push(psProfile);
        }
    }

    let rcStripped = 0;
    for (const rc of rcCandidates) {
        const a = stripRcSnippet(rc, PATH_RC_MARKER);
        const b = stripRcSnippet(rc, RC_MARKER);
        if (a || b) rcStripped++;
    }
    if (rcStripped > 0) {
        process.stdout.write(`  ✓ stripped atomic snippets from ${rcStripped} rc file(s)\n`);
    }

    // 3. Remove the install dir from Windows user PATH.
    if (isWindows()) {
        try {
            if (removeWindowsPath(paths.binDir)) {
                process.stdout.write(`  ✓ removed ${paths.binDir} from user PATH\n`);
            }
        } catch (err) {
            process.stderr.write(`  ! could not update user PATH: ${(err as Error).message}\n`);
        }
    }

    // 4. Remove fish completions file (the only one written outside ~/.atomic).
    const fishCompletion = join(homedir(), ".config", "fish", "completions", "atomic.fish");
    if (existsSync(fishCompletion)) {
        try { unlinkSync(fishCompletion); } catch { /* ignore */ }
    }

    process.stdout.write("Restart your shell to drop the PATH entry from your env.\n");
}

function purgeAtomicHome(): void {
    const atomicHome = join(homedir(), ".atomic");
    try {
        rmSync(atomicHome, { recursive: true, force: true });
        process.stdout.write(`  ✓ purged ${atomicHome}\n`);
    } catch (err) {
        process.stderr.write(`  ! could not purge ${atomicHome}: ${(err as Error).message}\n`);
    }
}

export async function uninstallCommand(opts: UninstallOptions = {}): Promise<number> {
    const method = (opts.detectInstall ?? detectInstallMethod)();

    switch (method) {
        case "bun":
        case "npm":
        case "pnpm":
        case "yarn":
            process.stderr.write(
                `Error: atomic was installed via ${method}.\n` +
                `Please run: ${PM_REMOVE_HINT[method]}\n`,
            );
            return 1;
        case "source":
        case "unknown":
            process.stderr.write(
                `Error: atomic appears to run from ${process.execPath}.\n` +
                `Cannot determine how to uninstall — remove manually or use your package manager.\n`,
            );
            return 1;
        case "binary": {
            const paths = getInstallPaths();
            process.stdout.write("Uninstalling atomic (install method: binary)...\n");
            uninstallBinary(paths);
            if (opts.purge) {
                purgeAtomicHome();
            } else {
                // ~/.atomic/completions is a derived cache — always reap.
                // --purge subsumes this by removing ~/.atomic outright.
                try { rmSync(paths.completionsDir, { recursive: true, force: true }); }
                catch { /* best-effort */ }
                process.stdout.write(`(Run with --purge to also remove ${join(homedir(), ".atomic")})\n`);
            }
            process.stdout.write("\nAtomic uninstalled.\n");
            return 0;
        }
    }
}

// ── Public entry ───────────────────────────────────────────────────────────

export async function installCommand(opts: InstallOptions = {}): Promise<number> {
    const paths = getInstallPaths();

    process.stdout.write("Installing atomic...\n");

    try {
        copyBinary(paths);
        process.stdout.write(`  ✓ binary installed at ${paths.binPath}\n`);
    } catch (err) {
        process.stderr.write(`  ✗ failed to install binary: ${(err as Error).message}\n`);
        return 1;
    }

    try {
        const added = persistPathEntry(paths.binDir);
        process.stdout.write(
            added
                ? `  ✓ added ${paths.binDir} to user PATH\n`
                : `  ✓ ${paths.binDir} already on PATH\n`,
        );
    } catch (err) {
        process.stderr.write(`  ! could not persist PATH: ${(err as Error).message}\n`);
        process.stderr.write(`    add ${paths.binDir} to your PATH manually\n`);
    }

    const mux = detectMuxBinary();
    if (mux.binary === null) {
        const required = isWindows() ? "psmux" : "tmux";
        const installHint = isWindows()
            ? "install via: scoop install psmux  (or)  winget install psmux"
            : "install via your package manager (e.g. `brew install tmux`, `apt install tmux`)";
        process.stdout.write(`  ! ${required} not found — ${installHint}\n`);
    } else if (mux.onPath) {
        process.stdout.write(`  ✓ ${mux.binary} found on PATH (${mux.directory})\n`);
    } else if (mux.directory) {
        try {
            const added = persistPathEntry(mux.directory);
            process.stdout.write(
                added
                    ? `  ✓ added ${mux.directory} to user PATH (${mux.binary})\n`
                    : `  ✓ ${mux.binary} already on PATH (${mux.directory})\n`,
            );
        } catch (err) {
            process.stderr.write(`  ! could not add ${mux.directory} to PATH: ${(err as Error).message}\n`);
        }
    }

    if (!opts.noCompletions) {
        const completions = installCompletions(paths);
        if (completions === null) {
            process.stdout.write("  ! could not detect shell — skipping completions\n");
        } else if (completions.rcPaths.length > 0) {
            process.stdout.write(
                `  ✓ ${completions.shell} completions installed (sourced from ${completions.rcPaths.join(", ")})\n`,
            );
        } else {
            process.stdout.write(`  ✓ ${completions.shell} completions installed\n`);
        }
    }

    // Fire-and-forget reaper for prior install artifacts. Mirrors
    // Claude Code's `void cleanupOldVersions()` at the tail of
    // installLatestImpl — never blocks the success path.
    queueMicrotask(() => {
        const reaped = cleanupOldArtifacts(paths.binDir);
        if (reaped.oldBinariesRemoved + reaped.tempFilesRemoved > 0) {
            process.stdout.write(
                `  · cleaned ${reaped.oldBinariesRemoved} archived binary file(s), ${reaped.tempFilesRemoved} temp file(s)\n`,
            );
        }
    });

    process.stdout.write("\nAtomic installed successfully. Restart your shell, then run:\n  atomic --help\n\n");
    return 0;
}
