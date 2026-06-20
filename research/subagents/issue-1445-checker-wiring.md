I’m unable to write `/home/alexlavaee/Documents/projects/github_work/atomic-file-length-limit/research/subagents/issue-1445-checker-wiring.md` because this subagent environment exposes only read/search/list tools and no file write/edit tool. I did not modify project/source files.

Below is the exact content to place in that file:

```markdown
# Issue #1445: File-Length Checker / Wiring Current State

## Analysis: File-Length Checker and Wiring

### Overview

The current file-length checker is a Bun TypeScript script invoked through the root `check:file-length` package script. In a Git checkout it enumerates files using `git ls-files`, so normal enforcement is tracked-file-only; outside Git or if Git commands fail, it falls back to recursively walking the working directory while applying `.gitignore` rules and the same path/generated exclusions.

### Commands / Tool Results Run

No source files were modified.

Because this subagent environment only exposed read/search tools, I did not run shell commands such as `git diff --cached` or `bun run check:file-length`. I inspected the requested files with these tool operations:

- `read scripts/check-file-length.ts`
- `read scripts/check-file-length-gitignore.ts`
- `read package.json`
- `read prek.toml`
- `read .github/workflows/test.yml`
- `read packages/coding-agent/docs/development.md`
- `read docs/ci.md`
- `read AGENTS.md`
- `read CLAUDE.md`
- `grep` searches for checker symbols, documented file-length text, and CI/prek wiring in the same files.

### Entry Points

- `package.json:25` - Root `check:file-length` script runs `bun scripts/check-file-length.ts`.
- `package.json:26` - Root `lint` script runs `bun run typecheck && bun run check:file-length`.
- `prek.toml:21` - Local `bun-lint` hook runs `bun run lint` with `pass_filenames = false`.
- `prek.toml:22` - Separate local `check-file-length` hook runs `bun run check:file-length` with `pass_filenames = false`.
- `.github/workflows/test.yml:36-37` - CI has a dedicated “File length check” step that runs `bun run check:file-length`.
- `scripts/check-file-length.ts:393-396` - Top-level `main().catch(...)` reports uncaught errors as `check-file-length: ...` and exits with status 2.

### Core Implementation

#### 1. Defaults, Scope, and Exclusions (`scripts/check-file-length.ts:7-34`)

- The default maximum is 500 physical lines (`DEFAULT_MAX_LINES`) at `scripts/check-file-length.ts:7`.
- Git command timeout is 30 seconds (`GIT_COMMAND_TIMEOUT_MS`) at `scripts/check-file-length.ts:8`.
- Generated-marker scanning is limited to the first 5 lines (`GENERATED_MARKER_LINE_LIMIT`) at `scripts/check-file-length.ts:9`.
- In-scope file extensions are `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.rs` at `scripts/check-file-length.ts:11-19`.
- Path exclusions are hard-coded at `scripts/check-file-length.ts:21-31`:
  - `**/node_modules/**`
  - `**/dist/**`
  - `**/target/**`
  - `**/binaries/**`
  - `**/.git/**`
  - `**/vendor/**`
  - `**/*.min.js`
  - `**/*.min.mjs`
  - `packages/workflows/skills/impeccable/**`
- Generated-marker exclusion pattern is `/(@generated|auto-generated style variants|generated -- do not edit|do not edit)/i` at `scripts/check-file-length.ts:33-34`.

#### 2. CLI Options: `--max`, quiet, and CI (`scripts/check-file-length.ts:71-133`)

- Usage text documents `--max=<lines>`, `--max <lines>`, `--quiet`, `--ci`, and `--help` at `scripts/check-file-length.ts:72-85`.
- `parseArgs()` starts with `maxLines = DEFAULT_MAX_LINES`, `quiet = false`, and `ci` derived from `CI=true` or `GITHUB_ACTIONS=true` at `scripts/check-file-length.ts:88-91`.
- `--help` / `-h` sets `help = true` at `scripts/check-file-length.ts:95-98`.
- `--quiet` / `-q` sets `quiet = true` at `scripts/check-file-length.ts:100-103`.
- `--ci` sets both `ci = true` and `quiet = true` at `scripts/check-file-length.ts:108-112`.
- `--max=<value>` is parsed at `scripts/check-file-length.ts:114-118`.
- `--max <value>` is parsed at `scripts/check-file-length.ts:120-126`.
- Unknown args throw `CliError` at `scripts/check-file-length.ts:129`.
- Final returned `quiet` is `quiet || ci`, so either explicit quiet mode, `--ci`, `CI=true`, or `GITHUB_ACTIONS=true` suppresses the clean success summary at `scripts/check-file-length.ts:131-135`.
- `parseMaxLines()` requires a positive safe integer and throws `CliError` otherwise at `scripts/check-file-length.ts:138-144`.

#### 3. Tracked-File-Only Policy in Git Checkouts (`scripts/check-file-length.ts:164-187`, `scripts/check-file-length.ts:231-239`)

- Git is invoked through `runGit()` using `Bun.spawnSync` with stdout/stderr pipes and the 30-second timeout at `scripts/check-file-length.ts:164-169`.
- `tryListTrackedFiles()` first runs `git rev-parse --show-toplevel` at `scripts/check-file-length.ts:171-172`.
- If Git root detection fails or returns an empty root, the Git listing path returns `null` at `scripts/check-file-length.ts:172-176`.
- In a valid Git checkout, it runs `git ls-files -z --full-name` from the repo root at `scripts/check-file-length.ts:178`.
- If `git ls-files` succeeds, NUL-separated output is split, empty entries are filtered, paths are normalized to `/`, and the listing source is returned as `"git"` at `scripts/check-file-length.ts:181-187`.
- `listCandidateFiles()` uses the Git listing if available at `scripts/check-file-length.ts:231-233`.
- Only if Git listing is unavailable does `listCandidateFiles()` return a walk-based listing from `listFilesByWalking(cwd)` with source `"walk"` at `scripts/check-file-length.ts:235-239`.

Current behavior: in normal repository/CI execution, candidate files come from `git ls-files`, so untracked files are not checked. The fallback walk is used when Git root/listing is unavailable, not as an additional source in Git mode.

#### 4. Fallback Recursive Walk and `.gitignore` Handling (`scripts/check-file-length.ts:190-229`, `scripts/check-file-length-gitignore.ts:18-49`)

- `listFilesByWalking()` initializes a pending directory stack with `[""]` and creates a workspace `.gitignore` matcher at `scripts/check-file-length.ts:190-193`.
- It reads each directory with `readdirSync(..., { withFileTypes: true })`, ignoring unreadable directories by continuing after catch at `scripts/check-file-length.ts:198-203`.
- For directories, it applies the hard-coded path exclusions by testing a placeholder child path, then applies `.gitignore` rules before pushing the directory for traversal at `scripts/check-file-length.ts:211-218`.
- For files, it only adds entries not ignored by `.gitignore` at `scripts/check-file-length.ts:222-224`.
- Walked files are sorted lexicographically before returning at `scripts/check-file-length.ts:227-228`.
- `createGitignoreMatcher(root)` returns a `WorkspaceGitignoreMatcher` at `scripts/check-file-length-gitignore.ts:18-20`.
- The matcher normalizes paths, walks applicable `.gitignore` rule directories, and toggles ignored state based on matching negated/non-negated rules at `scripts/check-file-length-gitignore.ts:27-36`.
- `.gitignore` files are discovered per directory via `join(root, normalizedDirectory, ".gitignore")`, cached, and parsed if present at `scripts/check-file-length-gitignore.ts:42-51`.
- `.gitignore` parsing skips empty/comment lines, supports `!` negation, anchored `/`, directory-only trailing `/`, slash-containing path patterns, and glob-to-RegExp conversion at `scripts/check-file-length-gitignore.ts:91-118`.

Current behavior: `.gitignore` matching only affects the non-Git fallback walk. In Git mode, tracked files are taken from `git ls-files`; `.gitignore` does not filter those tracked files.

#### 5. Per-File Filtering and Counting (`scripts/check-file-length.ts:147-162`, `scripts/check-file-length.ts:242-276`, `scripts/check-file-length.ts:340-368`)

- `normalizePath()` converts backslashes to forward slashes at `scripts/check-file-length.ts:147-148`.
- `hasTargetExtension()` lowercases the path and checks the configured target extensions at `scripts/check-file-length.ts:150-152`.
- `getPathExclusion()` tests each configured Bun glob and returns the matched pattern or `null` at `scripts/check-file-length.ts:154-160`.
- `firstLinesText()` scans bytes until the configured number of newline characters has been seen, then decodes only that prefix at `scripts/check-file-length.ts:242-256`.
- `hasGeneratedMarker()` applies the generated-marker regex to the first five lines at `scripts/check-file-length.ts:259-263`.
- `countPhysicalLines()` returns 0 for empty files, counts `\n` bytes, and adds one when the file does not end in newline at `scripts/check-file-length.ts:265-276`.
- The main loop normalizes each listed path, skips non-target extensions, skips matching path exclusions, reads file bytes with `Bun.file(...).bytes()`, skips generated-marker files, increments `checkedFiles`, counts physical lines, and records violations when `lineCount > options.maxLines` at `scripts/check-file-length.ts:340-368`.

#### 6. Output and Exit Behavior (`scripts/check-file-length.ts:288-396`)

- Violations are sorted by descending line count, then path, in `sortViolations()` at `scripts/check-file-length.ts:279-286`.
- `printViolations()` writes the failure summary, table, and “Split oversized authored files...” guidance to stderr at `scripts/check-file-length.ts:288-309`.
- Read failures are printed to stderr by `printReadFailures()` at `scripts/check-file-length.ts:312-321`.
- `main()` prints read failures before violation handling at `scripts/check-file-length.ts:371`.
- If any violations exist, it prints violations, sets `process.exitCode = 1`, and returns at `scripts/check-file-length.ts:373-377`.
- If read failures exist without violations, it sets `process.exitCode = 1` and returns at `scripts/check-file-length.ts:380-383`.
- On a clean pass and when not quiet, it prints a success summary including checked count, source (`tracked` for Git, `walked` for fallback), max, skipped-by-path count, and skipped-by-marker count at `scripts/check-file-length.ts:385-391`.
- Uncaught errors are printed with a `check-file-length:` prefix and exit status 2 at `scripts/check-file-length.ts:393-396`.

### Data Flow

1. User/CI/prek invokes `bun run check:file-length` through `package.json:25`.
2. Bun runs `scripts/check-file-length.ts`; `main()` parses args from `process.argv.slice(2)` at `scripts/check-file-length.ts:324-325`.
3. `listCandidateFiles(process.cwd())` chooses `git ls-files` output when available at `scripts/check-file-length.ts:328` and `scripts/check-file-length.ts:231-233`.
4. In Git mode, `tryListTrackedFiles()` returns repo root plus tracked paths from `git ls-files -z --full-name` at `scripts/check-file-length.ts:171-187`.
5. In fallback mode, `listFilesByWalking()` recursively walks from cwd while applying path exclusions and `.gitignore` rules at `scripts/check-file-length.ts:190-229`.
6. Main loop filters candidate paths by extension at `scripts/check-file-length.ts:342-343`.
7. Main loop filters hard-coded path exclusions at `scripts/check-file-length.ts:345-348`.
8. Main loop reads file bytes via `Bun.file(absolutePath).bytes()` at `scripts/check-file-length.ts:351-352`.
9. Main loop skips files with generated markers in the first five lines at `scripts/check-file-length.ts:359-362`.
10. Main loop counts physical lines and adds violations for `lineCount > options.maxLines` at `scripts/check-file-length.ts:364-368`.
11. Failures produce stderr output and exit code 1; clean non-quiet runs produce a stdout summary at `scripts/check-file-length.ts:371-391`.

### Tracked-File-Only Policy

Current behavior is tracked-file-only when Git is available:

- `git rev-parse --show-toplevel` establishes the repository root at `scripts/check-file-length.ts:171-176`.
- `git ls-files -z --full-name` is the source of file paths in Git mode at `scripts/check-file-length.ts:178-187`.
- `listCandidateFiles()` returns the Git listing immediately when available at `scripts/check-file-length.ts:231-233`.
- The fallback recursive walk is only used when the Git listing is unavailable at `scripts/check-file-length.ts:235-239`.

Documentation matches this behavior:

- `packages/coding-agent/docs/development.md:69` says the gate scans tracked `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.rs` files via `git ls-files`, with a recursive-walk fallback outside Git.
- `docs/ci.md:96` says CI runs `bun run check:file-length` to enforce the 500-line maximum for tracked TS/JS/Rust source-like files after documented exclusions.
- `AGENTS.md:83` and `CLAUDE.md:83` describe tracked TypeScript, JavaScript, and Rust source-like files at or below 500 physical lines.

### Documented Exclusions

Implementation exclusions:

- Path exclusions are defined at `scripts/check-file-length.ts:21-31`.
- Generated-marker regex is defined at `scripts/check-file-length.ts:33-34`.
- Generated-marker checks are limited to the first five lines via `firstLinesText()` and `hasGeneratedMarker()` at `scripts/check-file-length.ts:242-263`.
- Path exclusions are applied before reading file contents at `scripts/check-file-length.ts:345-348`.
- Generated-marker exclusions are applied after reading bytes and before counting lines at `scripts/check-file-length.ts:359-362`.

Documentation:

- `packages/coding-agent/docs/development.md:69` documents generated/vendored path glob exclusions for `node_modules`, `dist`, `target`, `binaries`, `.git`, `vendor`, minified bundles, and `packages/workflows/skills/impeccable/**`, plus first-five-line generated markers.
- `AGENTS.md:83` and `CLAUDE.md:83` document the same extension set and exclusions, including generated markers such as `@generated`, `auto-generated`, `DO NOT EDIT`, and `GENERATED -- do not edit`.
- `docs/ci.md:96` summarizes CI enforcement as applying only the documented generated/vendored exclusions.

There is no grandfather/baseline allowlist in the inspected implementation; filtering is by extension, path glob, and generated marker.

### `--max`, Quiet, and CI Behavior

- Default max is 500 lines at `scripts/check-file-length.ts:7`.
- `--max=<lines>` and `--max <lines>` are accepted at `scripts/check-file-length.ts:114-126`.
- `parseMaxLines()` accepts only positive safe integers at `scripts/check-file-length.ts:138-144`.
- `--quiet` / `-q` suppresses the clean success summary at `scripts/check-file-length.ts:100-103` and `scripts/check-file-length.ts:385-391`.
- `--ci` sets quiet mode at `scripts/check-file-length.ts:108-112`.
- `CI=true` or `GITHUB_ACTIONS=true` also enables CI/quiet behavior at `scripts/check-file-length.ts:91` and `scripts/check-file-length.ts:131-135`.
- Violations and read failures are still reported regardless of quiet mode because quiet is only checked before printing the clean success summary at `scripts/check-file-length.ts:385`.

### Bun / Package Script Wiring

- Root package declares `packageManager: bun@1.3.14` at `package.json:5`.
- Root package requires `bun >=1.3.14` at `package.json:6-8`.
- `check:file-length` runs `bun scripts/check-file-length.ts` at `package.json:25`.
- `lint` runs `bun run typecheck && bun run check:file-length` at `package.json:26`.
- `AGENTS.md:18` / `CLAUDE.md:18` document Bun ≥ 1.3.14 as the runtime/package manager/test runner.
- `AGENTS.md:36-39` / `CLAUDE.md:36-39` list repo commands including `bun run check:file-length` and describe npm as only a publish exception.
- `packages/coding-agent/docs/development.md:9-13` includes `bun install`, `bun run typecheck`, and `bun run check:file-length` in setup.
- `packages/coding-agent/docs/development.md:60-61` lists `bun run check:file-length` under testing commands.

### Prek Hook Wiring

- `prek.toml:1` installs both `pre-commit` and `pre-push` hook types by default.
- Builtin hooks are configured at `prek.toml:3-15`.
- Local hooks are configured at `prek.toml:17-24`.
- `bun-lint` runs `bun run lint` with `pass_filenames = false` at `prek.toml:21`.
- `check-file-length` separately runs `bun run check:file-length` with `pass_filenames = false` at `prek.toml:22`.
- Because both `bun-lint` and `check-file-length` invoke the file-length gate (`lint` includes it via `package.json:26`, and the separate hook invokes it directly via `prek.toml:22`), current prek wiring runs the checker through both paths.
- `package.json:17` runs `bun scripts/install-hooks.mjs` on prepare.
- `package.json:18-19` define manual prek install/run scripts using `bunx --bun --no-install prek ...`.
- `AGENTS.md:37` / `CLAUDE.md:37` state that hooks are configured in `prek.toml` and `bun install` runs root `prepare` to install hooks with `prek install --prepare-hooks`.

### CI Wiring

- `.github/workflows/test.yml:3-4` sets `PREK_DISABLE_INSTALL: "1"` for the workflow environment.
- `.github/workflows/test.yml:27` checks out the repository.
- `.github/workflows/test.yml:28-30` installs Bun via `oven-sh/setup-bun@v2` with `bun-version: latest`.
- `.github/workflows/test.yml:32-33` installs dependencies with `bun install --frozen-lockfile`.
- `.github/workflows/test.yml:34-35` runs `bun run typecheck`.
- `.github/workflows/test.yml:36-37` runs the dedicated `bun run check:file-length` step.
- `docs/ci.md:14-15` includes `bun run check:file-length` in the workflow overview.
- `docs/ci.md:95-96` documents typecheck followed by file-length enforcement in test workflow steps.
- `docs/ci.md:277` summarizes `test.yml` as enforcing the tracked TS/JS/Rust file-length gate.
- `docs/ci.md:299-300` includes `bun run check:file-length` in the local release validation checklist.

### Current Behavior Summary

- **Tracked-file-only:** Yes in Git checkouts. The checker uses `git ls-files -z --full-name` and returns that listing before any fallback walk (`scripts/check-file-length.ts:171-187`, `scripts/check-file-length.ts:231-233`).
- **Fallback outside Git:** Yes. If Git root/listing is unavailable, it recursively walks cwd and applies `.gitignore` plus path exclusions (`scripts/check-file-length.ts:190-229`, `scripts/check-file-length.ts:235-239`).
- **Documented exclusions:** Implemented as hard-coded Bun globs plus first-five-line generated markers (`scripts/check-file-length.ts:21-34`, `scripts/check-file-length.ts:345-362`) and reflected in docs (`packages/coding-agent/docs/development.md:69`, `AGENTS.md:83`, `CLAUDE.md:83`, `docs/ci.md:96`).
- **`--max`:** Implemented for `--max=<lines>` and `--max <lines>` with positive-integer validation (`scripts/check-file-length.ts:114-126`, `scripts/check-file-length.ts:138-144`).
- **Quiet/CI:** Implemented. `--quiet`, `--ci`, `CI=true`, and `GITHUB_ACTIONS=true` suppress only the clean success summary; errors/violations still print (`scripts/check-file-length.ts:88-91`, `scripts/check-file-length.ts:100-112`, `scripts/check-file-length.ts:131-135`, `scripts/check-file-length.ts:371-391`).
- **Bun wiring:** Root script runs the checker with Bun (`package.json:25`); repo declares Bun package manager and engine (`package.json:5-8`).
- **Prek wiring:** Default pre-commit/pre-push hooks include both `bun-lint` and a direct `check-file-length` local hook with `pass_filenames = false` (`prek.toml:1`, `prek.toml:21-22`).
- **CI wiring:** Test workflow installs dependencies with Bun, runs typecheck, then runs the file-length checker as its own step (`.github/workflows/test.yml:32-37`).
```
