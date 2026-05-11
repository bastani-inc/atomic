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
