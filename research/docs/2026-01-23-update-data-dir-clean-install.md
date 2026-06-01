---
date: 2026-01-23 05:19:12 UTC
researcher: Claude
git_commit: 66dcde04b92769bf112cf8dfb24d08b91d60d846
branch: main
repository: atomic
topic: "How to modify the update logic in the binary install option to completely remove the data dir before adding new data"
tags:
    [
        research,
        codebase,
        update,
        binary-install,
        data-directory,
        config-extraction,
    ]
status: complete
last_updated: 2026-01-23
last_updated_by: Claude
---

# Research

## Research Question

How can the update logic in the binary install option be modified to completely remove the data dir and then add the new data, preventing old artifacts from renames etc. from being kept incorrectly?

## Summary

The current update flow in `src/commands/update.ts` downloads a new config archive and extracts it **on top of** the existing data directory (`~/.local/share/atomic` on Unix, `%LOCALAPPDATA%\atomic` on Windows) without first removing it. This means renamed or deleted files from previous versions persist as stale artifacts.

The fix is straightforward: in the `updateCommand()` function, before calling `extractConfig()`, add a step that removes the existing data directory entirely, then re-create it before extraction. The same pattern should be applied to `install.sh` and `install.ps1` for fresh installs (though fresh installs are less affected since the directory typically doesn't exist yet).

## Detailed Findings

### Current Update Flow (TypeScript - `updateCommand()`)

The update command in [`src/commands/update.ts:153-290`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/commands/update.ts#L153-L290) follows this sequence:

1. Detect installation type (must be "binary")
2. Fetch latest release info from GitHub API
3. Compare versions, exit early if already up-to-date
4. Create a temp directory for downloads
5. Download the binary file
6. Download the config archive (`.tar.gz` or `.zip`)
7. Download and verify checksums for both files
8. Replace the binary (platform-specific logic)
9. **Extract config to data directory** (overlays on existing)
10. Verify the new binary works
11. Clean up temp directory

The critical section is lines 245-249:

```typescript
// Update config files
s.start("Updating config files...");
const dataDir = getBinaryDataDir();
await extractConfig(configPath, dataDir);
s.stop("Config files updated");
```

### `extractConfig()` Function

In [`src/commands/update.ts:116-147`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/commands/update.ts#L116-L147):

```typescript
async function extractConfig(archivePath: string, dataDir: string): Promise<void> {
  // Ensure data directory exists
  await mkdir(dataDir, { recursive: true });

  if (isWindows()) {
    // Expand-Archive with -Force (overwrites existing files but does NOT remove extras)
    ...
  } else {
    // tar -xzf (extracts over existing, does NOT remove extras)
    ...
  }
}
```

Both `tar -xzf` and `Expand-Archive -Force` will **overwrite** files that exist in both the old and new archives, but they will **not remove** files that only exist in the old version. This is the root cause of stale artifacts.

### Data Directory Resolution

In [`src/utils/config-path.ts:54-64`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/utils/config-path.ts#L54-L64):

- **Unix:** `$XDG_DATA_HOME/atomic` or `~/.local/share/atomic`
- **Windows:** `%LOCALAPPDATA%\atomic`

### Install Scripts (Same Pattern)

**`install.sh` line 203:**

```bash
tar -xzf "${tmp_dir}/${BINARY_NAME}-config.tar.gz" -C "$DATA_DIR"
```

**`install.ps1` line 141:**

```powershell
Expand-Archive -Path $TempConfig -DestinationPath $DataDir -Force
```

Both scripts create `$DATA_DIR` / `$DataDir` with `mkdir -p` (line 168 in bash, line 49 in PowerShell) then extract on top. For fresh installs this is fine, but if used to re-install/update, the same stale artifact problem applies.

### What Needs to Change

**In `src/commands/update.ts` (the `updateCommand` function), around lines 245-249:**

Before extracting, remove the existing data directory:

```typescript
// Update config files
s.start("Updating config files...");
const dataDir = getBinaryDataDir();
await rm(dataDir, { recursive: true, force: true }); // <-- ADD THIS
await extractConfig(configPath, dataDir);
s.stop("Config files updated");
```

The `rm` import already exists on line 10 (`import { mkdir, rm, rename, chmod } from "fs/promises";`), and `extractConfig()` already calls `mkdir(dataDir, { recursive: true })` before extraction, so the directory will be recreated.

**In `install.sh`, before line 203:**

```bash
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
tar -xzf "${tmp_dir}/${BINARY_NAME}-config.tar.gz" -C "$DATA_DIR"
```

**In `install.ps1`, before line 141:**

```powershell
if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
$null = New-Item -ItemType Directory -Force -Path $DataDir
Expand-Archive -Path $TempConfig -DestinationPath $DataDir -Force
```

### Error Recovery Consideration

If the update fails after removing the data dir but before extraction completes, the user would be left without config data. The binary itself would still work but `getConfigRoot()` in `config-path.ts:77-94` would throw an error saying the install is incomplete. The existing verification step (lines 252-261) would catch this since the binary would fail to initialize properly. The user would need to re-run `atomic update` or re-install to recover. This is an acceptable tradeoff since the alternative (stale files) causes silent correctness issues.

### Test Impact

The E2E test in [`tests/e2e/update-command.test.ts`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/tests/e2e/update-command.test.ts) only tests error paths and installation type detection (it runs from source, not binary). No existing tests directly test the config extraction step of the update flow, so the change should not break any tests. New tests could be added to verify the data directory is clean after update.

## Code References

- [`src/commands/update.ts:245-249`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/commands/update.ts#L245-L249) - Config extraction in update (the lines to modify)
- [`src/commands/update.ts:116-147`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/commands/update.ts#L116-L147) - `extractConfig()` function
- [`src/commands/update.ts:10`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/commands/update.ts#L10) - `rm` already imported from `fs/promises`
- [`src/utils/config-path.ts:54-64`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/utils/config-path.ts#L54-L64) - `getBinaryDataDir()` function
- [`src/utils/config-path.ts:77-94`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/src/utils/config-path.ts#L77-L94) - `getConfigRoot()` validates data dir exists
- [`install.sh:167-203`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/install.sh#L167-L203) - Bash installer data dir setup + extraction
- [`install.ps1:49-141`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/install.ps1#L49-L141) - PowerShell installer data dir setup + extraction
- [`tests/e2e/update-command.test.ts`](https://github.com/bastani/atomic/blob/66dcde04b92769bf112cf8dfb24d08b91d60d846/tests/e2e/update-command.test.ts) - Existing E2E tests (unaffected)

## Architecture Documentation

The data directory stores config files (`.claude`, `.opencode`, `.github` subdirectories) that the CLI copies into user projects. These are bundled as `atomic-config.tar.gz` (Unix) or `atomic-config.zip` (Windows) in GitHub releases via `.github/workflows/publish.yml`. The binary reads from this directory at runtime via `getConfigRoot()`.

## Historical Context (from research/)

- `research/docs/2026-01-21-update-uninstall-commands.md` - Documents the original implementation of the update command
- `research/docs/2026-01-21-binary-distribution-installers.md` - Documents the binary distribution system and installer scripts
- `research/docs/2026-01-20-cross-platform-support.md` - Documents platform-specific path resolution

## Related Research

- `research/docs/2026-01-21-update-uninstall-commands.md`
- `research/docs/2026-01-21-binary-distribution-installers.md`

## Open Questions

1. Should a backup of the data dir be created before removal, in case extraction fails? (Tradeoff: complexity vs. recovery from a rare failure mode)
2. Should the install scripts (`install.sh`, `install.ps1`) also be updated for the re-install case, or only the `atomic update` TypeScript path?
