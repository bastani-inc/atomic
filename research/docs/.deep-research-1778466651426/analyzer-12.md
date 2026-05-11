### Files Analysed

- `install.ps1` — Windows PowerShell bootstrap installer (128 LOC)
- `install.sh` — POSIX shell bootstrap installer (macOS + Linux, 174 LOC)
- `install.cmd` — Windows cmd.exe bootstrap installer (169 LOC)
- `packages/atomic/src/commands/cli/install.ts` — binary `atomic install` subcommand (826 LOC)
- `packages/atomic/src/commands/cli/install-method.ts` — synchronous install-method detector used by install.ts (105 LOC)
- `packages/atomic/src/services/system/install-method.ts` — async install-method detector used by the update/uninstall service layer (192 LOC)
- `packages/atomic/src/services/system/install-ui.ts` — phased async progress bar UI for auto-sync/install flows (297 LOC)

---

### Per-File Notes

#### `install.ps1`

- **Role:** Windows PowerShell 5.1+ bootstrap that fetches a manifest, downloads and SHA256-verifies the prebuilt binary, then delegates all placement logic to `atomic install`.
- **Key symbols:**
  - `$Target` param (`install.ps1:15-18`) — accepts `stable`, `latest`, or a semver string; validated by `ValidatePattern`.
  - `$RELEASES_BASE` (`install.ps1:30`) — GitHub releases URL: `https://github.com/flora131/atomic/releases`.
  - `$DOWNLOAD_DIR` (`install.ps1:31`) — `%USERPROFILE%\.atomic\downloads`.
  - `$platform` (`install.ps1:34-38`) — set to `windows-arm64` or `windows-x64` based on `$env:PROCESSOR_ARCHITECTURE`.
  - Manifest fetch via `Invoke-RestMethod` (`install.ps1:54`).
  - `$manifest.version` and `$manifest.platforms.$platform.checksum` extracted (`install.ps1:61-66`).
  - Binary download via `Invoke-WebRequest` in a `$maxAttempts=3` retry loop (`install.ps1:77-98`).
  - SHA256 verification via `Get-FileHash` (`install.ps1:100-105`).
  - Delegation: `& $binaryPath install` (`install.ps1:113`).
  - Cleanup of temp binary in `finally` block (`install.ps1:115-124`).
- **Control flow:**
  1. Reject 32-bit process (`install.ps1:25-28`).
  2. Detect platform string (`install.ps1:34-38`).
  3. Resolve manifest URL for `latest`/`stable` vs pinned version (`install.ps1:47-51`).
  4. Fetch manifest JSON via `Invoke-RestMethod` (`install.ps1:53-59`).
  5. Extract `version` and `checksum` from manifest (`install.ps1:61-66`).
  6. Construct binary URL using pinned version (`install.ps1:71-72`).
  7. Download binary with up to 3 attempts, exponential back-off capped at 5 s (`install.ps1:77-98`).
  8. SHA256 verify (`install.ps1:100-105`).
  9. Invoke `$binaryPath install` and clean up temp file in `finally` (`install.ps1:112-124`).
- **Data flow:** `$env:PROCESSOR_ARCHITECTURE` → `$platform` → manifest URL → `manifest.json` → `$version`, `$checksum` → binary URL → downloaded EXE → verified → invoked → deleted.
- **Dependencies:** None beyond PowerShell built-ins (`Invoke-RestMethod`, `Invoke-WebRequest`, `Get-FileHash`). No agent SDKs, no tmux.

---

#### `install.sh`

- **Role:** POSIX shell bootstrap installer for macOS and Linux; structurally identical to `install.ps1` but uses curl/wget, shasum/sha256sum, and handles musl libc detection for Alpine Linux.
- **Key symbols:**
  - `TARGET` (`install.sh:17`) — positional arg defaulting to `latest`.
  - `RELEASES_BASE` (`install.sh:24`) — same GitHub releases URL.
  - `DOWNLOAD_DIR` (`install.sh:25`) — `$HOME/.atomic/downloads`.
  - `download_file()` (`install.sh:37-52`) — delegates to curl (`--retry 3`) or wget.
  - `get_checksum_from_manifest()` (`install.sh:55-63`) — regex extracts SHA256 from manifest JSON without jq.
  - `get_version_from_manifest()` (`install.sh:65-73`) — regex extracts version string.
  - `$libc` (`install.sh:104-111`) — set to `-musl` on Alpine via ldd probe or `/lib/ld-musl-*` fallback.
  - `$platform` (`install.sh:113`) — composed as `${os}-${arch}${libc}`.
  - Rosetta 2 detection (`install.sh:94-98`) — upgrades x64 to arm64 on Apple Silicon under Rosetta.
  - Delegation: `"$binary_path" install` (`install.sh:166`).
- **Control flow:** OS detection → arch detection → Rosetta probe → musl probe → platform string → manifest fetch → version/checksum parse → binary download → SHA256 verify → `chmod +x` → `atomic install` → `rm -f`.
- **Data flow:** `uname -s`/`uname -m` → `$platform` → manifest URL → manifest JSON (parsed via bash regex) → `$version`, `$checksum` → binary URL → downloaded binary → verified/chmod → invoked → deleted.
- **Dependencies:** curl or wget (external), shasum/sha256sum (external). No agent SDKs, no tmux.

---

#### `install.cmd`

- **Role:** Windows cmd.exe bootstrap installer; functionally equivalent to `install.ps1` but targeted at environments where PowerShell execution policy may block `iex`; uses curl (ships with Windows 10+) and delegates JSON parsing and input validation to inline PowerShell calls.
- **Key symbols:**
  - `TARGET` (`install.cmd:16-17`) — first argument, defaults to `latest`.
  - Input validation via `powershell ... -match` (`install.cmd:27`) — validates semver pattern including prerelease; delegates because cmd.exe's `findstr` falsely rejects prelease strings due to trailing CR (`install.cmd:20-25`).
  - `PLATFORM` (`install.cmd:54-58`) — `windows-arm64` or `windows-x64`.
  - Manifest downloaded via `:download_file` subroutine using `curl -fsSL --retry 3` (`install.cmd:146`).
  - Manifest parsing via PowerShell `ConvertFrom-Json` pipeline, outputting `version|checksum` as a pipe-delimited pair (`install.cmd:89-92`).
  - SHA256 via `:verify_checksum` using `certutil -hashfile SHA256` (`install.cmd:154-168`).
  - Delegation: `"!BINARY_PATH!" install` (`install.cmd:120`).
  - 1-second `timeout /t 1` before temp cleanup to release file handles (`install.cmd:124`).
- **Control flow:** 32-bit rejection → arch detection → manifest URL resolution → curl download → PowerShell JSON parse → binary curl download → certutil SHA256 verify → `atomic install` → temp cleanup.
- **Data flow:** `%PROCESSOR_ARCHITECTURE%` → `PLATFORM` → manifest URL → `manifest.json` → `VERSION|EXPECTED_CHECKSUM` (via PowerShell) → binary URL → downloaded EXE → verified → invoked → deleted.
- **Dependencies:** curl (Windows 10+ built-in), certutil (Windows built-in), PowerShell (for JSON parsing and regex validation). No agent SDKs, no tmux.

---

#### `packages/atomic/src/commands/cli/install.ts`

- **Role:** The `atomic install` binary subcommand that the bootstrap scripts hand off to; performs self-copy to install dir, PATH persistence, tmux/psmux detection, shell completions installation, and artifact cleanup.
- **Key symbols:**
  - `RC_MARKER` (`install.ts:40`) — `"# Atomic CLI completions (cached)"` sentinel written to rc files.
  - `PATH_RC_MARKER` (`install.ts:41`) — `"# Atomic CLI PATH"` sentinel.
  - `InstallOptions` (`install.ts:43-46`) — `{ noCompletions?: boolean }`.
  - `InstallPaths` (`install.ts:48-52`) — `{ binDir, binPath, completionsDir }`.
  - `getInstallPaths()` (`install.ts:58-74`) — returns platform-specific paths:
    - Windows: `%LOCALAPPDATA%\atomic\bin\atomic.exe`, `~\.atomic\completions`.
    - Unix: `~/.local/bin/atomic`, `~/.atomic/completions`.
  - `copyBinary()` (`install.ts:96-132`) — atomic move pattern (copy to temp, chmod, rename); archives existing `atomic.exe` as `.old.<ts>` on Windows before copy.
  - `CleanupResult` (`install.ts:155-158`), `cleanupOldArtifacts()` (`install.ts:160-200`) — reaps `.old.<digits>` and `.tmp.<pid>.<ts>` orphan files; 1-hour threshold for temp files.
  - `pathContains()` (`install.ts:204-212`) — case-insensitive path membership check.
  - `persistPathEntry()` (`install.ts:223-228`) — delegates to `persistWindowsPath()` or `persistUnixPath()`.
  - `persistWindowsPath()` (`install.ts:230-254`) — reads/writes HKCU registry PATH via `[Environment]::SetEnvironmentVariable` PowerShell; uses env-var pass-through to avoid quoting hazards.
  - `persistUnixPath()` (`install.ts:256-269`) — appends idempotent snippet to detected shell rc files.
  - `detectUserShell()` (`install.ts:295-311`) — probes `$SHELL`, `/etc/passwd`, falls back to `bash`.
  - `detectMuxBinary()` (`install.ts:411-432`) — scans PATH then well-known dirs for `tmux` (Unix) or `psmux`/`pmux` (Windows).
  - `wellKnownMuxInstallDirs()` (`install.ts:435-462`) — platform-specific candidate directories for tmux/psmux.
  - `installCompletions()` (`install.ts:472-497`) — writes shell-specific completion script to `~/.atomic/completions/`; sources from rc file.
  - `ensureCompletionsSourcedFromRc()` (`install.ts:509-534`) — strips legacy `eval`-based snippet before appending marker-based source line.
  - `stripRcSnippet()` (`install.ts:555-590`) — removes marker-delimited blocks from rc files (used by uninstall).
  - `uninstallCommand()` (`install.ts:695-747`) — detects install method and either prints package-manager hint or runs full binary uninstall.
  - `installCommand()` (`install.ts:751-825`) — public entry: `copyBinary` → `persistPathEntry` → `detectMuxBinary` → `installCompletions` → `cleanupOldArtifacts` (microtask).
- **Control flow:** `installCommand()` calls helpers sequentially; errors in PATH persistence are non-fatal (logged, not thrown); mux-not-found is a warning; completions failure is a warning; artifact reaping is `queueMicrotask` (fire-and-forget).
- **Data flow:** `process.execPath` → `copyBinary` → install dir; `homedir()` + platform → PATH registry / rc files; `detectMuxBinary()` → mux directory added to PATH; `detectUserShell()` → completion script path → rc file.
- **Dependencies:** `node:fs`, `node:os`, `node:path`; `./install-method.ts` (for uninstall method detection); `../../completions/index.ts` (completion script strings); `Bun.spawnSync` (PowerShell invocations); **tmux/psmux detection is the one tmux coupling point in this file**.

---

#### `packages/atomic/src/commands/cli/install-method.ts`

- **Role:** Synchronous (cached) install-method detector used within `install.ts`'s uninstall flow; classifies the running binary as `binary | bun | npm | pnpm | yarn | source | unknown`.
- **Key symbols:**
  - `InstallMethod` type (`install-method.ts:4-11`) — union of 7 string literals.
  - `DetectOptions` (`install-method.ts:13-20`) — test seams for `execPath`, `probe`, `platform`.
  - `PKG_PATH_RE` (`install-method.ts:22`) — `/\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//`.
  - `PM_PROBE_CMD` (`install-method.ts:24-29`) — CLI list commands for bun/pnpm/yarn/npm.
  - `detectInstallMethod()` (`install-method.ts:45-52`) — memoizes result in module-level `cached` when no overrides.
  - `computeInstallMethod()` (`install-method.ts:54-92`) — heuristic chain: binary path prefix → node_modules regex → path substring heuristics → PM probes → bun exec path → unknown.
  - `_resetInstallMethodCache()` (`install-method.ts:104`) — test hook.
- **Control flow:** Path normalization → binary dir prefix check → `PKG_PATH_RE` → path substring → `Bun.spawnSync` probe per PM → exec path ends with `/bun` → `unknown`.
- **Data flow:** `process.execPath` (or override) → normalized path → classification.
- **Dependencies:** `node:os`, `node:path`; `Bun.spawnSync`. No agent SDKs.

---

#### `packages/atomic/src/services/system/install-method.ts`

- **Role:** Async richer install-method detector used by the update/uninstall service layer; returns discriminated union objects with `kind` and `binPath`; includes PM listing probes with timeouts, node_modules layout inspection, and `.git`-walk source-checkout detection.
- **Key symbols:**
  - `InstallMethod` discriminated union (`install-method.ts:15-21`) — `{ kind: "binary"|"bun"|"npm"|"pnpm"|"yarn"|"source"|"unknown"; binPath?: string }`.
  - `ATOMIC_PACKAGE_NAME` (`install-method.ts:13`) — `"@bastani/atomic"`.
  - `pmListsAtomic()` (`install-method.ts:63-93`) — async PM list queries with JSON parsing for npm/pnpm; NDJSON scan for yarn.
  - `PROBE_TIMEOUT_MS` (`install-method.ts:34`) — 5000 ms timeout; kills the probe process.
  - `inferPmFromNodeModules()` (`install-method.ts:97-107`) — inspects `.pnpm` or `.yarn-state.yml` marker files.
  - `isInsideRepoCheckout()` (`install-method.ts:113-148`) — walks up to 20 dirs looking for `.git` + `package.json` with matching `name` or `workspaces`.
  - `detectInstallMethod()` (`install-method.ts:152-191`) — checks binary install path → bun home roots → node_modules → PM probes → repo walk → unknown.
- **Control flow:** Async; path checks are synchronous fast paths; PM list probes are async with 5 s kill timeout.
- **Data flow:** `process.execPath` → `getInstallPaths().binPath` comparison → bun root check → node_modules check → PM list probe stdout → `.git` walk → `InstallMethod` object.
- **Dependencies:** `node:fs`, `node:os`, `node:path`; `../../commands/cli/install.ts` (for `getInstallPaths`); `Bun.spawn`. No agent SDKs.

---

#### `packages/atomic/src/services/system/install-ui.ts`

- **Role:** Progress bar and phased async runner for the auto-sync/first-run install flow; renders a braille spinner + gradient-filled bar in-place via ANSI escape sequences.
- **Key symbols:**
  - `StepResult` (`install-ui.ts:151-156`) — `{ label, ok, error? }`.
  - `Step` (`install-ui.ts:158-161`) — `{ label, fn: () => Promise<unknown> }`.
  - `Phase` (`install-ui.ts:163`) — `Step[]`; steps within a phase run in parallel.
  - `runSteps()` (`install-ui.ts:179-269`) — executes phases sequentially, steps within each phase via `Promise.all`; animates at 80 ms/frame via `setInterval`; hides cursor during animation; restores on SIGINT/SIGTERM.
  - `printSummary()` (`install-ui.ts:276-296`) — prints ✓/✗ per step with up to 4 lines of error output.
  - `renderBar()` (`install-ui.ts:106-134`) — per-character RGB gradient in true-color mode; solid color in 256-color mode; basic ANSI fallback.
  - `BAR_STATE_PALETTE` (`install-ui.ts:47-51`) — maps `progress/success/error` to Catppuccin Mocha palette keys `warning/success/error`.
  - `SPINNER_FRAMES` (`install-ui.ts:166`) — 10-frame braille spinner.
- **Control flow:** `runSteps(phases)` → for each phase → `Promise.all(steps)` → each step result captured → `completed++` → label update → after all phases → clear interval → render final line → return results.
- **Data flow:** `Phase[]` in → per-step `StepResult[]` out; `completed`/`total` counters drive bar fill ratio; `currentLabel` tracks in-flight step labels.
- **Dependencies:** `@bastani/atomic-sdk/theme/colors` (`COLORS`, `PALETTE`, `paletteRgb`); `@bastani/atomic-sdk/services/system/detect` (`supportsTrueColor`, `supports256Color`). No agent SDKs, no tmux.

---

### Cross-Cutting Synthesis

The Windows installer (`install.ps1`) is a thin 128-line bootstrap: it resolves a `manifest.json` from GitHub Releases (with version-pinning to avoid mid-release URL instability), downloads the platform-specific prebuilt binary with up to 3 retries, verifies the SHA256 checksum, and then executes `atomic install` before cleaning up the temp file. All substantive installation logic — binary placement using the atomic copy-then-rename pattern, PATH wiring to the Windows registry via PowerShell or to Unix rc files, tmux/psmux discovery across a curated set of package-manager install locations, shell completion script generation and rc-file injection, and artifact reaping — lives in `packages/atomic/src/commands/cli/install.ts`. The `install-method.ts` sibling provides install-method classification (binary vs. bun vs. npm/pnpm/yarn vs. source) used to gate whether `uninstallCommand` can proceed or must defer to the user's package manager. The `install-ui.ts` file provides the phased async progress bar consumed by the auto-sync flow, not by the bootstrap path. The entire installer stack is **agent-agnostic**: the only non-portable coupling is the `tmux`/`psmux` detection and PATH-wiring in `install.ts`, which is the single seam requiring renaming or replacement for a pi-coding-agent rewrite.

---

### Out-of-Partition References

- `packages/atomic/src/completions/index.ts` — exports `bashCompletionScript`, `zshCompletionScript`, `fishCompletionScript`, `powershellCompletionScript`; consumed directly by `install.ts:29-31`.
- `packages/atomic/src/commands/cli/install-method.test.ts` — unit tests for the synchronous install-method detector.
- `packages/atomic/src/commands/cli/install-method.win32.test.ts` — Windows-specific tests for the synchronous detector.
- `packages/atomic/src/commands/cli/install.test.ts` — unit tests for `install.ts` helpers (copyBinary, stripRcSnippet, etc.).
- `packages/atomic/src/services/system/install-method.test.ts` — unit tests for the async service-layer detector.
- `packages/atomic-sdk/src/theme/colors.ts` (or equivalent) — provides `COLORS`, `PALETTE`, `paletteRgb` used by `install-ui.ts`.
- `packages/atomic-sdk/src/services/system/detect.ts` — provides `supportsTrueColor`, `supports256Color` for terminal capability detection in `install-ui.ts`.
- `.devcontainer/features/claude/install.sh` — devcontainer feature installer for Claude Code CLI; separate from the Atomic bootstrap but coexists in the repo.
- `.devcontainer/features/copilot/install.sh` — devcontainer feature installer for GitHub Copilot CLI; ditto.
- `.devcontainer/features/opencode/install.sh` — devcontainer feature installer for OpenCode CLI; ditto.
