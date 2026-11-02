#!/usr/bin/env bash
# Publish the staged draft GitHub Release after npm succeeded; publish.yml's
# publish-github-release job runs this.
#
# Usage: publish-github-release.sh TAG
# A stable tag becomes the latest release; an `-alpha.N` tag becomes a
# prerelease that is never marked latest. Transient GitHub API failures are
# retried, and a release an earlier attempt already published is left as it is,
# so re-running this job after any failure is safe.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/release/lib.sh
source "$script_dir/lib.sh"

[[ $# -eq 1 ]] || {
  echo "Usage: publish-github-release.sh TAG" >&2
  exit 2
}
tag=$1
prerelease=false
[[ "$tag" != *-* ]] || prerelease=true
latest=true
[[ "$prerelease" == false ]] || latest=false

# Assigned first so that a release state GitHub could not report stops the script.
state=$(release_state "$tag")
case $state in
draft) ;;
published)
  echo "GitHub Release $tag is already published; an earlier attempt of this job published it."
  exit 0
  ;;
missing)
  echo "Draft GitHub Release $tag does not exist, so there is nothing to publish. Finish the release with a full run at the tag, which stages the draft again and skips every npm version that already exists: gh workflow run publish.yml --ref $tag -f tag=$tag" >&2
  exit 1
  ;;
esac
gh_retry release edit "$tag" --draft=false --prerelease="$prerelease" --latest="$latest"
