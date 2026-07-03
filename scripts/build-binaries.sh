#!/usr/bin/env bash
#
# Build @bastani/atomic binaries for all platforms locally.
# Mirrors .github/workflows/publish.yml binary build.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform native bindings
#   --platform <name>   Build only for specified platform
#                       (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#
# Output:
#   packages/coding-agent/binaries/
#     atomic-darwin-arm64.tar.gz
#     atomic-darwin-x64.tar.gz
#     atomic-linux-x64.tar.gz
#     atomic-linux-arm64.tar.gz
#     atomic-windows-x64.zip
#     atomic-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

echo "==> Installing dependencies..."
bun install --frozen-lockfile

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings for clipboard..."
    # bun (like npm) only installs optionalDependencies for the current
    # platform/arch. For bun --compile to embed the right native module
    # per target, force-install every platform binding via bun add --no-save.
    # Failures here are non-fatal: clipboard is optional and the runtime
    # call site has a try/catch fallback.
    bun add --no-save \
        @mariozechner/clipboard-darwin-arm64@0.3.2 \
        @mariozechner/clipboard-darwin-x64@0.3.2 \
        @mariozechner/clipboard-linux-x64-gnu@0.3.2 \
        @mariozechner/clipboard-linux-arm64-gnu@0.3.2 \
        @mariozechner/clipboard-win32-x64-msvc@0.3.2 \
        @mariozechner/clipboard-win32-arm64-msvc@0.3.2 || \
        echo "  warning: one or more clipboard bindings unavailable; binaries will fall back to no-op clipboard"
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if compgen -G "packages/natives/native/*.node" >/dev/null; then
    echo "==> Using existing Atomic native binding artifacts..."
else
    echo "==> Building Atomic native bindings for host platform..."
    bun run --cwd packages/natives build
fi

echo "==> Building @bastani/atomic package..."
cd packages/coding-agent
bun run build

echo "==> Building binaries..."

rm -rf binaries
mkdir -p binaries

if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    mkdir -p "binaries/$platform"
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --bytecode --format=cjs --external mupdf --target=bun-$platform ./dist/bun/cli.js --outfile "binaries/$platform/atomic.exe"
    else
        bun build --compile --bytecode --format=cjs --external mupdf --target=bun-$platform ./dist/bun/cli.js --outfile "binaries/$platform/atomic"
    fi
done

echo "==> Copying runtime dependencies..."
runtime_deps_dir="binaries/.runtime-node_modules"
rm -rf "$runtime_deps_dir"
bun run scripts/copy-runtime-dependencies.ts "$runtime_deps_dir"

echo "==> Copying shared assets..."
cursor_native_filename() {
    case "$1" in
        darwin-arm64) echo "atomic_natives.darwin-arm64.node" ;;
        darwin-x64) echo "atomic_natives.darwin-x64.node" ;;
        linux-x64) echo "atomic_natives.linux-x64-gnu.node" ;;
        linux-arm64) echo "atomic_natives.linux-arm64-gnu.node" ;;
        windows-x64) echo "atomic_natives.win32-x64-msvc.node" ;;
        windows-arm64) echo "atomic_natives.win32-arm64-msvc.node" ;;
        *) echo "Unknown platform: $1" >&2; return 1 ;;
    esac
}

for platform in "${PLATFORMS[@]}"; do
    cp package.json "binaries/$platform/"
    cp README.md "binaries/$platform/"
    cp CHANGELOG.md "binaries/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "binaries/$platform/"
    mkdir -p "binaries/$platform/theme"
    cp dist/modes/interactive/theme/*.json "binaries/$platform/theme/"
    mkdir -p "binaries/$platform/assets"
    cp dist/modes/interactive/assets/* "binaries/$platform/assets/"
    cp -r dist/core/export-html "binaries/$platform/"
    cp -r dist/builtin "binaries/$platform/"

    cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"
    rm -rf "binaries/$platform/node_modules/@bastani/atomic-natives/npm"
    find "binaries/$platform/node_modules/@bastani/atomic-natives" -maxdepth 1 -type f -name 'atomic_natives.*.node' -delete
    cursor_native="$(cursor_native_filename "$platform")"
    cursor_native_dir="binaries/$platform/node_modules/@bastani/atomic-natives/native"
    if [ ! -f "$cursor_native_dir/$cursor_native" ]; then
        echo "Missing Atomic native binding for $platform: $cursor_native_dir/$cursor_native" >&2
        echo "Build or download all Atomic native artifacts before building release archives." >&2
        exit 1
    fi
    find "$cursor_native_dir" -type f -name 'atomic_natives.*.node' ! -name "$cursor_native" -delete

    cp -r docs "binaries/$platform/"
    cp -r examples "binaries/$platform/"
done

rm -rf "$runtime_deps_dir"

echo "==> Creating release archives..."
cd binaries

create_zip_archive() {
    local platform="$1"
    local archive="atomic-$platform.zip"

    if command -v zip >/dev/null 2>&1; then
        (cd "$platform" && zip -rq "../$archive" .)
        return
    fi

    local powershell_cmd=""
    if command -v pwsh >/dev/null 2>&1; then
        powershell_cmd="pwsh"
    elif command -v powershell.exe >/dev/null 2>&1; then
        powershell_cmd="powershell.exe"
    elif command -v powershell >/dev/null 2>&1; then
        powershell_cmd="powershell"
    fi

    if [[ -n "$powershell_cmd" ]]; then
        "$powershell_cmd" -NoProfile -Command \
            "\$ErrorActionPreference = 'Stop'; Compress-Archive -Path '$platform/*' -DestinationPath '$archive' -Force"
        return
    fi

    echo "Neither zip nor PowerShell is available to create $archive" >&2
    exit 1
}

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "Creating atomic-$platform.zip..."
        create_zip_archive "$platform"
    else
        echo "Creating atomic-$platform.tar.gz..."
        mv "$platform" atomic && tar -czf "atomic-$platform.tar.gz" atomic && mv atomic "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
