#!/usr/bin/env bash
#
# Build @bastani/atomic binaries for all platforms locally.
# Mirrors .github/workflows/publish.yml binary build.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--skip-install] [--skip-package-build] [--platform <platform>]
#
# Options:
#   --skip-deps          Skip installing cross-platform native bindings
#   --skip-install       Reuse dependencies installed by the caller
#   --skip-package-build Reuse packages/coding-agent/dist built by the caller
#   --platform <name>    Build only for specified platform
#                        (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
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

# Keep caller-provided relative temp roots stable across every directory change.
if [[ -n "${TMPDIR:-}" && "$TMPDIR" != /* ]]; then
    TMPDIR="$(cd -- "$TMPDIR" && pwd -P)"
    export TMPDIR
fi
cd -- "$(dirname -- "$0")/.."

SKIP_DEPS=false
SKIP_INSTALL=false
SKIP_PACKAGE_BUILD=false
PLATFORM=""

CLIPBOARD_STAGE_DIR=""
cleanup_clipboard_stage() {
    if [[ -n "$CLIPBOARD_STAGE_DIR" ]]; then
        rm -rf "$CLIPBOARD_STAGE_DIR"
    fi
}
trap cleanup_clipboard_stage EXIT

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-package-build)
            SKIP_PACKAGE_BUILD=true
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

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    bun install --frozen-lockfile
else
    echo "==> Reusing caller-installed dependencies (--skip-install)"
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Staging cross-platform native bindings for clipboard..."
    # Stage in a disposable package so release preparation never mutates the
    # repository manifest or lockfiles. --os '*' --cpu '*' bypasses Bun's host
    # filtering and installs every exact-version release target.
    clipboard_version="$(bun -e 'const p = await Bun.file("node_modules/@mariozechner/clipboard/package.json").json(); console.log(p.version)')"
    CLIPBOARD_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atomic-clipboard-stage.XXXXXX")"
    # mktemp may echo a relative path when TMPDIR is relative. Canonicalize it
    # before the later cd into packages/coding-agent so staging and cleanup
    # keep referring to the same directory.
    CLIPBOARD_STAGE_DIR="$(cd -- "$CLIPBOARD_STAGE_DIR" && pwd -P)"
    bun run packages/coding-agent/scripts/stage-clipboard-native-bindings.ts \
        "$CLIPBOARD_STAGE_DIR" "$clipboard_version"
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

if compgen -G "packages/natives/native/*.node" >/dev/null; then
    echo "==> Using existing Atomic native binding artifacts..."
else
    echo "==> Building Atomic native bindings for host platform..."
    bun run --cwd packages/natives build
fi

if [[ "$SKIP_PACKAGE_BUILD" == "false" ]]; then
    echo "==> Building @bastani/atomic package..."
    cd packages/coding-agent
    bun run build
else
    echo "==> Reusing caller-built @bastani/atomic package (--skip-package-build)"
    test -f packages/coding-agent/dist/bun/cli.js || {
        echo "Missing packages/coding-agent/dist/bun/cli.js; cannot use --skip-package-build" >&2
        exit 1
    }
    cd packages/coding-agent
fi

echo "==> Building binaries..."

rm -rf binaries
mkdir -p binaries

if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

shared_app_dir="binaries/.app"
rm -rf "$shared_app_dir"
mkdir -p "$shared_app_dir"
echo "==> Building shared app bundle..."
bun build --target=bun --format=cjs --external mupdf ./dist/bun/cli.js --outfile "$shared_app_dir/app.js"
bun build --target=bun --format=cjs --external mupdf ./src/utils/image-resize-worker.ts --outfile "$shared_app_dir/image-resize-worker.js"

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    mkdir -p "binaries/$platform"
    if [[ "$platform" == windows-* ]]; then
        # Bun 1.3.14 bytecode-compiled Windows standalone executables can
        # segfault before user code runs (llint_entry / bytecode alignment).
        # Keep Windows release binaries standalone-compiled, but ship source
        # payload instead of embedded bytecode until Bun's fix is available.
        bun build --compile --format=cjs --external mupdf --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-$platform ./dist/bun/split-loader.js --outfile "binaries/$platform/atomic.exe"
    else
        bun build --compile --bytecode --format=cjs --external mupdf --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-$platform ./dist/bun/split-loader.js --outfile "binaries/$platform/atomic"
    fi
done

echo "==> Copying runtime dependencies..."
runtime_deps_dir="binaries/.runtime-node_modules"
rm -rf "$runtime_deps_dir"
bun run scripts/copy-runtime-dependencies.ts "$runtime_deps_dir"
clipboard_copy_args=()
if [[ "$SKIP_DEPS" == "true" ]]; then
    # Local builds reuse whichever optional native packages are already present.
    # Release builds remain strict so every requested archive gets its binding.
    clipboard_copy_args+=(--allow-missing)
else
    clipboard_copy_args+=(--source-node-modules "$CLIPBOARD_STAGE_DIR/node_modules")
fi
bun run scripts/copy-clipboard-native-bindings.ts "$runtime_deps_dir" "${clipboard_copy_args[@]}" "${PLATFORMS[@]}"
cleanup_clipboard_stage
CLIPBOARD_STAGE_DIR=""

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

win32_console_mode_arch() {
    case "$1" in
        windows-x64) echo "x64" ;;
        windows-arm64) echo "arm64" ;;
        *) return 1 ;;
    esac
}

for platform in "${PLATFORMS[@]}"; do
    cp package.json "binaries/$platform/"
    cp README.md "binaries/$platform/"
    cp CHANGELOG.md "binaries/$platform/"
    cp "$shared_app_dir/app.js" "binaries/$platform/"
    cp "$shared_app_dir/image-resize-worker.js" "binaries/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "binaries/$platform/"
    mkdir -p "binaries/$platform/theme"
    cp dist/modes/interactive/theme/*.json "binaries/$platform/theme/"
    mkdir -p "binaries/$platform/assets"
    cp dist/modes/interactive/assets/* "binaries/$platform/assets/"
    cp -r dist/core/export-html "binaries/$platform/"
    cp -r dist/builtin "binaries/$platform/"
    if console_arch="$(win32_console_mode_arch "$platform")"; then
        console_src="../../node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-$console_arch/win32-console-mode.node"
        console_dst="binaries/$platform/native/win32/prebuilds/win32-$console_arch"
        if [ -f "$console_src" ]; then
            mkdir -p "$console_dst"
            cp "$console_src" "$console_dst/"
        fi
    fi

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

rm -rf "$runtime_deps_dir" "$shared_app_dir"

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
