---
date: 2026-01-20
researcher: OpenCode Research Agent
git_commit: 1b357aac679a636fe373fccee8c11323c4a91f83
branch: lavaman131/feat/improve-cross-plat
repository: .atomic
topic: "Cross-Platform Compatibility Analysis of Atomic CLI"
tags: [research, codebase, cross-platform, windows, macos, linux, cli]
status: complete
last_updated: 2026-01-20
last_updated_by: OpenCode Research Agent
last_updated_note: "Added follow-up research for Windows-specific issues: command execution and file overwrite"
---

# Research: Cross-Platform Support in Atomic CLI

## Research Question

Document the current cross-platform implementation patterns in the `src` directory CLI codebase, specifically identifying:

1. File path handling patterns
2. File system operations
3. Process/subprocess management
4. Environment handling
5. External tool invocations
6. Line endings handling
7. Home/config directory patterns
8. Platform detection and branching
9. Any hardcoded OS assumptions

**Scope**: Only `src` directory; excludes `.opencode`, `.claude`, `.github` folders.

---

## Summary

The Atomic CLI demonstrates **strong cross-platform design intent** with several well-implemented patterns for Windows and Unix compatibility. Key strengths include centralized platform detection, consistent use of Node.js `path` module APIs, Bun-native process spawning (avoiding shell strings), and platform-specific script filtering. The codebase uses modern runtime-agnostic APIs where possible.

**Key Findings**:

- **Platform Detection**: Centralized in `src/utils/detect.ts` with `isWindows()`, `isMacOS()`, `isLinux()` functions
- **Path Handling**: Primarily uses `path.join()`, `path.resolve()`, `path.relative()`, and `path.sep` for cross-platform compatibility
- **Process Spawning**: Uses `Bun.spawn()` with command arrays (not shell strings), inheriting stdio
- **File Operations**: Uses `Bun.file()`/`Bun.write()` for binary-safe copying; `fs/promises` for JSON
- **Script Filtering**: Automatically excludes platform-opposite scripts (`.ps1` on Unix, `.sh` on Windows)
- **External Dependency**: `@clack/prompts` is cross-platform with known Windows-specific handling

**One Notable Pattern**: Hardcoded forward slash (`/`) in exclusion path matching at `src/utils/copy.ts:78` may cause issues on Windows where `path.relative()` returns backslash-separated paths.

---

## Detailed Findings

### 1. Platform Detection (`src/utils/detect.ts`)

The codebase centralizes all platform detection in a single utilities module.

**Core Functions**:

| Function           | File:Line                                                                                                                          | Implementation                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `isWindows()`      | [detect.ts:38-40](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L38-L40) | `process.platform === "win32"`       |
| `isMacOS()`        | [detect.ts:45-47](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L45-L47) | `process.platform === "darwin"`      |
| `isLinux()`        | [detect.ts:52-54](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L52-L54) | `process.platform === "linux"`       |
| `isWslInstalled()` | [detect.ts:76-80](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L76-L80) | Windows-only check for `wsl` in PATH |

**Script Extension Selection**:

```typescript
// detect.ts:60-62
export function getScriptExtension(): string {
    return isWindows() ? ".ps1" : ".sh";
}

// detect.ts:67-70
export function getOppositeScriptExtension(): string {
    return isWindows() ? ".sh" : ".ps1";
}
```

**Usage Locations**:

- `src/commands/init.ts:73` - Get opposite extension for filtering
- `src/commands/init.ts:259` - WSL warning on Windows
- `src/utils/copy.ts:112` - Script filtering during copy

---

### 2. File Path Handling

#### Cross-Platform Patterns Used

| Pattern           | File:Line                                                                                                                                                                                                                                             | Description                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `path.join()`     | [init.ts:47](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L47), [copy.ts:118](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L118) | Consistent path construction                   |
| `path.resolve()`  | [copy.ts:14-15](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L14-L15)                                                                                                                        | Absolute path resolution                       |
| `path.relative()` | [copy.ts:16](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L16), [copy.ts:129](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L129)    | Cross-platform relative paths                  |
| `path.sep`        | [copy.ts:17](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L17)                                                                                                                               | Platform-specific separator in traversal check |
| `path.extname()`  | [copy.ts:137](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L137)                                                                                                                             | Extension extraction                           |

**Path Safety Validation** ([copy.ts:13-18](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L13-L18)):

```typescript
export function isPathSafe(basePath: string, targetPath: string): boolean {
    const resolvedBase = resolve(basePath);
    const resolvedTarget = resolve(basePath, targetPath);
    const rel = relative(resolvedBase, resolvedTarget);
    return !rel.startsWith("..") && !rel.includes(`..${sep}`);
}
```

Uses `path.sep` to detect path traversal attacks on both Windows (`\`) and Unix (`/`).

#### Potential Cross-Platform Issue

**Hardcoded forward slash in exclusion matching** ([copy.ts:78](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L78)):

```typescript
if (relativePath === ex || relativePath.startsWith(`${ex}/`)) {
```

On Windows, `path.relative()` returns backslash-separated paths (e.g., `subdir\file`), but this check looks for forward slashes (`subdir/file`). This may cause exclusion patterns to not match correctly on Windows.

---

### 3. File System Operations

#### APIs Used

| API           | Source      | File:Line                                                                                                                 | Purpose                          |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Bun.file()`  | Bun         | [copy.ts:33](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L33)   | Create file reference            |
| `Bun.write()` | Bun         | [copy.ts:34](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L34)   | Write file to disk (binary-safe) |
| `mkdir()`     | fs/promises | [copy.ts:106](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L106) | Create directory                 |
| `readdir()`   | fs/promises | [copy.ts:109](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L109) | List directory entries           |
| `stat()`      | fs/promises | [copy.ts:171](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L171) | Get file/directory stats         |
| `realpath()`  | fs/promises | [copy.ts:49](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L49)   | Resolve symlink target           |
| `readFile()`  | fs/promises | [merge.ts:25](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/merge.ts#L25) | Read file as text (UTF-8)        |
| `writeFile()` | fs/promises | [merge.ts:44](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/merge.ts#L44) | Write text to file               |

#### Symlink Handling (Cross-Platform) ([copy.ts:42-61](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L42-L61))

Symlinks are dereferenced and copied as regular files to avoid Windows permission requirements:

```typescript
async function copySymlinkAsFile(src: string, dest: string): Promise<void> {
    const resolvedPath = await realpath(src);
    const stats = await stat(resolvedPath);
    if (stats.isFile()) {
        await copyFile(resolvedPath, dest);
    }
}
```

Comment at line 43-44 notes: "This ensures symlinks work on Windows without requiring special permissions"

#### Line Ending Handling

| Operation  | File:Line                                                                                                                      | Behavior                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| JSON write | [merge.ts:44](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/merge.ts#L44)      | Uses LF (`\n`) only             |
| File copy  | [copy.ts:33-34](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/copy.ts#L33-L34) | Binary copy, preserves original |

---

### 4. Process/Subprocess Management

#### Primary Process Spawning ([run-agent.ts:111-119](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/run-agent.ts#L111-L119))

```typescript
const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
});
const exitCode = await proc.exited;
```

**Cross-platform strengths**:

- Uses command array (not shell string) - avoids shell injection and quoting issues
- No shell-specific invocation (no `cmd.exe`, `bash`, `powershell`)
- Inherited stdio works consistently across platforms

#### Command Detection ([detect.ts:11-13](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L11-L13))

```typescript
export function isCommandInstalled(cmd: string): boolean {
    return Bun.which(cmd) !== null;
}
```

Uses `Bun.which()` which handles PATH lookup cross-platform.

---

### 5. Environment and Configuration

#### Environment Variables Accessed

| Variable   | File:Line                                                                                                                            | Purpose                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `DEBUG`    | [run-agent.ts:61](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/run-agent.ts#L61) | Enable debug logging           |
| `NO_COLOR` | [detect.ts:88](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L88)          | Disable ANSI colors (standard) |
| `TERM`     | [detect.ts:121](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L121)        | Detect 256-color support       |

**No home directory access**: The CLI does NOT use `HOME`, `USERPROFILE`, or `XDG_*` variables. All configuration is workspace-relative (`process.cwd()`).

#### Configuration Paths

| Resolution          | File:Line                                                                                                                    | Pattern                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Package root        | [init.ts:47](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L47)   | `join(import.meta.dir, "..", "..")` |
| Target directory    | [init.ts:155](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L155) | `process.cwd()`                     |
| Agent config folder | [init.ts:174](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L174) | `join(targetDir, agent.folder)`     |

---

### 6. External Dependencies

#### @clack/prompts

**Status**: Explicitly designed for cross-platform support with Windows-specific handling.

**Platform Support**:

- Checks for `isWindows` constant internally for platform-specific behaviors
- Version 0.3.0 included "Improved Windows/non-unicode support"
- Version 1.0.0-alpha.0 fixed `ERR_TTY_INIT_FAILED` error on Git Bash for Windows

**Known Issues**:
| Issue | Platform | Status | Workaround |
|-------|----------|--------|------------|
| Stdin raw mode not restored after `spinner.stop()` | Windows 11 | Open (#408) | Manually call `process.stdin.setRawMode(false)` |

**Sources**: [GitHub bombshell-dev/clack](https://github.com/bombshell-dev/clack), [DeepWiki Analysis](https://deepwiki.com/bombshell-dev/clack)

---

### 7. Platform-Specific Branching Summary

| Location          | Condition                          | Windows Behavior             | Unix Behavior                |
| ----------------- | ---------------------------------- | ---------------------------- | ---------------------------- |
| `detect.ts:61`    | `isWindows()`                      | Returns `.ps1`               | Returns `.sh`                |
| `detect.ts:68`    | `isWindows()`                      | Returns `.sh` (to skip)      | Returns `.ps1` (to skip)     |
| `detect.ts:77`    | `!isWindows()`                     | Continues to WSL check       | Returns `false`              |
| `init.ts:259`     | `isWindows() && !isWslInstalled()` | Shows WSL warning            | No action                    |
| `copy.ts:146-149` | `entry.isSymbolicLink()`           | Dereferences (all platforms) | Dereferences (all platforms) |

---

## Code References

### Platform Detection

- `src/utils/detect.ts:38-40` - `isWindows()` function
- `src/utils/detect.ts:45-47` - `isMacOS()` function
- `src/utils/detect.ts:52-54` - `isLinux()` function
- `src/utils/detect.ts:60-70` - Script extension selection
- `src/utils/detect.ts:76-80` - WSL detection

### Path Handling

- `src/utils/copy.ts:6` - Path module imports (`join`, `extname`, `relative`, `resolve`, `sep`)
- `src/utils/copy.ts:13-18` - `isPathSafe()` function with `sep` usage
- `src/utils/copy.ts:78` - Hardcoded forward slash (potential issue)
- `src/commands/init.ts:47` - Package root resolution via `join()`

### File Operations

- `src/utils/copy.ts:31-39` - `copyFile()` using Bun APIs
- `src/utils/copy.ts:42-61` - `copySymlinkAsFile()` symlink dereferencing
- `src/utils/copy.ts:95-164` - `copyDir()` recursive copy
- `src/utils/merge.ts:21-45` - JSON file merging

### Process Management

- `src/commands/run-agent.ts:111-119` - Main process spawning with `Bun.spawn()`
- `src/utils/detect.ts:11-13` - `isCommandInstalled()` via `Bun.which()`
- `src/utils/detect.ts:19-33` - `getCommandVersion()` via `Bun.spawnSync()`

---

## Architecture Documentation

### Design Patterns

1. **Centralized Platform Detection**: All OS checks in `detect.ts` via named boolean functions
2. **Path Safety Validation**: `isPathSafe()` prevents directory traversal attacks
3. **Binary-Safe File Copying**: `Bun.file()`/`Bun.write()` preserves file content exactly
4. **Symlink Dereferencing**: Universal approach avoids Windows permission issues
5. **Command Array Spawning**: Avoids shell injection and cross-platform quoting issues
6. **Platform Script Filtering**: Automatic exclusion of opposite-platform scripts

### Runtime Dependencies

| Dependency     | Version | Cross-Platform Status                |
| -------------- | ------- | ------------------------------------ |
| Bun            | ^1.3.6  | Cross-platform runtime               |
| @clack/prompts | ^0.11.0 | Cross-platform with Windows handling |

---

## Historical Context (from research/)

No prior research documents found in `research/` directory related to cross-platform support.

---

## Related Research

This is the initial cross-platform support research document for the Atomic CLI.

---

## Open Questions

1. **Exclusion path matching on Windows**: Does the hardcoded forward slash in `copy.ts:78` cause exclusion patterns to fail on Windows?
2. **@clack/prompts spinner issue**: Does the open issue #408 (stdin raw mode on Windows) affect Atomic CLI usage?
3. **WSL script execution**: Are the bundled `.sh` scripts expected to run in WSL on Windows, and is this documented for users?
4. **Line ending consistency**: Should JSON files written by the CLI use platform-native line endings (CRLF on Windows)?

---

## Follow-up Research [2026-01-20]

### Reported Issues

Two Windows-specific issues were reported:

1. **Commands not working**: `atomic -a opencode -- run --command commit` works on macOS/Linux but not Windows
2. **File overwrite**: CLAUDE.md and AGENTS.md being overwritten on Windows

---

### Issue 1: Agent Commands Not Working on Windows

**Reported Behavior**: Commands like `atomic -a opencode -- run --command commit` work on macOS/Linux but fail on Windows.

#### Code Flow Analysis

The command execution flow is:

1. `src/index.ts:99` - Detects agent run mode via `isAgentRunMode(rawArgs)`
2. `src/index.ts:137` - Extracts agent arguments via `extractAgentArgs(rawArgs)`
3. `src/index.ts:139` - Calls `runAgentCommand(agentName, agentArgs, { force: forceFlag })`
4. `src/commands/run-agent.ts:104` - Builds command array: `[agent.cmd, ...flags, ...agentArgs]`
5. `src/commands/run-agent.ts:111-116` - Spawns process via `Bun.spawn(cmd, {...})`

For the example command `atomic -a opencode -- run --command commit`:

- `agentArgs` = `["run", "--command", "commit"]`
- `cmd` = `["opencode", "run", "--command", "commit"]`

#### Potential Causes on Windows

| Cause                  | Location                                                                                                                               | Description                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Command resolution** | [run-agent.ts:104](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/run-agent.ts#L104) | On Windows, `opencode` may be installed as `opencode.cmd` or `opencode.exe`. While `Bun.which()` can find it, `Bun.spawn()` may need the full path or extension. |
| **PATH differences**   | [detect.ts:12](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L12)            | `Bun.which()` returns the path, but the code only checks `!== null`. The resolved path is not used in spawn.                                                     |
| **Argument handling**  | [run-agent.ts:111](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/run-agent.ts#L111) | Windows may handle arguments differently, especially with special characters or spaces.                                                                          |

#### Code Evidence

**Command check vs spawn mismatch** ([detect.ts:11-13](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/utils/detect.ts#L11-L13) vs [run-agent.ts:104](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/run-agent.ts#L104)):

```typescript
// detect.ts - checks if command exists
export function isCommandInstalled(cmd: string): boolean {
  return Bun.which(cmd) !== null;  // Returns full path like "C:\...\opencode.cmd"
}

// run-agent.ts - spawns with bare command name
const cmd = [agent.cmd, ...flags, ...agentArgs];  // Uses "opencode", not the resolved path
const proc = Bun.spawn(cmd, {...});
```

**Observation**: The code checks if the command exists using `Bun.which()` but doesn't use the resolved path when spawning. On Windows, this may cause issues if the command is a `.cmd` wrapper script.

#### Potential Fix Direction

Use the resolved path from `Bun.which()` when spawning:

```typescript
const cmdPath = Bun.which(agent.cmd);
if (!cmdPath) {
    // ... error handling
}
const cmd = [cmdPath, ...flags, ...agentArgs];
```

---

### Issue 2: CLAUDE.md and AGENTS.md Overwritten on Windows

**Reported Behavior**: CLAUDE.md and AGENTS.md files are being overwritten on Windows when they should be preserved.

#### Code Flow Analysis

The file preservation logic is in `src/commands/init.ts:217-247`:

```typescript
// Line 217-247: Additional files handling
for (const file of agent.additional_files) {
    const srcFile = join(configRoot, file);
    const destFile = join(targetDir, file);

    if (!(await pathExists(srcFile))) continue;

    const destExists = await pathExists(destFile);
    const shouldPreserve = agent.preserve_files.includes(file);
    const shouldMerge = agent.merge_files.includes(file);

    // Line 228-230: Force flag bypasses ALL preservation logic
    if (shouldForce) {
        await copyFile(srcFile, destFile);
        continue;
    }

    // Line 234-237: Merge files (e.g., .mcp.json)
    if (shouldMerge && destExists) {
        await mergeJsonFile(srcFile, destFile);
        continue;
    }

    // Line 240-242: Preserve files (e.g., CLAUDE.md, AGENTS.md)
    if (shouldPreserve && destExists) {
        continue; // Skip - preserve user's customization
    }

    // Line 246: Default: copy the file
    await copyFile(srcFile, destFile);
}
```

#### Configuration Evidence

**`src/config.ts:37-39`** (Claude agent):

```typescript
additional_files: ["CLAUDE.md", ".mcp.json"],
preserve_files: ["CLAUDE.md"],
merge_files: [".mcp.json"],
```

**`src/config.ts:54-56`** (OpenCode agent):

```typescript
additional_files: ["AGENTS.md"],
preserve_files: ["AGENTS.md"],
merge_files: [],
```

#### Root Cause Analysis

The issue is **NOT Windows-specific** - it's a logic flow issue that affects all platforms:

1. **User prompt is misleading** ([init.ts:181-186](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L181-L186)):

    ```typescript
    const update = await confirm({
        message: `${agent.folder} already exists. Overwrite config files?`,
        // ...
    });
    ```

    The prompt says "Overwrite config files" but doesn't mention that CLAUDE.md/AGENTS.md (which are in the project root, not in the config folder) will also be overwritten.

2. **Force flag bypasses preservation** ([init.ts:178-199](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L178-L199)):
    - When user confirms "Yes, overwrite", `shouldForce` is set to `true`
    - Lines 228-230: `if (shouldForce)` then copy and `continue` - **skips the preservation check**

3. **Expected vs actual behavior**:
   | Scenario | Expected | Actual |
   |----------|----------|--------|
   | Config folder exists, user says "Yes, overwrite" | Overwrite `.claude/` or `.opencode/` contents, preserve CLAUDE.md/AGENTS.md | ALL files overwritten including CLAUDE.md/AGENTS.md |
   | `--force` flag used | Same as above | ALL files overwritten |

#### Code Location

**The issue is at** [init.ts:228-230](https://github.com/bastani-inc/atomic/blob/1b357aac679a636fe373fccee8c11323c4a91f83/src/commands/init.ts#L228-L230):

```typescript
// Force flag (or user-confirmed overwrite) bypasses all preservation/merge logic
if (shouldForce) {
    await copyFile(srcFile, destFile);
    continue;
}
```

The comment explicitly states "bypasses all preservation/merge logic" - this is intentional behavior, but the user experience suggests this isn't what users expect.

#### Why It Appears Windows-Specific

Users may be experiencing this on Windows more often because:

1. Windows users may be re-running `atomic init` more frequently due to other issues
2. The overwrite prompt appears whenever the config folder exists
3. Users saying "Yes" to overwrite config folder don't expect root-level files to be affected

#### Potential Fix Direction

Separate the concerns:

1. Keep `--force` for truly forcing all overwrites
2. When user confirms overwrite via prompt, only set force for the config folder contents, not for `preserve_files`
3. Update the prompt message to clarify what will be overwritten

---

### Summary of Windows Issues

| Issue                | Root Cause                                    | Platform-Specific?                                                               | Code Location                         |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| Commands not working | Command path not resolved before spawn        | **Yes** - Windows requires full path or extension for `.cmd` wrappers            | `run-agent.ts:104`, `detect.ts:11-13` |
| Files overwritten    | `shouldForce` bypasses `preserve_files` logic | **No** - affects all platforms, but appears more on Windows due to user workflow | `init.ts:228-230`                     |

---

### Additional Code References

- `src/commands/init.ts:178-199` - Force flag and user confirmation flow
- `src/commands/init.ts:217-247` - Additional files handling loop
- `src/commands/init.ts:228-230` - Force bypass of preservation
- `src/commands/run-agent.ts:93` - Command installation check
- `src/commands/run-agent.ts:104` - Command array construction
- `src/commands/run-agent.ts:111-116` - Process spawning
