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
#                        (darwin-arm64, darwin-x64, linux-x64, linux-arm64,
#                         linux-x64-musl, linux-arm64-musl, windows-x64, windows-arm64)
#
# Output:
#   packages/coding-agent/binaries/
#     atomic-darwin-arm64.tar.gz
#     atomic-darwin-x64.tar.gz
#     atomic-linux-x64.tar.gz
#     atomic-linux-arm64.tar.gz
#     atomic-linux-x64-musl.tar.gz
#     atomic-linux-arm64-musl.tar.gz
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

ALPINE_MUSL_RUNTIME_BRANCH="v3.22"
ALPINE_MUSL_RUNTIME_VERSION="14.2.0-r6"
ALPINE_MUSL_RUNTIME_BASE="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_MUSL_RUNTIME_BRANCH/main"

CLIPBOARD_STAGE_DIR=""
MUSL_RUNTIME_STAGE_DIR=""
cleanup_clipboard_stage() {
    if [[ -n "$CLIPBOARD_STAGE_DIR" ]]; then
        rm -rf "$CLIPBOARD_STAGE_DIR"
    fi
}

cleanup_musl_runtime_stage() {
    if [[ -n "$MUSL_RUNTIME_STAGE_DIR" ]]; then
        rm -rf "$MUSL_RUNTIME_STAGE_DIR"
    fi
}

cleanup_build_stages() {
    cleanup_clipboard_stage
    cleanup_musl_runtime_stage
}
trap cleanup_build_stages EXIT

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
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|linux-x64-musl|linux-arm64-musl|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Reusing caller-installed dependencies (--skip-install)"
fi

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform Atomic native bindings..."
    # Mirrors pi's build-binaries.sh. Every platform binding goes in one command
    # because npm prunes what a previous --no-save install added, so a binding
    # per invocation would leave only the last one on disk. --force bypasses the
    # os/cpu restrictions that exist to prevent exactly this, and --ignore-scripts
    # because none of these are meant to run on this host.
    natives_version="$(node -p 'require("./packages/natives/package.json").version')"
    natives_targets=()
    for natives_platform in darwin-arm64 darwin-x64 linux-x64-gnu linux-arm64-gnu linux-x64-musl linux-arm64-musl win32-x64-msvc win32-arm64-msvc; do
        natives_targets+=("@bastani/atomic-natives-${natives_platform}@${natives_version}")
    done
    # A versionless release base pins every manifest at the 0.0.0 placeholder, and
    # nothing is published under it, so the fetch can only fail. Skip it rather
    # than let npm prune the installed tree on its way to ETARGET.
    if [[ "$natives_version" == "0.0.0" ]]; then
        echo "==> Skipping cross-platform bindings: packages/natives is at the 0.0.0 placeholder"
    elif ! npm install --include=optional --no-save --package-lock=false --force --ignore-scripts \
        "${natives_targets[@]}"; then
        # `--no-save --force` mutates node_modules before it fails, and it prunes
        # real runtime dependencies on the way out (this removed css-select and
        # broke the release binary). Put the tree back before continuing.
        echo "==> Cross-platform bindings unavailable; restoring the dependency tree"
        npm ci --ignore-scripts
    fi

    echo "==> Staging cross-platform native bindings for clipboard..."
    # Stage in a disposable package so release preparation never mutates the
    # repository manifest or lockfiles. --os '*' --cpu '*' bypasses host
    # filtering and installs every exact-version release target.
    clipboard_version="$(node -p 'require("./node_modules/@mariozechner/clipboard/package.json").version')"
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
    npm run build --workspace=@bastani/atomic-natives
fi

if [[ "$SKIP_PACKAGE_BUILD" == "false" ]]; then
    echo "==> Building @bastani/atomic package..."
    cd packages/coding-agent
    npm run build
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
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl windows-x64 windows-arm64)
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
bun run scripts/assert-pi-runtime-assets.ts --node-modules "$runtime_deps_dir" --app "$shared_app_dir/app.js"
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
atomic_native_filename() {
    case "$1" in
        darwin-arm64) echo "atomic_natives.darwin-arm64.node" ;;
        darwin-x64) echo "atomic_natives.darwin-x64.node" ;;
        linux-x64) echo "atomic_natives.linux-x64-gnu.node" ;;
        linux-arm64) echo "atomic_natives.linux-arm64-gnu.node" ;;
        linux-x64-musl) echo "atomic_natives.linux-x64-musl.node" ;;
        linux-arm64-musl) echo "atomic_natives.linux-arm64-musl.node" ;;
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

download_build_asset() {
    local url="$1"
    local destination="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$destination"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$destination" "$url"
    else
        echo "curl or wget is required to stage musl runtime libraries" >&2
        return 1
    fi
}

verify_build_sha256() {
    local expected="$1"
    local file="$2"
    if command -v sha256sum >/dev/null 2>&1; then
        local checksum_manifest="$MUSL_RUNTIME_STAGE_DIR/checksum.$$.txt"
        printf '%s  %s\n' "$expected" "$file" > "$checksum_manifest"
        sha256sum -c "$checksum_manifest"
        rm -f "$checksum_manifest"
    elif command -v shasum >/dev/null 2>&1; then
        local actual
        actual="$(shasum -a 256 "$file")"
        [[ "${actual%% *}" == "$expected" ]]
    else
        echo "sha256sum or shasum is required to verify musl runtime libraries" >&2
        return 1
    fi
}

stage_musl_runtime() {
    local platform="$1"
    local payload_dir="$2"
    local alpine_arch=""
    local libgcc_sha256=""
    local libstdcpp_sha256=""

    case "$platform" in
        linux-x64-musl)
            alpine_arch="x86_64"
            libgcc_sha256="04f3467bc967e705221a843fe4d3de5850db826e571686e0c0ed453d38cb5c59"
            libstdcpp_sha256="939f7c99898f3e8154207a17f4acbe8bc40437e1bb1b43f5525620ca9e452a2e"
            ;;
        linux-arm64-musl)
            alpine_arch="aarch64"
            libgcc_sha256="ba1835eec3ad8a120efd3d5020e561d53553a0513763a08f509e3ce6d4baa9ca"
            libstdcpp_sha256="0d2f054057a4f932e985a129eccb79908b40964185139a0a609aed3032aba064"
            ;;
        *)
            echo "Cannot stage musl runtime for $platform" >&2
            return 1
            ;;
    esac

    command -v patchelf >/dev/null 2>&1 || {
        echo "patchelf is required to build musl release archives" >&2
        return 1
    }

    MUSL_RUNTIME_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atomic-musl-runtime.XXXXXX")"
    MUSL_RUNTIME_STAGE_DIR="$(cd -- "$MUSL_RUNTIME_STAGE_DIR" && pwd -P)"
    local libgcc_apk="$MUSL_RUNTIME_STAGE_DIR/libgcc.apk"
    local libstdcpp_apk="$MUSL_RUNTIME_STAGE_DIR/libstdc++.apk"
    download_build_asset "$ALPINE_MUSL_RUNTIME_BASE/$alpine_arch/libgcc-$ALPINE_MUSL_RUNTIME_VERSION.apk" "$libgcc_apk"
    download_build_asset "$ALPINE_MUSL_RUNTIME_BASE/$alpine_arch/libstdc++-$ALPINE_MUSL_RUNTIME_VERSION.apk" "$libstdcpp_apk"
    verify_build_sha256 "$libgcc_sha256" "$libgcc_apk"
    verify_build_sha256 "$libstdcpp_sha256" "$libstdcpp_apk"
    tar -xzf "$libgcc_apk" -C "$MUSL_RUNTIME_STAGE_DIR"
    tar -xzf "$libstdcpp_apk" -C "$MUSL_RUNTIME_STAGE_DIR"

    mkdir -p "$payload_dir/lib"
    cp -L "$MUSL_RUNTIME_STAGE_DIR/usr/lib/libgcc_s.so.1" "$payload_dir/lib/libgcc_s.so.1"
    cp -L "$MUSL_RUNTIME_STAGE_DIR/usr/lib/libstdc++.so.6" "$payload_dir/lib/libstdc++.so.6"

    local patched_count=0
    while IFS= read -r -d '' elf_file; do
        local needed
        if ! needed="$(patchelf --print-needed "$elf_file" 2>/dev/null)"; then
            continue
        fi
        case "$needed" in
            *libgcc_s.so.1*|*libstdc++.so.6*) ;;
            *) continue ;;
        esac

        local elf_dir
        local relative_lib
        local runtime_rpath
        local current_rpath
        local next_rpath
        elf_dir="$(dirname -- "$elf_file")"
        relative_lib="$(node -e 'process.stdout.write(require("node:path").relative(process.argv[1], process.argv[2]).replaceAll("\\\\", "/"))' "$elf_dir" "$payload_dir/lib")"
        runtime_rpath='$ORIGIN'
        if [[ "$relative_lib" != "." ]]; then
            runtime_rpath="$runtime_rpath/$relative_lib"
        fi
        current_rpath="$(patchelf --print-rpath "$elf_file")"
        case ":$current_rpath:" in
            *":$runtime_rpath:"*) next_rpath="$current_rpath" ;;
            ::) next_rpath="$runtime_rpath" ;;
            *) next_rpath="$current_rpath:$runtime_rpath" ;;
        esac
        patchelf --set-rpath "$next_rpath" "$elf_file"
        patched_count=$((patched_count + 1))
    done < <(find "$payload_dir" -type f \( -path "$payload_dir/atomic" -o -name '*.node' -o -name '*.so' -o -name '*.so.*' \) -print0)

    [[ "$patched_count" -gt 0 ]] || {
        echo "No musl payload ELF declared libgcc_s.so.1 or libstdc++.so.6: $platform" >&2
        return 1
    }

    cleanup_musl_runtime_stage
    MUSL_RUNTIME_STAGE_DIR=""
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
    bun run ../../scripts/assert-builtin-set.ts "binaries/$platform/builtin"
    if console_arch="$(win32_console_mode_arch "$platform")"; then
        console_src="../../node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-$console_arch/win32-console-mode.node"
        console_dst="binaries/$platform/native/win32/prebuilds/win32-$console_arch"
        if [ -f "$console_src" ]; then
            mkdir -p "$console_dst"
            cp "$console_src" "$console_dst/"
        fi
    fi

    cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"
    if [[ "$platform" == linux-*-musl ]]; then
        # The embedded-postgres wrapper remains useful for its Docker/in-memory fallback,
        # but its optional @embedded-postgres/* packages contain glibc binaries only.
        rm -rf "binaries/$platform/node_modules/@embedded-postgres"
    fi
    rm -rf "binaries/$platform/node_modules/@bastani/atomic-natives/npm"
    find "binaries/$platform/node_modules/@bastani/atomic-natives" -maxdepth 1 -type f -name 'atomic_natives.*.node' -delete
    atomic_native="$(atomic_native_filename "$platform")"
    atomic_native_dir="binaries/$platform/node_modules/@bastani/atomic-natives/native"
    if [ ! -f "$atomic_native_dir/$atomic_native" ]; then
        echo "Missing Atomic native binding for $platform: $atomic_native_dir/$atomic_native" >&2
        echo "Build or download all Atomic native artifacts before building release archives." >&2
        exit 1
    fi
    find "$atomic_native_dir" -type f -name 'atomic_natives.*.node' ! -name "$atomic_native" -delete

    cp -r docs "binaries/$platform/"
    cp -r examples "binaries/$platform/"
    if [[ "$platform" == linux-*-musl ]]; then
        echo "==> Bundling musl C++ runtime for $platform..."
        stage_musl_runtime "$platform" "binaries/$platform"
    fi
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
