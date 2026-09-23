#!/usr/bin/env bash
# Reproducible, bounded trial build; this does not publish, optimize, or alter profiles.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

image_dir=.github/runner-images
[[ -f "$image_dir/Dockerfile" ]] || { echo "missing Dockerfile" >&2; exit 1; }
if grep -Eq '(^|[[:space:]])(COPY|ADD)[[:space:]]' "$image_dir/Dockerfile"; then
  echo 'runner image must not copy repository source or node_modules' >&2
  exit 1
fi
if grep -Eiq '(secret|token|password|npmrc|node_modules)' "$image_dir/Dockerfile"; then
  echo 'runner image definition contains a secret/dependency payload' >&2
  exit 1
fi

# Namespace performs the test build remotely and injects NAMESPACE_BASE_IMAGE_REF.
# Keep this bounded so a failed trial cannot consume an unbounded build allocation.
if command -v timeout >/dev/null 2>&1; then
  timeout --signal=TERM --kill-after=30s 1800s \
    nsc base-image build-github-image --os-label ubuntu-24.04 --platform linux/amd64 -f "$image_dir/Dockerfile"
else
  echo 'GNU timeout is required for the 30-minute build bound (install coreutils)' >&2
  exit 2
fi
