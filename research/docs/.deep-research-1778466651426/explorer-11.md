# Partition 11 of 12 — Findings

## Scope

`install.cmd/` (1 files, 168 LOC)

## Files in Scope

<!-- Source: codebase-locator sub-agent -->

# Partition 11: Binary Distribution Installer (install.cmd)

## Implementation

- `install.cmd` — Windows batch installer script (169 LOC) that bootstraps Atomic CLI installation on Windows by downloading a verified prebuilt binary from GitHub Releases, verifying SHA256 checksum, and delegating to the binary's `install` subcommand for PATH wiring, shell completions, and mux detection.

## Configuration

- `install.cmd` — Hardcoded GitHub release base URL (`bastani/atomic`), download directory (`%USERPROFILE%\.atomic\downloads`), manifest.json parsing strategy, platform detection (AMD64 vs ARM64), and version validation regex.

## Notable Clusters

- `install.cmd/` — 1 file, Windows-specific binary distribution entry point. Mirrors Claude Code's installer design: fetches manifest.json from GitHub Releases, resolves platform-specific binary URL, downloads and verifies checksum via PowerShell (due to cmd.exe regex limitations), then hands off to the binary's `install` subcommand for environment setup.

## Summary

The `install.cmd` script is a lightweight bootstrap for Windows that decouples pre-flight validation and binary download from the main CLI installation logic. It delegates actual installation (PATH updates, shell completions, tmux detection) to the binary's `install` subcommand. The script validates Windows architecture (rejects 32-bit), uses PowerShell for manifest/version parsing to work around cmd.exe regex limitations, performs SHA256 verification via CertUtil, and cleans up temporary files. This design is specific to the Atomic CLI binary distribution strategy and will require adaptation or replacement in a pi-coding-agent fork.

## How It Works

<!-- Source: codebase-analyzer sub-agent -->

## Analysis: Binary Distribution Installers (install.cmd + peers)

### Files Analysed

- `install.cmd` — Windows batch bootstrap (169 LOC)
- `install.ps1` — Windows PowerShell bootstrap (128 LOC)
- `install.sh` — macOS/Linux bash bootstrap (173 LOC)
- `packages/atomic/src/commands/cli/install.ts` — `atomic install` / `atomic uninstall` subcommand handler (826 LOC)
- `packages/atomic/src/commands/cli/install-method.ts` — install-method detection (105 LOC)

---

### Per-File Notes

#### `install.cmd`

- **Role:** Windows cmd.exe bootstrap that downloads a verified Atomic binary from GitHub Releases and delegates to its `install` subcommand.

- **Key symbols:**
    - `TARGET` (`install.cmd:16`) — positional arg (`latest`, `stable`, or `x.y.z[-pre]`), defaults to `latest`
    - `RELEASES_BASE` (`install.cmd:51`) — hardcoded `https://github.com/bastani/atomic/releases`
    - `DOWNLOAD_DIR` (`install.cmd:52`) — hardcoded `%USERPROFILE%\.atomic\downloads`
    - `PLATFORM` (`install.cmd:54-58`) — set to `windows-arm64` or `windows-x64` based on `%PROCESSOR_ARCHITECTURE%`
    - `:download_file` subroutine (`install.cmd:144-147`) — thin `curl -fsSL --retry 3` wrapper
    - `:verify_checksum` subroutine (`install.cmd:149-168`) — invokes `certutil -hashfile <path> SHA256`, strips spaces, does case-insensitive comparison against `%EXPECTED%`

- **Control flow:**
    1. `install.cmd:16-31` — Validate `TARGET` via a PowerShell regex (`^(?:stable|latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$`) because cmd.exe's `findstr` has no end-of-input anchor and falsely rejects prerelease versions due to a trailing CRLF.
    2. `install.cmd:41-48` — Reject 32-bit Windows via `%PROCESSOR_ARCHITECTURE%` and `%PROCESSOR_ARCHITEW6432%`.
    3. `install.cmd:62-66` — Verify `curl` is available; print hint to use `install.ps1` if absent.
    4. `install.cmd:69-75` — Resolve `manifest.json` URL: `latest`/`stable` → `releases/latest/download/manifest.json`; pinned version → `releases/download/v<VER>/manifest.json`.
    5. `install.cmd:77-98` — Download manifest via `:download_file`; parse `VERSION` and `EXPECTED_CHECKSUM` via a single PowerShell invocation (`ConvertFrom-Json`) that emits `<version>|<checksum>` on stdout, split by `for /f … delims=|`.
    6. `install.cmd:101-116` — Construct `BINARY_URL` and `BINARY_PATH`; download and verify checksum via `:verify_checksum`.
    7. `install.cmd:119-133` — Run `"!BINARY_PATH!" install`; wait 1 second for handles to release; delete temp binary; propagate exit code.

- **Data flow:**
    - Input: optional `%~1` version string from CLI.
    - Intermediate state: `%USERPROFILE%\.atomic\downloads\manifest.json` (downloaded, read, immediately deleted at `install.cmd:98`), then `atomic-<version>-<platform>.exe` (downloaded, checksum-verified, executed, then deleted at `install.cmd:125`).
    - Output: delegates all PATH/completions/settings work to the binary itself; exits 0 on success, 1 on any failure.

- **Dependencies:** `curl` (Windows 10+ built-in), `certutil` (Windows built-in), `powershell.exe` (Windows built-in). No external package manager required.

---

#### `install.ps1`

- **Role:** Windows PowerShell bootstrap that mirrors `install.cmd`'s flow with native PowerShell idioms (no `curl`/`certutil` dependency).

- **Key symbols:**
    - `$Target` param (`install.ps1:16-19`) — validated via `[ValidatePattern('^(stable|latest|\d+\.\d+\.\d+(-[^\s]+)?)$')]`
    - `$RELEASES_BASE` (`install.ps1:30`) — same hardcoded `https://github.com/bastani/atomic/releases`
    - `$DOWNLOAD_DIR` (`install.ps1:31`) — `$env:USERPROFILE\.atomic\downloads`
    - `$platform` (`install.ps1:34-38`) — `windows-arm64` or `windows-x64`

- **Control flow:**
    1. `install.ps1:25-28` — 64-bit check via `[Environment]::Is64BitProcess`.
    2. `install.ps1:47-51` — Resolve manifest URL by same `latest`/`stable`/pinned logic.
    3. `install.ps1:53-59` — `Invoke-RestMethod` to fetch and auto-parse manifest JSON into `$manifest`.
    4. `install.ps1:61-66` — Extract `$version` and `$checksum` from `$manifest.platforms.$platform.checksum`.
    5. `install.ps1:71` — Pin binary URL to `releases/download/v$version/…` (not `latest/download`) for reliability mid-release.
    6. `install.ps1:77-98` — Retry loop (3 attempts, `[Math]::Min(5, attempt*2)` second back-off) via `Invoke-WebRequest`; 5.1-compatible (no `-MaximumRetryCount`).
    7. `install.ps1:100-105` — SHA-256 verify via `Get-FileHash`.
    8. `install.ps1:113-124` — Run `& $binaryPath install`; `finally` block deletes temp with `Start-Sleep -Seconds 1` before unlink.

- **Dependencies:** `powershell.exe` / `pwsh.exe` only; `Invoke-RestMethod`, `Invoke-WebRequest`, `Get-FileHash` are all PowerShell builtins.

---

#### `install.sh`

- **Role:** macOS/Linux bash bootstrap analogous to `install.cmd`/`install.ps1`.

- **Key symbols:**
    - `download_file()` (`install.sh:37-52`) — wraps `curl -fsSL --retry 3` or `wget -q`
    - `get_checksum_from_manifest()` (`install.sh:55-63`) — pure-bash JSON extraction using `BASH_REMATCH` regex (no `jq` required)
    - `get_version_from_manifest()` (`install.sh:65-73`) — same pattern
    - `libc` detection (`install.sh:104-111`) — detects musl Linux via `ldd --version`, `/lib/ld-musl-x86_64.so.1`, or `/lib/ld-musl-aarch64.so.1`; appends `-musl` to platform string

- **Control flow:**
    1. `install.sh:19` — Validate `TARGET` regex in bash.
    2. `install.sh:76-98` — Detect OS/arch; Rosetta 2 detection at `install.sh:94-98`.
    3. `install.sh:104-111` — musl detection for Alpine Linux hosts.
    4. `install.sh:117-121` — Manifest URL resolution.
    5. `install.sh:123-137` — Download manifest (piped to stdout, not disk), parse `version` and `checksum`.
    6. `install.sh:143-147` — Download binary to `$DOWNLOAD_DIR/atomic-$version-$platform`.
    7. `install.sh:150-160` — SHA-256 verify via `shasum -a 256` (macOS) or `sha256sum` (Linux).
    8. `install.sh:162` — `chmod +x`.
    9. `install.sh:166` — Run `"$binary_path" install`; `install.sh:169` deletes temp.

- **Dependencies:** `curl` or `wget` (either sufficient), `bash`, no external tools for manifest parsing.

---

#### `packages/atomic/src/commands/cli/install.ts`

- **Role:** The `atomic install` and `atomic uninstall` subcommand implementations — receives control from bootstrap scripts, performs binary self-copy, PATH wiring, tmux/psmux detection, and shell completions setup.

- **Key symbols:**
    - `RC_MARKER` (`install.ts:40`) — `"# Atomic CLI completions (cached)"` — sentinel inserted in rc files
    - `PATH_RC_MARKER` (`install.ts:41`) — `"# Atomic CLI PATH"` — sentinel for PATH rc snippets
    - `getInstallPaths()` (`install.ts:58`) — returns `InstallPaths` with `binDir`, `binPath`, `completionsDir`; Windows uses `%LOCALAPPDATA%\atomic\bin`, Unix uses `~/.local/bin`
    - `copyBinary()` (`install.ts:96`) — atomic move: `copyFileSync → chmodSync → renameSync` via a `.tmp.<pid>.<ts>` intermediate; Windows archives running `.exe` to `.exe.old.<ts>` first
    - `cleanupOldArtifacts()` (`install.ts:160`) — reaps `atomic.exe.old.<digits>` and `atomic.exe.tmp.<pid>.<ts>` files older than 1 hour from `binDir`
    - `pathContains()` (`install.ts:204`) — checks if `dir` is already on `PATH`, case-insensitive on Windows
    - `persistPathEntry()` (`install.ts:223`) — routes to `persistWindowsPath()` (registry via PowerShell `[Environment]::SetEnvironmentVariable`) or `persistUnixPath()` (appends to rc files)
    - `appendPathRcSnippet()` (`install.ts:343`) — writes POSIX `case ":$PATH:" in … esac` guard or fish `fish_add_path`
    - `detectMuxBinary()` (`install.ts:411`) — searches PATH then `wellKnownMuxInstallDirs()` for `tmux` (Unix) or `psmux`/`pmux` (Windows)
    - `wellKnownMuxInstallDirs()` (`install.ts:435`) — enumerates Homebrew, Scoop, WinGet, Chocolatey, and manual install locations
    - `installCompletions()` (`install.ts:472`) — writes completion script from `COMPLETION_SCRIPTS[shell]` to `~/.atomic/completions/atomic.<ext>`, then sources it from rc file
    - `ensureCompletionsSourcedFromRc()` (`install.ts:509`) — strips legacy `eval "$(atomic completions …)"` snippet before writing new cached-source snippet
    - `stripRcSnippet()` (`install.ts:555`) — marker-aware line filter that removes up to 6-line blocks written by previous installs
    - `uninstallCommand()` (`install.ts:695`) — dispatches on `detectInstallMethod()` result; only handles `binary` method directly, prints hints for `bun`/`npm`/`pnpm`/`yarn`
    - `installCommand()` (`install.ts:751`) — orchestrates: `copyBinary` → `persistPathEntry` → `detectMuxBinary`/`persistPathEntry` for mux → `installCompletions` → `cleanupOldArtifacts` (via `queueMicrotask`)

- **Control flow (installCommand):**
    1. `install.ts:752` — `getInstallPaths()` to resolve target dirs
    2. `install.ts:756` — `copyBinary(paths)` — self-copy from `process.execPath`
    3. `install.ts:764` — `persistPathEntry(paths.binDir)` — idempotent PATH update
    4. `install.ts:776` — `detectMuxBinary()` — tmux/psmux detection and optional PATH persistence
    5. `install.ts:798` — `installCompletions(paths)` — write completion cache + rc source line
    6. `install.ts:814` — `queueMicrotask(() => cleanupOldArtifacts(paths.binDir))` — non-blocking reaper

- **tmux dependency (load-bearing for current Atomic, removable for pi-rewrite):**
    - `install.ts:403-462` — `detectMuxBinary()` and `wellKnownMuxInstallDirs()` explicitly detect and configure tmux (Unix) and psmux/pmux (Windows) as required mux binaries. The `installCommand` at `install.ts:776-795` will warn if no mux binary is found. These functions reference tmux/psmux as named binary strings and their platform-specific install directories. In a pi-coding-agent rewrite, this entire block is removable.

- **Data flow:**
    - Input: `process.execPath` (source binary path), `process.env` (PATH, LOCALAPPDATA, etc.), filesystem state of rc files
    - State written: binary copied to `binDir/atomic[.exe]`, PATH entries appended to registry (Windows) or rc files (Unix), completion scripts written to `~/.atomic/completions/`, rc files modified with source lines
    - Output: exit code 0/1, stdout progress messages

- **Dependencies:**
    - `node:fs`, `node:os`, `node:path` (standard)
    - `./install-method.ts` — install method detection
    - `../../completions/index.ts` — shell completion script strings
    - `Bun.spawnSync` — PowerShell invocation on Windows, package manager probing
    - `Bun.which` — mux binary PATH search

---

#### `packages/atomic/src/commands/cli/install-method.ts`

- **Role:** Detects how the currently-running `atomic` binary was installed (binary installer, bun/npm/pnpm/yarn global, or source checkout) by inspecting `process.execPath`.

- **Key symbols:**
    - `InstallMethod` type (`install-method.ts:4`) — union: `"binary" | "bun" | "npm" | "pnpm" | "yarn" | "source" | "unknown"`
    - `detectInstallMethod()` (`install-method.ts:45`) — memoized detection via `computeInstallMethod()`
    - `computeInstallMethod()` (`install-method.ts:54`) — three checks: (1) exec path matches canonical `~/.local/bin` or `%LOCALAPPDATA%\atomic\bin` → `"binary"`; (2) path contains `node_modules/@bastani/atomic` → package manager (path heuristics then `<pm> ls -g` probe); (3) exec ends with `/bun` or `/bun.exe` → `"source"`
    - `PKG_PATH_RE` (`install-method.ts:22`) — `/\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//`
    - `_resetInstallMethodCache()` (`install-method.ts:104`) — test seam to clear memoized result
    - `PM_PROBE_CMD` (`install-method.ts:24-29`) — maps `bun`/`pnpm`/`yarn`/`npm` to `ls -g` commands for confirming @bastani/atomic presence

- **Data flow:** Input is `process.execPath` (or injected `opts.execPath`). Output is a single `InstallMethod` string, memoized in module-level `cached` variable (`install-method.ts:31`).

---

### Cross-Cutting Synthesis

The binary distribution installer is a two-phase pipeline split across two layers. The outer layer (`install.cmd`, `install.ps1`, `install.sh`) is a minimal OS-native bootstrap whose sole job is: validate target version, detect architecture, download `manifest.json` from `https://github.com/bastani/atomic/releases`, parse the platform-specific SHA-256 checksum, download the versioned binary, verify it, and hand off via `<binary> install`. All three scripts use a `$RELEASES_BASE/download/v$version/<asset>` pin strategy (never `latest/download` for the binary itself) to avoid race conditions during release. The inner layer (`install.ts` `installCommand`) performs the durable work: atomic-move self-copy, PATH persistence (registry on Windows, rc-file appends on Unix), tmux/psmux binary detection with `wellKnownMuxInstallDirs`, shell completion cache writes, and a non-blocking reaper for install artifacts. `install-method.ts` provides a memoized detection of how the binary was installed, which gates `uninstallCommand` behaviour. The tmux/psmux detection block in `install.ts:403-462` is the primary agent-specific dependency in this layer; all other logic is agent-agnostic PATH and completions management directly replaceable for a pi-coding-agent fork.

---

### Out-of-Partition References

- `packages/atomic/src/completions/index.ts` — exports `Shell` type and four completion script strings (`bash`, `zsh`, `fish`, `powershell`) consumed by `installCommand` to write shell completion caches; the per-shell scripts in `packages/atomic/src/completions/` carry the actual completion logic.
- `packages/atomic/src/commands/cli/install.test.ts` — test suite for `installCommand`/`uninstallCommand`; relevant for understanding which code paths are tested and what must be adapted in a rewrite.
- `packages/atomic/src/services/system/install-method.ts` — a second `install-method.ts` at a different path; may be an alternate or service-layer variant of the detection logic.
- `install.ps1` — the PowerShell peer of `install.cmd`; shares identical flow and hardcoded `bastani/atomic` release URL; must be rebranded for pi-coding-agent.
- `install.sh` — the macOS/Linux peer; includes musl and Rosetta 2 detection not present in the Windows scripts.

## Patterns

<!-- Source: codebase-pattern-finder sub-agent -->

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

- Line 51: `set "RELEASES_BASE=https://github.com/bastani/atomic/releases"`
- Line 11: Usage example hardcodes `bastani/atomic/main/install.cmd`
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
export function copyBinary(
    paths: InstallPaths,
    sourcePath: string = process.execPath,
): void {
    if (
        resolve(sourcePath).toLowerCase() ===
        resolve(paths.binPath).toLowerCase()
    ) {
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
        try {
            unlinkSync(tempPath);
        } catch {
            /* ignore */
        }
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
    if (current === null)
        throw new Error("Could not read user PATH from registry");

    if (pathContains(current, dir, ";")) return false;

    const newValue =
        current && !current.endsWith(";")
            ? `${current};${dir}`
            : `${current}${dir}`;
    const writeScript = `[Environment]::SetEnvironmentVariable('Path', $env:_ATOMIC_NEW_PATH, 'User')`;
    const result = runPowerShell(writeScript, { _ATOMIC_NEW_PATH: newValue });
    if (result === null)
        throw new Error(
            `Could not write user PATH to registry (tried to add ${dir})`,
        );

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
export function appendPathRcSnippet(
    rcPath: string,
    shell: Shell | "sh",
    dir: string,
): void {
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
        if (found)
            return { binary: name, directory: dirname(found), onPath: true };
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
        "/opt/homebrew/bin", // macOS Apple Silicon
        "/usr/local/bin", // macOS Intel + Linux
        "/usr/bin", // Linux distro
        "/snap/bin", // Linux snap
        "/opt/local/bin", // MacPorts
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

    const ext: Record<Shell, string> = {
        bash: "bash",
        zsh: "zsh",
        fish: "fish",
        powershell: "ps1",
    };
    const cachePath = join(paths.completionsDir, `atomic.${ext[shell]}`);
    writeFileSync(cachePath, COMPLETION_SCRIPTS[shell], "utf8");

    if (shell === "fish") {
        const fishDir = join(homedir(), ".config", "fish", "completions");
        mkdirSync(fishDir, { recursive: true });
        writeFileSync(
            join(fishDir, "atomic.fish"),
            COMPLETION_SCRIPTS.fish,
            "utf8",
        );
        return { cachePath, rcPaths: [], shell };
    }

    const rcPaths = completionsRcPaths(shell);
    for (const rcPath of rcPaths) {
        ensureCompletionsSourcedFromRc(rcPath, shell, cachePath);
    }
    return { cachePath, rcPaths, shell };
}

export function ensureCompletionsSourcedFromRc(
    rcPath: string,
    shell: Shell,
    cachePath: string,
): void {
    const content = readFileSync(rcPath, "utf8");

    // Strip legacy eval-based snippet
    const legacyPattern =
        shell === "powershell"
            ? /atomic completions powershell \| Invoke-Expression/
            : /eval "\$\(atomic completions [a-z]+\)"/;
    if (legacyPattern.test(content)) {
        const cleaned = content
            .split("\n")
            .filter(
                (line) =>
                    !legacyPattern.test(line) &&
                    line !== "# Atomic CLI completions",
            )
            .join("\n");
        writeFileSync(rcPath, cleaned);
    }

    if (readFileSync(rcPath, "utf8").includes(RC_MARKER)) return;

    const snippet =
        shell === "powershell"
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
    bun: ["bun", "pm", "ls", "-g"],
    pnpm: ["pnpm", "list", "-g", "--depth=0"],
    yarn: ["yarn", "global", "list"],
    npm: ["npm", "list", "-g", "--depth=0"],
};

function computeInstallMethod(opts: DetectOptions): InstallMethod {
    const exec = normalize(opts.execPath ?? process.execPath);
    const currentPlatform = opts.platform ?? osPlatform();

    // 1. Binary install
    const binDir =
        currentPlatform === "win32"
            ? join(
                  process.env.LOCALAPPDATA ??
                      join(homedir(), "AppData", "Local"),
                  "atomic",
                  "bin",
              )
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
            if (r.exitCode === 0 && r.stdout.includes("@bastani/atomic"))
                return pm;
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

export function cleanupOldArtifacts(
    binDir: string,
    now: number = Date.now(),
): CleanupResult {
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
            } catch {
                /* still locked or gone — ignore */
            }
            continue;
        }

        if (TMP_INSTALL_PATTERN.test(entry)) {
            try {
                const stats = statSync(entryPath);
                if (now - stats.mtime.getTime() > ONE_HOUR_MS) {
                    unlinkSync(entryPath);
                    tempFilesRemoved++;
                }
            } catch {
                /* ignore */
            }
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

1. **GitHub Release URL Base**: `https://github.com/bastani/atomic/releases` (install.cmd:51, install.ps1:30, install.sh:24)
2. **Package Scope**: `@bastani/atomic` (install-method.ts:22, install.ts:614-617)
3. **Binary Name**: `atomic` (hardcoded in paths, regex patterns, completion scripts)
4. **Tmux/Psmux Detection**: Tied to Atomic's multiplexer strategy
5. **GitHub Org/Repo**: `bastani/atomic` (hardcoded in usage examples)

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

## Out-of-Partition References

Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
