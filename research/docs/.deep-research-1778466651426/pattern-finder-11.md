# Pattern Finder 11: Install Layer Architecture

**Scope**: `install.cmd/` (includes install.cmd, install.ps1, install.sh, and related TS code)

## Overview

The install layer represents a three-stage bootstrap + self-setup pipeline: shell scripts download a verified prebuilt binary from GitHub Releases, hand it off to the binary's embedded `install` subcommand, which performs actual placement, PATH wiring, tmux/psmux detection, and shell completions. The layer is **nearly agent-agnostic** at the script level (download + verify + exec) but has **hardcoded Atomic-specific values** (GitHub org, package name, tmux/psmux references).

---

## Patterns

#### Pattern 1: Multi-Stage Bootstrap with Manifest-Driven Verification
**Where:** `install.cmd:68-98`, `install.ps1:44-105`, `install.sh:116-160`
**What:** Scripts fetch a manifest.json from GitHub Releases, parse it for the target platform's checksum and version, download the pinned binary, verify SHA256, then hand off to the binary's embedded `install` subcommand.

```batch
REM install.cmd (lines 68-98)
set "MANIFEST_URL=!RELEASES_BASE!/latest/download/manifest.json"
call :download_file "!MANIFEST_URL!" "!DOWNLOAD_DIR!\manifest.json"

for /f "usebackq tokens=1,2 delims=|" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$m = Get-Content -Raw '!DOWNLOAD_DIR!\manifest.json' ^| ConvertFrom-Json; $c = $m.platforms.'!PLATFORM!'.checksum; if (-not $c) { exit 2 }; Write-Output ($m.version + '|' + $c)"`) do (
    set "VERSION=%%a"
    set "EXPECTED_CHECKSUM=%%b"
)

set "BINARY_URL=!RELEASES_BASE!/download/v!VERSION!/atomic-!PLATFORM!.exe"
call :verify_checksum "!BINARY_PATH!" "!EXPECTED_CHECKSUM!"
"!BINARY_PATH!" install
```

**Atomic-Specific Hardcodes:**
- Line 51: `set "RELEASES_BASE=https://github.com/flora131/atomic/releases"`
- Line 11: Usage example hardcodes `flora131/atomic/main/install.cmd`
- All three scripts only reference `atomic` (not configurable agent name)

**Seams for pi-coding-agent:**
- `RELEASES_BASE` should become a configurable template variable
- Binary/package name `atomic` should be replaceable at generation time
- GitHub org `flora131` is hardcoded; should be parameterized

---

#### Pattern 2: Platform Detection and Manifest Lookup
**Where:** `install.cmd:40-58`, `install.sh:76-113`
**What:** Detect OS and CPU architecture, map to platform string (windows-x64, windows-arm64, linux-x64, linux-arm64, darwin-x64, darwin-arm64, linux-x64-musl), then query manifest for that platform's binary and checksum.

```batch
REM install.cmd (lines 40-58)
if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto :arch_valid
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" goto :arch_valid
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto :arch_valid
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" goto :arch_valid

set "PLATFORM=windows-arm64" if ARM64, else "windows-x64"

REM Manifest lookup delegates to PowerShell:
for /f ... powershell ... "$m = Get-Content ... | ConvertFrom-Json; $c = $m.platforms.'!PLATFORM!'.checksum"
```

**Bash variant** (install.sh lines 76-113):
```bash
case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
esac

case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
esac

# Detect Rosetta 2 (Apple Silicon)
if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
    if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" == "1" ]]; then
        arch="arm64"
    fi
fi

# Detect musl on Linux
if ldd --version 2>&1 | grep -qi musl; then
    libc="-musl"
fi

platform="${os}-${arch}${libc}"
```

**Note**: musl detection is **Atomic-specific** — assumes a release matrix with `-musl` variants. Not tied to any particular coding agent.

---

#### Pattern 3: Binary Placement via Atomic Move (Copy → Chmod → Rename)
**Where:** `packages/atomic/src/commands/cli/install.ts:96-132`
**What:** Copy source binary to a temp `.tmp.<pid>.<ts>` file next to the target, chmod on Unix, then rename atomically. On Windows, archive the running binary first (can't delete in-use exe). Crash-safe: mid-install crashes leave orphan temps that are reaped later.

```typescript
export function copyBinary(paths: InstallPaths, sourcePath: string = process.execPath): void {
    if (resolve(sourcePath).toLowerCase() === resolve(paths.binPath).toLowerCase()) {
        return; // Already running from install location
    }

    if (!existsSync(paths.binDir)) {
        mkdirSync(paths.binDir, { recursive: true });
    }

    // Windows: archive the running exe before copy
    if (isWindows() && existsSync(paths.binPath)) {
        const archivedPath = `${paths.binPath}.old.${Date.now()}`;
        renameSync(paths.binPath, archivedPath);
    }

    const tempPath = `${paths.binPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        copyFileSync(sourcePath, tempPath);
        if (!isWindows()) {
            chmodSync(tempPath, 0o755);
        }
        renameSync(tempPath, paths.binPath);
    } catch (err) {
        try { unlinkSync(tempPath); } catch { /* ignore */ }
        throw err;
    }
}
```

**Note:** This pattern mirrors Claude Code's atomic move. The binary name `atomic` and paths like `~/.local/bin/atomic` are hardcoded in `getInstallPaths()`.

---

#### Pattern 4: Persistent PATH Writes (Platform-Specific)
**Where:** `packages/atomic/src/commands/cli/install.ts:223-268`
**What:** On Windows, use PowerShell to write HKCU\Environment\Path and broadcast WM_SETTINGCHANGE. On Unix, append idempotent snippets to shell rc files (.bashrc, .zshrc, .profile, fish config.fish).

```typescript
function persistWindowsPath(dir: string): boolean {
    const readScript = `[Environment]::GetEnvironmentVariable('Path', 'User')`;
    const current = runPowerShell(readScript);
    if (current === null) throw new Error("Could not read user PATH from registry");

    if (pathContains(current, dir, ";")) return false;

    const newValue = current && !current.endsWith(";") ? `${current};${dir}` : `${current}${dir}`;
    const writeScript = `[Environment]::SetEnvironmentVariable('Path', $env:_ATOMIC_NEW_PATH, 'User')`;
    const result = runPowerShell(writeScript, { _ATOMIC_NEW_PATH: newValue });
    if (result === null) throw new Error(`Could not write user PATH to registry (tried to add ${dir})`);

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
    if (!pathContains(process.env.PATH ?? "", dir, ":")) {
        process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    }
    return modified;
}
```

**Shell RC Snippets** (install.ts:343-353):
```typescript
export function appendPathRcSnippet(rcPath: string, shell: Shell | "sh", dir: string): void {
    const snippet =
        shell === "fish"
            ? `\n${PATH_RC_MARKER}\nfish_add_path "${dir}"\n`
            : `\n${PATH_RC_MARKER}\ncase ":$PATH:" in\n    *":${dir}:"*) ;;\n    *) export PATH="${dir}:$PATH" ;;\nesac\n`;
    appendFileSync(rcPath, snippet);
}
```

**Agent-Agnostic**: PATH manipulation is generic; only the marker string `# Atomic CLI PATH` needs renaming.

---

#### Pattern 5: Mux/Psmux Binary Detection and PATH Addition
**Where:** `packages/atomic/src/commands/cli/install.ts:403-462`
**What:** Search for tmux (Unix) or psmux/pmux (Windows) on PATH, then in well-known install directories. If found but not on PATH, persist its directory to PATH.

```typescript
function detectMuxBinary(): MuxDetection {
    const candidates = isWindows() ? ["psmux", "pmux"] : ["tmux"];
    const ext = isWindows() ? ".exe" : "";

    for (const name of candidates) {
        const found = Bun.which(name, { PATH: process.env.PATH ?? "" });
        if (found) return { binary: name, directory: dirname(found), onPath: true };
    }

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
        return [
            process.env.SCOOP ? join(process.env.SCOOP, "shims") : null,
            join(home, "scoop", "shims"),
            join(localAppData, "Microsoft", "WinGet", "Links"),
            // ... etc
        ];
    }
    return [
        "/opt/homebrew/bin",  // macOS Apple Silicon
        "/usr/local/bin",     // macOS Intel + Linux
        "/usr/bin",           // Linux distro
        "/snap/bin",          // Linux snap
        "/opt/local/bin",     // MacPorts
    ];
}
```

**Atomic-Specific Coupling**: The hardcoded mux binaries (tmux/psmux/pmux) are tightly bound to Atomic's tmux integration. Removing this requires deciding the pi-coding-agent's multiplexer strategy (if any).

**In install.ts main flow** (lines 776-796):
```typescript
const mux = detectMuxBinary();
if (mux.binary === null) {
    const required = isWindows() ? "psmux" : "tmux";
    const installHint = isWindows()
        ? "install via: scoop install psmux  (or)  winget install psmux"
        : "install via your package manager (e.g. `brew install tmux`, `apt install tmux`)";
    process.stdout.write(`  ! ${required} not found — ${installHint}\n`);
}
```

---

#### Pattern 6: Shell Completion Installation
**Where:** `packages/atomic/src/commands/cli/install.ts:472-534`
**What:** Write cached completion scripts to `~/.atomic/completions/atomic.<shell>` and source them from appropriate rc files. Also handle cleanup of legacy eval-based completions.

```typescript
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

export function ensureCompletionsSourcedFromRc(rcPath: string, shell: Shell, cachePath: string): void {
    const content = readFileSync(rcPath, "utf8");

    // Strip legacy eval-based snippet
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
```

**Hardcoded Names**: `atomic.bash`, `atomic.zsh`, `atomic.fish`, `atomic.ps1` — all embed "atomic". Marker `# Atomic CLI completions (cached)` is also hardcoded.

---

#### Pattern 7: Install Method Detection (Package Manager vs Binary vs Source)
**Where:** `packages/atomic/src/commands/cli/install-method.ts:22-92`
**What:** Detect whether the running binary came from a binary install (~/.local/bin/atomic), a package manager (node_modules/@bastani/atomic), or a source checkout (bun link).

```typescript
const PKG_PATH_RE = /\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//;

const PM_PROBE_CMD: Record<"bun" | "pnpm" | "yarn" | "npm", string[]> = {
    bun:  ["bun",  "pm",     "ls", "-g"],
    pnpm: ["pnpm", "list",   "-g", "--depth=0"],
    yarn: ["yarn", "global", "list"],
    npm:  ["npm",  "list",   "-g", "--depth=0"],
};

function computeInstallMethod(opts: DetectOptions): InstallMethod {
    const exec = normalize(opts.execPath ?? process.execPath);
    const currentPlatform = opts.platform ?? osPlatform();

    // 1. Binary install
    const binDir = currentPlatform === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "atomic", "bin")
        : join(homedir(), ".local", "bin");
    const norm = normalize(binDir);
    if (exec === norm || exec.startsWith(`${norm}/`)) return "binary";

    // 2. Pkg-manager install — @bastani/atomic in node_modules
    if (PKG_PATH_RE.test(exec)) {
        if (exec.includes("/.bun/install/global/")) return "bun";
        if (exec.includes("/pnpm/global/")) return "pnpm";
        if (exec.includes("/.config/yarn/global/")) return "yarn";

        const probe = opts.probe ?? defaultProbe;
        for (const pm of ["bun", "pnpm", "yarn", "npm"] as const) {
            const r = probe(PM_PROBE_CMD[pm]);
            if (r.exitCode === 0 && r.stdout.includes("@bastani/atomic")) return pm;
        }
        return "npm";
    }

    // 3. Source checkout
    if (exec.endsWith("/bun") || exec.endsWith("/bun.exe")) return "source";

    return "unknown";
}
```

**Atomic + Package-Manager Hardcodes:**
- Line 22: `@bastani/atomic` (package name scope)
- Per-platform packages: `@bastani/atomic-windows-*` (install.ts:718), `@bastani/atomic-linux-*`, etc.
- Uninstall hints (install.ts:613-618) hardcode full package names for bun/npm/pnpm/yarn

---

#### Pattern 8: Artifact Reaper (Cleanup of Old Binaries and Temp Files)
**Where:** `packages/atomic/src/commands/cli/install.ts:150-200`
**What:** Clean up leftover `.old.<timestamp>` files (Windows running-exe archives) and `.tmp.<pid>.<timestamp>` temps older than 1 hour. Runs as fire-and-forget microtask at end of successful install.

```typescript
const ONE_HOUR_MS = 60 * 60 * 1000;
const OLD_BINARY_PATTERN = /^atomic(?:\.exe)?\.old\.\d+$/;
const TMP_INSTALL_PATTERN = /^atomic(?:\.exe)?\.tmp\.\d+\.\d+$/;

export function cleanupOldArtifacts(binDir: string, now: number = Date.now()): CleanupResult {
    let entries: string[];
    try {
        entries = readdirSync(binDir);
    } catch {
        return { oldBinariesRemoved: 0, tempFilesRemoved: 0 };
    }

    for (const entry of entries) {
        const entryPath = join(binDir, entry);

        if (OLD_BINARY_PATTERN.test(entry)) {
            try {
                unlinkSync(entryPath);
                oldBinariesRemoved++;
            } catch { /* still locked or gone — ignore */ }
            continue;
        }

        if (TMP_INSTALL_PATTERN.test(entry)) {
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
```

**Hardcoded Names**: Patterns match `/^atomic(?:\.exe)?\.old\.\d+$/` and `/^atomic(?:\.exe)?\.tmp\.\d+\.\d+$/`. For pi-coding-agent, replace `atomic` with agent binary name.

---

## Seams & Coupling Summary

### Tightly Coupled (Must Change for pi-coding-agent)
1. **GitHub Release URL Base**: `https://github.com/flora131/atomic/releases` (install.cmd:51, install.ps1:30, install.sh:24)
2. **Package Scope**: `@bastani/atomic` (install-method.ts:22, install.ts:614-617)
3. **Binary Name**: `atomic` (hardcoded in paths, regex patterns, completion scripts)
4. **Tmux/Psmux Detection**: Tied to Atomic's multiplexer strategy
5. **GitHub Org/Repo**: `flora131/atomic` (hardcoded in usage examples)

### Loosely Coupled (Reusable or Parameterizable)
1. **Platform Detection**: Fully generic (OS/arch mapping, musl detection)
2. **Atomic Move Pattern**: Portable crash-safe installation (copy → chmod → rename)
3. **PATH Manipulation**: Generic (registry on Windows, rc-file appending on Unix)
4. **Shell Completion Setup**: Generic framework (only marker strings and filenames change)
5. **Artifact Reaper**: Generic pattern (only binary name changes)

### Agent-Agnostic Utilities
- `runPowerShell()`: Spawns PowerShell with environment; fully reusable
- `Bun.which()`: Binary resolution; fully reusable
- `pathContains()`: Case-insensitive path lookup; fully reusable

---

## Files

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.cmd`
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.ps1`
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.sh`
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/install.ts`
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/install-method.ts`

