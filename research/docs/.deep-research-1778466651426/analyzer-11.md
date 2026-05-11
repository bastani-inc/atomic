## Analysis: Binary Distribution Installers (install.cmd + peers)

### Files Analysed

- `install.cmd` — Windows batch bootstrap (169 LOC)
- `install.ps1` — Windows PowerShell bootstrap (128 LOC)
- `install.sh` — macOS/Linux bash bootstrap (173 LOC)
- `packages/atomic/src/commands/cli/install.ts` — `atomic install` / `atomic uninstall` subcommand handler (826 LOC)
- `packages/atomic/src/commands/cli/install-method.ts` — install-method detection (105 LOC)

---

### Per-File Notes

#### `install.cmd`

- **Role:** Windows cmd.exe bootstrap that downloads a verified Atomic binary from GitHub Releases and delegates to its `install` subcommand.

- **Key symbols:**
  - `TARGET` (`install.cmd:16`) — positional arg (`latest`, `stable`, or `x.y.z[-pre]`), defaults to `latest`
  - `RELEASES_BASE` (`install.cmd:51`) — hardcoded `https://github.com/flora131/atomic/releases`
  - `DOWNLOAD_DIR` (`install.cmd:52`) — hardcoded `%USERPROFILE%\.atomic\downloads`
  - `PLATFORM` (`install.cmd:54-58`) — set to `windows-arm64` or `windows-x64` based on `%PROCESSOR_ARCHITECTURE%`
  - `:download_file` subroutine (`install.cmd:144-147`) — thin `curl -fsSL --retry 3` wrapper
  - `:verify_checksum` subroutine (`install.cmd:149-168`) — invokes `certutil -hashfile <path> SHA256`, strips spaces, does case-insensitive comparison against `%EXPECTED%`

- **Control flow:**
  1. `install.cmd:16-31` — Validate `TARGET` via a PowerShell regex (`^(?:stable|latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$`) because cmd.exe's `findstr` has no end-of-input anchor and falsely rejects prerelease versions due to a trailing CRLF.
  2. `install.cmd:41-48` — Reject 32-bit Windows via `%PROCESSOR_ARCHITECTURE%` and `%PROCESSOR_ARCHITEW6432%`.
  3. `install.cmd:62-66` — Verify `curl` is available; print hint to use `install.ps1` if absent.
  4. `install.cmd:69-75` — Resolve `manifest.json` URL: `latest`/`stable` → `releases/latest/download/manifest.json`; pinned version → `releases/download/v<VER>/manifest.json`.
  5. `install.cmd:77-98` — Download manifest via `:download_file`; parse `VERSION` and `EXPECTED_CHECKSUM` via a single PowerShell invocation (`ConvertFrom-Json`) that emits `<version>|<checksum>` on stdout, split by `for /f … delims=|`.
  6. `install.cmd:101-116` — Construct `BINARY_URL` and `BINARY_PATH`; download and verify checksum via `:verify_checksum`.
  7. `install.cmd:119-133` — Run `"!BINARY_PATH!" install`; wait 1 second for handles to release; delete temp binary; propagate exit code.

- **Data flow:**
  - Input: optional `%~1` version string from CLI.
  - Intermediate state: `%USERPROFILE%\.atomic\downloads\manifest.json` (downloaded, read, immediately deleted at `install.cmd:98`), then `atomic-<version>-<platform>.exe` (downloaded, checksum-verified, executed, then deleted at `install.cmd:125`).
  - Output: delegates all PATH/completions/settings work to the binary itself; exits 0 on success, 1 on any failure.

- **Dependencies:** `curl` (Windows 10+ built-in), `certutil` (Windows built-in), `powershell.exe` (Windows built-in). No external package manager required.

---

#### `install.ps1`

- **Role:** Windows PowerShell bootstrap that mirrors `install.cmd`'s flow with native PowerShell idioms (no `curl`/`certutil` dependency).

- **Key symbols:**
  - `$Target` param (`install.ps1:16-19`) — validated via `[ValidatePattern('^(stable|latest|\d+\.\d+\.\d+(-[^\s]+)?)$')]`
  - `$RELEASES_BASE` (`install.ps1:30`) — same hardcoded `https://github.com/flora131/atomic/releases`
  - `$DOWNLOAD_DIR` (`install.ps1:31`) — `$env:USERPROFILE\.atomic\downloads`
  - `$platform` (`install.ps1:34-38`) — `windows-arm64` or `windows-x64`

- **Control flow:**
  1. `install.ps1:25-28` — 64-bit check via `[Environment]::Is64BitProcess`.
  2. `install.ps1:47-51` — Resolve manifest URL by same `latest`/`stable`/pinned logic.
  3. `install.ps1:53-59` — `Invoke-RestMethod` to fetch and auto-parse manifest JSON into `$manifest`.
  4. `install.ps1:61-66` — Extract `$version` and `$checksum` from `$manifest.platforms.$platform.checksum`.
  5. `install.ps1:71` — Pin binary URL to `releases/download/v$version/…` (not `latest/download`) for reliability mid-release.
  6. `install.ps1:77-98` — Retry loop (3 attempts, `[Math]::Min(5, attempt*2)` second back-off) via `Invoke-WebRequest`; 5.1-compatible (no `-MaximumRetryCount`).
  7. `install.ps1:100-105` — SHA-256 verify via `Get-FileHash`.
  8. `install.ps1:113-124` — Run `& $binaryPath install`; `finally` block deletes temp with `Start-Sleep -Seconds 1` before unlink.

- **Dependencies:** `powershell.exe` / `pwsh.exe` only; `Invoke-RestMethod`, `Invoke-WebRequest`, `Get-FileHash` are all PowerShell builtins.

---

#### `install.sh`

- **Role:** macOS/Linux bash bootstrap analogous to `install.cmd`/`install.ps1`.

- **Key symbols:**
  - `download_file()` (`install.sh:37-52`) — wraps `curl -fsSL --retry 3` or `wget -q`
  - `get_checksum_from_manifest()` (`install.sh:55-63`) — pure-bash JSON extraction using `BASH_REMATCH` regex (no `jq` required)
  - `get_version_from_manifest()` (`install.sh:65-73`) — same pattern
  - `libc` detection (`install.sh:104-111`) — detects musl Linux via `ldd --version`, `/lib/ld-musl-x86_64.so.1`, or `/lib/ld-musl-aarch64.so.1`; appends `-musl` to platform string

- **Control flow:**
  1. `install.sh:19` — Validate `TARGET` regex in bash.
  2. `install.sh:76-98` — Detect OS/arch; Rosetta 2 detection at `install.sh:94-98`.
  3. `install.sh:104-111` — musl detection for Alpine Linux hosts.
  4. `install.sh:117-121` — Manifest URL resolution.
  5. `install.sh:123-137` — Download manifest (piped to stdout, not disk), parse `version` and `checksum`.
  6. `install.sh:143-147` — Download binary to `$DOWNLOAD_DIR/atomic-$version-$platform`.
  7. `install.sh:150-160` — SHA-256 verify via `shasum -a 256` (macOS) or `sha256sum` (Linux).
  8. `install.sh:162` — `chmod +x`.
  9. `install.sh:166` — Run `"$binary_path" install`; `install.sh:169` deletes temp.

- **Dependencies:** `curl` or `wget` (either sufficient), `bash`, no external tools for manifest parsing.

---

#### `packages/atomic/src/commands/cli/install.ts`

- **Role:** The `atomic install` and `atomic uninstall` subcommand implementations — receives control from bootstrap scripts, performs binary self-copy, PATH wiring, tmux/psmux detection, and shell completions setup.

- **Key symbols:**
  - `RC_MARKER` (`install.ts:40`) — `"# Atomic CLI completions (cached)"` — sentinel inserted in rc files
  - `PATH_RC_MARKER` (`install.ts:41`) — `"# Atomic CLI PATH"` — sentinel for PATH rc snippets
  - `getInstallPaths()` (`install.ts:58`) — returns `InstallPaths` with `binDir`, `binPath`, `completionsDir`; Windows uses `%LOCALAPPDATA%\atomic\bin`, Unix uses `~/.local/bin`
  - `copyBinary()` (`install.ts:96`) — atomic move: `copyFileSync → chmodSync → renameSync` via a `.tmp.<pid>.<ts>` intermediate; Windows archives running `.exe` to `.exe.old.<ts>` first
  - `cleanupOldArtifacts()` (`install.ts:160`) — reaps `atomic.exe.old.<digits>` and `atomic.exe.tmp.<pid>.<ts>` files older than 1 hour from `binDir`
  - `pathContains()` (`install.ts:204`) — checks if `dir` is already on `PATH`, case-insensitive on Windows
  - `persistPathEntry()` (`install.ts:223`) — routes to `persistWindowsPath()` (registry via PowerShell `[Environment]::SetEnvironmentVariable`) or `persistUnixPath()` (appends to rc files)
  - `appendPathRcSnippet()` (`install.ts:343`) — writes POSIX `case ":$PATH:" in … esac` guard or fish `fish_add_path`
  - `detectMuxBinary()` (`install.ts:411`) — searches PATH then `wellKnownMuxInstallDirs()` for `tmux` (Unix) or `psmux`/`pmux` (Windows)
  - `wellKnownMuxInstallDirs()` (`install.ts:435`) — enumerates Homebrew, Scoop, WinGet, Chocolatey, and manual install locations
  - `installCompletions()` (`install.ts:472`) — writes completion script from `COMPLETION_SCRIPTS[shell]` to `~/.atomic/completions/atomic.<ext>`, then sources it from rc file
  - `ensureCompletionsSourcedFromRc()` (`install.ts:509`) — strips legacy `eval "$(atomic completions …)"` snippet before writing new cached-source snippet
  - `stripRcSnippet()` (`install.ts:555`) — marker-aware line filter that removes up to 6-line blocks written by previous installs
  - `uninstallCommand()` (`install.ts:695`) — dispatches on `detectInstallMethod()` result; only handles `binary` method directly, prints hints for `bun`/`npm`/`pnpm`/`yarn`
  - `installCommand()` (`install.ts:751`) — orchestrates: `copyBinary` → `persistPathEntry` → `detectMuxBinary`/`persistPathEntry` for mux → `installCompletions` → `cleanupOldArtifacts` (via `queueMicrotask`)

- **Control flow (installCommand):**
  1. `install.ts:752` — `getInstallPaths()` to resolve target dirs
  2. `install.ts:756` — `copyBinary(paths)` — self-copy from `process.execPath`
  3. `install.ts:764` — `persistPathEntry(paths.binDir)` — idempotent PATH update
  4. `install.ts:776` — `detectMuxBinary()` — tmux/psmux detection and optional PATH persistence
  5. `install.ts:798` — `installCompletions(paths)` — write completion cache + rc source line
  6. `install.ts:814` — `queueMicrotask(() => cleanupOldArtifacts(paths.binDir))` — non-blocking reaper

- **tmux dependency (load-bearing for current Atomic, removable for pi-rewrite):**
  - `install.ts:403-462` — `detectMuxBinary()` and `wellKnownMuxInstallDirs()` explicitly detect and configure tmux (Unix) and psmux/pmux (Windows) as required mux binaries. The `installCommand` at `install.ts:776-795` will warn if no mux binary is found. These functions reference tmux/psmux as named binary strings and their platform-specific install directories. In a pi-coding-agent rewrite, this entire block is removable.

- **Data flow:**
  - Input: `process.execPath` (source binary path), `process.env` (PATH, LOCALAPPDATA, etc.), filesystem state of rc files
  - State written: binary copied to `binDir/atomic[.exe]`, PATH entries appended to registry (Windows) or rc files (Unix), completion scripts written to `~/.atomic/completions/`, rc files modified with source lines
  - Output: exit code 0/1, stdout progress messages

- **Dependencies:**
  - `node:fs`, `node:os`, `node:path` (standard)
  - `./install-method.ts` — install method detection
  - `../../completions/index.ts` — shell completion script strings
  - `Bun.spawnSync` — PowerShell invocation on Windows, package manager probing
  - `Bun.which` — mux binary PATH search

---

#### `packages/atomic/src/commands/cli/install-method.ts`

- **Role:** Detects how the currently-running `atomic` binary was installed (binary installer, bun/npm/pnpm/yarn global, or source checkout) by inspecting `process.execPath`.

- **Key symbols:**
  - `InstallMethod` type (`install-method.ts:4`) — union: `"binary" | "bun" | "npm" | "pnpm" | "yarn" | "source" | "unknown"`
  - `detectInstallMethod()` (`install-method.ts:45`) — memoized detection via `computeInstallMethod()`
  - `computeInstallMethod()` (`install-method.ts:54`) — three checks: (1) exec path matches canonical `~/.local/bin` or `%LOCALAPPDATA%\atomic\bin` → `"binary"`; (2) path contains `node_modules/@bastani/atomic` → package manager (path heuristics then `<pm> ls -g` probe); (3) exec ends with `/bun` or `/bun.exe` → `"source"`
  - `PKG_PATH_RE` (`install-method.ts:22`) — `/\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//`
  - `_resetInstallMethodCache()` (`install-method.ts:104`) — test seam to clear memoized result
  - `PM_PROBE_CMD` (`install-method.ts:24-29`) — maps `bun`/`pnpm`/`yarn`/`npm` to `ls -g` commands for confirming @bastani/atomic presence

- **Data flow:** Input is `process.execPath` (or injected `opts.execPath`). Output is a single `InstallMethod` string, memoized in module-level `cached` variable (`install-method.ts:31`).

---

### Cross-Cutting Synthesis

The binary distribution installer is a two-phase pipeline split across two layers. The outer layer (`install.cmd`, `install.ps1`, `install.sh`) is a minimal OS-native bootstrap whose sole job is: validate target version, detect architecture, download `manifest.json` from `https://github.com/flora131/atomic/releases`, parse the platform-specific SHA-256 checksum, download the versioned binary, verify it, and hand off via `<binary> install`. All three scripts use a `$RELEASES_BASE/download/v$version/<asset>` pin strategy (never `latest/download` for the binary itself) to avoid race conditions during release. The inner layer (`install.ts` `installCommand`) performs the durable work: atomic-move self-copy, PATH persistence (registry on Windows, rc-file appends on Unix), tmux/psmux binary detection with `wellKnownMuxInstallDirs`, shell completion cache writes, and a non-blocking reaper for install artifacts. `install-method.ts` provides a memoized detection of how the binary was installed, which gates `uninstallCommand` behaviour. The tmux/psmux detection block in `install.ts:403-462` is the primary agent-specific dependency in this layer; all other logic is agent-agnostic PATH and completions management directly replaceable for a pi-coding-agent fork.

---

### Out-of-Partition References

- `packages/atomic/src/completions/index.ts` — exports `Shell` type and four completion script strings (`bash`, `zsh`, `fish`, `powershell`) consumed by `installCommand` to write shell completion caches; the per-shell scripts in `packages/atomic/src/completions/` carry the actual completion logic.
- `packages/atomic/src/commands/cli/install.test.ts` — test suite for `installCommand`/`uninstallCommand`; relevant for understanding which code paths are tested and what must be adapted in a rewrite.
- `packages/atomic/src/services/system/install-method.ts` — a second `install-method.ts` at a different path; may be an alternate or service-layer variant of the detection logic.
- `install.ps1` — the PowerShell peer of `install.cmd`; shares identical flow and hardcoded `flora131/atomic` release URL; must be rebranded for pi-coding-agent.
- `install.sh` — the macOS/Linux peer; includes musl and Rosetta 2 detection not present in the Windows scripts.
