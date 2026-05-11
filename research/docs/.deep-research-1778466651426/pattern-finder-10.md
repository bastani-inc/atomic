# Pattern Research: install.sh Bootstrap Installer

## Patterns Found

#### Pattern: Curl-pipe bootstrap entry point
**Where:** `install.sh:10,13`
**What:** Production curl-pipe invocation with optional version pinning.
```bash
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash
#
# Pin a specific version:
#   curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash -s -- 0.4.47
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
**Variations / call-sites:** Hard-coded base at line 24: `RELEASES_BASE="https://github.com/flora131/atomic/releases"`; binary URL template at line 140.

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

