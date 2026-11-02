#!/usr/bin/env bash
# Publish the staged draft GitHub Release after npm succeeded; publish.yml's
# publish-github-release job runs this.
#
# Usage: publish-github-release.sh TAG
# A stable tag becomes the latest release; an `-alpha.N` tag becomes a
# prerelease that is never marked latest.
set -euo pipefail

[[ $# -eq 1 ]] || {
  echo "Usage: publish-github-release.sh TAG" >&2
  exit 2
}
tag=$1
prerelease=false
[[ "$tag" != *-* ]] || prerelease=true
latest=true
[[ "$prerelease" == false ]] || latest=false

existing=$(gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null || true)
[[ "$existing" == true ]] || {
  echo "Draft GitHub Release $tag does not exist." >&2
  exit 1
}
gh release edit "$tag" --draft=false --prerelease="$prerelease" --latest="$latest"
