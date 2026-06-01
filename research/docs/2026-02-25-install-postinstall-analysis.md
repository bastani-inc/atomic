---
date: 2026-02-25
researcher: Claude Code (codebase-analyzer agent)
git_commit: TBD
branch: main
repository: playwright-cli (atomic fork)
topic: "Installation and Postinstall Infrastructure Analysis"
tags: [analysis, installation, postinstall, config-sync, skills]
status: complete
---

# Analysis: Installation and Postinstall Infrastructure

## Overview

The Atomic CLI uses a multi-stage installation and configuration sync system. The infrastructure supports three installation modes (source, npm, binary) and ensures that bundled agent configurations (.claude, .opencode, .copilot) are synced to `~/.atomic` for global discovery while intelligently excluding SCM-specific skills (gh-_, sl-_) that should be project-scoped.

## Entry Points

The installation infrastructure has three main entry points:

1. **`install.sh`** - Unix/macOS shell installer (bash)
2. **`install.ps1`** - Windows PowerShell installer
3. **`src/scripts/postinstall.ts`** - npm/bun package postinstall hook

All three paths eventually call the same core logic in `src/utils/atomic-global-config.ts`.

---

## 1. `install.sh` - Unix/macOS Shell Installer

### Overview

A bash script that downloads pre-compiled binaries from GitHub Releases and syncs bundled config templates to `~/.atomic`.

### Entry Point

- Lines 174-259: `main()` function orchestrates the entire installation

### Core Implementation

#### 1. Configuration and Setup (`install.sh:8-20`)

```bash
GITHUB_REPO="bastani-inc/atomic"
BINARY_NAME="atomic"
BIN_DIR="${ATOMIC_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
ATOMIC_HOME="$HOME/.atomic"
```

**Key Variables:**

- `BIN_DIR` - Where the binary executable is installed (default: `~/.local/bin`)
- `DATA_DIR` - Where config templates are extracted (default: `~/.local/share/atomic`)
- `ATOMIC_HOME` - Global agent config directory (`~/.atomic`)

#### 2. Platform Detection (`install.sh:28-60`)

The `detect_platform()` function identifies OS and architecture:

**OS Detection (lines 33-43):**

- Maps `uname -s` output to: `linux`, `darwin`
- On Windows (MinGW/Cygwin/MSYS), delegates to PowerShell installer at line 39

**Architecture Detection (lines 45-49):**

- Maps `uname -m` to: `x64` (from x86_64/amd64) or `arm64` (from arm64/aarch64)

**Rosetta 2 Detection (lines 52-57):**

- On macOS with x64 architecture, checks `sysctl.proc_translated`
- If running under Rosetta 2 emulation, switches to native `arm64` binary
- This ensures Apple Silicon Macs get the ARM binary even if shell runs in x64 mode

**Returns:** Platform string in format `${os}-${arch}` (e.g., "linux-x64", "darwin-arm64")

#### 3. Binary Download and Verification (`install.sh:199-221`)

**Download URLs (lines 199-202):**

```bash
base_url="https://github.com/${GITHUB_REPO}/releases/download/${version}"
download_url="${base_url}/${BINARY_NAME}-${platform}"
config_url="${base_url}/${BINARY_NAME}-config.tar.gz"
checksums_url="${base_url}/checksums.txt"
```

**Download Process:**

1. Line 206: Downloads binary to temp directory using `curl`
2. Line 212: Downloads config tarball (`atomic-config.tar.gz`)
3. Line 216: Downloads checksums file

**Checksum Verification (lines 113-140):**

- `verify_checksum()` function validates SHA256 checksums
- Lines 127-133: Uses `sha256sum` (Linux) or `shasum -a 256` (macOS)
- Lines 135-137: Fails installation if checksums don't match
- Protects against corrupted downloads or man-in-the-middle attacks

#### 4. Config Files Extraction (`install.sh:228-231`)

```bash
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
tar -xzf "${tmp_dir}/${BINARY_NAME}-config.tar.gz" -C "$DATA_DIR"
```

**Behavior:**

- Performs a **clean install** by removing existing `$DATA_DIR`
- Extracts tarball contents to `~/.local/share/atomic/`
- Tarball contains: `.claude/`, `.opencode/`, `.github/`, `.mcp.json`

#### 5. `sync_global_agent_configs()` Function (`install.sh:144-165`)

This is the **critical configuration sync logic** that populates `~/.atomic`:

**Directory Creation (line 147):**

```bash
mkdir -p "$ATOMIC_HOME/.claude" "$ATOMIC_HOME/.opencode" "$ATOMIC_HOME/.copilot"
```

**Config Copying (lines 149-155):**

```bash
cp -R "$source_root/.claude/." "$ATOMIC_HOME/.claude/"
cp -R "$source_root/.opencode/." "$ATOMIC_HOME/.opencode/"
cp -R "$source_root/.github/." "$ATOMIC_HOME/.copilot/"

if [[ -f "$source_root/.mcp.json" ]]; then
    cp "$source_root/.mcp.json" "$ATOMIC_HOME/.mcp.json"
fi
```

**Key Mapping:**

- `.claude/` → `~/.atomic/.claude/`
- `.opencode/` → `~/.atomic/.opencode/`
- `.github/` → `~/.atomic/.copilot/` (note the rename!)
- `.mcp.json` → `~/.atomic/.mcp.json`

**SCM Skill Exclusion (lines 158-160):**

```bash
rm -rf "$ATOMIC_HOME/.claude/skills/gh-"* "$ATOMIC_HOME/.claude/skills/sl-"* 2>/dev/null || true
rm -rf "$ATOMIC_HOME/.opencode/skills/gh-"* "$ATOMIC_HOME/.opencode/skills/sl-"* 2>/dev/null || true
rm -rf "$ATOMIC_HOME/.copilot/skills/gh-"* "$ATOMIC_HOME/.copilot/skills/sl-"* 2>/dev/null || true
```

**Why exclude SCM skills?**

- Skills prefixed with `gh-*` (GitHub) and `sl-*` (Sapling) are **project-scoped**
- These are installed per-repository via `atomic init` command
- Global installation would conflict with per-project SCM configuration
- Examples: `gh-commit`, `gh-create-pr`, `sl-commit`, `sl-submit-diff`

**Copilot Cleanup (lines 163-164):**

```bash
rm -rf "$ATOMIC_HOME/.copilot/workflows" 2>/dev/null || true
rm -f "$ATOMIC_HOME/.copilot/dependabot.yml" 2>/dev/null || true
```

**Rationale:**

- Keeps Copilot global config focused on skills/agents/instructions/MCP
- Removes GitHub-specific workflow and dependency management files
- These belong in project repositories, not global config

#### 6. PATH Configuration (`install.sh:84-110`, `245-253`)

**Shell Detection (lines 63-81):**

- Detects user's shell from `$SHELL` variable
- Supports: fish, zsh, bash, and generic shells

**PATH Addition (lines 84-110):**

- For fish: Uses `fish_add_path $BIN_DIR`
- For bash/zsh: Uses `export PATH="$BIN_DIR:$PATH"`
- Only adds if `$BIN_DIR` not already in config
- Creates config file if it doesn't exist

**Execution (lines 245-253):**

- Checks if `$BIN_DIR` already in current `$PATH`
- If not, adds it to detected shell config file
- Warns user to restart shell or source config file

### Data Flow

```
GitHub Release
    ↓
1. Download atomic-linux-x64 (binary)
2. Download atomic-config.tar.gz (configs)
3. Download checksums.txt
    ↓
4. Verify checksums (SHA256)
    ↓
5. Install binary → ~/.local/bin/atomic
6. Extract configs → ~/.local/share/atomic/
    ↓
7. sync_global_agent_configs():
   - Copy ~/.local/share/atomic/.claude/ → ~/.atomic/.claude/
   - Copy ~/.local/share/atomic/.opencode/ → ~/.atomic/.opencode/
   - Copy ~/.local/share/atomic/.github/ → ~/.atomic/.copilot/
   - Copy ~/.local/share/atomic/.mcp.json → ~/.atomic/.mcp.json
   - Remove ~/.atomic/*/skills/gh-*
   - Remove ~/.atomic/*/skills/sl-*
   - Remove ~/.atomic/.copilot/workflows
   - Remove ~/.atomic/.copilot/dependabot.yml
    ↓
8. Add ~/.local/bin to PATH in shell config
```

### Key Patterns

- **Clean Install Strategy**: Removes `$DATA_DIR` before extraction to avoid stale files
- **Security**: SHA256 checksum verification prevents compromised downloads
- **Cross-Platform**: Delegates to PowerShell on Windows detection
- **Atomic Operations**: Uses temp directory with EXIT trap for cleanup
- **Idempotent PATH**: Only adds to shell config if not already present

---

## 2. `install.ps1` - Windows PowerShell Installer

### Overview

PowerShell script providing equivalent functionality to `install.sh` for Windows platforms.

### Entry Point

- Lines 113-235: Main installation logic (not in a named function)

### Core Implementation

#### 1. Configuration (`install.ps1:13-18`)

```powershell
$GithubRepo = "bastani-inc/atomic"
$BinaryName = "atomic"
$BinDir = if ($env:ATOMIC_INSTALL_DIR) { $env:ATOMIC_INSTALL_DIR } elseif ($InstallDir) { $InstallDir } else { "${Home}\.local\bin" }
$DataDir = if ($env:LOCALAPPDATA) { "${env:LOCALAPPDATA}\atomic" } else { "${Home}\AppData\Local\atomic" }
$AtomicHome = "${Home}\.atomic"
```

**Key Differences from Unix:**

- `$DataDir` uses `%LOCALAPPDATA%\atomic` instead of XDG data home
- `$BinDir` uses `\.local\bin` under user home
- Binary has `.exe` extension

#### 2. Architecture Detection (`install.ps1:66-75`)

```powershell
$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $Target = "windows-x64.exe" }
    "ARM64" { $Target = "windows-arm64.exe" }
    default {
        Write-Err "Unsupported architecture: $Arch"
        exit 1
    }
}
```

**Simpler than Unix:**

- No OS detection needed (PowerShell implies Windows)
- No Rosetta 2 detection needed
- Uses `$env:PROCESSOR_ARCHITECTURE` environment variable

#### 3. Download and Verification (`install.ps1:116-169`)

**Dual Download Strategy (lines 116-131):**

```powershell
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    curl.exe "-#SfLo" $TempBinary $DownloadUrl
} else {
    Write-Info "curl.exe not found, using Invoke-WebRequest..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempBinary -UseBasicParsing
}
```

**Fallback Logic:**

- Prefers native `curl.exe` (available in Windows 10 1803+)
- Falls back to PowerShell's `Invoke-WebRequest`
- Provides better compatibility across Windows versions

**Checksum Verification (lines 138-169):**

```powershell
$ExpectedHash = ($ExpectedLine -split '\s+')[0].ToLower()
$ActualHash = (Get-FileHash -Path $TempBinary -Algorithm SHA256).Hash.ToLower()

if ($ActualHash -ne $ExpectedHash) {
    Write-Err "Checksum verification failed!"
    Write-Err "Expected: $ExpectedHash"
    Write-Err "Actual:   $ActualHash"
    exit 1
}
```

**Verifies both:**

1. Binary checksum (lines 138-152)
2. Config archive checksum (lines 155-169)

#### 4. Config Extraction (`install.ps1:175-178`)

```powershell
if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
$null = New-Item -ItemType Directory -Force -Path $DataDir
Expand-Archive -Path $TempConfig -DestinationPath $DataDir -Force
```

**Key Differences:**

- Uses `Expand-Archive` for `.zip` files (not `.tar.gz`)
- Clean install by removing existing `$DataDir`
- Archives are uploaded as `atomic-config.zip` for Windows

#### 5. `Sync-GlobalAgentConfigs` Function (`install.ps1:20-51`)

The PowerShell equivalent of the bash function:

**Directory Creation (lines 27-29):**

```powershell
$null = New-Item -ItemType Directory -Force -Path $claudeDir
$null = New-Item -ItemType Directory -Force -Path $opencodeDir
$null = New-Item -ItemType Directory -Force -Path $copilotDir
```

**Config Copying (lines 31-38):**

```powershell
Copy-Item -Path (Join-Path $SourceRoot ".claude\*") -Destination $claudeDir -Recurse -Force
Copy-Item -Path (Join-Path $SourceRoot ".opencode\*") -Destination $opencodeDir -Recurse -Force
Copy-Item -Path (Join-Path $SourceRoot ".github\*") -Destination $copilotDir -Recurse -Force

$mcpConfigSource = Join-Path $SourceRoot ".mcp.json"
if (Test-Path $mcpConfigSource) {
    Copy-Item -Path $mcpConfigSource -Destination (Join-Path $AtomicHome ".mcp.json") -Force
}
```

**SCM Skill Removal (lines 40-47):**

```powershell
foreach ($agentDir in @($claudeDir, $opencodeDir, $copilotDir)) {
    $skillsDir = Join-Path $agentDir "skills"
    if (Test-Path $skillsDir) {
        Get-ChildItem -Path $skillsDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "gh-*" -or $_.Name -like "sl-*" } |
            ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
    }
}
```

**Copilot Cleanup (lines 49-50):**

```powershell
Remove-Item -Recurse -Force (Join-Path $copilotDir "workflows") -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $copilotDir "dependabot.yml") -ErrorAction SilentlyContinue
```

**Implementation Notes:**

- Uses PowerShell cmdlets instead of Unix commands
- Same exclusion logic as bash version
- Handles errors gracefully with `-ErrorAction SilentlyContinue`

#### 6. PATH Configuration (`install.ps1:194-222`)

**User PATH Update (lines 196-199):**

```powershell
$UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*${BinDir}*") {
    [System.Environment]::SetEnvironmentVariable('Path', "${BinDir};${UserPath}", 'User')
    $env:Path = "${BinDir};${env:Path}"
}
```

**Environment Broadcast (lines 202-215):**

```powershell
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@

[Win32.NativeMethods]::SendMessageTimeout(
    [IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result
) | Out-Null
```

**Advanced Windows Feature:**

- Uses P/Invoke to call Win32 API `SendMessageTimeout`
- Broadcasts `WM_SETTINGCHANGE` message (0x1A) to all windows
- Message parameter "Environment" notifies of PATH change
- Allows new terminals to pick up PATH without system restart
- Handles errors gracefully (warns if broadcast fails)

### Data Flow

```
GitHub Release
    ↓
1. Download atomic-windows-x64.exe
2. Download atomic-config.zip (not .tar.gz)
3. Download checksums.txt
    ↓
4. Verify checksums (SHA256)
    ↓
5. Install binary → %USERPROFILE%\.local\bin\atomic.exe
6. Extract configs → %LOCALAPPDATA%\atomic\
    ↓
7. Sync-GlobalAgentConfigs:
   - Copy %LOCALAPPDATA%\atomic\.claude\ → %USERPROFILE%\.atomic\.claude\
   - Copy %LOCALAPPDATA%\atomic\.opencode\ → %USERPROFILE%\.atomic\.opencode\
   - Copy %LOCALAPPDATA%\atomic\.github\ → %USERPROFILE%\.atomic\.copilot\
   - Copy %LOCALAPPDATA%\atomic\.mcp.json → %USERPROFILE%\.atomic\.mcp.json
   - Remove %USERPROFILE%\.atomic\*\skills\gh-*
   - Remove %USERPROFILE%\.atomic\*\skills\sl-*
   - Remove %USERPROFILE%\.atomic\.copilot\workflows
   - Remove %USERPROFILE%\.atomic\.copilot\dependabot.yml
    ↓
8. Add %USERPROFILE%\.local\bin to User PATH
9. Broadcast WM_SETTINGCHANGE to notify system
```

### Key Patterns

- **Dual Download Strategy**: curl.exe fallback to Invoke-WebRequest
- **Win32 API Integration**: Uses P/Invoke for environment broadcast
- **PowerShell Idioms**: Uses `-ErrorAction SilentlyContinue` extensively
- **Same Core Logic**: Mirrors bash implementation with PowerShell syntax

---

## 3. `src/scripts/postinstall.ts` - npm/bun Postinstall Hook

### Overview

A Bun script that runs after `npm install` or `bun install` to sync bundled configs to `~/.atomic`.

### Entry Point

- Lines 15-25: `main()` function

### Core Implementation

#### 1. Imports (`postinstall.ts:3-7`)

```typescript
import {
    hasAtomicGlobalAgentConfigs,
    syncAtomicGlobalAgentConfigs,
} from "../utils/atomic-global-config";
import { getConfigRoot } from "../utils/config-path";
```

**Dependencies:**

- `atomic-global-config.ts` - Core sync logic
- `config-path.ts` - Installation type detection and path resolution

#### 2. Main Function (`postinstall.ts:15-25`)

```typescript
async function main(): Promise<void> {
    try {
        await syncAtomicGlobalAgentConfigs(getConfigRoot());
        await verifyAtomicGlobalConfigSync();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `[atomic] Warning: failed to sync ~/.atomic global configs: ${message}`,
        );
    }
}
```

**Error Handling:**

- Wrapped in try-catch at lines 16-22
- Failures are **warnings, not errors**
- Allows installation to succeed even if sync fails
- Useful for restricted environments or CI systems

#### 3. Verification (`postinstall.ts:9-13`)

```typescript
async function verifyAtomicGlobalConfigSync(): Promise<void> {
    if (!(await hasAtomicGlobalAgentConfigs())) {
        throw new Error("Missing synced global config entries in ~/.atomic");
    }
}
```

**Validation:**

- Calls `hasAtomicGlobalAgentConfigs()` from atomic-global-config.ts
- Ensures required directories and files exist after sync
- Throws error if verification fails (caught by main)

#### 4. Execution (`postinstall.ts:25`)

```typescript
await main();
```

**Top-level await:**

- Enabled by Bun runtime
- Script runs synchronously during install
- Blocks until sync completes or fails

### Configuration in `package.json`

#### Postinstall Script (`package.json:40`)

```json
"scripts": {
  "postinstall": "lefthook install && bun run src/scripts/postinstall.ts"
}
```

**Execution Order:**

1. `lefthook install` - Sets up Git hooks
2. `bun run src/scripts/postinstall.ts` - Syncs global configs

**When it runs:**

- After `npm install` or `bun install`
- After `npm install -g @bastani/atomic`
- Not during binary installations (install.sh/install.ps1)

#### Files Field (`package.json:22-31`)

```json
"files": [
  "src",
  "assets/settings.schema.json",
  ".claude",
  ".opencode",
  ".mcp.json",
  ".github/skills",
  ".github/agents",
  ".github/mcp-config.json"
]
```

**What gets bundled:**

- All TypeScript source (`src/`)
- Config templates (`.claude/`, `.opencode/`, `.github/`)
- MCP configuration files (`.mcp.json`, `.github/mcp-config.json`)
- **Excludes:** `.github/workflows`, `.github/dependabot.yml`

**Why this matters:**

- npm package contains all templates needed for sync
- Smaller package size by excluding CI/CD files
- Matches exclusion logic in installer scripts

### Data Flow

```
npm/bun install
    ↓
1. Install package to node_modules/@bastani/atomic/
2. Run postinstall script
    ↓
3. getConfigRoot() determines installation type:
   - Source: ~/project/atomic (repo root)
   - npm: ~/project/node_modules/@bastani/atomic
   - Binary: ~/.local/share/atomic (not applicable here)
    ↓
4. syncAtomicGlobalAgentConfigs(configRoot):
   - Copies configRoot/.claude/ → ~/.atomic/.claude/
   - Copies configRoot/.opencode/ → ~/.atomic/.opencode/
   - Copies configRoot/.github/ → ~/.atomic/.copilot/
   - Copies configRoot/.mcp.json → ~/.atomic/.mcp.json
   - Excludes gh-*, sl-* skills
   - Cleans up copilot workflows/dependabot.yml
    ↓
5. hasAtomicGlobalAgentConfigs() verifies sync
6. Success or warning logged
```

### Key Patterns

- **Non-blocking**: Warnings instead of errors for failures
- **Idempotent**: Safe to run multiple times
- **Installation-aware**: Uses `getConfigRoot()` for different install types
- **Verification**: Validates sync completed successfully

---

## 4. `src/utils/atomic-global-config.ts` - Core Sync Logic

### Overview

The central module implementing all configuration sync logic used by both installer scripts (via shell) and postinstall (directly).

### Entry Point

- Line 128: `syncAtomicGlobalAgentConfigs()` - Main sync function

### Core Implementation

#### 1. Configuration Constants (`atomic-global-config.ts:8-34`)

**Home Directory (line 8):**

```typescript
const ATOMIC_HOME_DIR = join(homedir(), ".atomic");
```

**SCM Skill Prefixes (line 10):**

```typescript
export const MANAGED_SCM_SKILL_PREFIXES = ["gh-", "sl-"] as const;
```

**Global Agent Folders (lines 12-16):**

```typescript
const GLOBAL_AGENT_FOLDER_BY_KEY: Record<AgentKey, string> = {
    claude: ".claude",
    opencode: ".opencode",
    copilot: ".copilot",
};
```

**Template Source Folders (lines 18-23):**

```typescript
const TEMPLATE_AGENT_FOLDER_BY_KEY: Record<AgentKey, string> = {
    claude: AGENT_CONFIG.claude.folder, // ".claude"
    opencode: AGENT_CONFIG.opencode.folder, // ".opencode"
    copilot: AGENT_CONFIG.copilot.folder, // ".github"
};
```

**Required Entries for Verification (lines 25-29):**

```typescript
const REQUIRED_GLOBAL_CONFIG_ENTRIES: Record<AgentKey, string[]> = {
    claude: ["agents", "skills", "settings.json"],
    opencode: ["agents", "skills", "opencode.json"],
    copilot: ["agents", "skills"],
};
```

**Atomic Home Required Files (lines 31-34):**

```typescript
const REQUIRED_ATOMIC_HOME_ENTRIES = [
    ".mcp.json",
    join(".copilot", "mcp-config.json"),
] as const;
```

#### 2. SCM Skill Management (`atomic-global-config.ts:70-101`)

**Identification (lines 71-73):**

```typescript
export function isManagedScmSkillName(name: string): boolean {
    return MANAGED_SCM_SKILL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
```

**Pruning (lines 78-88):**

```typescript
async function pruneManagedScmSkills(agentDir: string): Promise<void> {
    const skillsDir = join(agentDir, "skills");
    if (!(await pathExists(skillsDir))) return;

    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!isManagedScmSkillName(entry.name)) continue;
        await rm(join(skillsDir, entry.name), { recursive: true, force: true });
    }
}
```

**Purpose:**

- Removes stale SCM skills from previous installations
- Ensures clean state for project-specific skill management
- Called after copying templates (line 147)

**Exclude List Generation (lines 93-101):**

```typescript
async function getManagedScmSkillExcludes(
    sourceDir: string,
): Promise<string[]> {
    const skillsDir = join(sourceDir, "skills");
    if (!(await pathExists(skillsDir))) return [];

    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
        .filter(
            (entry) => entry.isDirectory() && isManagedScmSkillName(entry.name),
        )
        .map((entry) => join("skills", entry.name));
}
```

**Purpose:**

- Builds exclusion paths for SCM skills in source directory
- Used by `copyDir()` to skip copying these skills
- Returns relative paths like: `["skills/gh-commit", "skills/sl-commit"]`

#### 3. MCP Config Sync (`atomic-global-config.ts:106-119`)

```typescript
async function syncAtomicGlobalMcpConfigs(
    configRoot: string,
    baseDir: string,
): Promise<void> {
    const claudeMcpSource = join(configRoot, ".mcp.json");
    const claudeMcpDestination = join(baseDir, ".mcp.json");
    if (await pathExists(claudeMcpSource)) {
        await copyFile(claudeMcpSource, claudeMcpDestination);
    }

    const copilotMcpSource = join(
        configRoot,
        AGENT_CONFIG.copilot.folder,
        "mcp-config.json",
    );
    const copilotMcpDestination = join(
        baseDir,
        GLOBAL_AGENT_FOLDER_BY_KEY.copilot,
        "mcp-config.json",
    );
    if (await pathExists(copilotMcpSource)) {
        await mkdir(join(baseDir, GLOBAL_AGENT_FOLDER_BY_KEY.copilot), {
            recursive: true,
        });
        await copyFile(copilotMcpSource, copilotMcpDestination);
    }
}
```

**Two MCP Files:**

1. **Claude MCP** (lines 107-111):
    - Source: `{configRoot}/.mcp.json`
    - Destination: `~/.atomic/.mcp.json`
2. **Copilot MCP** (lines 113-118):
    - Source: `{configRoot}/.github/mcp-config.json`
    - Destination: `~/.atomic/.copilot/mcp-config.json`

**Conditional Copying:**

- Only copies if source file exists
- Creates parent directory for Copilot MCP if needed

#### 4. Main Sync Function (`atomic-global-config.ts:128-151`)

```typescript
export async function syncAtomicGlobalAgentConfigs(
    configRoot: string,
    baseDir: string = ATOMIC_HOME_DIR,
): Promise<void> {
    await mkdir(baseDir, { recursive: true });

    const agentKeys = Object.keys(AGENT_CONFIG) as AgentKey[];
    for (const agentKey of agentKeys) {
        const sourceFolder = join(configRoot, getTemplateAgentFolder(agentKey));
        if (!(await pathExists(sourceFolder))) continue;

        const destinationFolder = join(
            baseDir,
            getAtomicGlobalAgentFolder(agentKey),
        );
        const scmSkillExcludes = await getManagedScmSkillExcludes(sourceFolder);

        await copyDir(sourceFolder, destinationFolder, {
            exclude: [...AGENT_CONFIG[agentKey].exclude, ...scmSkillExcludes],
        });

        // Ensure stale managed SCM skills from previous installs are removed.
        await pruneManagedScmSkills(destinationFolder);
    }

    await syncAtomicGlobalMcpConfigs(configRoot, baseDir);
}
```

**Step-by-Step:**

1. **Create Base Directory (line 132):**
    - Ensures `~/.atomic/` exists

2. **Iterate Agent Keys (lines 134-149):**
    - Loops through: `claude`, `opencode`, `copilot`

3. **For Each Agent (lines 135-148):**

    **a. Resolve Paths (lines 136-140):**

    ```typescript
    const sourceFolder = join(configRoot, getTemplateAgentFolder(agentKey));
    const destinationFolder = join(
        baseDir,
        getAtomicGlobalAgentFolder(agentKey),
    );
    ```

    - Example for Claude:
        - Source: `{configRoot}/.claude`
        - Destination: `~/.atomic/.claude`

    **b. Build Exclusion List (line 141):**

    ```typescript
    const scmSkillExcludes = await getManagedScmSkillExcludes(sourceFolder);
    ```

    - Scans source folder for `gh-*` and `sl-*` skill directories
    - Returns relative paths to exclude

    **c. Copy with Exclusions (lines 143-145):**

    ```typescript
    await copyDir(sourceFolder, destinationFolder, {
        exclude: [...AGENT_CONFIG[agentKey].exclude, ...scmSkillExcludes],
    });
    ```

    - Merges agent-specific excludes from config.ts
    - Merges SCM skill excludes from step b
    - Example for Copilot:
        - Agent excludes: `["workflows", "dependabot.yml", "mcp-config.json", ".DS_Store"]`
        - SCM excludes: `["skills/gh-commit", "skills/sl-commit", ...]`

    **d. Prune Stale Skills (line 148):**

    ```typescript
    await pruneManagedScmSkills(destinationFolder);
    ```

    - Removes any `gh-*` or `sl-*` directories that may have slipped through
    - Cleans up skills from previous installations

4. **Sync MCP Configs (line 150):**
    - Copies `.mcp.json` files for both Claude and Copilot

#### 5. Verification Function (`atomic-global-config.ts:156-183`)

```typescript
export async function hasAtomicGlobalAgentConfigs(
    baseDir: string = ATOMIC_HOME_DIR,
): Promise<boolean> {
    const agentKeys = Object.keys(AGENT_CONFIG) as AgentKey[];

    for (const agentKey of agentKeys) {
        const agentDir = join(baseDir, getAtomicGlobalAgentFolder(agentKey));
        if (!(await pathExists(agentDir))) return false;

        const requiredEntries = REQUIRED_GLOBAL_CONFIG_ENTRIES[agentKey];
        const entryChecks = await Promise.all(
            requiredEntries.map((entryName) =>
                pathExists(join(agentDir, entryName)),
            ),
        );

        if (entryChecks.some((exists) => !exists)) {
            return false;
        }
    }

    const atomicHomeChecks = await Promise.all(
        REQUIRED_ATOMIC_HOME_ENTRIES.map((entryName) =>
            pathExists(join(baseDir, entryName)),
        ),
    );
    if (atomicHomeChecks.some((exists) => !exists)) {
        return false;
    }

    return true;
}
```

**Verification Steps:**

1. **Check Agent Directories (lines 161-173):**
    - For each agent (claude, opencode, copilot):
        - Verify directory exists
        - Verify required entries exist
    - Example for Claude:
        - `~/.atomic/.claude/agents/` must exist
        - `~/.atomic/.claude/skills/` must exist
        - `~/.atomic/.claude/settings.json` must exist

2. **Check Atomic Home Entries (lines 175-179):**
    - Verify `~/.atomic/.mcp.json` exists
    - Verify `~/.atomic/.copilot/mcp-config.json` exists

3. **Return Result (line 181):**
    - Returns `true` only if all checks pass
    - Used by postinstall script to validate sync

#### 6. Agent Config Source (`src/config.ts:29-70`)

Referenced by atomic-global-config.ts at line 5:

```typescript
export const AGENT_CONFIG: Record<AgentKey, AgentConfig> = {
    claude: {
        name: "Claude Code",
        cmd: "claude",
        additional_flags: [],
        folder: ".claude",
        install_url: "https://code.claude.com/docs/en/setup",
        exclude: [".DS_Store"],
        additional_files: [".mcp.json"],
        preserve_files: [],
        merge_files: [".mcp.json"],
    },
    opencode: {
        name: "OpenCode",
        cmd: "opencode",
        additional_flags: [],
        folder: ".opencode",
        install_url: "https://opencode.ai",
        exclude: [
            "node_modules",
            ".gitignore",
            "bun.lock",
            "package.json",
            ".DS_Store",
        ],
        additional_files: [],
        preserve_files: [],
        merge_files: [],
    },
    copilot: {
        name: "GitHub Copilot CLI",
        cmd: "copilot",
        additional_flags: [
            "--add-dir",
            ".",
            "--yolo",
            "--disable-builtin-mcps",
        ],
        folder: ".github",
        install_url:
            "https://github.com/github/copilot-cli?tab=readme-ov-file#installation",
        exclude: [
            "workflows",
            "dependabot.yml",
            "mcp-config.json",
            ".DS_Store",
        ],
        additional_files: [".github/mcp-config.json"],
        preserve_files: [],
        merge_files: [".github/mcp-config.json"],
    },
};
```

**Key Fields for Sync:**

- `folder` - Source directory in package/binary data
- `exclude` - Paths to skip during copy
- `additional_files` - Extra files to copy from repo root
- `merge_files` - Files to merge (not overwrite) when exists

### Data Flow

```
syncAtomicGlobalAgentConfigs(configRoot, baseDir)
    ↓
1. Create ~/.atomic/ directory
    ↓
2. For each agent (claude, opencode, copilot):
   a. Resolve source folder:
      - claude: {configRoot}/.claude
      - opencode: {configRoot}/.opencode
      - copilot: {configRoot}/.github
   b. Resolve destination folder:
      - claude: ~/.atomic/.claude
      - opencode: ~/.atomic/.opencode
      - copilot: ~/.atomic/.copilot
   c. Scan source for SCM skills (gh-*, sl-*)
   d. Build exclusion list:
      - Agent-specific excludes from AGENT_CONFIG
      - SCM skill directories
   e. Copy with exclusions using copyDir()
   f. Prune any remaining SCM skills from destination
    ↓
3. Copy MCP configs:
   - {configRoot}/.mcp.json → ~/.atomic/.mcp.json
   - {configRoot}/.github/mcp-config.json → ~/.atomic/.copilot/mcp-config.json
    ↓
Complete
```

### Key Patterns

- **Abstraction**: Used by both shell scripts and TypeScript postinstall
- **Double Protection**: Both excludes during copy AND prunes after
- **Verification**: Separate function to validate sync success
- **Configuration-Driven**: Uses AGENT_CONFIG for all agent-specific logic
- **Idempotent**: Safe to run multiple times

---

## 5. Copy Utilities (`src/utils/copy.ts`)

### Overview

Provides cross-platform file/directory copying with exclusions, used by atomic-global-config.ts.

### Key Functions

#### 1. `copyDir()` (`copy.ts:117-185`)

The main recursive directory copy function used by `syncAtomicGlobalAgentConfigs()`.

**Signature (lines 117-122):**

```typescript
export async function copyDir(
    src: string,
    dest: string,
    options: CopyOptions = {},
    rootSrc?: string,
): Promise<void>;
```

**Parameters:**

- `src` - Source directory path
- `dest` - Destination directory path
- `options` - Copy options including exclusions
- `rootSrc` - Root source path for calculating relative paths (internal)

**Copy Options (lines 32-37):**

```typescript
interface CopyOptions {
    exclude?: string[];
    skipOppositeScripts?: boolean;
}
```

**Implementation:**

**a. Setup (lines 124-128):**

```typescript
const { exclude = [], skipOppositeScripts = true } = options;
const root = rootSrc ?? src;
await mkdir(dest, { recursive: true });
const entries = await readdir(src, { withFileTypes: true });
```

**b. Platform Script Filtering (line 134):**

```typescript
const oppositeExt = getOppositeScriptExtension();
```

- Returns `.ps1` on Unix, `.sh` on Windows
- Skips installer scripts for opposite platform

**c. Entry Processing Loop (lines 139-173):**

```typescript
for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    // Validate destination path doesn't escape
    if (!isPathSafe(dest, entry.name)) {
        throw new Error(`Path traversal detected: ${entry.name}`);
    }

    // Calculate relative path from root
    const relativePath = relative(root, srcPath);

    // Check if this path should be excluded
    if (shouldExclude(relativePath, entry.name, exclude)) {
        continue;
    }

    // Skip opposite platform scripts
    if (skipOppositeScripts && extname(entry.name) === oppositeExt) {
        continue;
    }

    if (entry.isDirectory()) {
        copyPromises.push(copyDir(srcPath, destPath, options, root));
    } else if (entry.isFile()) {
        copyPromises.push(copyFile(srcPath, destPath));
    } else if (entry.isSymbolicLink()) {
        copyPromises.push(copySymlinkAsFile(srcPath, destPath));
    }
}
```

**d. Parallel Execution (line 176):**

```typescript
await Promise.all(copyPromises);
```

- Copies all files/subdirectories in parallel for performance

**Security Features:**

- **Path traversal protection** (lines 144-148): Prevents `../` escapes
- **Symlink dereferencing** (line 170): Copies target content, not symlink

#### 2. `shouldExclude()` (`copy.ts:80-106`)

Determines if a path should be skipped based on exclusion rules.

```typescript
export function shouldExclude(
    relativePath: string,
    name: string,
    exclude: string[],
): boolean {
    // Check if the name matches any exclusion
    if (exclude.includes(name)) {
        return true;
    }

    // Normalize the relative path for cross-platform comparison
    const normalizedPath = normalizePath(relativePath);

    // Check if the relative path starts with any exclusion
    for (const ex of exclude) {
        const normalizedExclusion = normalizePath(ex);
        if (
            normalizedPath === normalizedExclusion ||
            normalizedPath.startsWith(`${normalizedExclusion}/`)
        ) {
            return true;
        }
    }

    return false;
}
```

**Matching Logic:**

1. **Basename match** (line 86): Checks if `name` exactly matches any exclusion
    - Example: `name="workflows"` matches `exclude=["workflows"]`
2. **Path prefix match** (lines 95-101): Checks if relative path starts with exclusion
    - Example: `relativePath="skills/gh-commit"` matches `exclude=["skills/gh-commit"]`
    - Also matches subdirectories: `"skills/gh-commit/foo"` matches `"skills/gh-commit"`

**Path Normalization (line 92):**

```typescript
const normalizedPath = normalizePath(relativePath);
```

- Converts backslashes to forward slashes
- Ensures Windows paths match Unix-style exclusion patterns

#### 3. `copyFile()` (`copy.ts:43-51`)

```typescript
export async function copyFile(src: string, dest: string): Promise<void> {
    try {
        const srcFile = Bun.file(src);
        await Bun.write(dest, srcFile);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to copy ${src} to ${dest}: ${message}`);
    }
}
```

**Uses Bun's optimized file API:**

- `Bun.file()` - Creates file reference
- `Bun.write()` - Efficiently copies file content

#### 4. `pathExists()` (`copy.ts:190-197`)

```typescript
export async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
```

**Used extensively for:**

- Checking if source folders exist before copying
- Verifying sync completed successfully
- Conditional file copying (MCP configs)

---

## 6. Config Path Resolution (`src/utils/config-path.ts`)

### Overview

Detects installation type and resolves paths to config templates.

### Key Functions

#### 1. `detectInstallationType()` (`config-path.ts:29-45`)

```typescript
export function detectInstallationType(): InstallationType {
    const dir = import.meta.dir;

    // Bun compiled executables use a virtual filesystem with '$bunfs' prefix
    if (
        dir.includes("$bunfs") ||
        dir.startsWith("B:\\") ||
        dir.startsWith("b:\\")
    ) {
        return "binary";
    }

    // Check for node_modules in path (npm/bun installed)
    if (dir.includes("node_modules")) {
        return "npm";
    }

    // Default to source (development mode)
    return "source";
}
```

**Detection Logic:**

1. **Binary**: `import.meta.dir` contains `$bunfs` (Bun's virtual filesystem)
    - Windows may show as `B:\` drive letter
2. **npm**: Path contains `node_modules`
3. **Source**: Everything else (development mode)

**Why this matters:**

- Binary installs read from `~/.local/share/atomic/`
- npm installs read from `node_modules/@bastani/atomic/`
- Source installs read from repo root

#### 2. `getConfigRoot()` (`config-path.ts:77-99`)

```typescript
export function getConfigRoot(): string {
    const installType = detectInstallationType();

    if (installType === "binary") {
        const dataDir = getBinaryDataDir();

        if (!existsSync(dataDir)) {
            throw new Error(
                `Config data directory not found: ${dataDir}\n\n` +
                    `This usually means the installation is incomplete.\n` +
                    `Please reinstall using the install script.`,
            );
        }

        return dataDir;
    }

    // For source and npm installs, navigate up from the current file
    return join(import.meta.dir, "..", "..");
}
```

**Path Resolution:**

- **Binary**: Returns `~/.local/share/atomic/` (or Windows equivalent)
    - Must exist (validated)
    - Populated by install.sh/install.ps1
- **Source/npm**: Returns package root by navigating up from `src/utils/`
    - `src/utils/config-path.ts` → `../..` → package root

**Used By:**

- `postinstall.ts` at line 17: `syncAtomicGlobalAgentConfigs(getConfigRoot())`
- All commands that need to read bundled templates

#### 3. `getBinaryDataDir()` (`config-path.ts:54-64`)

```typescript
export function getBinaryDataDir(): string {
    if (isWindows()) {
        const localAppData =
            process.env.LOCALAPPDATA ||
            join(process.env.USERPROFILE || "", "AppData", "Local");
        return join(localAppData, "atomic");
    }

    // Unix: follow XDG Base Directory spec
    const xdgDataHome =
        process.env.XDG_DATA_HOME ||
        join(process.env.HOME || "", ".local", "share");
    return join(xdgDataHome, "atomic");
}
```

**Platform-Specific Paths:**

- **Unix/macOS**: `$XDG_DATA_HOME/atomic` or `~/.local/share/atomic`
- **Windows**: `%LOCALAPPDATA%\atomic` or `%USERPROFILE%\AppData\Local\atomic`

**Matches installer scripts:**

- install.sh line 12: `DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"`
- install.ps1 line 17: `$DataDir = "${env:LOCALAPPDATA}\atomic"`

---

## Installation Types Comparison

| Aspect              | Binary (install.sh/ps1)  | npm/bun                         | Source         |
| ------------------- | ------------------------ | ------------------------------- | -------------- |
| **Binary Location** | `~/.local/bin/atomic`    | `node_modules/.bin/atomic`      | N/A (bun run)  |
| **Config Source**   | `~/.local/share/atomic/` | `node_modules/@bastani/atomic/` | Repo root      |
| **Sync Trigger**    | install.sh line 234      | package.json postinstall        | Manual or auto |
| **Config Archive**  | atomic-config.tar.gz     | npm package files               | N/A            |
| **PATH Setup**      | Automatic (shell config) | npm handles                     | Manual         |
| **Verification**    | Binary --version check   | hasAtomicGlobalAgentConfigs()   | N/A            |

---

## WHERE to Install New Tools (e.g., Playwright CLI)

### Location Analysis

Based on the infrastructure analysis, here are the **integration points** for adding a new tool like Playwright CLI:

### Option 1: As a Bundled Skill (Recommended)

If Playwright CLI should be available globally across all projects:

**1. Add Skill to Templates**

Create skill directories in bundled templates:

```
.claude/skills/playwright-cli/
.opencode/skills/playwright-cli/
.github/skills/playwright-cli/
```

These will be synced to `~/.atomic/` by the installation system.

**2. Add to package.json Files Array** (`package.json:22-31`)

Add new skill directories to ensure they're included in npm package:

```json
"files": [
  "src",
  ".claude",
  ".claude/skills/playwright-cli",  // Add this
  ".opencode",
  ".opencode/skills/playwright-cli", // Add this
  ".github/skills",
  ".github/skills/playwright-cli",   // Add this
  ...
]
```

**3. No Changes Needed to Installers**

The existing infrastructure will automatically:

- Extract skill from atomic-config.tar.gz (install.sh line 231)
- Expand skill from atomic-config.zip (install.ps1 line 178)
- Copy skill to ~/.atomic/ (sync functions)

**4. Skill Will Be Available Globally**

After installation, all agents can discover:

- `~/.atomic/.claude/skills/playwright-cli/`
- `~/.atomic/.opencode/skills/playwright-cli/`
- `~/.atomic/.copilot/skills/playwright-cli/`

### Option 2: As an SCM-Specific Skill (Project-Scoped)

If Playwright CLI should be project-specific (like gh-_, sl-_):

**1. Name with Prefix Pattern**

Name the skill to match SCM pattern:

```
gh-playwright  # GitHub-specific
sl-playwright  # Sapling-specific
```

**2. Will Be Automatically Excluded**

The infrastructure will automatically:

- Skip during global sync (install.sh lines 158-160)
- Exclude during copy (atomic-global-config.ts line 141)
- Prune from global config (atomic-global-config.ts line 148)

**3. Install Per-Project**

Skills will be installed via `atomic init` command for each repository.

### Option 3: As a Separate Binary Tool

If Playwright CLI is a standalone binary (not an agent skill):

**1. Add to Installer Scripts**

**In install.sh** (after line 226):

```bash
# Install additional tools
info "Installing Playwright CLI..."
curl --fail --location --progress-bar \
  --output "${BIN_DIR}/playwright-cli" \
  "https://github.com/your-org/playwright-cli/releases/download/${PLAYWRIGHT_VERSION}/playwright-cli-${platform}" || \
  warn "Failed to install Playwright CLI"
chmod +x "${BIN_DIR}/playwright-cli"
```

**In install.ps1** (after line 172):

```powershell
# Install additional tools
Write-Info "Installing Playwright CLI..."
try {
    $PlaywrightUrl = "https://github.com/your-org/playwright-cli/releases/download/${PlaywrightVersion}/playwright-cli-${Target}"
    $PlaywrightPath = "${BinDir}\playwright-cli.exe"
    Invoke-WebRequest -Uri $PlaywrightUrl -OutFile $PlaywrightPath -UseBasicParsing
} catch {
    Write-Warn "Failed to install Playwright CLI: $_"
}
```

**2. Add to npm Package**

If distributing as npm package dependency:

```json
"dependencies": {
  "@your-org/playwright-cli": "^1.0.0"
}
```

Then add to bin in package.json:

```json
"bin": {
  "atomic": "src/cli.ts",
  "playwright-cli": "node_modules/@your-org/playwright-cli/bin/cli.js"
}
```

### Option 4: As an MCP Tool

If Playwright CLI should integrate via Model Context Protocol:

**1. Add to MCP Config** (`.mcp.json`)

```json
{
    "mcpServers": {
        "playwright": {
            "command": "npx",
            "args": ["-y", "@your-org/playwright-mcp-server"],
            "env": {}
        }
    }
}
```

**2. Sync Happens Automatically**

The infrastructure will:

- Copy `.mcp.json` to `~/.atomic/.mcp.json` (atomic-global-config.ts line 110)
- Make available to Claude Code and other MCP-compatible agents

### Recommended Approach for Playwright CLI

Based on the codebase patterns, the **recommended approach** is:

**Option 1 (Bundled Skill) + Option 4 (MCP Tool)**

1. **Create skill templates** in `.claude/skills/playwright-cli/`, etc.
2. **Add MCP server config** to `.mcp.json` for tool integration
3. **Include in package.json files array** for npm distribution
4. **Let existing infrastructure handle syncing** to `~/.atomic/`

This provides:

- ✅ Global availability across all projects
- ✅ Agent-agnostic (works with Claude, OpenCode, Copilot)
- ✅ No installer script modifications needed
- ✅ Automatic sync on install/update
- ✅ MCP integration for advanced capabilities

---

## Summary

The Atomic CLI installation infrastructure is a **three-layer system**:

1. **Platform-Specific Installers** (install.sh, install.ps1)
    - Download and install pre-compiled binaries
    - Extract config templates to data directories
    - Call sync functions to populate `~/.atomic/`
    - Configure PATH in shell configs

2. **npm/bun Postinstall Hook** (src/scripts/postinstall.ts)
    - Runs after package installation
    - Delegates to core sync logic
    - Handles source and npm install modes

3. **Core Sync Logic** (src/utils/atomic-global-config.ts)
    - Central implementation used by both layers
    - Copies agent configs to `~/.atomic/`
    - Excludes SCM-specific skills (gh-_, sl-_)
    - Cleans up Copilot workflows and dependabot.yml

**Key Design Principles:**

- **Configuration-Driven**: Uses AGENT_CONFIG for all agent-specific logic
- **Cross-Platform**: Consistent behavior on Unix, macOS, and Windows
- **Idempotent**: Safe to run multiple times
- **Secure**: SHA256 verification, path traversal protection
- **Flexible**: Supports three installation types (binary, npm, source)

**For Adding New Tools:**

- **Global Skills**: Add to template directories, include in package.json files
- **Project Skills**: Use SCM prefix (gh-_, sl-_) for automatic exclusion
- **Binary Tools**: Modify installer scripts to download and install
- **MCP Tools**: Add to .mcp.json for automatic sync

---

## File Reference Summary

| File                        | Lines of Interest | Purpose                                                             |
| --------------------------- | ----------------- | ------------------------------------------------------------------- |
| **install.sh**              | 144-165           | `sync_global_agent_configs()` - Copies configs, excludes SCM skills |
| **install.sh**              | 228-234           | Config extraction and sync invocation                               |
| **install.ps1**             | 20-51             | `Sync-GlobalAgentConfigs` - PowerShell equivalent                   |
| **install.ps1**             | 175-181           | Config extraction and sync invocation                               |
| **postinstall.ts**          | 15-25             | Main function calling sync logic                                    |
| **atomic-global-config.ts** | 128-151           | `syncAtomicGlobalAgentConfigs()` - Core sync implementation         |
| **atomic-global-config.ts** | 78-88             | `pruneManagedScmSkills()` - Removes stale SCM skills                |
| **atomic-global-config.ts** | 156-183           | `hasAtomicGlobalAgentConfigs()` - Verification                      |
| **config.ts**               | 29-70             | `AGENT_CONFIG` - Agent configuration definitions                    |
| **copy.ts**                 | 117-185           | `copyDir()` - Recursive copy with exclusions                        |
| **config-path.ts**          | 29-45             | `detectInstallationType()` - Install mode detection                 |
| **config-path.ts**          | 77-99             | `getConfigRoot()` - Config template path resolution                 |
| **package.json**            | 22-31             | `files` array - npm package contents                                |
| **package.json**            | 40                | `postinstall` script - Hook definition                              |
