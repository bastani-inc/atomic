#!/usr/bin/env bash
# Provision a portable git in a container that has none (#4322), then use it offline from a fresh process.
# Needs Docker and a built checkout (`npm ci --ignore-scripts && npm run build`).

set -euo pipefail

cd -- "$(dirname -- "$0")/.."
repo="$PWD"
image="${ATOMIC_GIT_CONTAINER_IMAGE:-node:22-bookworm-slim}"
dist="/repo/packages/coding-agent/dist/index.js"

if [ ! -f "packages/coding-agent/dist/index.js" ]; then
    echo "packages/coding-agent/dist/index.js is missing; run npm run build first" >&2
    exit 1
fi

workspace="$(mktemp -d "${TMPDIR:-/tmp}/atomic-git-provision.XXXXXX")"
cleanup() {
    docker run --rm -v "$workspace:/state" "$image" rm -rf /state/agent /state/tmp >/dev/null 2>&1 || true
    rm -rf "$workspace"
}
trap cleanup EXIT
mkdir -p "$workspace/agent" "$workspace/tmp"

run_phase() {
    local mode="$1"
    shift
    docker run --rm "$@" \
        -v "$repo:/repo:ro" \
        -v "$workspace:/state" \
        -e ATOMIC_CODING_AGENT_DIR=/state/agent \
        -e HOME=/state/tmp \
        -e TMPDIR=/state/tmp \
        -e GIT_CONFIG_NOSYSTEM=1 \
        -e GIT_CONFIG_GLOBAL=/dev/null \
        -w /repo \
        "$image" \
        sh -c '
            if command -v git >/dev/null 2>&1 || [ -e /usr/bin/git ]; then
                echo "the container must not have git: $(command -v git)" >&2
                exit 1
            fi
            if [ "$1" = offline ]; then export ATOMIC_OFFLINE=1; fi
            if [ "$1" = https ]; then
                apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends libcurl4 >/dev/null
                if command -v git >/dev/null 2>&1; then echo "installing libcurl4 must not install git" >&2; exit 1; fi
                if [ -e /etc/ssl/certs/ca-certificates.crt ]; then echo "the https phase must rely on the bundled CA file" >&2; exit 1; fi
            fi
            exec node /repo/scripts/git-provisioning-container-fixture.mjs "$1" "$2"
        ' fixture "$mode" "$dist"
}

echo "== online: provision a portable git and run init, commit, and worktree add"
run_phase online
echo "== https: the provisioned git reaches github.com with its bundled CA file once the system libcurl is installed"
run_phase https
echo "== offline, no network: a fresh process reuses the installed git"
run_phase offline --network none
echo "git provisioning container test passed"
