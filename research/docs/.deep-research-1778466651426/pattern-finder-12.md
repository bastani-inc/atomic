# Pattern Audit: install.ps1 (Partition 12/12)

## Scope: Bootstrap & Installation Infrastructure

### Summary

The install.ps1 (and companion install.sh, install.cmd) files reveal a **two-stage bootstrap pattern** that is agent-agnostic: stage 1 (platform-specific download script) fetches a verified binary; stage 2 hands off to the binary's built-in `install` subcommand for placement, PATH wiring, and completions setup. The infrastructure is modeled on Claude Code's installer but is decoupled from any coding-agent SDK. Atomic-specific code concentrates in three areas: (1) mux (tmux/psmux) detection (403–462 lines in install.ts), (2) agent-specific shell rc snippets (PATH write patterns), and (3) completions cache paths. All three are removable for pi-coding-agent rewrite.

---

## Patterns

#### Pattern 1: Two-Stage Bootstrap via GitHub Releases

**Where:** `install.ps1:1-129` & `packages/atomic/src/commands/cli/install.ts:1-50`
**What:** Download stage validates target version, fetches manifest with checksums, retries transient network failures, verifies SHA-256, and hands off to the binary's `install` subcommand—avoiding logic duplication across platforms.

```powershell
# install.ps1 manifest resolution (lines 44–51)
if ($Target -eq "latest" -or $Target -eq "stable") {
    $manifestUrl = "$RELEASES_BASE/latest/download/manifest.json"
} else {
    $manifestUrl = "$RELEASES_BASE/download/v$Target/manifest.json"
}

try {
    $manifest = Invoke-RestMethod -Uri $manifestUrl -ErrorAction Stop
}
catch {
    Write-Error "Failed to fetch manifest from $manifestUrl : $_"
    exit 1
}

$version = $manifest.version
$checksum = $manifest.platforms.$platform.checksum
if (-not $checksum) {
    Write-Error "Platform $platform not found in manifest for version $version"
    exit 1
}
```

**Variations / call-sites:**

- `install.sh:54-73` — Same logic via regex-based JSON parsing (no jq dependency)
- `install.cmd:68–98` — PowerShell helper + cmd-only fallback for manifest parse
- `packages/atomic/src/commands/cli/install.ts:96–132` — Binary self-copy via atomic-move pattern (temp + rename for atomicity)

---

#### Pattern 2: Retry Loop with Exponential Backoff (Network Resilience)

**Where:** `install.ps1:74–98`
**What:** Hand-rolled retry for transient DNS/network failures, mirroring `curl --retry 3` in shell installers.

```powershell
# install.ps1 retry loop (lines 77–93)
$maxAttempts = 3
$attempt = 0
$downloaded = $false
$lastError = $null
while ($attempt -lt $maxAttempts -and -not $downloaded) {
    $attempt++
    try {
        Invoke-WebRequest -Uri $binaryUrl -OutFile $binaryPath -ErrorAction Stop
        $downloaded = $true
    }
    catch {
        $lastError = $_
        if ($attempt -lt $maxAttempts) {
            Start-Sleep -Seconds ([Math]::Min(5, $attempt * 2))
        }
    }
}
if (-not $downloaded) {
    Write-Error "Failed to download binary from $binaryUrl after $maxAttempts attempts: $lastError"
    if (Test-Path $binaryPath) { Remove-Item -Force $binaryPath }
    exit 1
}
```

**Variations / call-sites:**

- `install.sh:37–52` — Uniform downloader dispatch (curl vs wget) with same retry semantics
- No explicit backoff in shell (relying on curl/wget built-ins); PowerShell implements via `Start-Sleep`

---

#### Pattern 3: Platform Detection (OS + Architecture)

**Where:** `install.ps1:33–38` & `packages/atomic/src/commands/cli/install.ts:54–74`
**What:** Detect 64-bit OS, pick native ARM64 binary if available, fall back to x64.

```powershell
# install.ps1 platform detection (lines 33–38)
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    $platform = "windows-arm64"
} else {
    $platform = "windows-x64"
}

# Reject 32-bit (lines 25–28)
if (-not [Environment]::Is64BitProcess) {
    Write-Error "atomic does not support 32-bit Windows. Please use a 64-bit version of Windows."
    exit 1
}
```

**Variations / call-sites:**

- `install.sh:75–98` — Linux/macOS via `uname -s` + `uname -m`; special-case Rosetta 2 (Apple Silicon under x64 translation) + musl libc detection for Alpine
- `packages/atomic/src/commands/cli/install.ts:54–74` — Runtime equivalents (isWindows, getInstallPaths platform-specific dirs)

---

#### Pattern 4: Idempotent Atomic Move (Copy-Chmod-Rename)

**Where:** `packages/atomic/src/commands/cli/install.ts:76–132`
**What:** Copy to per-process temp file, chmod +x (Unix), rename—safe against crash mid-install. On Windows, archive existing running .exe before replacing.

```typescript
// install.ts atomic move (lines 119–132)
const tempPath = `${paths.binPath}.tmp.${process.pid}.${Date.now()}`;
try {
    copyFileSync(sourcePath, tempPath);
    if (!isWindows()) {
        chmodSync(tempPath, 0o755);
    }
    renameSync(tempPath, paths.binPath);
} catch (err) {
    // Best-effort temp cleanup so a failed install doesn't leave
    // garbage behind for the reaper to find.
    try {
        unlinkSync(tempPath);
    } catch {
        /* ignore */
    }
    throw err;
}

// Windows special case: archive running .exe (lines 107–117)
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
```

**Variations / call-sites:**

- `packages/atomic/src/commands/cli/install.ts:150–200` — Reaper cleans `.old.*` and `.tmp.*` orphans (1-hour threshold mirrors Claude Code)
- `packages/atomic/src/commands/cli/install.ts:620–683` — Uninstall path mirrors archival pattern on Windows

---

#### Pattern 5: Persistent PATH Writes (Platform-Specific Semantics)

**Where:** `packages/atomic/src/commands/cli/install.ts:223–269`
**What:** Windows uses PowerShell to write HKCU registry; Unix appends rc-file snippets (shell-specific: bash case/esac, fish add_path).

```typescript
// install.ts Windows PATH write (lines 230–254)
function persistWindowsPath(dir: string): boolean {
    const readScript = `[Environment]::GetEnvironmentVariable('Path', 'User')`;
    const current = runPowerShell(readScript);
    if (current === null) {
        throw new Error("Could not read user PATH from registry");
    }

    if (pathContains(current, dir, ";")) {
        return false;
    }

    const newValue =
        current && !current.endsWith(";")
            ? `${current};${dir}`
            : `${current}${dir}`;
    const writeScript = `[Environment]::SetEnvironmentVariable('Path', $env:_ATOMIC_NEW_PATH, 'User')`;
    const result = runPowerShell(writeScript, { _ATOMIC_NEW_PATH: newValue });
    if (result === null) {
        throw new Error(
            `Could not write user PATH to registry (tried to add ${dir})`,
        );
    }

    process.env.PATH = `${process.env.PATH ?? ""};${dir}`;
    return true;
}

// install.ts Unix PATH rc-file append (lines 256–269)
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

**Variations / call-sites:**

- `packages/atomic/src/commands/cli/install.ts:343–353` — Rc-file snippet template (shell-aware: fish vs bash/zsh case block)
- `packages/atomic/src/commands/cli/install.ts:592–604` — Uninstall mirror (removeWindowsPath, stripRcSnippet)

---

#### Pattern 6: tmux/psmux Detection (Agent-Specific Coupling)

**Where:** `packages/atomic/src/commands/cli/install.ts:403–462`
**What:** Detect mux binary on PATH or in well-known dirs; persist its dir to PATH if not already there. **This is tmux-specific and must be removed for pi-coding-agent.**

```typescript
// install.ts mux detection (lines 411–433)
function detectMuxBinary(): MuxDetection {
    const candidates = isWindows() ? ["psmux", "pmux"] : ["tmux"];
    const ext = isWindows() ? ".exe" : "";

    // 1. Already on PATH?
    for (const name of candidates) {
        const found = Bun.which(name, { PATH: process.env.PATH ?? "" });
        if (found)
            return { binary: name, directory: dirname(found), onPath: true };
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

// install.ts well-known dirs (lines 435–462)
export function wellKnownMuxInstallDirs(): string[] {
    const home = homedir();
    if (isWindows()) {
        const localAppData =
            process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
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
            process.env.ChocolateyInstall
                ? join(process.env.ChocolateyInstall, "bin")
                : null,
            "C:\\ProgramData\\chocolatey\\bin",
        ];
        return dirs.filter((d): d is string => d !== null);
    }
    return [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/snap/bin",
        "/opt/local/bin",
    ];
}
```

**Variations / call-sites:**

- `packages/atomic/src/commands/cli/install.ts:776–796` — Call-site in installCommand: warn if mux not found, add mux dir to PATH if found but not on PATH
- **Removal seam for pi-coding-agent:** Delete lines 403–796 (entire mux detection block) and lines 776–796 (mux-specific install output). Replace with no-op or pi-specific agent detector.

---

#### Pattern 7: Shell Completions Cache & RC-File Sourcing

**Where:** `packages/atomic/src/commands/cli/install.ts:464–534`
**What:** Write completion script to cache dir (~/.atomic/completions/<shell>), source it from rc files. Fish auto-loads from ~/.config/fish/completions/. Idempotent: strip legacy eval-based snippet before appending new cache-source line.

```typescript
// install.ts installCompletions (lines 472–497)
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
        // Fish auto-loads from ~/.config/fish/completions/
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

// install.ts ensureCompletionsSourcedFromRc (lines 509–534)
export function ensureCompletionsSourcedFromRc(
    rcPath: string,
    shell: Shell,
    cachePath: string,
): void {
    if (!existsSync(rcPath)) {
        mkdirSync(dirname(rcPath), { recursive: true });
        writeFileSync(rcPath, "");
    }
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

**Variations / call-sites:**

- `packages/atomic/src/commands/cli/install.ts:33–38` — COMPLETION_SCRIPTS map (imports from completions/index.ts)
- `packages/atomic/src/commands/cli/install.ts:40–41` — RC_MARKER and PATH_RC_MARKER for idempotency
- **For pi-coding-agent:** Rename RC_MARKER to pi-agnostic identifier, import pi completions (if any)

---

## Atomic-Specific vs. Agent-Agnostic Code

### Must Remove for pi-coding-agent Rewrite

1. **tmux/psmux detection** (install.ts:403–462, referenced at :776–796)
    - Replace with pi-specific fallback or no-op detector

2. **Atomic-branded markers and messages**
    - RC_MARKER = `"# Atomic CLI completions (cached)"` (install.ts:40)
    - PATH_RC_MARKER = `"# Atomic CLI PATH"` (install.ts:41)
    - Brand strings in output ("Atomic installed successfully", "Atomic uninstalled", etc.)

3. **Atomic package manager hints** (install.ts:613–618)
    - bun remove -g @bastani/atomic
    - Tie to pi package name and registry

### Agent-Agnostic (Reusable for pi-coding-agent)

1. **Two-stage bootstrap** (install.ps1/sh/cmd + install.ts binary handoff)
2. **Manifest-driven download + checksum verification**
3. **Atomic move** (copy-chmod-rename for safe binary placement)
4. **Artifact reaper** (cleanup orphans mid-install)
5. **Idempotent PATH persistence** (registry on Windows, rc-file on Unix)
6. **Shell detection** (detectUserShell, SHELL env var fallback + /etc/passwd)
7. **Completions cache** (shell-aware sourcing, legacy migration)
8. **Platform detection** (isWindows, ARM64, musl libc fallback)
9. **PowerShell spawn utilities** (runPowerShell, detectPSProfiles)

### Seams for pi-coding-agent Extensions

1. **manifest.json URL**: Parameterize org/repo (currently hardcoded `bastani/atomic`)
    - install.ps1:30, install.sh:24, install.cmd:51
    - install.ts: none (binary uses hardcoded URL; move to config)

2. **Completion script sources**: Replace `COMPLETION_SCRIPTS` map (install.ts:33–38)
    - Inject pi completions or fetch from pi-specific URL

3. **Install paths**: Parameterize via env or config instead of hardcoded homedir subdirs
    - install.ts:58–74 (getInstallPaths)

4. **Agent detector**: Replace detectMuxBinary call-site (install.ts:776) with pi-specific equivalent
    - Could check for pi-coding-agent-specific environment vars or config

---

## Modeled on Claude Code's install.ts

Comments throughout install.ts (and install.ps1) reference Claude Code's installer as the template: lines 4–5, 83–86, 107–110, 136–146, 357–367, 812–813. This means the bootstrap pattern is proven across two coding agents (Claude Code, Atomic) and is safe to fork for pi-coding-agent—just update references, markers, and the agent detector.
