### Files Analysed

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.sh` — primary file under analysis (174 LOC)
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/install.ts` — referenced as the `atomic install` binary subcommand; read to confirm handoff contract

---

### Per-File Notes

#### `install.sh`

- **Role:** POSIX bash bootstrap installer for macOS and Linux. It resolves a release manifest, downloads the versioned prebuilt binary, verifies its SHA-256 checksum, marks it executable, delegates all placement/PATH/completions logic to the binary itself via `atomic install`, then cleans up the temp download. Explicitly modeled on Claude Code's own `install.sh` (comment at line 5).

- **Key symbols:**
  - `TARGET` (line 17) — positional arg `$1`, defaults to `"latest"`. Validated against the regex `^(stable|latest|[0-9]+\.[0-9]+\.[0-9]+(-[^[:space:]]+)?)$` at line 19.
  - `RELEASES_BASE` (line 24) — `https://github.com/flora131/atomic/releases`. Hardcoded to the `flora131/atomic` GitHub repo.
  - `DOWNLOAD_DIR` (line 25) — `$HOME/.atomic/downloads`. Temp storage for the downloaded binary.
  - `DOWNLOADER` (lines 28–35) — shell variable set to `"curl"` or `"wget"` based on PATH probing.
  - `download_file()` (lines 37–52) — abstraction that dispatches to curl (`-fsSL --retry 3`) or wget (`-q`) depending on `DOWNLOADER`. When `$output` is empty, writes to stdout; otherwise writes to file.
  - `get_checksum_from_manifest()` (lines 55–63) — pure-bash JSON extractor; strips whitespace with `tr`/`sed`, then uses `BASH_REMATCH` with regex `\"$platform\"[^}]*\"checksum\"[[:space:]]*:[[:space:]]*\"([a-f0-9]{64})\"` to extract the 64-hex-char SHA-256 string for the target platform key.
  - `get_version_from_manifest()` (lines 65–73) — similarly extracts `"version"` string from the manifest JSON using `BASH_REMATCH`.
  - `os` (lines 76–84) — set to `"darwin"` or `"linux"` via `uname -s`; MINGW/MSYS/CYGWIN rejected at line 79 with redirect to `install.ps1`/`install.cmd`.
  - `arch` (lines 86–90) — set to `"x64"` or `"arm64"` via `uname -m`.
  - Rosetta 2 detection (lines 94–98): if `os=darwin` and `arch=x64`, checks `sysctl -n sysctl.proc_translated`; if result is `"1"`, overrides `arch` to `"arm64"` to prefer the native Apple Silicon binary.
  - `libc` (lines 104–111): on Linux, checks `ldd --version 2>&1 | grep -qi musl` or the presence of `/lib/ld-musl-x86_64.so.1` or `/lib/ld-musl-aarch64.so.1`; if musl detected, `libc="-musl"`.
  - `platform` (line 113) — assembled as `${os}-${arch}${libc}`. Possible values: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-x64-musl`, `linux-arm64`, `linux-arm64-musl`.
  - `manifest_url` (lines 117–121) — `$RELEASES_BASE/latest/download/manifest.json` for `latest`/`stable`, or `$RELEASES_BASE/download/v$TARGET/manifest.json` for a pinned version.
  - `version` (line 129) — extracted from manifest JSON via `get_version_from_manifest`.
  - `checksum` (line 134) — extracted from manifest JSON for the detected `$platform` via `get_checksum_from_manifest`.
  - `binary_url` (line 140) — `$RELEASES_BASE/download/v$version/atomic-$platform`. Downloads always pinned to the version from the manifest, never by `$TARGET` directly (prevents race on `latest`).
  - `binary_path` (line 141) — `$DOWNLOAD_DIR/atomic-$version-$platform`. Includes version in filename to avoid collision.
  - SHA-256 verification (lines 150–160) — `shasum -a 256` on Darwin, `sha256sum` on Linux. Actual hash compared to `$checksum`; mismatch deletes the binary and exits 1.
  - `chmod +x` (line 162) — marks the verified binary executable before execution.
  - `"$binary_path" install` (line 166) — handoff to the binary's own `install` subcommand for all remaining placement, PATH, tmux detection, and shell completion setup.
  - `rm -f "$binary_path"` (line 169) — cleanup of the temp download after handoff.

- **Control flow:**
  1. Parse and validate `$TARGET` (lines 17–22).
  2. Detect curl or wget; abort if neither found (lines 28–35).
  3. Detect OS from `uname -s`; reject Windows (lines 76–84).
  4. Detect arch from `uname -m`; reject unsupported (lines 86–90).
  5. Rosetta 2 check on Darwin/x64 (lines 94–98).
  6. musl libc check on Linux (lines 104–111).
  7. Assemble `platform` string; create `DOWNLOAD_DIR` (lines 113–114).
  8. Resolve `manifest_url` based on `$TARGET` (lines 117–121).
  9. Fetch manifest JSON; exit if empty (lines 123–127).
  10. Parse `version` from manifest; exit on parse failure (lines 129–132).
  11. Parse `checksum` from manifest for `$platform`; exit if platform absent (lines 134–137).
  12. Download binary to `$binary_path`; exit and clean up on failure (lines 143–147).
  13. Compute actual SHA-256; compare to `$checksum`; exit and clean up on mismatch (lines 150–160).
  14. `chmod +x` the binary (line 162).
  15. Execute `"$binary_path" install` (line 166).
  16. Delete `$binary_path` (line 169).
  17. Print completion message (lines 171–173).

- **Data flow:**
  - Input: `$1` → `$TARGET` → `manifest_url` selection.
  - `manifest_json` ← `download_file "$manifest_url" ""` (stdout capture, no temp file).
  - `$version` ← `get_version_from_manifest "$manifest_json"`.
  - `$checksum` ← `get_checksum_from_manifest "$manifest_json" "$platform"`.
  - Binary downloaded to `$binary_path` (file on disk).
  - `$actual` ← `shasum`/`sha256sum` on `$binary_path`.
  - `$actual` compared to `$checksum`; binary deleted if mismatch.
  - Verified binary executed with argument `install`; process replaces itself via exec semantics (foreground subshell).
  - `$binary_path` deleted after `atomic install` returns.

- **Dependencies:**
  - External tools: `curl` or `wget` (HTTP), `uname`, `sysctl` (Darwin only), `ldd` (Linux only), `shasum` (Darwin) or `sha256sum` (Linux), `chmod`, `rm`, `mkdir`.
  - No jq dependency — JSON parsing implemented entirely in bash via `BASH_REMATCH`.
  - `set -e` (line 15) — any unhandled non-zero exit aborts the script.
  - Network: `https://github.com/flora131/atomic/releases` for both the manifest and the binary artifact.
  - Binary handoff: relies on `packages/atomic/src/commands/cli/install.ts` (`installCommand`) being compiled into the distributed `atomic` binary and responding to the `install` subargument.

---

### Cross-Cutting Synthesis

`install.sh` is a thin, dependency-free bootstrap whose only job is to safely obtain and verify a platform-specific prebuilt binary from GitHub Releases, then hand off all post-download logic to the binary itself. The two-phase design (shell script → `atomic install`) keeps the bash surface minimal: the script does network access, manifest parsing, SHA-256 verification, and nothing else. All decisions about install path (`~/.local/bin`), PATH persistence, tmux/psmux discovery, and shell completions live in `packages/atomic/src/commands/cli/install.ts` (`installCommand`, line 751), which runs after the handoff. The manifest-then-binary URL pattern means `latest` resolution and version pinning both go through a single manifest fetch, and the actual binary download URL is always pinned to the manifest-reported version (line 140), preventing time-of-check/time-of-use races with GitHub's `latest` redirect. Platform detection covers six targets (darwin-x64, darwin-arm64, linux-x64/musl, linux-arm64/musl) with Rosetta 2 and musl fallbacks. Windows hosts are rejected at line 80 with an explicit redirect to `install.ps1` or `install.cmd`.

---

### Out-of-Partition References

- `install.ps1` — Windows counterpart to `install.sh`; referenced at line 80 as the redirect target for MINGW/MSYS/CYGWIN hosts; uses the same `flora131/atomic` releases base and same manifest-then-binary pattern.
- `install.cmd` — Windows CMD fallback installer; referenced at line 80 alongside `install.ps1`.
- `packages/atomic/src/commands/cli/install.ts` — TypeScript implementation of `installCommand` (exported at line 751); receives control after `"$binary_path" install` at `install.sh:166`; handles binary self-copy (`copyBinary`), PATH wiring (`persistPathEntry`), tmux/psmux detection (`detectMuxBinary`), shell completions (`installCompletions`), and artifact reaping (`cleanupOldArtifacts`).
- `packages/atomic/src/commands/cli/install.test.ts` — test suite for the TypeScript install subcommand; not directly referenced by `install.sh` but exercises the code that `install.sh` delegates to.
