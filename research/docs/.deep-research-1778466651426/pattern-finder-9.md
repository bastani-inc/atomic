# Pattern Finder 9: Scripts Directory Analysis

## Found Patterns

#### Pattern: Bun.file() Text/JSON Streaming
**Where:** `scripts/lint-offload-await.ts:99`
**What:** Read file content as text asynchronously using Bun's file API with streaming methods.
```typescript
let text = "";
try {
  text = await Bun.file(EXECUTOR).text();
} catch (err) {
  console.error(`lint-offload-await: cannot read ${EXECUTOR}: ${err}`);
  process.exit(2);
}
const lines = text.split("\n");
```
**Variations / call-sites:**
- `lint-offload-await.ts:119` — same pattern, repeated for component files
- `bump-version.ts:96` — `Bun.file(fullPath).json()` for JSON parsing
- `build-assets.ts` does NOT use Bun file API; uses `spawnSync` + Node fs instead

#### Pattern: Bun.Glob().scanSync() for File Discovery
**Where:** `scripts/lint-offload-await.ts:113`
**What:** Synchronous glob pattern matching to discover files before async processing.
```typescript
const componentFiles = Array.from(
  new Bun.Glob(COMPONENTS_GLOB).scanSync(REPO_ROOT),
).map((p) => join(REPO_ROOT, p));
const targets = [EXECUTOR, ...componentFiles];
for (const file of targets) {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    continue;
  }
  const lines = text.split("\n");
  violations.push(
    ...checkAwaitOrCatch(file, lines, "offloadManager.requestResume(", "requestResume-await"),
  );
}
```
**Variations / call-sites:**
- `lint-offload-await.ts:132` — second scan for switch-client gate rule, same pattern

#### Pattern: import.meta.main Guard for Script Entry Point
**Where:** `scripts/lint-offload-await.ts:92`
**What:** Conditional execution guard that allows module import without running main logic.
```typescript
if (import.meta.main) {
  const violations: Violation[] = [];

  // Rule A — registerSession in executor.ts
  {
    let text = "";
    try {
      text = await Bun.file(EXECUTOR).text();
    } catch (err) {
      console.error(`lint-offload-await: cannot read ${EXECUTOR}: ${err}`);
      process.exit(2);
    }
    // ... rule enforcement logic
  }

  if (violations.length > 0) {
    console.error("\nlint-offload-await: FAIL");
    // ... error reporting
    process.exit(1);
  }

  console.log("lint-offload-await: OK");
  process.exit(0);
}
```
**Variations / call-sites:**
- `build-assets.ts:106` — same guard pattern for optional execution
- `lint-custom-workflows.ts` does NOT use this guard; runs unconditionally

#### Pattern: Bun Shell ($) for Git Command Execution
**Where:** `packages/atomic/script/bump-version.ts:86`
**What:** Execute shell commands via Bun's `$` template literal syntax for subprocess integration.
```typescript
async function getVersion(): Promise<string> {
  const arg = positional[0];

  if (!arg) {
    console.error(
      "Usage: bun run src/scripts/bump-version.ts <version|--from-branch>"
    );
    process.exit(1);
  }

  if (arg === "--from-branch") {
    const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
    return parseVersionFromBranch(branch);
  }

  // Strip leading 'v' if provided
  return arg.replace(/^v/, "");
}
```
**Variations / call-sites:**
- Only in `bump-version.ts` — no other scripts use shell integration
- Shows git coupling: script must run inside a git repo for `--from-branch` flag

#### Pattern: Bun.write() for JSON File Updates
**Where:** `packages/atomic/script/bump-version.ts:105`
**What:** Update file content atomically with JSON stringification and formatting.
```typescript
async function bumpFile(filePath: string, version: string): Promise<void> {
  const fullPath = resolve(ROOT, filePath);
  const content = await Bun.file(fullPath).json();
  const oldVersion = content.version;

  if (oldVersion === version) {
    console.log(`  ${filePath}: already at ${version}`);
    return;
  }

  content.version = version;
  await Bun.write(fullPath, JSON.stringify(content, null, 2) + "\n");
  console.log(`  ${filePath}: ${oldVersion} → ${version}`);
}
```
**Variations / call-sites:**
- Only in `bump-version.ts:105` — isolated pattern
- Preserves formatting (2-space indent + trailing newline)

#### Pattern: spawnSync() for External Tool Invocation with Stdio Inheritance
**Where:** `packages/atomic/script/build-assets.ts:74`
**What:** Execute tar commands synchronously with stdio passthrough for progress/error visibility.
```typescript
for (const { outPath, leafDir, excludes } of archives) {
  const excludeArgs = (excludes ?? []).map((ex) => `--exclude=${ex}`);
  const relOut = relative(rootDir, outPath);
  const relLeaf = relative(rootDir, leafDir);
  const r = spawnSync(
    "tar",
    ["-cf", relOut, ...excludeArgs, "-C", relLeaf, "."],
    { stdio: "inherit", cwd: rootDir },
  );
  if (r.status !== 0) {
    throw new Error(
      `bundleEmbeddedAssets: tar failed for ${outPath} (exit ${r.status})`,
    );
  }
}
```
**Variations / call-sites:**
- `build-assets.ts:85` — second spawnSync for tar `-tf` listing, different stdio mode (returns stdout)

#### Pattern: findRepoRoot() Anchor-Walk Dependency
**Where:** `packages/atomic/script/bump-version.ts:52`
**What:** Locate workspace root by walking up filesystem for `bun.lock` marker, with override fallback.
```typescript
const ROOT = rootOverride ? resolve(rootOverride) : findRepoRoot(import.meta.dir);
```
**Variations / call-sites:**
- `build-assets.ts:107` — same pattern, no override support
- Defined in: `packages/atomic/src/lib/workspace-paths.ts:32`
- Couples scripts to workspace structure; breaks if `bun.lock` is not present

#### Pattern: Line-by-Line Regex Pattern Matching for Linting
**Where:** `scripts/lint-custom-workflows.ts:38`
**What:** Synchronous file read, split into lines, iterate with regex test to find violations.
```typescript
const lines = source.split("\n");
const hits: { line: number; text: string }[] = [];

for (let i = 0; i < lines.length; i++) {
  if (PATTERN.test(lines[i])) {
    hits.push({ line: i + 1, text: lines[i].trim() });
  }
}

if (hits.length > 0) {
  console.error(
    `\nlint-custom-workflows: FAIL — anti-pattern detected in custom-workflows.ts`,
  );
  console.error(`  ${ERROR_MSG}\n`);
  for (const h of hits) {
    console.error(`  ${TARGET}:${h.line}  →  ${h.text}`);
  }
  console.error(
    "\n  Fix: build an alias-keyed Set<string> from LoadedWorkflow[] and use that for override-subtraction.\n",
  );
  process.exit(1);
}
```
**Variations / call-sites:**
- Used in `lint-offload-await.ts:48-59` (checkAwaitOrCatch function) — more complex multi-rule version
- Used in `lint-offload-await.ts:67-88` (checkSwitchClientGate function) — lookback window pattern

---

## Agent/SDK/Tmux Couplings

**Bun Runtime Coupling:**
- All 4 scripts use `#!/usr/bin/env bun` shebang
- Direct Bun APIs: `Bun.file()`, `Bun.Glob()`, `Bun.write()`, Bun `$` shell
- No tmux coupling (build/release scripts are synchronous utilities, not interactive)

**External Tool Couplings:**
- `build-assets.ts` → `tar` command (GNU tar for Linux/macOS, bsdtar on Windows)
- `bump-version.ts` → `git rev-parse` for `--from-branch` feature
- No OpenCode SDK, Claude Agent SDK, or Copilot SDK imports detected

**Workspace Path Coupling:**
- All scripts anchor on `bun.lock` via `findRepoRoot(import.meta.dir)`
- Scripts assume workspace root structure:
  - `.claude/`, `.opencode/`, `.github/`, `.agents/` directories (build-assets)
  - `packages/atomic/`, `packages/atomic-sdk/` subdirectories (bump-version)
  - `packages/atomic/src/commands/custom-workflows.ts` (lint-custom-workflows)
  - `packages/atomic-sdk/src/runtime/executor.ts` + `packages/atomic-sdk/src/components/**` (lint-offload-await)

**Process Control Coupling:**
- All 4 scripts use `process.exit()` with status codes (0 for success, 1 for lint fail, 2 for read errors)
- No agent/CLI orchestration observed

---

## Summary

The `scripts/` directory contains lightweight build/release/lint utilities (357 LOC across 4 files) that follow a consistent pattern: module-based functions exportable for testing, with optional `import.meta.main` guards. File I/O is Bun-native (`.file()`, `.Glob()`, `.write()`), shell commands use Bun's `$` template literal, and external tools (tar, git) are invoked via `spawnSync`. No agent SDK coupling—these are pure utilities. Rewrite onto pi-coding-agent would require minimal changes: convert `Bun.file()` and `Bun.write()` to Node `fs` equivalents, replace `Bun.Glob()` with `glob` npm package, and handle git/tar subprocess calls identically via Node's child_process.
