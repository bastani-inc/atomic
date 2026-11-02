#!/usr/bin/env bash
# Publish one release's npm payload; publish.yml's publish-npm job runs this.
#
# Usage: publish-npm.sh --payload-dir DIR --registry URL [--requires-registered NAME]... PACKAGE...
# Environment: VERSION (the release version) and NPM_TAG (`latest` or `next`).
#
# PACKAGE... is the whole payload in publication order. The native platform
# leaves (@bastani/atomic-natives-*) publish first, four at a time; every other
# package publishes after them, one at a time, in the order given. A failed leaf
# stops the run before any dependent publishes.
#
# A publish that fails transiently (see npm_publish_failure_kind in lib.sh) is
# retried with backoff, and each attempt first asks npm whether the version is
# already there, so a retry never publishes a version twice. A run that still
# fails can be resumed by re-running it: versions npm already has are skipped.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/release/lib.sh
source "$script_dir/lib.sh"

payload_dir=""
registry=""
requires_registered_name=()
packages=()
while (($#)); do
  case $1 in
  --payload-dir)
    payload_dir=$2
    shift 2
    ;;
  --registry)
    registry=$2
    shift 2
    ;;
  --requires-registered)
    requires_registered_name+=("$2")
    shift 2
    ;;
  -*)
    echo "Unknown option: $1" >&2
    exit 2
    ;;
  *)
    packages+=("$1")
    shift
    ;;
  esac
done
[[ -n "$payload_dir" && -n "$registry" && ${#packages[@]} -gt 0 ]] || {
  echo "Usage: publish-npm.sh --payload-dir DIR --registry URL [--requires-registered NAME]... PACKAGE..." >&2
  exit 2
}
: "${VERSION:?VERSION is required}"
: "${NPM_TAG:?NPM_TAG is required}"

declare -A tarballs=()
for file in "$payload_dir"/*.tgz; do
  name=$(tar -xOf "$file" package/package.json | jq -er .name)
  version=$(tar -xOf "$file" package/package.json | jq -er .version)
  [[ "$version" == "$VERSION" ]] || {
    echo "$name has version $version, expected $VERSION" >&2
    exit 1
  }
  tarballs[$name]="$file"
done
[[ "${#tarballs[@]}" -eq "${#packages[@]}" ]] || {
  echo "Expected exactly ${#packages[@]} npm packages; found ${#tarballs[@]}" >&2
  exit 1
}

publish_package() {
  local name=$1
  [[ -n "${tarballs[$name]:-}" ]] || {
    echo "Missing package $name" >&2
    return 1
  }
  # A package name that has never been published has no npm trusted publisher yet, so an
  # OIDC publish of it would fail the release. These names publish only once they exist.
  if [[ " ${requires_registered_name[*]} " == *" $name "* ]]; then
    local registration_output registration_status
    if registration_output=$(npm view "$name" name --registry "$registry" 2>&1); then
      : # The registered name can be published with its trusted publisher.
    else
      registration_status=$?
      if ((registration_status < 128)) && grep -Eq 'E404|404 Not Found|is not in this registry' <<<"$registration_output"; then
        echo "::warning::$name is not registered on npm yet; skipping it. Publish it once by hand and add the trusted publisher (see docs/ci.md)."
        return 0
      fi
      echo "Cannot determine whether $name is registered (npm exited $registration_status): $registration_output" >&2
      return 1
    fi
  fi
  local attempt status output failure delay
  for ((attempt = 1; ; attempt++)); do
    if npm_has_version "$name"; then
      echo "$name@$VERSION already exists; skipping."
      return 0
    fi
    output=$(mktemp)
    if npm publish "${tarballs[$name]}" --provenance --access public --tag "$NPM_TAG" --registry "$registry" >"$output" 2>&1; then
      status=0
    else
      status=$?
    fi
    cat "$output"
    failure=$(npm_publish_failure_kind "$output")
    rm -f "$output"
    ((status != 0)) || return 0
    case $failure in
    exists)
      # npm refuses the same way for a version that was unpublished, so the
      # refusal alone does not prove dependents can install this version.
      if npm_serves_version_eventually "$name"; then
        echo "$name@$VERSION is already on npm (the registry refused to publish over it); skipping."
        return 0
      fi
      echo "npm refuses to publish $name@$VERSION over an existing version but does not serve it (was it unpublished?); not retrying." >&2
      return 1
      ;;
    transient) ;;
    *)
      echo "Publishing $name@$VERSION failed (npm exited $status); this error is not retried." >&2
      return "$status"
      ;;
    esac
    if ((attempt >= NPM_PUBLISH_ATTEMPTS)); then
      echo "Publishing $name@$VERSION failed $attempt times with transient errors; giving up." >&2
      return "$status"
    fi
    delay=$(retry_delay "$attempt" "$NPM_RETRY_BASE_SECONDS")
    echo "::warning::Publishing $name@$VERSION failed transiently (attempt $attempt of $NPM_PUBLISH_ATTEMPTS); retrying in ${delay}s if npm still lacks it."
    sleep "$delay"
  done
}

# Whether npm already serves name@VERSION. Any other answer, including an
# unreachable registry, is "no": publishing then either succeeds or is refused
# because the version exists, and both settle the question.
npm_has_version() {
  local found
  found=$(npm view "$1@$VERSION" version --registry "$registry" 2>/dev/null) || return 1
  [[ "$found" == "$VERSION" ]]
}

# Whether npm serves name@VERSION within the npm retry budget, allowing for a
# registry view that lags behind a publish it has just accepted.
npm_serves_version_eventually() {
  local attempt
  for ((attempt = 1; attempt <= NPM_PUBLISH_ATTEMPTS; attempt++)); do
    npm_has_version "$1" && return 0
    ((attempt == NPM_PUBLISH_ATTEMPTS)) || sleep "$(retry_delay "$attempt" "$NPM_RETRY_BASE_SECONDS")"
  done
  return 1
}

platform_leaves=() dependents=()
for name in "${packages[@]}"; do
  if [[ "$name" == @bastani/atomic-natives-* ]]; then platform_leaves+=("$name"); else dependents+=("$name"); fi
done
# Leaves publish in batches of NATIVE_PUBLISH_BATCH: eight concurrent provenance
# uploads from one runner preceded both transparency-log 409s seen in releases.
NATIVE_PUBLISH_BATCH=4
logs=$(mktemp -d)
failed=0
for ((start = 0; start < ${#platform_leaves[@]}; start += NATIVE_PUBLISH_BATCH)); do
  batch=("${platform_leaves[@]:start:NATIVE_PUBLISH_BATCH}")
  pids=()
  for name in "${batch[@]}"; do
    publish_package "$name" >"$logs/${name##*/}.log" 2>&1 &
    pids+=("$!")
  done
  for index in "${!pids[@]}"; do
    wait "${pids[$index]}" || failed=1
    cat "$logs/${batch[$index]##*/}.log"
  done
done
((failed == 0)) || {
  echo "A native platform package failed to publish; dependents were not published. Re-run the failed jobs to resume: versions already on npm are skipped." >&2
  exit 1
}
for name in "${dependents[@]}"; do
  publish_package "$name"
done
