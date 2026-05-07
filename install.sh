#!/bin/bash
#
# Atomic CLI installer for macOS and Linux.
#
# Modeled on Claude Code's install.sh: download a verified prebuilt
# binary from GitHub Releases, then hand off to `atomic install` for
# placement, PATH wiring, mux detection, and shell completions.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash
#
# Pin a specific version:
#   curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash -s -- 0.4.47

set -e

TARGET="${1:-latest}"

if [[ ! "$TARGET" =~ ^(stable|latest|[0-9]+\.[0-9]+\.[0-9]+(-[^[:space:]]+)?)$ ]]; then
    echo "Usage: $0 [stable|latest|VERSION]" >&2
    exit 1
fi

RELEASES_BASE="https://github.com/flora131/atomic/releases"
DOWNLOAD_DIR="$HOME/.atomic/downloads"

# Pick a downloader.
if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    echo "Either curl or wget is required but neither is installed" >&2
    exit 1
fi

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
mkdir -p "$DOWNLOAD_DIR"

# Resolve the manifest URL.
if [[ "$TARGET" == "latest" || "$TARGET" == "stable" ]]; then
    manifest_url="$RELEASES_BASE/latest/download/manifest.json"
else
    manifest_url="$RELEASES_BASE/download/v$TARGET/manifest.json"
fi

manifest_json=$(download_file "$manifest_url" "")
if [[ -z "$manifest_json" ]]; then
    echo "Failed to fetch manifest from $manifest_url" >&2
    exit 1
fi

version=$(get_version_from_manifest "$manifest_json") || {
    echo "Could not parse version from manifest" >&2
    exit 1
}

checksum=$(get_checksum_from_manifest "$manifest_json" "$platform") || {
    echo "Platform $platform not found in manifest for version $version" >&2
    exit 1
}

# Download the binary by pinned version.
binary_url="$RELEASES_BASE/download/v$version/atomic-$platform"
binary_path="$DOWNLOAD_DIR/atomic-$version-$platform"

if ! download_file "$binary_url" "$binary_path"; then
    echo "Failed to download binary from $binary_url" >&2
    rm -f "$binary_path"
    exit 1
fi

# Verify SHA-256.
if [[ "$os" == "darwin" ]]; then
    actual=$(shasum -a 256 "$binary_path" | cut -d' ' -f1)
else
    actual=$(sha256sum "$binary_path" | cut -d' ' -f1)
fi

if [[ "$actual" != "$checksum" ]]; then
    echo "Checksum verification failed (expected $checksum, got $actual)" >&2
    rm -f "$binary_path"
    exit 1
fi

chmod +x "$binary_path"

# Hand off to the binary's `install` subcommand.
echo "Setting up atomic..."
"$binary_path" install

# Clean up.
rm -f "$binary_path"

echo ""
echo "✅ Installation complete!"
echo ""
