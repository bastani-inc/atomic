#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <archive> <linux-x64-musl|linux-arm64-musl>" >&2
    exit 2
fi

archive="$1"
platform="$2"
case "$platform" in
    linux-x64-musl) docker_platform="linux/amd64" ;;
    linux-arm64-musl) docker_platform="linux/arm64" ;;
    *)
        echo "Unsupported musl archive platform: $platform" >&2
        exit 2
        ;;
esac

[[ -f "$archive" ]] || {
    echo "Musl release archive not found: $archive" >&2
    exit 1
}

workspace="$(mktemp -d "${TMPDIR:-/tmp}/atomic-musl-archive-smoke.XXXXXX")"
cleanup() {
    rm -rf "$workspace"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$workspace"
for path in \
    atomic/atomic \
    atomic/app.js \
    atomic/package.json \
    atomic/builtin/workflows/package.json \
    atomic/node_modules/@bastani/atomic-natives/package.json \
    atomic/lib/libgcc_s.so.1 \
    atomic/lib/libstdc++.so.6; do
    [[ -e "$workspace/$path" ]] || {
        echo "Missing musl release archive path: $path" >&2
        exit 1
    }
done

cat > "$workspace/smoke.sh" <<'SMOKE'
#!/bin/sh
set -eu
atomic=/smoke/atomic/atomic
test -f /smoke/atomic/app.js
test -d /smoke/atomic/builtin
test -d /smoke/atomic/node_modules
test -f /smoke/atomic/lib/libgcc_s.so.1
test -f /smoke/atomic/lib/libstdc++.so.6
"$atomic" --version
set +e
output=$(printf '' | "$atomic" --no-session 2>&1)
status=$?
set -e
echo "$output"
if echo "$output" | grep -q 'Failed to load extension'; then exit 1; fi
if [ "$status" -ne 0 ] && ! echo "$output" | grep -Eq 'No models available|No model selected|No API key found'; then
    exit "$status"
fi
SMOKE
chmod +x "$workspace/smoke.sh"

docker run --rm --platform "$docker_platform" \
    -v "$workspace:/smoke:ro" \
    alpine:3.22 \
    /bin/sh /smoke/smoke.sh
