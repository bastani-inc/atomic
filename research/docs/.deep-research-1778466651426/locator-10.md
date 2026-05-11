# Locator 10: install.sh — Partition Findings

## Overview
Partition 10 scopes the primary POSIX bootstrap installer for Atomic CLI. Single 174-line shell script containing the complete download-and-verify workflow.

### Implementation
- `install.sh` — POSIX bash bootstrap installer with curl/wget fallback, GitHub Release hardcoding (`flora131/atomic`), manifest.json parsing, platform detection (Darwin/Linux, x64/arm64, musl detection), SHA-256 verification, and delegation to binary's `atomic install` subcommand.

### Key Hard-Coded URLs & Configuration
- **Releases Base**: `https://github.com/flora131/atomic/releases` (line 24, hardcoded as `RELEASES_BASE`)
- **Manifest URL Pattern**: `$RELEASES_BASE/latest/download/manifest.json` or `$RELEASES_BASE/download/v$TARGET/manifest.json` (lines 118–120)
- **Binary URL Pattern**: `$RELEASES_BASE/download/v$version/atomic-$platform` (line 140)
- **Repository Owner**: `flora131` (embedded in RELEASES_BASE URL)

### Download & Install Workflow
- **Downloader Detection**: `curl` or `wget` with fallback logic (lines 28–35)
- **Entry Point**: Raw GitHub URL with piping: `curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash` (line 10)
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

1. **URL Authority Migration**: All GitHub hardcoding (`flora131/atomic`) must be replaced with pi-coding-agent equivalent registry/domain.
2. **Manifest Schema**: The manifest.json structure assumes `{ "version": "...", "<platform>": { "checksum": "<hex>" } }` — must be confirmed or adapted for pi schema.
3. **Agent-Specific Download URLs**: No agent-specific branching detected in current script; all platforms resolve from single repo.
4. **No npm Involvement**: Bootstrap installer is pure POSIX bash; `npm install` is not invoked at this stage (that occurs in the binary's `install` subcommand, outside this scope).
5. **Dependency**: Requires curl or wget; no other external tools beyond standard POSIX utilities (uname, mkdir, shasum/sha256sum, chmod).
