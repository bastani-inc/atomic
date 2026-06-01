---
date: 2026-01-20
researcher: Claude
git_commit: 2fa30637912db42e55f81478cfc0b84af8f3ee46
branch: main
repository: atomic
topic: "Modifying --force/-f flags to overwrite all files including AGENTS.md/CLAUDE.md"
tags: [research, codebase, init, force-flag, file-preservation, cli]
status: complete
last_updated: 2026-01-20
last_updated_by: Claude
---

# Research: Modifying --force/-f Flag Behavior

## Research Question

How to modify the `--force`, `-f` flags to overwrite ALL files (including AGENTS.md/CLAUDE.md). The regular init command and all variants without the force flag should update all agent files for that particular agent except for CLAUDE.md and AGENTS.md if they exist **and aren't empty**.

## Summary

The current implementation **intentionally prevents** overwriting CLAUDE.md/AGENTS.md even with the `--force` flag. To implement the desired behavior:

1. **With `--force`/`-f`**: Remove the preservation check at `src/commands/init.ts:227-234` so preserved files can be overwritten
2. **Without force**: Add an empty file check before preserving - only skip files that exist AND have non-empty content

### Key Modification Points

| File                   | Lines   | Change Required                                 |
| ---------------------- | ------- | ----------------------------------------------- |
| `src/commands/init.ts` | 227-234 | Modify preservation logic to respect force flag |
| `src/commands/init.ts` | 227-234 | Add empty file check for non-force mode         |
| `src/utils/copy.ts`    | (new)   | Add `isFileEmpty()` utility function            |
| `tests/init.test.ts`   | 197-215 | Update tests to reflect new force behavior      |

## Detailed Findings

### Current Preservation Logic (src/commands/init.ts:217-252)

The critical code block that handles additional files (including AGENTS.md/CLAUDE.md):

```typescript
// src/commands/init.ts:217-252
for (const file of agent.additional_files) {
    const srcFile = join(configRoot, file);
    const destFile = join(targetDir, file);

    if (!(await pathExists(srcFile))) continue;

    const destExists = await pathExists(destFile);
    const shouldPreserve = agent.preserve_files.includes(file);
    const shouldMerge = agent.merge_files.includes(file);

    // IMPORTANT: Preserved files (CLAUDE.md, AGENTS.md) are NEVER overwritten,
    // even with --force flag. This protects user customizations intentionally.
    if (shouldPreserve && destExists) {
        if (process.env.DEBUG === "1") {
            console.log(`[DEBUG] Preserving user file: ${file}`);
        }
        continue; // ← THIS BYPASSES FORCE FLAG
    }

    // Handle merge files (e.g., .mcp.json)
    if (shouldMerge && destExists) {
        await mergeJsonFile(srcFile, destFile);
        continue;
    }

    // Force flag (or user-confirmed overwrite) bypasses normal existence checks
    if (shouldForce) {
        await copyFile(srcFile, destFile);
        continue;
    }

    // Default: only copy if destination doesn't exist
    if (!destExists) {
        await copyFile(srcFile, destFile);
    }
}
```

**Critical observation**: The preservation check at lines 227-234 happens **BEFORE** the force flag check at lines 242-246. This means preserved files are skipped regardless of the force flag.

### Agent Configuration (src/config.ts:29-70)

| Agent    | `preserve_files` | `additional_files`           |
| -------- | ---------------- | ---------------------------- |
| claude   | `["CLAUDE.md"]`  | `["CLAUDE.md", ".mcp.json"]` |
| opencode | `["AGENTS.md"]`  | `["AGENTS.md"]`              |
| copilot  | `["AGENTS.md"]`  | `["AGENTS.md"]`              |

### Force Flag Data Flow

```
CLI Input: "atomic init --force" or "atomic -a claude -f"
    │
    ▼
src/index.ts:147 - parseArgs() or src/utils/arg-parser.ts:86 hasForceFlag()
    │
    ▼
src/commands/init.ts:178 - shouldForce = options.force ?? false
    │
    ├─────────────────────────────────────────────┐
    │                                             │
    ▼                                             ▼
src/commands/init.ts:211-214                src/commands/init.ts:227-252
copyDirPreserving({ force })                Additional files loop
    │                                             │
    ▼                                             ▼
Lines 90-91: if (!destExists || force)      Lines 227-234: BYPASSES force
             copyFile()                     for preserved files
```

### Required Changes

#### Change 1: Modify Preservation to Respect Force Flag

**Current behavior** (src/commands/init.ts:227-234):

```typescript
// IMPORTANT: Preserved files (CLAUDE.md, AGENTS.md) are NEVER overwritten,
// even with --force flag. This protects user customizations intentionally.
if (shouldPreserve && destExists) {
    if (process.env.DEBUG === "1") {
        console.log(`[DEBUG] Preserving user file: ${file}`);
    }
    continue;
}
```

**Required change**:

```typescript
// With --force: overwrite ALL files including preserved files
// Without --force: preserve files that exist AND have content
if (shouldPreserve && destExists && !shouldForce) {
    // Check if file is empty - empty files should be overwritten
    const isEmpty = await isFileEmpty(destFile);
    if (!isEmpty) {
        if (process.env.DEBUG === "1") {
            console.log(`[DEBUG] Preserving non-empty user file: ${file}`);
        }
        continue;
    }
}
```

#### Change 2: Add Empty File Check Utility

**New function needed** (src/utils/copy.ts):

```typescript
/**
 * Check if a file exists and is empty (0 bytes or only whitespace)
 */
export async function isFileEmpty(path: string): Promise<boolean> {
    try {
        const file = Bun.file(path);
        const size = file.size;
        if (size === 0) return true;

        // Optionally check for whitespace-only content
        const content = await file.text();
        return content.trim().length === 0;
    } catch {
        return true; // Treat errors as "empty" to allow overwrite
    }
}
```

**Note**: The codebase currently has no pattern for checking file size or emptiness. The `pathExists()` function at `src/utils/copy.ts:189-198` only checks existence via `stat()`.

### Existing Patterns for Reference

#### Path Existence (src/utils/copy.ts:189-198)

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

#### File Copy (src/utils/copy.ts:43-51)

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

#### File Read in Tests (tests/copy.test.ts:29)

```typescript
const content = await Bun.file(destFile).text();
```

### Test Coverage Impact

Current tests that will need updates:

| File                 | Lines   | Test                                                                 | Change Needed                |
| -------------------- | ------- | -------------------------------------------------------------------- | ---------------------------- |
| `tests/init.test.ts` | 197-215 | `preservation logic: preserved files skip copy even with force=true` | Invert expectation           |
| `tests/init.test.ts` | 170-195 | Agent preserve_files config tests                                    | No change (config unchanged) |
| `tests/init.test.ts` | (new)   | Empty file handling                                                  | Add new tests                |

**Current test at lines 197-215**:

```typescript
test("preservation logic: preserved files skip copy even with force=true", () => {
    const preserveFiles = ["CLAUDE.md", "AGENTS.md"];
    const file = "CLAUDE.md";
    const destExists = true;
    const shouldForce = true;

    const shouldPreserve = preserveFiles.includes(file);

    let wasSkipped = false;
    if (shouldPreserve && destExists) {
        wasSkipped = true;
    }

    expect(wasSkipped).toBe(true); // ← Will need to change to false
});
```

### copyDirPreserving Function (src/commands/init.ts:63-97)

This function handles files inside the agent config directories (e.g., `.claude/`, `.opencode/`). It already respects the force flag correctly:

```typescript
// src/commands/init.ts:88-96
const destExists = await pathExists(destPath);

// Only copy if destination doesn't exist OR force flag is set
if (!destExists || force) {
    await copyFile(srcPath, destPath);
}
// Otherwise skip - preserve user's existing file
```

**No changes needed** for config folder files - only the additional files loop needs modification.

## Code References

### Core Implementation Files

- [src/commands/init.ts:227-234](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/commands/init.ts#L227-L234) - Preservation logic (main change point)
- [src/commands/init.ts:217-252](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/commands/init.ts#L217-L252) - Additional files handling loop
- [src/commands/init.ts:178](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/commands/init.ts#L178) - Force flag extraction
- [src/commands/init.ts:63-97](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/commands/init.ts#L63-L97) - copyDirPreserving function

### Configuration

- [src/config.ts:29-70](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/config.ts#L29-L70) - AGENT_CONFIG with preserve_files
- [src/config.ts:38](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/config.ts#L38) - Claude preserve_files: ["CLAUDE.md"]
- [src/config.ts:55](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/config.ts#L55) - OpenCode preserve_files: ["AGENTS.md"]

### CLI Entry Points

- [src/index.ts:147](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/index.ts#L147) - Force flag in parseArgs options
- [src/index.ts:48](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/index.ts#L48) - Help text for -f/--force
- [src/utils/arg-parser.ts:86-93](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/utils/arg-parser.ts#L86-L93) - hasForceFlag() utility

### Utility Functions

- [src/utils/copy.ts:189-198](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/utils/copy.ts#L189-L198) - pathExists() function
- [src/utils/copy.ts:43-51](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/src/utils/copy.ts#L43-L51) - copyFile() function

### Tests

- [tests/init.test.ts:197-215](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/tests/init.test.ts#L197-L215) - Preservation with force test (needs update)
- [tests/init.test.ts:163-277](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/tests/init.test.ts#L163-L277) - File preservation logic tests
- [tests/routing.test.ts:449-478](https://github.com/bastani/atomic/blob/2fa30637912db42e55f81478cfc0b84af8f3ee46/tests/routing.test.ts#L449-L478) - hasForceFlag() tests

## Architecture Documentation

### Behavior Matrix After Changes

| Scenario                                         | Current Behavior | New Behavior     |
| ------------------------------------------------ | ---------------- | ---------------- |
| `init` (no flag, CLAUDE.md exists & has content) | Skip             | Skip (preserved) |
| `init` (no flag, CLAUDE.md exists & is empty)    | Skip             | Overwrite        |
| `init` (no flag, CLAUDE.md doesn't exist)        | Copy             | Copy             |
| `init --force` (CLAUDE.md exists)                | Skip             | Overwrite        |
| `init --force` (CLAUDE.md doesn't exist)         | Copy             | Copy             |

### Files to Modify

| File                   | Changes                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `src/commands/init.ts` | Modify lines 227-234 to check force flag and file emptiness |
| `src/utils/copy.ts`    | Add `isFileEmpty()` utility function                        |
| `tests/init.test.ts`   | Update force+preserve test, add empty file tests            |
| `tests/copy.test.ts`   | Add tests for `isFileEmpty()`                               |

### Implementation Steps

1. **Add `isFileEmpty()` to src/utils/copy.ts**
2. **Modify preservation logic at src/commands/init.ts:227-234**:
    - Move the force check before preservation check
    - Add empty file check for non-force mode
3. **Update tests in tests/init.test.ts**
4. **Update help text if needed** (line 48 mentions "CLAUDE.md/AGENTS.md preserved")

## Historical Context (from research/)

- [research/docs/2026-01-20-init-config-merge-behavior.md](./2026-01-20-init-config-merge-behavior.md) - Previous research on config merge, documented the intentional preservation behavior
- The original design explicitly stated "NEVER overwritten, even with --force flag" at line 227-228

## Related Research

- [research/docs/2026-01-20-init-config-merge-behavior.md](./2026-01-20-init-config-merge-behavior.md) - Config merge behavior research
- [research/docs/2026-01-19-cli-auto-init-agent.md](./2026-01-19-cli-auto-init-agent.md) - Auto-init behavior

## Open Questions

1. **Definition of "empty"**: Should whitespace-only files be considered empty? The proposed `isFileEmpty()` function trims content.

2. **Help text update**: The current help text says "CLAUDE.md/AGENTS.md preserved". Should this be updated to reflect the new force behavior?

3. **Debug logging**: Should the debug log at line 230-231 be updated to distinguish between "preserved (non-empty)" and "overwritten (empty)"?

4. **Config folder files**: The `copyDirPreserving` function at lines 63-97 also preserves files without force. Should the empty file check apply there too, or only to additional_files?

5. **AGENTS.md symlink**: On some systems, AGENTS.md is a symlink to CLAUDE.md. Does the empty check need to follow symlinks?
