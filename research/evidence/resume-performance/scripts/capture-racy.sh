#!/usr/bin/env bash
# capture-racy.sh <src-repo> : capture cost in a fresh clone (index as new as the files: racily clean entries)
# and again after `git status` has rewritten the index, which is what a user's own Git usually does.
set -u
SRC=$1; N=$(basename $SRC); D=${RP:-/fast/tmp/resume-perf}/racy/$N; rm -rf $D; mkdir -p $(dirname $D)
git clone -q --no-hardlinks $SRC $D
git -C $D remote set-url origin $(git -C $SRC remote get-url origin)
git -C $D fetch -q origin 2>/dev/null || true
echo "$N tracked=$(git -C $D ls-files | wc -l) fresh-clone:"; node ${RP:-/fast/tmp/resume-perf}/harness/capture-bench.mjs $D README.md 5 2>/dev/null
sleep 1.1; git -C $D status > /dev/null
echo "$N after git status:"; node ${RP:-/fast/tmp/resume-perf}/harness/capture-bench.mjs $D README.md 5 2>/dev/null
