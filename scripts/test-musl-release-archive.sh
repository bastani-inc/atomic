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
    atomic/lib/libstdc++.so.6 \
    "atomic/node_modules/@bastani/atomic-natives/postgres-runtime/bin/initdb" \
    "atomic/node_modules/@bastani/atomic-natives/postgres-runtime/bin/pg_ctl" \
    "atomic/node_modules/@bastani/atomic-natives/postgres-runtime/POSTGRESQL-LICENSE" \
    "atomic/node_modules/@bastani/atomic-natives/postgres-runtime/ZONKY-APACHE-2.0-LICENSE" \
    "atomic/node_modules/@bastani/atomic-natives/postgres-runtime/runtime-provenance.json"; do
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

cat > "$workspace/postgres-smoke.sh" <<'SMOKE'
#!/bin/sh
set -eu
source_runtime="/smoke/atomic/node_modules/@bastani/atomic-natives/postgres-runtime"
runtime=/tmp/atomic-postgres-runtime
cp -R "$source_runtime" "$runtime"
awk -F '"' '/"source":/{source=$4} /"target":/{print source " " $4}' "$runtime/pg-symlinks.json" |
    while read -r source target; do cp "$runtime/$source" "$runtime/$target"; done
data=/tmp/atomic-postgres-smoke
"$runtime/bin/initdb" -D "$data" --auth=trust --no-locale >/tmp/initdb.log
"$runtime/bin/pg_ctl" -D "$data" -o "-h 127.0.0.1 -p 55439" -w start
trap '"$runtime/bin/pg_ctl" -D "$data" -m fast -w stop >/dev/null 2>&1 || true' EXIT
# PostgreSQL's SSLRequest handshake proves a real protocol connection without
# adding a client package to the deliberately minimal Zonky runtime.
response=$(printf '\000\000\000\010\004\322\026\057' | nc -w 3 127.0.0.1 55439 | head -c 1)
test "$response" = N
"$runtime/bin/pg_ctl" -D "$data" -m fast -w stop
trap - EXIT
echo "embedded PostgreSQL initdb/start/connect/shutdown succeeded"
SMOKE
chmod +x "$workspace/postgres-smoke.sh"
chmod -R a+rX "$workspace"

docker run --rm --platform "$docker_platform" \
    -v "$workspace:/smoke:ro" \
    alpine:3.22 \
    /bin/sh /smoke/smoke.sh

docker run --rm --platform "$docker_platform" --user 65534:65534 \
    -v "$workspace:/smoke:ro" \
    alpine:3.22 \
    /bin/sh /smoke/postgres-smoke.sh
