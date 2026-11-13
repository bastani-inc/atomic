#!/usr/bin/env bash
# fetch-bench.sh <name> <url> <sha> : fetch + checkout of one commit into a fresh bare store, by strategy.
set -u
N=$1 URL=$2 SHA=$3; B=/fast/tmp/resume-perf/fetch-bench/$N; rm -rf $B; mkdir -p $B
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1
now() { date +%s%3N; }
run() { # strategy, setup-args...
  local S=$1; shift; local G=$B/$S.git W=$B/$S-wt
  git init -q --bare $G
  local t0=$(now)
  case $S in
    full) git --git-dir=$G fetch -q --no-tags -- $URL $SHA ;;
    blobless) git --git-dir=$G remote add origin $URL; git --git-dir=$G config remote.origin.promisor true
              git --git-dir=$G config remote.origin.partialclonefilter blob:none
              git --git-dir=$G fetch -q --no-tags --filter=blob:none origin $SHA ;;
    treeless) git --git-dir=$G remote add origin $URL; git --git-dir=$G config remote.origin.promisor true
              git --git-dir=$G config remote.origin.partialclonefilter tree:0
              git --git-dir=$G fetch -q --no-tags --filter=tree:0 origin $SHA ;;
    shallow) git --git-dir=$G fetch -q --no-tags --depth=1 -- $URL $SHA ;;
  esac
  local t1=$(now)
  git --git-dir=$G worktree add -q --detach $W $SHA 2>/dev/null
  local t2=$(now)
  echo "$N $S fetch_ms=$((t1-t0)) checkout_ms=$((t2-t1)) total_ms=$((t2-t0)) store=$(du -sm $G | cut -f1)MB"
}
for s in full blobless treeless shallow; do run $s; done
