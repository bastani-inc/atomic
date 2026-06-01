---
date: 2026-01-21 09:07:46 UTC
researcher: Claude Code
git_commit: 1816ee688508fe72f1a7ece9ecf556d12094b3b7
branch: main
repository: atomic
topic: "Implementing atomic update and atomic uninstall CLI Commands"
tags:
    [
        research,
        codebase,
        cli,
        update,
        uninstall,
        binary-distribution,
        self-update,
    ]
status: complete
last_updated: 2026-01-21
last_updated_by: Claude Code
---

# Research: Implementing `atomic update` and `atomic uninstall` Commands

## Research Question

Research the codebase to understand how to add an `atomic update` command that will fetch and download the latest release to upgrade. Also, create an `atomic uninstall` command that will remove the binary and data dirs. These CLI commands should only be supported for the binary installation though since npm/bun already have built-in upgrade mechanisms. A helpful error message should be given if the user attempts to upgrade in this way if they installed through bun/npm. Be very thorough and consider edge cases.

## Summary

This document provides comprehensive research for implementing `atomic update` and `atomic uninstall` commands. The key design principle is that **these commands should only be available for binary installations** since npm/bun have their own upgrade mechanisms (`bun upgrade @bastani/atomic`, `npm update -g @bastani/atomic`).

The codebase already has:

1. **Installation detection** via `detectInstallationType()` in `src/utils/config-path.ts`
2. **Data directory configuration** via `getBinaryDataDir()` and `getConfigRoot()`
3. **Install scripts** (`install.sh`, `install.ps1`) that define the canonical locations
4. **GitHub Releases infrastructure** for binary distribution

## Detailed Findings

### 1. Current CLI Command Structure

#### Entry Point: `src/index.ts`

The CLI uses a combination of:

- **Manual argument parsing** for agent run mode (`isAgentRunMode`)
- **`parseArgs` from `util`** for standard command parsing
- **Positional commands** handled via switch statement

```typescript
// src/index.ts:175-199
switch (command) {
  case "init":
    await initCommand({ ... });
    break;
  case undefined:
    // default to init
    await initCommand({ ... });
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
```

**To add new commands**, extend the switch statement:

```typescript
case "update":
  await updateCommand({ ... });
  break;
case "uninstall":
  await uninstallCommand({ ... });
  break;
```

#### Argument Parsing Pattern

Commands receive options from `parseArgs`:

- `src/index.ts:146-158` - Options definition

New commands should follow the same pattern:

1. Check if supported for installation type
2. Parse command-specific flags
3. Call the command handler

### 2. Installation Method Detection

#### Existing Detection Logic: `src/utils/config-path.ts:29-45`

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

**Installation types:**
| Type | Detection | Update Mechanism |
|------|-----------|------------------|
| `binary` | `$bunfs` in path (Bun compiled) | `atomic update` ✓ |
| `npm` | `node_modules` in path | `bun upgrade`/`npm update` |
| `source` | Default (development) | `git pull` |

#### Recommended Error Messages

For npm/bun installations:

```
Error: 'atomic update' is not available for npm/bun installations.

To update atomic, use your package manager:
  bun upgrade @bastani/atomic
  # or
  npm update -g @bastani/atomic
```

For source installations:

```
Error: 'atomic update' is not available in development mode.

To update atomic from source:
  git pull
  bun install
```

### 3. Directory Locations

#### Binary Installation Paths

| Platform       | Binary Location                       | Data Directory          |
| -------------- | ------------------------------------- | ----------------------- |
| Unix (default) | `~/.local/bin/atomic`                 | `~/.local/share/atomic` |
| Unix (custom)  | `$ATOMIC_INSTALL_DIR/atomic`          | `$XDG_DATA_HOME/atomic` |
| Windows        | `%USERPROFILE%\.local\bin\atomic.exe` | `%LOCALAPPDATA%\atomic` |

**Source: `install.sh:11-12`**

```bash
BIN_DIR="${ATOMIC_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
```

**Source: `install.ps1:16-17`**

```powershell
$BinDir = if ($env:ATOMIC_INSTALL_DIR) { ... } else { "${Home}\.local\bin" }
$DataDir = if ($env:LOCALAPPDATA) { "${env:LOCALAPPDATA}\atomic" } else { ... }
```

#### Existing Helper Functions

```typescript
// src/utils/config-path.ts:54-64
export function getBinaryDataDir(): string {
  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || ...;
    return join(localAppData, "atomic");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local", "share");
  return join(xdgDataHome, "atomic");
}
```

#### New Helper Needed: Binary Location

```typescript
// Proposed: src/utils/config-path.ts
export function getBinaryInstallDir(): string {
    if (isWindows()) {
        return (
            process.env.ATOMIC_INSTALL_DIR ||
            join(process.env.USERPROFILE || "", ".local", "bin")
        );
    }
    return (
        process.env.ATOMIC_INSTALL_DIR ||
        join(process.env.HOME || "", ".local", "bin")
    );
}

export function getBinaryPath(): string {
    const dir = getBinaryInstallDir();
    const name = isWindows() ? "atomic.exe" : "atomic";
    return join(dir, name);
}
```

### 4. GitHub Releases Structure

**Source: `.github/workflows/publish.yml`**

Assets published per release:

```
atomic-linux-x64
atomic-linux-arm64
atomic-darwin-x64
atomic-darwin-arm64
atomic-windows-x64.exe
atomic-config.tar.gz
atomic-config.zip
checksums.txt
```

**Release URL patterns:**

```
# Latest release
https://api.github.com/repos/bastani/atomic/releases/latest

# Specific version
https://github.com/bastani/atomic/releases/download/v{version}/atomic-{platform}

# Config files
https://github.com/bastani/atomic/releases/download/v{version}/atomic-config.tar.gz
```

### 5. Update Command Implementation

#### High-Level Flow

```
atomic update
    │
    ├─► Check installation type
    │   ├─► npm/source → Error with guidance
    │   └─► binary → Continue
    │
    ├─► Check current version (VERSION from package.json)
    │
    ├─► Fetch latest version from GitHub API
    │   └─► Compare with current
    │       └─► If same → "Already up to date"
    │
    ├─► Confirm update (unless --yes)
    │
    ├─► Download new binary to temp location
    │   └─► Verify checksum
    │
    ├─► Download new config files to temp location
    │   └─► Verify checksum
    │
    ├─► Replace binary (platform-specific)
    │   ├─► Unix: atomic rename
    │   └─► Windows: rename old → move new → cleanup
    │
    ├─► Update config files in data directory
    │
    └─► Verify installation
        └─► Run atomic --version
```

#### Platform-Specific Binary Replacement

**Unix:**

- A running executable can be replaced via `rename()` syscall
- The old binary continues running from memory
- New invocations use the new binary

```typescript
// Pseudocode for Unix update
async function replaceBinaryUnix(newBinary: string, targetPath: string) {
    // 1. Make new binary executable
    await chmod(newBinary, 0o755);

    // 2. Atomic rename (replaces old)
    await rename(newBinary, targetPath);
}
```

**Windows:**

- Running executables are locked and cannot be deleted/overwritten
- But they CAN be renamed
- Strategy: rename old → move new → cleanup old later

```typescript
// Pseudocode for Windows update
async function replaceBinaryWindows(newBinary: string, targetPath: string) {
    const oldPath = targetPath + ".old";

    // 1. Rename running executable to .old
    await rename(targetPath, oldPath);

    // 2. Move new binary to target location
    try {
        await rename(newBinary, targetPath);
    } catch (e) {
        // Rollback: restore old binary
        await rename(oldPath, targetPath);
        throw e;
    }

    // 3. Delete old binary (may fail if still running)
    try {
        await unlink(oldPath);
    } catch {
        // Will be cleaned up on next update
    }
}
```

#### Version Checking

```typescript
// Fetch latest version from GitHub API
async function getLatestVersion(): Promise<string> {
    const response = await fetch(
        "https://api.github.com/repos/bastani/atomic/releases/latest",
    );
    const data = await response.json();
    return data.tag_name; // e.g., "v0.1.0"
}

// Compare versions
function isNewerVersion(latest: string, current: string): boolean {
    // Strip 'v' prefix and compare semantically
    const latestNum = latest.replace(/^v/, "");
    const currentNum = current.replace(/^v/, "");
    // Use semver comparison
}
```

#### Checksum Verification

Reuse the pattern from `install.sh`:

```typescript
async function verifyChecksum(
    filePath: string,
    checksums: string,
    expectedFilename: string,
): Promise<boolean> {
    // Parse checksum from checksums.txt
    const line = checksums
        .split("\n")
        .find((l) => l.includes(expectedFilename));
    if (!line) throw new Error(`No checksum for ${expectedFilename}`);
    const expectedHash = line.split(/\s+/)[0];

    // Calculate actual hash
    const file = Bun.file(filePath);
    const hash = Bun.CryptoHasher.hash("sha256", await file.arrayBuffer());
    const actualHash = Buffer.from(hash).toString("hex");

    return actualHash === expectedHash;
}
```

#### Flags for Update Command

| Flag            | Description                                  |
| --------------- | -------------------------------------------- |
| `--yes`, `-y`   | Skip confirmation prompt                     |
| `--version <v>` | Update to specific version (not just latest) |
| `--check`       | Only check for updates, don't install        |

### 6. Uninstall Command Implementation

#### High-Level Flow

```
atomic uninstall
    │
    ├─► Check installation type
    │   ├─► npm/source → Error with guidance
    │   └─► binary → Continue
    │
    ├─► Show what will be removed:
    │   ├─► Binary: ~/.local/bin/atomic
    │   └─► Data: ~/.local/share/atomic
    │
    ├─► Confirm (unless --yes)
    │
    ├─► Remove data directory
    │
    ├─► Remove binary (self-delete)
    │   ├─► Unix: can delete self
    │   └─► Windows: schedule deletion
    │
    └─► Print manual PATH cleanup instructions
```

#### Self-Deletion Considerations

**Unix:**

- A process can delete its own executable file
- The inode remains until the process exits
- Simple `unlink()` works

**Windows:**

- Cannot delete running executable
- Options:
    1. Rename to `.delete` and schedule deletion at reboot
    2. Spawn helper process to delete after exit
    3. Instruct user to delete manually

Recommended Windows approach:

```typescript
// Windows: rename and schedule deletion
async function selfDeleteWindows(binaryPath: string) {
    const deletePath = binaryPath + ".delete";
    await rename(binaryPath, deletePath);

    // Schedule deletion at next reboot using MoveFileEx
    // Or: print instructions for manual deletion
    console.log(`
Please delete the following file manually:
  ${deletePath}

Or restart your computer to complete uninstallation.
`);
}
```

#### PATH Cleanup

**Decision**: Print manual instructions (safer than auto-modifying shell configs)

```
To complete uninstallation, remove the following from your shell config:

Bash (~/.bashrc):
  export PATH="$HOME/.local/bin:$PATH"

Zsh (~/.zshrc):
  export PATH="$HOME/.local/bin:$PATH"

Fish (~/.config/fish/config.fish):
  fish_add_path ~/.local/bin

PowerShell ($PROFILE):
  # Remove ~/.local/bin from $env:Path
```

**Alternative**: Offer `--cleanup-path` flag for automated cleanup with explicit opt-in.

#### Flags for Uninstall Command

| Flag            | Description                                 |
| --------------- | ------------------------------------------- |
| `--yes`, `-y`   | Skip confirmation prompt                    |
| `--keep-config` | Keep data directory, only remove binary     |
| `--dry-run`     | Show what would be removed without removing |

### 7. Edge Cases and Error Handling

#### Update Edge Cases

| Scenario                        | Handling                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Network failure during download | Delete partial file, show error with retry instructions                                             |
| Checksum mismatch               | Delete downloaded file, show error                                                                  |
| Insufficient permissions        | Check permissions before download, suggest running with elevated privileges or using user directory |
| Already up to date              | Inform user, exit 0                                                                                 |
| Version downgrade requested     | Allow with `--force` flag                                                                           |
| GitHub API rate limit           | Suggest using `GITHUB_TOKEN` env var                                                                |
| Binary locked (Windows)         | Rename strategy with cleanup                                                                        |

#### Uninstall Edge Cases

| Scenario                             | Handling                                              |
| ------------------------------------ | ----------------------------------------------------- |
| Binary not found                     | Already uninstalled, show success message             |
| Data directory not found             | Warn but continue                                     |
| Insufficient permissions             | Show error with suggested commands                    |
| Binary in use (Windows)              | Rename to `.delete`, show manual cleanup instructions |
| Partial uninstall (previous failure) | Clean up `.delete` files                              |

#### Permission Handling

```typescript
async function checkWritePermission(path: string): Promise<boolean> {
    try {
        // Try to create a temp file in the directory
        const testPath = join(dirname(path), `.atomic-test-${Date.now()}`);
        await Bun.write(testPath, "");
        await unlink(testPath);
        return true;
    } catch {
        return false;
    }
}
```

### 8. Proposed File Structure

```
src/
├── commands/
│   ├── init.ts           # existing
│   ├── run-agent.ts      # existing
│   ├── update.ts         # NEW: update command
│   └── uninstall.ts      # NEW: uninstall command
├── utils/
│   ├── config-path.ts    # extend with binary location helpers
│   ├── detect.ts         # existing platform detection
│   ├── download.ts       # NEW: download and verify helpers
│   └── ...
└── index.ts              # add new command cases
```

### 9. User Experience Flow

#### Update Command

```
$ atomic update

Checking for updates...
Current version: v0.1.0
Latest version:  v0.2.0

A new version of atomic is available!

Changes in v0.2.0:
  - Added new feature X
  - Fixed bug Y

Do you want to update? [Y/n] y

Downloading atomic v0.2.0...
Verifying checksum... ✓
Installing binary...   ✓
Updating config files... ✓

Successfully updated to v0.2.0!

Run 'atomic --help' to see what's new.
```

```
$ atomic update
# When installed via npm

Error: 'atomic update' is not available for npm installations.

To update atomic, use:
  bun upgrade @bastani/atomic
  # or
  npm update -g @bastani/atomic
```

#### Uninstall Command

```
$ atomic uninstall

This will remove:
  - Binary:    /home/user/.local/bin/atomic
  - Data:      /home/user/.local/share/atomic

Are you sure you want to uninstall atomic? [y/N] y

Removing data directory... ✓
Removing binary... ✓

Atomic has been uninstalled.

To complete the uninstallation, remove the PATH entry from your shell config:
  ~/.bashrc or ~/.zshrc: export PATH="$HOME/.local/bin:$PATH"
```

### 10. Command Behavior Summary

| Command                 | Binary Install            | npm/bun Install              | Source Install          |
| ----------------------- | ------------------------- | ---------------------------- | ----------------------- |
| `atomic update`         | ✓ Updates binary + config | ✗ Error: use package manager | ✗ Error: use git pull   |
| `atomic uninstall`      | ✓ Removes binary + data   | ✗ Error: use package manager | ✗ Error: not applicable |
| `atomic update --check` | ✓ Shows available update  | ✗ Error                      | ✗ Error                 |

## Code References

- `src/index.ts:175-199` - Command switch statement (add new commands here)
- `src/utils/config-path.ts:29-45` - `detectInstallationType()` function
- `src/utils/config-path.ts:54-64` - `getBinaryDataDir()` function
- `src/utils/detect.ts:53-55` - `isWindows()` function
- `src/version.ts:4-6` - Current version from package.json
- `install.sh:11-12` - Binary and data directory paths
- `install.ps1:16-17` - Windows binary and data directory paths
- `.github/workflows/publish.yml:40-57` - Binary build targets
- `.github/workflows/publish.yml:110-132` - Release asset uploads

## Architecture Documentation

### Current Installation Flow

```
┌─────────────────────────────────────────────────┐
│                   User Installs                  │
└─────────────────────────────────────────────────┘
          │                    │                │
          ▼                    ▼                ▼
    ┌──────────┐        ┌──────────┐      ┌──────────┐
    │ Binary   │        │ npm/bun  │      │ Source   │
    │ (curl)   │        │ install  │      │ (git)    │
    └──────────┘        └──────────┘      └──────────┘
          │                    │                │
          ▼                    ▼                ▼
    ┌──────────┐        ┌──────────┐      ┌──────────┐
    │~/.local/ │        │ node_    │      │ ./src/   │
    │  bin/    │        │ modules/ │      │          │
    │  share/  │        │          │      │          │
    └──────────┘        └──────────┘      └──────────┘
```

### Proposed Update Flow

```
┌─────────────────────────────────────────────────┐
│                 atomic update                    │
└─────────────────────────────────────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │ detectInstall    │
              │ Type()           │
              └──────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
    ┌────────┐     ┌────────┐     ┌────────┐
    │ binary │     │  npm   │     │ source │
    │   ✓    │     │   ✗    │     │   ✗    │
    └────────┘     └────────┘     └────────┘
        │               │               │
        ▼               ▼               ▼
    ┌────────┐     ┌────────────┐  ┌────────────┐
    │ GitHub │     │ Error:     │  │ Error:     │
    │ API    │     │ use npm    │  │ use git    │
    └────────┘     └────────────┘  └────────────┘
        │
        ▼
    ┌────────────────────────┐
    │ Download + Verify      │
    │ Replace Binary         │
    │ Update Config          │
    └────────────────────────┘
```

## Historical Context (from research/)

- `research/docs/2026-01-21-binary-distribution-installers.md` - Comprehensive research on install scripts, platform detection, checksum verification, and PATH handling
- `research/docs/2026-01-20-cross-platform-support.md` - Related research on cross-platform considerations

## Related Research

- [Bun upgrade command](https://bun.sh/docs/cli/upgrade) - Self-update pattern
- [Deno upgrade command](https://docs.deno.com/runtime/reference/cli/upgrade/) - Self-update with package manager detection
- [Rustup self update](https://rust-lang.github.io/rustup/) - Comprehensive self-update with rollback
- [go-github-selfupdate](https://github.com/rhysd/go-github-selfupdate) - Go library patterns
- [self-replace crate](https://docs.rs/self-replace/) - Rust cross-platform binary replacement

## Open Questions

1. **Changelog display**: Should `atomic update` show a changelog/release notes? The GitHub API provides release body text.

2. **Automatic update checks**: Should atomic periodically check for updates and notify users? (Like npm does)

3. **Rollback capability**: Should we keep one previous version for rollback purposes? This adds complexity but provides safety.

4. **Windows ARM64**: Currently not supported in builds. Add if there's demand.

## Implementation Checklist

### Update Command

- [ ] Create `src/commands/update.ts`
- [ ] Add `getBinaryInstallDir()` and `getBinaryPath()` to `src/utils/config-path.ts`
- [ ] Create `src/utils/download.ts` with download and checksum helpers
- [ ] Add `update` case to `src/index.ts` switch statement
- [ ] Update help text in `showHelp()` function
- [ ] Handle Windows binary replacement with rename strategy
- [ ] Add tests for update command
- [ ] Update README with `atomic update` documentation

### Uninstall Command

- [ ] Create `src/commands/uninstall.ts`
- [ ] Add `uninstall` case to `src/index.ts` switch statement
- [ ] Update help text in `showHelp()` function
- [ ] Handle Windows self-deletion
- [ ] Add tests for uninstall command
- [ ] Update README with `atomic uninstall` documentation

### Documentation

- [ ] Add "Updating Atomic" section to README
- [ ] Add "Uninstalling Atomic" section (update existing) to include CLI command
- [ ] Document installation type detection behavior
