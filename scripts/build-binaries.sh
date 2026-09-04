#!/usr/bin/env bash
#
# Build @bastani/atomic binaries for all platforms locally.
# Mirrors .github/workflows/publish.yml binary build.
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--skip-install] [--skip-package-build] [--offline-model-data] [--skip-windows] [--platform <platform>]
#
# Options:
#   --skip-deps          Skip installing cross-platform native bindings
#   --skip-install       Reuse dependencies installed by the caller
#   --skip-package-build Reuse packages/coding-agent/dist built by the caller
#   --offline-model-data Build @bastani/pi-ai with bundled model data instead of refreshing it
#   --skip-windows       Build every default platform except the Windows targets
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
OFFLINE_MODEL_DATA=false
SKIP_WINDOWS=false
PLATFORM=""

ALPINE_MUSL_RUNTIME_BRANCH="v3.22"
ALPINE_MUSL_RUNTIME_VERSION="14.2.0-r6"
ALPINE_MUSL_RUNTIME_BASE="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_MUSL_RUNTIME_BRANCH/main"

CLIPBOARD_STAGE_DIR=""
ESBUILD_STAGE_DIR=""
MUSL_RUNTIME_STAGE_DIR=""
cleanup_clipboard_stage() {
    if [[ -n "$CLIPBOARD_STAGE_DIR" ]]; then
        rm -rf "$CLIPBOARD_STAGE_DIR"
    fi
}

cleanup_esbuild_stage() {
    if [[ -n "$ESBUILD_STAGE_DIR" ]]; then
        rm -rf "$ESBUILD_STAGE_DIR"
    fi
}

cleanup_musl_runtime_stage() {
    if [[ -n "$MUSL_RUNTIME_STAGE_DIR" ]]; then
        rm -rf "$MUSL_RUNTIME_STAGE_DIR"
    fi
}

cleanup_build_stages() {
    cleanup_clipboard_stage
    cleanup_esbuild_stage
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
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --skip-windows)
            SKIP_WINDOWS=true
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

if [[ "$SKIP_WINDOWS" == "true" && "$PLATFORM" == windows-* ]]; then
    echo "--skip-windows cannot be combined with --platform $PLATFORM"
    exit 1
fi

alias_pi_ai() {
    echo "==> Aliasing @earendil-works/pi-ai onto packages/ai..."
    node scripts/alias-pi-ai.mjs
}

build_pi_ai() {
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building @bastani/pi-ai with bundled model data..."
        npm run build:offline --workspace=@bastani/pi-ai
    else
        echo "==> Building @bastani/pi-ai..."
        npm run build --workspace=@bastani/pi-ai
    fi
}

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Reusing caller-installed dependencies (--skip-install)"
fi

alias_pi_ai
build_pi_ai

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
    elif compgen -G "packages/natives/native/*.node" >/dev/null; then
        # publish.yml stages the just-built bindings before this script. Fetching
        # @bastani/atomic-natives-*@$VERSION from npm can only fail: this release
        # is what would publish them. The failed --force install then requires
        # npm ci, which drops the pi-ai alias and breaks the coding-agent build.
        echo "==> Skipping registry install of @bastani/atomic-natives-*: local native artifacts are already staged"
    elif ! npm install --include=optional --no-save --package-lock=false --force --ignore-scripts \
        "${natives_targets[@]}"; then
        # `--no-save --force` mutates node_modules before it fails, and it prunes
        # real runtime dependencies on the way out (this removed css-select and
        # broke the release binary). Put the tree back before continuing.
        echo "==> Cross-platform bindings unavailable; restoring the dependency tree"
        npm ci --ignore-scripts
        alias_pi_ai
        build_pi_ai
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

    echo "==> Staging cross-platform esbuild binaries for Chord..."
    esbuild_version="$(node -p 'require("./node_modules/esbuild/package.json").version')"
    ESBUILD_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atomic-esbuild-stage.XXXXXX")"
    ESBUILD_STAGE_DIR="$(cd -- "$ESBUILD_STAGE_DIR" && pwd -P)"
    printf '%s\n' '{"name":"atomic-esbuild-native-stage","private":true}' > "$ESBUILD_STAGE_DIR/package.json"
    esbuild_targets=()
    for esbuild_target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64; do
        esbuild_targets+=("@esbuild/${esbuild_target}@${esbuild_version}")
    done
    (
        cd "$ESBUILD_STAGE_DIR"
        bun add --no-save --os '*' --cpu '*' "${esbuild_targets[@]}"
    )
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
    if [[ "$SKIP_WINDOWS" == "true" ]]; then
        non_windows_platforms=()
        for candidate_platform in "${PLATFORMS[@]}"; do
            [[ "$candidate_platform" == windows-* ]] || non_windows_platforms+=("$candidate_platform")
        done
        PLATFORMS=("${non_windows_platforms[@]}")
    fi
fi

shared_app_dir="binaries/.app"
rm -rf "$shared_app_dir"
mkdir -p "$shared_app_dir"
echo "==> Building shared app bundle..."
# Bun's compiled launcher cannot resolve bare packages from the dynamically loaded CJS sidecar.
# Bundle pi-tui itself, but keep the import.meta.url-sensitive native loader payload-relative.
bun build --target=bun --format=cjs --minify-syntax --external mupdf --external=*native-modifiers.js ./dist/bun/cli.js --outfile "$shared_app_dir/app.js"
bun build --target=bun --format=cjs --external mupdf ./src/utils/image-resize-worker.ts --outfile "$shared_app_dir/image-resize-worker.js"

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    mkdir -p "binaries/$platform"
    bun_target="bun-$platform"
    # Bun's generic x64 runtime assumes newer CPU instructions. Keep every x64
    # release target, including musl, compatible with baseline x64 machines.
    if [[ "$platform" == *-x64 || "$platform" == *-x64-* ]]; then
        bun_target="${bun_target}-baseline"
    fi
    binary_name="atomic"
    if [[ "$platform" == windows-* ]]; then
        binary_name="atomic.exe"
    fi
    # Every release target embeds startup-optimized bytecode, but Bun 1.4.0
    # Windows bytecode executables must be compiled on a Windows host: the same
    # command cross-compiled from a non-Windows host produces a launcher that
    # segfaults before user code runs (even on --version). publish.yml builds
    # the Windows archives on the Windows runner and passes --skip-windows to
    # the Linux release-payload build.
    bun build --compile --bytecode --format=cjs --external mupdf --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target="$bun_target" ./dist/bun/split-loader.js --outfile "binaries/$platform/$binary_name"
done

echo "==> Copying runtime dependencies..."
runtime_deps_dir="binaries/.runtime-node_modules"
rm -rf "$runtime_deps_dir"
bun run scripts/copy-runtime-dependencies.ts "$runtime_deps_dir"
cp "$runtime_deps_dir/@earendil-works/pi-tui/dist/native-modifiers.js" "$shared_app_dir/native-modifiers.js"
cp "$runtime_deps_dir/@earendil-works/pi-tui/dist/native-module-path.js" "$shared_app_dir/native-module-path.js"
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

# The @embedded-postgres leaf that can actually run on each archive. `embedded-postgres`
# publishes no arm64 Windows package, so windows-arm64 names one that never matches and
# every leaf is pruned.
embedded_postgres_package_name() {
    case "$1" in
        darwin-arm64) echo "darwin-arm64" ;;
        darwin-x64) echo "darwin-x64" ;;
        linux-x64) echo "linux-x64" ;;
        linux-arm64) echo "linux-arm64" ;;
        windows-x64) echo "windows-x64" ;;
        windows-arm64) echo "windows-arm64" ;;
        *) echo "Unknown platform: $1" >&2; return 1 ;;
    esac
}

esbuild_package_name() {
    case "$1" in
        darwin-arm64) echo "darwin-arm64" ;;
        darwin-x64) echo "darwin-x64" ;;
        linux-arm64|linux-arm64-musl) echo "linux-arm64" ;;
        linux-x64|linux-x64-musl) echo "linux-x64" ;;
        windows-arm64) echo "win32-arm64" ;;
        windows-x64) echo "win32-x64" ;;
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
    cp "$shared_app_dir/native-modifiers.js" "binaries/$platform/"
    cp "$shared_app_dir/native-module-path.js" "binaries/$platform/"
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
    # Chord 0.85 uses esbuild for facet bundling. The shared dependency tree contains only the
    # build host's optional native leaf, so replace it with the leaf for this archive target.
    esbuild_leaf="$(esbuild_package_name "$platform")"
    esbuild_source_root="$runtime_deps_dir"
    if [[ -n "$ESBUILD_STAGE_DIR" ]]; then
        esbuild_source_root="$ESBUILD_STAGE_DIR/node_modules"
    fi
    rm -rf "binaries/$platform/node_modules/@esbuild"
    if [ -d "$esbuild_source_root/@esbuild/$esbuild_leaf" ]; then
        mkdir -p "binaries/$platform/node_modules/@esbuild"
        cp -r "$esbuild_source_root/@esbuild/$esbuild_leaf" "binaries/$platform/node_modules/@esbuild/"
    elif [[ "$SKIP_DEPS" == "false" ]]; then
        echo "Missing esbuild native package for $platform: @esbuild/$esbuild_leaf" >&2
        exit 1
    else
        echo "==> esbuild native package unavailable for $platform (--skip-deps)"
    fi
    if [[ "$platform" == linux-*-musl ]]; then
        # npm's Linux leaves contain glibc binaries. Musl archives instead receive
        # the checksum-pinned Zonky Alpine runtime in the native package below.
        rm -rf "binaries/$platform/node_modules/@embedded-postgres"
    else
        # Every archive is built on one runner, so the shared runtime copy carries that
        # runner's @embedded-postgres binary into all of them. Keep only the leaf that
        # matches this archive. Windows ARM64 receives its x64-emulated tree below.
        embedded_postgres_leaf="$(embedded_postgres_package_name "$platform")"
        embedded_postgres_dir="binaries/$platform/node_modules/@embedded-postgres"
        if [ -d "$embedded_postgres_dir" ]; then
            find "$embedded_postgres_dir" -mindepth 1 -maxdepth 1 -type d ! -name "$embedded_postgres_leaf" -exec rm -rf {} +
        fi
    fi

    if [[ "$platform" == linux-*-musl || "$platform" == windows-arm64 ]]; then
        echo "==> Staging embedded PostgreSQL runtime for $platform..."
        node ../../scripts/stage-postgres-runtime.mjs "$platform" "binaries/$platform/node_modules/@bastani/atomic-natives"
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

    # Last gate before the archive is created: no package staged here may declare a platform
    # this archive cannot run. Atomic 0.9.12 shipped @esbuild/linux-x64 in the arm64 archives.
    bun run ../../packages/coding-agent/scripts/assert-archive-architecture.ts "binaries/$platform" --platform "$platform"
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
