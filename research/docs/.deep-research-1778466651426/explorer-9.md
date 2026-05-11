# Partition 9 of 12 — Findings

## Scope
`scripts/` (3 files, 357 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
# Partition 9: scripts/ — Maintenance Script Locator

## Implementation

- `scripts/lint-offload-await.ts` — Enforces await/catch/void discipline on offloadManager (registerSession, requestResume) and tmuxRun(["switch-client"]) calls; no agent SDK imports, uses Bun.file/Bun.Glob for text parsing
- `scripts/lint-custom-workflows.ts` — Guards against alias-vs-name asymmetric lookup anti-pattern in custom-workflows.ts registry resolve; no agent SDK imports, uses readFileSync for pattern scanning

## Tests

- `scripts/lint-offload-await.test.ts` — Unit tests for checkAwaitOrCatch and checkSwitchClientGate validation functions; 17 test cases covering await, void, .catch, offload-exempt annotation, and violation detection logic

## Notable Findings

### Coupling Analysis

**lint-offload-await.ts**
- Direct tmux references: Rules B checks for `tmuxRun(["switch-client", ...)` patterns as part of workflow-pane offload RFC validation
- Agent SDK coupling: None. Script uses Bun native APIs (Bun.file, Bun.Glob) to scan source code
- Responsibility: Linter enforcing async/await discipline on offloadManager calls (RFC: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.5 / §8.3)
- Scopes: executor.ts (Rule A, A2) and components/**/*.{ts,tsx} (Rule A2, Rule B)

**lint-custom-workflows.ts**
- No tmux or agent SDK coupling
- Responsibility: Linter detecting registry.resolve() calls using .alias keys instead of .name keys (anti-pattern mitigation per RFC §5.7)
- Scopes: packages/atomic/src/commands/custom-workflows.ts

### Entry Points

Both scripts export named functions for testability but execute linting logic when `import.meta.main === true`:
- `checkAwaitOrCatch()` — reusable validator for Rule A / A2
- `checkSwitchClientGate()` — reusable validator for Rule B

### Package.json Integration

- `npm run lint` chains: oxlint → lint-custom-workflows.ts → lint-offload-await.ts
- `npm run lint:offload-await` runs lint-offload-await.ts standalone

### Rewrite Impact

**lint-offload-await.ts**: Heavy tmuxRun pattern dependency. The pi-coding-agent rewrite **removes all tmux**, so Rule B (switch-client gating) becomes obsolete. Rules A/A2 (offloadManager discipline) may persist if offloadManager exists in pi architecture, or be entirely removed if pi uses different async primitives.

**lint-custom-workflows.ts**: Pure business logic linter, zero tmux/agent SDK coupling. Can be ported as-is to pi-coding-agent, possibly renamed for clarity.

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
### Files Analysed

- `scripts/lint-offload-await.ts` (162 LOC) — custom AST-free linter enforcing async-discipline on offload manager calls
- `scripts/lint-custom-workflows.ts` (63 LOC) — custom regex linter enforcing correct registry key usage in custom-workflows.ts
- `scripts/lint-offload-await.test.ts` (134 LOC) — unit tests for the two exported check functions in lint-offload-await.ts

---

### Per-File Notes

#### `scripts/lint-offload-await.ts`

- **Role:** Enforces three rules of async/offload discipline on source files in `packages/atomic-sdk/src/runtime/executor.ts` and `packages/atomic-sdk/src/components/**/*.{ts,tsx}`. Rules are referenced to RFC `specs/2026-05-08-workflow-pane-offload-and-resume.md §5.5 / §8.3`. Exits with code 1 on violations, 0 on clean, 2 on file read failure.

- **Key symbols:**
  - `REPO_ROOT` (line 16) — `join(import.meta.dir, "..")`, used to anchor all file paths
  - `EXECUTOR` (lines 17–24) — absolute path to `packages/atomic-sdk/src/runtime/executor.ts`
  - `COMPONENTS_GLOB` (line 25) — `"packages/atomic-sdk/src/components/**/*.{ts,tsx}"` passed to `Bun.Glob`
  - `Violation` interface (lines 27–32) — shape `{ file: string; line: number; text: string; rule: string }`
  - `checkAwaitOrCatch(file, lines, pattern, rule): Violation[]` (lines 41–60) — exported pure function implementing Rules A and A2
  - `checkSwitchClientGate(file, lines): Violation[]` (lines 67–88) — exported pure function implementing Rule B

- **Control flow:**
  - The `import.meta.main` guard at line 92 gates all I/O; the file is safe to import without side effects.
  - Rule A block (lines 96–108): reads `EXECUTOR` via `Bun.file(...).text()`, splits by `"\n"`, calls `checkAwaitOrCatch` with pattern `"offloadManager.registerSession("` and rule label `"registerSession-await"`.
  - Rule A2 block (lines 111–128): builds file list by combining `EXECUTOR` with all files matched by `COMPONENTS_GLOB` via `new Bun.Glob(COMPONENTS_GLOB).scanSync(REPO_ROOT)` (line 113). Iterates each file, reads it, calls `checkAwaitOrCatch` with pattern `"offloadManager.requestResume("` and rule label `"requestResume-await"`. File read errors are silently skipped via empty `catch` (line 120).
  - Rule B block (lines 132–143): re-scans `COMPONENTS_GLOB` (not executor), reads each file, calls `checkSwitchClientGate`.
  - Reporting block (lines 145–161): if any violations collected, prints each as `[rule] file:line → text`, prints fix instructions referencing RFC §5.5/§8.3, exits 1. Otherwise prints OK and exits 0.

- **Data flow for `checkAwaitOrCatch` (lines 41–60):**
  - Receives `lines: string[]` and `pattern: string`.
  - Iterates lines; for each line, checks if `trimmed.includes(pattern)` (line 51). If not, skips.
  - Short-circuits as passing when trimmed starts with `"//"` (line 52), `"await "` (line 53), or `"void "` (line 54).
  - If none of those, checks `lines.slice(i, i + 6)` (a 6-element window: the match line plus 5 following lines) for any line containing `".catch("` (line 55). If found, passes.
  - Otherwise appends `{ file, line: i + 1, text: trimmed, rule }` to `out`.

- **Data flow for `checkSwitchClientGate` (lines 67–88):**
  - Hardcodes `PATTERN = 'tmuxRun(["switch-client"'` (line 68).
  - For each line containing `PATTERN`: checks same-line for `"// offload-exempt:"` (line 73) and previous line for same (line 74). Either exempts the call.
  - If not exempt: looks backward in `lines.slice(Math.max(0, i - 20), i)` (line 76) for any line containing `"offloadManager.getStatus("` or `"offloadManager.requestResume("` (lines 80–81). If found, passes.
  - Otherwise appends violation with rule `"switch-client-gate"` (line 85).

- **Dependencies:**
  - `node:path` — `join` (line 14)
  - `Bun.file` (Bun runtime API) — used at lines 99, 119, 136 for file reading
  - `Bun.Glob` (Bun runtime API) — used at lines 113, 132 for glob expansion via `.scanSync(REPO_ROOT)`
  - No external npm packages; no imports of project source files

---

#### `scripts/lint-custom-workflows.ts`

- **Role:** Guards the file `packages/atomic/src/commands/custom-workflows.ts` against one specific anti-pattern: calling `registry.resolve(<expr>.alias, ...)`. The registry is keyed by compiled `def.name`, so resolving by `.alias` is asymmetric and causes silent wrong overrides. References RFC §5.7. Exits 1 on match, 0 on clean, 2 on read failure.

- **Key symbols:**
  - `TARGET` (lines 15–23) — absolute path to `packages/atomic/src/commands/custom-workflows.ts`, computed via `join(import.meta.dir, "..", "packages", "atomic", "src", "commands", "custom-workflows.ts")`
  - `PATTERN` (line 25) — regex `/registry\.resolve\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\.alias/`; matches `registry.resolve(` followed by optional whitespace, a JS identifier, then `.alias`
  - `ERROR_MSG` (lines 27–28) — human-readable error string referencing RFC §5.7
  - `hits` (line 39) — `{ line: number; text: string }[]` accumulating matched lines

- **Control flow:**
  - No `import.meta.main` guard; the entire script body executes on import. This file is not intended to be imported as a module.
  - Reads `TARGET` synchronously via `readFileSync(TARGET, "utf-8")` (line 32). On failure, logs and exits with code 2 (lines 34–36).
  - Splits source by `"\n"` (line 38), iterates lines (lines 41–45), tests each against `PATTERN` via `PATTERN.test(lines[i])` (line 42). Matches push `{ line: i + 1, text: lines[i].trim() }` into `hits`.
  - If `hits.length > 0` (line 47): prints error block with `TARGET:line → text` for each hit, prints fix hint (use alias-keyed `Set<string>` from `LoadedWorkflow[]`), exits 1.
  - Otherwise prints OK message and exits 0 (line 62).

- **Data flow:**
  - Single file read → line-by-line regex scan → collect hits → conditional exit.
  - `PATTERN` is stateful (`RegExp`); `PATTERN.test()` is called per line without `.lastIndex` reset, but since there is no `g` flag, `test()` is stateless and safe to reuse.

- **Dependencies:**
  - `fs.readFileSync` (Node.js built-in, line 12)
  - `path.join` (Node.js built-in, line 13)
  - No Bun-specific APIs; no project source imports

---

#### `scripts/lint-offload-await.test.ts`

- **Role:** Unit test suite for the two exported pure functions in `lint-offload-await.ts`. Uses `bun:test`. Covers 17 cases: 8 for `checkAwaitOrCatch`, 6 for `checkSwitchClientGate`, plus 3 metadata-shape verifications.

- **Key symbols:**
  - Import at line 2: `import { checkAwaitOrCatch, checkSwitchClientGate } from "./lint-offload-await.ts"` — directly imports named exports; since the file has an `import.meta.main` guard, no I/O occurs on import.

- **Control flow (test cases):**
  - `checkAwaitOrCatch` tests (lines 6–76):
    - Line 6–11: bare `requestResume` → 1 violation, rule `"requestResume-await"`, line 1
    - Line 14–18: bare `registerSession` → 1 violation
    - Line 20–25: `await`-prefixed → 0 violations
    - Line 27–32: `void`-prefixed → 0 violations
    - Line 34–39: comment line (`//` prefix) → 0 violations
    - Line 41–50: `.catch` within 5 lines → 0 violations
    - Line 52–64: `.catch` at line 7 (index 6, outside `slice(i, i+6)`) → 1 violation; verifies 5-line window boundary
    - Line 66–76: two bare calls with a comment between → 2 violations at lines 1 and 3
  - `checkSwitchClientGate` tests (lines 80–133):
    - Line 80–83: bare `tmuxRun(["switch-client"` → 1 violation
    - Line 85–90: same-line `// offload-exempt:` annotation → 0 violations
    - Line 92–98: previous-line `// offload-exempt:` annotation → 0 violations
    - Line 100–108: preceding `offloadManager.getStatus(` within window → 0 violations
    - Line 110–116: preceding `offloadManager.requestResume(` within window → 0 violations
    - Line 118–123: `getStatus` present but at line 1 with 21 lines before `tmuxRun` → 1 violation; verifies 20-line window boundary exactly (22-element array: 1 gate + 20 fillers + 1 call; window `slice(max(0, 21-20), 21)` = `slice(1,21)` which excludes line 0 where getStatus is)
    - Line 125–133: shape test — `file`, `line`, `rule`, `text` fields of returned violation object

- **Dependencies:**
  - `bun:test` — `test`, `expect` (line 1)
  - `./lint-offload-await.ts` — `checkAwaitOrCatch`, `checkSwitchClientGate` (line 2)

---

### Cross-Cutting Synthesis

All three scripts enforce behavioral contracts defined by a single RFC (`specs/2026-05-08-workflow-pane-offload-and-resume.md`) without using a full AST parser. Both linters operate on raw string arrays split from file text, using substring inclusion (`includes`) and regex (`test`) as their matching primitives. This makes them fast and dependency-light but limited to textual patterns.

`lint-offload-await.ts` is the more complex script: it has two exported pure functions (`checkAwaitOrCatch`, `checkSwitchClientGate`) that carry all detection logic, enabling unit testing without file I/O. The `import.meta.main` guard cleanly separates the testable library surface from the executable entry point. `lint-custom-workflows.ts` has no such separation — the entire body executes on load, making it untestable as a module.

The lint chain in `package.json` runs `oxlint` first, then `lint-custom-workflows.ts`, then `lint-offload-await.ts` in sequence; any step's non-zero exit aborts the chain. Rule B in `lint-offload-await.ts` creates a concrete coupling to `tmuxRun(["switch-client"` string patterns that exist in `packages/atomic-sdk/src/components/`. For the pi-coding-agent rewrite, all three scripts would need to be removed or substantially rewritten if `offloadManager`, `tmuxRun`, and `registry.resolve` are eliminated.

---

### Out-of-Partition References

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/executor.ts` — Rule A target: scanned for bare `offloadManager.registerSession(` and `offloadManager.requestResume(` calls
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/components/**/*.{ts,tsx}` — Rule A2 and Rule B scan target: components checked for both requestResume discipline and ungated switch-client calls
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic-sdk/src/runtime/offload-manager.ts` — defines `offloadManager.registerSession`, `requestResume`, `getStatus` referenced by both linter patterns
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/custom-workflows.ts` — sole target of lint-custom-workflows.ts; scanned for `registry.resolve(<id>.alias, ...)` pattern; contains `mergeIntoRegistry` function referenced in fix hint
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/specs/2026-05-08-workflow-pane-offload-and-resume.md` — RFC document whose §5.5, §8.3, §5.7 sections define the rules enforced by both linters
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/package.json` — root `lint` script (line 38) chains oxlint → lint-custom-workflows.ts → lint-offload-await.ts; `lint:offload-await` alias defined at line 39

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
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

## External References
<!-- Source: codebase-online-researcher sub-agent -->
# Partition 9 — `scripts/` external dependency research

Scope: `scripts/lint-offload-await.ts`, `scripts/lint-custom-workflows.ts`, `scripts/lint-offload-await.test.ts` (357 LOC total).

## Dependency inventory

| File | External import | Nature |
|------|----------------|--------|
| lint-offload-await.ts | `node:path` (`join`) | Node built-in, no doc needed |
| lint-offload-await.ts | `Bun.file(path).text()` | Bun-native API — central |
| lint-offload-await.ts | `new Bun.Glob(pattern).scanSync(root)` | Bun-native API — central |
| lint-offload-await.ts | `import.meta.dir`, `import.meta.main` | Bun module meta — central |
| lint-custom-workflows.ts | `fs` (`readFileSync`) | Node built-in, no doc needed |
| lint-custom-workflows.ts | `path` (`join`) | Node built-in, no doc needed |
| lint-offload-await.test.ts | `bun:test` (`test`, `expect`) | Bun-native test runner — central |

`lint-custom-workflows.ts` uses only Node built-ins and pure regex; it has no Bun-specific APIs and will port to any Node-compatible runtime unchanged.

---

#### Bun File I/O (`Bun.file` / `BunFile`)

**Docs:** https://bun.com/docs/runtime/file-io

**Relevant behaviour:**

- `Bun.file(path: string | number | URL, options?: { type?: string }): BunFile` — constructs a lazy file reference; no disk I/O occurs at construction time.
- `BunFile.text(): Promise<string>` — reads entire file as UTF-8 string. Async; must be awaited.
- `BunFile.exists(): Promise<boolean>` — non-throwing way to check existence (the scripts use try/catch instead).
- Additional read methods: `.json()`, `.arrayBuffer()`, `.bytes()`, `.stream()` — not used in these scripts.
- `BunFile` implements the `Blob` interface.
- `Bun.file` is **Bun-exclusive**; it has no direct Node.js equivalent. The closest Node substitute is `fs.promises.readFile(path, 'utf-8')`.

**Where used:** `scripts/lint-offload-await.ts:99`, `scripts/lint-offload-await.ts:119`

```
text = await Bun.file(EXECUTOR).text();   // line 99
text = await Bun.file(file).text();       // line 119
```

**Rewrite note:** If pi-coding-agent runs on Node, replace with `import { readFile } from 'node:fs/promises'; const text = await readFile(path, 'utf-8');`. If it stays on Bun, `Bun.file(path).text()` is idiomatic and preferred over `fs.promises.readFile`.

---

#### Bun Glob (`Bun.Glob`)

**Docs:** https://bun.com/docs/runtime/glob

**Relevant behaviour:**

- `new Bun.Glob(pattern: string)` — constructs a glob matcher.
- `glob.scanSync(root: string | ScanOptions): Iterable<string>` — synchronously walks from `root`, yields relative path strings matching the pattern.
- `glob.scan(root: string | ScanOptions): AsyncIterable<string>` — async variant.
- `glob.match(path: string): boolean` — test a single path string.
- `ScanOptions`: `{ cwd?: string, dot?: boolean, absolute?: boolean, followSymlinks?: boolean, onlyFiles?: boolean }`. `cwd` defaults to `process.cwd()`.
- Return values are **relative** paths unless `absolute: true` is passed. The scripts pass `REPO_ROOT` as the root and then manually join with `join(REPO_ROOT, p)` to get absolute paths (line 114).
- `Bun.Glob` is **Bun-exclusive**. Node.js substitute: `glob` npm package (e.g., `import { globSync } from 'glob';`) or `node:fs` + manual recursion.

**Where used:** `scripts/lint-offload-await.ts:113`, `scripts/lint-offload-await.ts:132`

```
new Bun.Glob(COMPONENTS_GLOB).scanSync(REPO_ROOT)   // line 113
new Bun.Glob(COMPONENTS_GLOB).scanSync(REPO_ROOT)   // line 132
```

Pattern used: `"packages/atomic-sdk/src/components/**/*.{ts,tsx}"` — a brace-expansion glob with `**` recursion. Both `glob` npm and Bun.Glob support this syntax identically.

---

#### `import.meta.dir` and `import.meta.main` (Bun module meta)

**Docs:** https://bun.com/docs/runtime/import-meta

**Relevant behaviour:**

- `import.meta.dir` — absolute directory path of the current source file (Bun extension; equivalent to Node's `path.dirname(new URL(import.meta.url).pathname)` or `__dirname` in CJS).
- `import.meta.main` — `true` when the current module is the entry-point script (Bun extension; equivalent to `import.meta.url === Bun.main` or checking `process.argv[1]`).

**Where used:** `scripts/lint-offload-await.ts:16` (`import.meta.dir`), `scripts/lint-offload-await.ts:92` (`import.meta.main`)

**Rewrite note for Node:** Replace `import.meta.dir` with `path.dirname(fileURLToPath(import.meta.url))`. Replace `import.meta.main` with `process.argv[1] === fileURLToPath(import.meta.url)`.

---

#### `bun:test` test runner

**Docs:** https://bun.com/docs/test/writing

**Relevant behaviour:**

- Import: `import { test, expect } from "bun:test";`
- `test(name: string, fn: () => void | Promise<void>, timeout?: number)` — register a test case.
- `expect(value).toHaveLength(n)` — asserts `.length === n`.
- `expect(value).toBe(primitive)` — strict equality (`===`).
- `expect(value[index]!.rule).toBe("...")` — non-null assertion on array element before property access.
- Default test timeout: 5000 ms.
- `bun:test` is **Bun-native**. It is Jest-compatible for the subset of matchers used here (`toBe`, `toHaveLength`). A Node port can use Jest or Vitest with identical test source.

**Where used:** `scripts/lint-offload-await.test.ts:1-133` (all 133 LOC are bun:test API)

---

## Summary for rewrite

The three scripts are self-contained linters with no agent SDK, tmux, Claude, Copilot, or OpenCode dependencies. The only rewrite risk is the three Bun-exclusive APIs:

1. `Bun.file(path).text()` — replace with `fs.promises.readFile(path, 'utf-8')` if moving off Bun.
2. `new Bun.Glob(pattern).scanSync(root)` — replace with `globSync(pattern, { cwd: root })` from the `glob` npm package.
3. `import.meta.dir` / `import.meta.main` — replace with `path.dirname(fileURLToPath(import.meta.url))` / argv check.

If pi-coding-agent continues to use Bun as its runtime, zero changes are required in `scripts/`.

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
