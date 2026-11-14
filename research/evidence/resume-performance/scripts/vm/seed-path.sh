#!/usr/bin/env bash
# seed-path.sh <project>: does seeded build output survive a fresh checkout, at the same path and at another one?
# A worktree at path X is built, its ignored directories are archived, and the worktree is deleted. Then a fresh
# checkout of the same commit is made at X again, and at a new path Y; the archive is extracted into each and the
# blueprint's maintenance runs on top, with the same package stores at the same path (like ~/.cargo on a runner).
# Seconds: extract + maintenance. Compare with "none": the fresh checkout without the archive.
set -u; source $(dirname $0)/common.sh
P=$1; R=$RP/runs/$P; HN=$RP/harness; E=$RP/seed/$P; rm -rf $E; mkdir -p $E
SRC=$RP/src/$P; HEAD=$(git -C $SRC rev-parse HEAD)
H=$E/home S=$E/stores; mkdir -p $H; source $HN/env.sh
maint() { python3 -c "
import yaml
d=yaml.safe_load(open('$HN/projects/$P.yaml'))
print('\n'.join(s['run'] for s in (d.get('initialize') or []) + (d.get('maintenance') or [])))"; }
now() { date +%s%3N; }
fresh() { git -C $SRC worktree remove --force $1 > /dev/null 2>&1; rm -rf $1; git -C $SRC worktree prune; git -C $SRC worktree add -q --detach $1 $HEAD; }
fresh $E/X; (cd $E/X && maint | BENCH_BUILD_CACHE= bash -e > $E/prebuild.log 2>&1)
DIRS=$(cd $E/X && git ls-files -z --others --ignored --exclude-standard --directory | python3 -c '
import sys
ds = sorted(p[:-1] for p in sys.stdin.read().split("\0") if p.endswith("/") and not p.startswith(".atomic/"))
print(" ".join(d for d in ds if not any(d.startswith(o + "/") for o in ds if o != d)))')
(cd $E/X && tar -I 'zstd -T0 -3' -cf $E/build.tar.zst $DIRS)
echo "$P dirs: $DIRS archive=$(stat -c %s $E/build.tar.zst)" | tee $E/result.txt
for mode in none same other; do
  case $mode in none|other) T=$E/Y ;; same) T=$E/X ;; esac
  fresh $T; sleep 1
  s=$(now); [ $mode != none ] && (cd $T && tar -I zstd -xf $E/build.tar.zst); x=$(now)
  (cd $T && maint | BENCH_BUILD_CACHE= bash -e > $E/$mode.log 2>&1); rc=$?; m=$(now)
  echo "$P $mode extract_ms=$((x-s)) maintenance_ms=$((m-x)) exit=$rc" | tee -a $E/result.txt
  git -C $SRC worktree remove --force $T > /dev/null 2>&1; rm -rf $T
done
git -C $SRC worktree prune
