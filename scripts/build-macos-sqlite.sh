#!/usr/bin/env bash
#
# Builds the SQLite library the macOS standalone binaries load instead of the system's
# (packages/coding-agent/src/bun/bundled-sqlite.ts). The source is the SQLite amalgamation pinned in
# scripts/bundled-sqlite.json, the release Node's node:sqlite bundles, so the binaries and an npm install under
# Node run the same SQLite. It is compiled with the options Node compiles it with (deps/sqlite/sqlite.gyp).
#
# Usage:
#   ./scripts/build-macos-sqlite.sh <arm64|x64> <output.dylib>
#
# The download is kept in $ATOMIC_SQLITE_CACHE_DIR (default ${XDG_CACHE_HOME:-$HOME/.cache}/atomic-sqlite) and
# checked against the pinned SHA-256 before every use. Needs macOS with the Xcode command line tools.

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <arm64|x64> <output.dylib>" >&2
    exit 2
fi
case "$1" in
    arm64) clang_arch=arm64 ;;
    x64) clang_arch=x86_64 ;;
    *) echo "Unknown architecture: $1 (arm64 or x64)" >&2; exit 2 ;;
esac
output="$2"
[[ "$(uname -s)" == Darwin ]] || { echo "The macOS SQLite library is built on macOS" >&2; exit 1; }

root="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
pin="$root/scripts/bundled-sqlite.json"
pinned() { node -p "require(process.argv[1])[process.argv[2]]" "$pin" "$1"; }
url="$(pinned url)"
sha256="$(pinned sha256)"
version="$(pinned version)"

cache="${ATOMIC_SQLITE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/atomic-sqlite}"
archive="$cache/$(basename -- "$url")"
mkdir -p "$cache"
checksum() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
if [[ ! -f "$archive" || "$(checksum "$archive")" != "$sha256" ]]; then
    echo "==> Downloading SQLite $version"
    curl -fsSL --retry 3 "$url" -o "$archive.part"
    actual="$(checksum "$archive.part")"
    if [[ "$actual" != "$sha256" ]]; then
        rm -f "$archive.part"
        echo "SHA-256 mismatch for $url: expected $sha256, got $actual" >&2
        exit 1
    fi
    mv "$archive.part" "$archive"
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/atomic-sqlite.XXXXXX")"
trap 'rm -rf "$work"' EXIT
unzip -q "$archive" -d "$work"
source_dir="$work/$(basename -- "$url" .zip)"

echo "==> Building SQLite $version for $1"
mkdir -p "$(dirname -- "$output")"
# The deployment target is the one Bun's macOS runtime declares (LC_BUILD_VERSION minos), so the library loads
# wherever the binary runs. The defines are Node's.
clang -dynamiclib -arch "$clang_arch" -O2 -mmacosx-version-min=13.0 \
    -install_name @rpath/libsqlite3.dylib \
    -DSQLITE_DEFAULT_MEMSTATUS=0 \
    -DSQLITE_ENABLE_COLUMN_METADATA \
    -DSQLITE_ENABLE_DBSTAT_VTAB \
    -DSQLITE_ENABLE_FTS3 \
    -DSQLITE_ENABLE_FTS3_PARENTHESIS \
    -DSQLITE_ENABLE_FTS5 \
    -DSQLITE_ENABLE_GEOPOLY \
    -DSQLITE_ENABLE_MATH_FUNCTIONS \
    -DSQLITE_ENABLE_PERCENTILE \
    -DSQLITE_ENABLE_PREUPDATE_HOOK \
    -DSQLITE_ENABLE_RBU \
    -DSQLITE_ENABLE_RTREE \
    -DSQLITE_ENABLE_SESSION \
    "$source_dir/sqlite3.c" -o "$work/libsqlite3.dylib"
mv "$work/libsqlite3.dylib" "$output"
