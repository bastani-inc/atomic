#!/usr/bin/env bash
# Stage the release's draft GitHub Release; publish.yml's stage-github-release job runs this.
#
# Usage: stage-github-release.sh TAG ASSET_DIR
# ASSET_DIR holds the eight release archives and RELEASE_NOTES.md. The script
# writes SHA256SUMS beside them, replaces an earlier draft for TAG, creates the
# draft with every asset, and verifies the uploaded asset set. It refuses to
# touch a release that is already published.
set -euo pipefail

[[ $# -eq 2 ]] || {
  echo "Usage: stage-github-release.sh TAG ASSET_DIR" >&2
  exit 2
}
tag=$1
cd "$2"

sha256sum atomic-*.tar.gz atomic-*.zip >SHA256SUMS
existing=$(gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null || true)
[[ "$existing" != false ]] || {
  echo "GitHub Release $tag is already published. Refusing to mutate a public release." >&2
  exit 1
}
[[ "$existing" != true ]] || gh release delete "$tag" --yes
assets=(atomic-darwin-arm64.tar.gz atomic-darwin-x64.tar.gz atomic-linux-x64.tar.gz atomic-linux-arm64.tar.gz atomic-linux-x64-musl.tar.gz atomic-linux-arm64-musl.tar.gz atomic-windows-x64.zip atomic-windows-arm64.zip SHA256SUMS)
gh release create "$tag" --verify-tag --draft --title "$tag" --notes-file RELEASE_NOTES.md "${assets[@]}"
expected=$(printf '%s\n' "${assets[@]}" | sort)
actual=$(gh release view "$tag" --json assets --jq '.assets[].name' | sort)
[[ "$actual" == "$expected" ]] || {
  echo "Draft release asset set mismatch" >&2
  exit 1
}
