#!/usr/bin/env bash
# Stage the release's draft GitHub Release; publish.yml's stage-github-release job runs this.
#
# Usage: stage-github-release.sh TAG ASSET_DIR
# ASSET_DIR holds the eight release archives and RELEASE_NOTES.md. The script
# writes SHA256SUMS beside them, replaces an earlier draft for TAG, creates the
# draft with every asset, and verifies the uploaded asset set. It refuses to
# touch a release that is already published.
#
# Transient GitHub API failures are retried. A draft this script could not
# complete is deleted, so a failed staging never leaves a partial draft; once
# staging succeeds, nothing in the workflow deletes the draft again.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/release/lib.sh
source "$script_dir/lib.sh"

[[ $# -eq 2 ]] || {
  echo "Usage: stage-github-release.sh TAG ASSET_DIR" >&2
  exit 2
}
tag=$1
cd "$2"

sha256sum atomic-*.tar.gz atomic-*.zip >SHA256SUMS
# Assigned first so that a release state GitHub could not report stops the script.
state=$(release_state "$tag")
case $state in
published)
  echo "GitHub Release $tag is already published. Refusing to mutate a public release." >&2
  exit 1
  ;;
draft) gh_retry release delete "$tag" --yes ;;
esac

# Best effort: when GitHub cannot say whether a draft exists, leave it to the
# next attempt or re-run, which replaces any draft it finds.
delete_incomplete_draft() {
  local current
  current=$(release_state "$tag") || return 0
  if [[ "$current" == draft ]]; then
    echo "Deleting the incomplete draft GitHub Release $tag." >&2
    gh_retry release delete "$tag" --yes
  fi
}

assets=(atomic-darwin-arm64.tar.gz atomic-darwin-x64.tar.gz atomic-linux-x64.tar.gz atomic-linux-arm64.tar.gz atomic-linux-x64-musl.tar.gz atomic-linux-arm64-musl.tar.gz atomic-windows-x64.zip atomic-windows-arm64.zip SHA256SUMS)
for ((attempt = 1; ; attempt++)); do
  err=$(mktemp)
  if gh release create "$tag" --verify-tag --draft --title "$tag" --notes-file RELEASE_NOTES.md "${assets[@]}" 2>"$err"; then
    rm -f "$err"
    break
  else
    status=$?
  fi
  cat "$err" >&2
  delete_incomplete_draft
  if ((attempt >= GH_ATTEMPTS)) || ! gh_error_is_transient "$err"; then
    rm -f "$err"
    exit "$status"
  fi
  rm -f "$err"
  delay=$(retry_delay "$attempt" "$GH_RETRY_BASE_SECONDS")
  echo "::warning::Creating the draft GitHub Release $tag failed transiently (attempt $attempt of $GH_ATTEMPTS); retrying in ${delay}s."
  sleep "$delay"
done

expected=$(printf '%s\n' "${assets[@]}" | sort)
actual=$(gh_retry release view "$tag" --json assets --jq '.assets[].name' | sort)
[[ "$actual" == "$expected" ]] || {
  echo "Draft release asset set mismatch" >&2
  delete_incomplete_draft
  exit 1
}
