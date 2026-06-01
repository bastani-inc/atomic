# Partition 10 of 12 — Findings

## Scope

`install.sh/` (1 files, 173 LOC)

## Files in Scope

<!-- Source: codebase-locator sub-agent -->

# Locator 10: install.sh — Partition Findings

## Overview

Partition 10 scopes the primary POSIX bootstrap installer for Atomic CLI. Single 174-line shell script containing the complete download-and-verify workflow.

### Implementation

- `install.sh` — POSIX bash bootstrap installer with curl/wget fallback, GitHub Release hardcoding (`bastani-inc/atomic`), manifest.json parsing, platform detection (Darwin/Linux, x64/arm64, musl detection), SHA-256 verification, and delegation to binary's `atomic install` subcommand.

### Key Hard-Coded URLs & Configuration

- **Releases Base**: `https://github.com/bastani-inc/atomic/releases` (line 24, hardcoded as `RELEASES_BASE`)
- **Manifest URL Pattern**: `$RELEASES_BASE/latest/download/manifest.json` or `$RELEASES_BASE/download/v$TARGET/manifest.json` (lines 118–120)
- **Binary URL Pattern**: `$RELEASES_BASE/download/v$version/atomic-$platform` (line 140)
- **Repository Owner**: `flora131` (embedded in RELEASES_BASE URL)

### Download & Install Workflow

- **Downloader Detection**: `curl` or `wget` with fallback logic (lines 28–35)
- **Entry Point**: Raw GitHub URL with piping: `curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash` (line 10)
- **Version Pinning**: Optional version argument: `bash -s -- 0.4.47` (line 13)
- **Platform Detection**:
    - OS detection via `uname -s`: Darwin (macOS), Linux, Windows rejection (lines 76–84)
    - Arch detection via `uname -m`: x64/amd64, arm64/aarch64 (lines 86–90)
    - Rosetta 2 detection on Apple Silicon (lines 94–98)
    - musl libc detection on Alpine Linux via `ldd --version` or `/lib/ld-musl-*` presence (lines 106–110)

### Manifest & Checksum Verification

- **Manifest JSON Parsing**: Regex-based extraction without `jq` (lines 55–73):
    - `get_checksum_from_manifest()` — extracts platform-specific SHA-256 (58-byte hex checksum)
    - `get_version_from_manifest()` — extracts version string
- **SHA-256 Verification**: Platform-specific commands:
    - Darwin: `shasum -a 256` (line 151)
    - Linux: `sha256sum` (line 153)

### Install Delegation

- **Binary Execution**: Downloaded binary is made executable and invoked with `install` subcommand (lines 162, 166)
- **Cleanup**: Downloaded binary is deleted after setup (line 169)
- **Download Location**: `$HOME/.atomic/downloads` (line 25)

### Platform Support Matrix

- **Supported Platforms**: darwin-x64, darwin-arm64, linux-x64, linux-x64-musl, linux-arm64, linux-arm64-musl
- **Unsupported**: Windows (explicit rejection with fallback to install.ps1 or install.cmd, line 80)

---

## Notes for PI-Coding-Agent Rewrite

1. **URL Authority Migration**: All GitHub hardcoding (`bastani-inc/atomic`) must be replaced with pi-coding-agent equivalent registry/domain.
2. **Manifest Schema**: The manifest.json structure assumes `{ "version": "...", "<platform>": { "checksum": "<hex>" } }` — must be confirmed or adapted for pi schema.
3. **Agent-Specific Download URLs**: No agent-specific branching detected in current script; all platforms resolve from single repo.
4. **No npm Involvement**: Bootstrap installer is pure POSIX bash; `npm install` is not invoked at this stage (that occurs in the binary's `install` subcommand, outside this scope).
5. **Dependency**: Requires curl or wget; no other external tools beyond standard POSIX utilities (uname, mkdir, shasum/sha256sum, chmod).

## How It Works

<!-- Source: codebase-analyzer sub-agent -->

### Files Analysed

- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/install.sh` — primary file under analysis (174 LOC)
- `/home/alilavaee/Documents/projects/atomic-pi-rewrite/packages/atomic/src/commands/cli/install.ts` — referenced as the `atomic install` binary subcommand; read to confirm handoff contract

---

### Per-File Notes

#### `install.sh`

- **Role:** POSIX bash bootstrap installer for macOS and Linux. It resolves a release manifest, downloads the versioned prebuilt binary, verifies its SHA-256 checksum, marks it executable, delegates all placement/PATH/completions logic to the binary itself via `atomic install`, then cleans up the temp download. Explicitly modeled on Claude Code's own `install.sh` (comment at line 5).

- **Key symbols:**
    - `TARGET` (line 17) — positional arg `$1`, defaults to `"latest"`. Validated against the regex `^(stable|latest|[0-9]+\.[0-9]+\.[0-9]+(-[^[:space:]]+)?)$` at line 19.
    - `RELEASES_BASE` (line 24) — `https://github.com/bastani-inc/atomic/releases`. Hardcoded to the `bastani-inc/atomic` GitHub repo.
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
    - Network: `https://github.com/bastani-inc/atomic/releases` for both the manifest and the binary artifact.
    - Binary handoff: relies on `packages/atomic/src/commands/cli/install.ts` (`installCommand`) being compiled into the distributed `atomic` binary and responding to the `install` subargument.

---

### Cross-Cutting Synthesis

`install.sh` is a thin, dependency-free bootstrap whose only job is to safely obtain and verify a platform-specific prebuilt binary from GitHub Releases, then hand off all post-download logic to the binary itself. The two-phase design (shell script → `atomic install`) keeps the bash surface minimal: the script does network access, manifest parsing, SHA-256 verification, and nothing else. All decisions about install path (`~/.local/bin`), PATH persistence, tmux/psmux discovery, and shell completions live in `packages/atomic/src/commands/cli/install.ts` (`installCommand`, line 751), which runs after the handoff. The manifest-then-binary URL pattern means `latest` resolution and version pinning both go through a single manifest fetch, and the actual binary download URL is always pinned to the manifest-reported version (line 140), preventing time-of-check/time-of-use races with GitHub's `latest` redirect. Platform detection covers six targets (darwin-x64, darwin-arm64, linux-x64/musl, linux-arm64/musl) with Rosetta 2 and musl fallbacks. Windows hosts are rejected at line 80 with an explicit redirect to `install.ps1` or `install.cmd`.

---

### Out-of-Partition References

- `install.ps1` — Windows counterpart to `install.sh`; referenced at line 80 as the redirect target for MINGW/MSYS/CYGWIN hosts; uses the same `bastani-inc/atomic` releases base and same manifest-then-binary pattern.
- `install.cmd` — Windows CMD fallback installer; referenced at line 80 alongside `install.ps1`.
- `packages/atomic/src/commands/cli/install.ts` — TypeScript implementation of `installCommand` (exported at line 751); receives control after `"$binary_path" install` at `install.sh:166`; handles binary self-copy (`copyBinary`), PATH wiring (`persistPathEntry`), tmux/psmux detection (`detectMuxBinary`), shell completions (`installCompletions`), and artifact reaping (`cleanupOldArtifacts`).
- `packages/atomic/src/commands/cli/install.test.ts` — test suite for the TypeScript install subcommand; not directly referenced by `install.sh` but exercises the code that `install.sh` delegates to.

## Patterns

<!-- Source: codebase-pattern-finder sub-agent -->

# Pattern Research: install.sh Bootstrap Installer

## Patterns Found

#### Pattern: Curl-pipe bootstrap entry point

**Where:** `install.sh:10,13`
**What:** Production curl-pipe invocation with optional version pinning.

```bash
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash
#
# Pin a specific version:
#   curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | bash -s -- 0.4.47
```

**Variations / call-sites:** Comments only; the script itself is designed to receive `$1` as the version target (line 17).

---

#### Pattern: Version target validation via regex

**Where:** `install.sh:17-22`
**What:** Accept `latest`, `stable`, or semantic version strings; validate with regex before proceeding.

```bash
TARGET="${1:-latest}"

if [[ ! "$TARGET" =~ ^(stable|latest|[0-9]+\.[0-9]+\.[0-9]+(-[^[:space:]]+)?)$ ]]; then
    echo "Usage: $0 [stable|latest|VERSION]" >&2
    exit 1
fi
```

**Variations / call-sites:** No other call-sites; this is the sole validation gate.

---

#### Pattern: Downloader abstraction (curl/wget fallback)

**Where:** `install.sh:27-35`
**What:** Detect available downloader; fail fast if neither curl nor wget exists.

```bash
# Pick a downloader.
if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    echo "Either curl or wget is required but neither is installed" >&2
    exit 1
fi
```

**Variations / call-sites:** Called once; abstraction used in `download_file()` (lines 37-52).

---

#### Pattern: Conditional download_file function with URL output routing

**Where:** `install.sh:37-52`
**What:** Abstract download with dual backends (curl vs wget) and optional file output; return stdout if no output path specified.

```bash
download_file() {
    local url="$1" output="$2"
    if [[ "$DOWNLOADER" == "curl" ]]; then
        if [[ -n "$output" ]]; then
            curl -fsSL --retry 3 -o "$output" "$url"
        else
            curl -fsSL --retry 3 "$url"
        fi
    else
        if [[ -n "$output" ]]; then
            wget -q -O "$output" "$url"
        else
            wget -q -O - "$url"
        fi
    fi
}
```

**Variations / call-sites:** Called at lines 123 (manifest fetch), 143 (binary download).

---

#### Pattern: Manifest URL resolution based on release channel

**Where:** `install.sh:117-121`
**What:** Route to `/latest/download/` for rolling releases, or `/download/v<VERSION>/` for pinned versions.

```bash
# Resolve the manifest URL.
if [[ "$TARGET" == "latest" || "$TARGET" == "stable" ]]; then
    manifest_url="$RELEASES_BASE/latest/download/manifest.json"
else
    manifest_url="$RELEASES_BASE/download/v$TARGET/manifest.json"
fi
```

**Variations / call-sites:** Hard-coded base at line 24: `RELEASES_BASE="https://github.com/bastani-inc/atomic/releases"`; binary URL template at line 140.

---

#### Pattern: JSON parsing without jq (bash-only regex)

**Where:** `install.sh:54-73`
**What:** Extract `checksum` and `version` from manifest JSON using BASH_REMATCH and regex; normalize JSON whitespace first.

```bash
# Extract platform.<name>.checksum from manifest JSON without jq.
get_checksum_from_manifest() {
    local json="$1" platform="$2"
    json=$(echo "$json" | tr -d '\n\r\t' | sed 's/  */ /g')
    if [[ $json =~ \"$platform\"[^}]*\"checksum\"[[:space:]]*:[[:space:]]*\"([a-f0-9]{64})\" ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

get_version_from_manifest() {
    local json="$1"
    json=$(echo "$json" | tr -d '\n\r\t')
    if [[ $json =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}
```

**Variations / call-sites:** Called at lines 129, 134.

---

#### Pattern: Cross-platform OS/arch detection with libc routing

**Where:** `install.sh:75-113`
**What:** Detect `uname -s` (Darwin/Linux/Windows), `uname -m` (x86_64/arm64), Rosetta 2 emulation, and musl libc; compose normalized platform string.

```bash
# Detect OS + arch.
case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    MINGW*|MSYS*|CYGWIN*)
        echo "Windows is not supported by install.sh — use install.ps1 or install.cmd instead." >&2
        exit 1
        ;;
    *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64) arch="x64"   ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Detect Rosetta 2 — prefer the native arm64 binary on Apple Silicon
# even if the shell is running under x64 translation.
if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
    if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" == "1" ]]; then
        arch="arm64"
    fi
fi

# Detect musl on Linux. Without this, Alpine hosts download the glibc
# binary and fail at launch on `libc.so.6: not found`. busybox `ldd` on
# Alpine prints "musl libc" to stderr; glibc's `ldd` prints "GLIBC". The
# `/lib/ld-musl-*` fallback covers stripped images where `ldd` is absent.
libc=""
if [[ "$os" == "linux" ]]; then
    if ldd --version 2>&1 | grep -qi musl \
        || [ -f /lib/ld-musl-x86_64.so.1 ] \
        || [ -f /lib/ld-musl-aarch64.so.1 ]; then
        libc="-musl"
    fi
fi

platform="${os}-${arch}${libc}"
```

**Variations / call-sites:** Platform string used at lines 134, 140, 141.

---

#### Pattern: Binary handoff to internal `install` subcommand

**Where:** `install.sh:164-169`
**What:** Download prebuilt binary, verify checksum, execute internal subcommand (`atomic install`), then clean up.

```bash
# Hand off to the binary's `install` subcommand.
echo "Setting up atomic..."
"$binary_path" install

# Clean up.
rm -f "$binary_path"
```

**Variations / call-sites:** Binary path constructed at line 141; stored in `$binary_path`.

---

## Summary

The `install.sh` installer exhibits eight distinct patterns: curl-pipe bootstrap entry, version validation, downloader abstraction, conditional file output routing, manifest/binary URL resolution via release channels, JSON parsing without jq, comprehensive platform detection with libc routing for Alpine Linux, and binary handoff with cleanup. All URL base constants are hard-coded (`RELEASES_BASE`), and the manifest provides platform-specific checksums and version pinning. The script is modeled on Claude Code's installer and designed for execution via curl pipe, accepting optional version arguments at invocation time.

## Out-of-Partition References

Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
