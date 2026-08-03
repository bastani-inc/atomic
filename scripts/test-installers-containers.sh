#!/usr/bin/env bash

set -euo pipefail

cd -- "$(dirname -- "$0")/.."

workspace="$(mktemp -d "${TMPDIR:-/tmp}/atomic-installer-containers.XXXXXX")"
cleanup() {
    rm -rf "$workspace"
}
trap cleanup EXIT

mkdir -p "$workspace/payload/atomic/builtin" "$workspace/payload/atomic/node_modules/fixture"
cat > "$workspace/payload/atomic/atomic" <<'ATOMIC'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
    printf '%s\n' '1.0.0'
    exit 0
fi
exit 1
ATOMIC
chmod +x "$workspace/payload/atomic/atomic"
printf '%s\n' '{"name":"@bastani/atomic","version":"1.0.0"}' > "$workspace/payload/atomic/package.json"
printf '%s\n' 'fixture app' > "$workspace/payload/atomic/app.js"
printf '%s\n' 'fixture builtin' > "$workspace/payload/atomic/builtin/payload.txt"
printf '%s\n' 'fixture module' > "$workspace/payload/atomic/node_modules/fixture/payload.txt"

COPYFILE_DISABLE=1 tar --no-xattrs -czf "$workspace/payload.tar.gz" -C "$workspace/payload" atomic
if command -v sha256sum >/dev/null 2>&1; then
    archive_hash="$(sha256sum "$workspace/payload.tar.gz")"
else
    archive_hash="$(shasum -a 256 "$workspace/payload.tar.gz")"
fi
archive_hash="${archive_hash%% *}"

release_dir="$workspace/releases/1.0.0"
mkdir -p "$release_dir" "$workspace/bin"
: > "$release_dir/SHA256SUMS"
for asset in atomic-linux-x64.tar.gz atomic-linux-arm64.tar.gz atomic-linux-x64-musl.tar.gz atomic-linux-arm64-musl.tar.gz; do
    cp "$workspace/payload.tar.gz" "$release_dir/$asset"
    printf '%s  %s\n' "$archive_hash" "$asset" >> "$release_dir/SHA256SUMS"
done

cat > "$workspace/bin/wget" <<'WGET'
#!/bin/sh
output=
url=
while [ "$#" -gt 0 ]; do
    case $1 in
        -O) shift; output=$1 ;;
        -*) ;;
        *) url=$1 ;;
    esac
    shift
done
case $url in
    https://api.github.com/repos/bastani-inc/atomic/releases/tags/1.0.0)
        printf '%s\n' '{"tag_name":"1.0.0"}'
        ;;
    https://github.com/bastani-inc/atomic/releases/download/1.0.0/*)
        file=${url##*/}
        /bin/cp "/fixture/releases/1.0.0/$file" "$output"
        ;;
    *)
        printf 'unexpected fixture request: %s\n' "$url" >&2
        exit 1
        ;;
esac
WGET
chmod +x "$workspace/bin/wget"

for container in alpine:3.22 debian:bookworm-slim; do
    name=${container%%:*}
    mkdir -p "$workspace/$name-home" "$workspace/$name-tmp"
    docker run --rm \
        -v "$PWD:/repo:ro" \
        -v "$workspace:/fixture" \
        -e HOME="/fixture/$name-home" \
        -e TMPDIR="/fixture/$name-tmp" \
        -e ATOMIC_INSTALL_DIR="/fixture/$name-install" \
        -e ATOMIC_BIN_DIR="/fixture/$name-bin" \
        -e PATH="/fixture/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        "$container" \
        /bin/sh -c '
            set -eu
            /bin/sh /repo/install.sh --ref 1.0.0
            test -L "$ATOMIC_INSTALL_DIR/current"
            test -L "$ATOMIC_BIN_DIR/atomic"
            test -f "$ATOMIC_INSTALL_DIR/current/app.js"
            test -f "$ATOMIC_INSTALL_DIR/current/builtin/payload.txt"
            test -f "$ATOMIC_INSTALL_DIR/current/node_modules/fixture/payload.txt"
            test "$("$ATOMIC_BIN_DIR/atomic" --version)" = 1.0.0
        '
done
