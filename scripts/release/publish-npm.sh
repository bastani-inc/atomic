#!/usr/bin/env bash
# Publish one release's npm payload; publish.yml's publish-npm job runs this.
#
# Usage: publish-npm.sh --payload-dir DIR --registry URL [--requires-registered NAME]... PACKAGE...
# Environment: VERSION (the release version) and NPM_TAG (`latest` or `next`).
#
# PACKAGE... is the whole payload in publication order. The native platform
# leaves (@bastani/atomic-natives-*) publish first, in parallel; every other
# package publishes after them, one at a time, in the order given. A failed leaf
# stops the run before any dependent publishes.
set -euo pipefail

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
  if npm view "$name@$VERSION" version --registry "$registry" >/dev/null 2>&1; then
    echo "$name@$VERSION already exists; skipping."
  else
    npm publish "${tarballs[$name]}" --provenance --access public --tag "$NPM_TAG" --registry "$registry"
  fi
}

platform_leaves=() dependents=()
for name in "${packages[@]}"; do
  if [[ "$name" == @bastani/atomic-natives-* ]]; then platform_leaves+=("$name"); else dependents+=("$name"); fi
done
logs=$(mktemp -d)
pids=()
for name in "${platform_leaves[@]}"; do
  publish_package "$name" >"$logs/${name##*/}.log" 2>&1 &
  pids+=("$!")
done
failed=0
for index in "${!pids[@]}"; do
  wait "${pids[$index]}" || failed=1
  cat "$logs/${platform_leaves[$index]##*/}.log"
done
((failed == 0)) || {
  echo "A native platform package failed to publish; dependents were not published." >&2
  exit 1
}
for name in "${dependents[@]}"; do
  publish_package "$name"
done
