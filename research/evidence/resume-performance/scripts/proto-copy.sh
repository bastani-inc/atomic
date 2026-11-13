#!/usr/bin/env bash
# proto-copy.sh <project> : prototype of dependency-directory materialization outside Atomic.
# Source = the worktree the cold resume restored and built (dependencies installed).
# For each method, make a fresh detached worktree of the same commit (like a restore), copy the
# ignored dependency directories in with that method, then run the blueprint maintenance on top.
set -u
P=$1; RP=/fast/tmp/resume-perf; HN=$RP/harness; R=$RP/runs/$P
SRC=$(cat $R/cold-worktrees.txt | head -1)
H=$R/homeB S=$R/stores-B; source $HN/env.sh
STORE=$(git -C $SRC rev-parse --git-common-dir)
HEAD=$(git -C $SRC rev-parse HEAD)
DIRS=$(cd $SRC && git ls-files -z --others --ignored --exclude-standard --directory | tr '\0' '\n' | grep '/$' | sed 's#/$##')
echo "dependency dirs: $(echo $DIRS | tr '\n' ' ')" | tee $R/proto.txt
echo "size: $(cd $SRC && du -sh --apparent-size $DIRS 2>/dev/null | awk '{s=s" "$2"="$1} END{print s}')" | tee -a $R/proto.txt
echo "files: $(cd $SRC && find $DIRS 2>/dev/null | wc -l)" | tee -a $R/proto.txt
maint() { python3 -c "
import yaml,sys
d=yaml.safe_load(open('$HN/projects/$P.yaml'))
print('\n'.join(s['run'] for s in d.get('maintenance') or []))"; }
for method in none cp reflink hardlink; do
  T=$R/proto-$method; git --git-dir=$STORE worktree remove --force $T >/dev/null 2>&1; rm -rf $T
  git --git-dir=$STORE worktree add -q --detach $T $HEAD
  # bring the snapshot's working-tree edits along, like a restore does
  (cd $SRC && git diff HEAD --binary) | (cd $T && git apply --allow-empty 2>/dev/null); cp -a $SRC/.atomic $T/ 2>/dev/null
  s=$(date +%s%3N)
  for d in $DIRS; do
    mkdir -p $T/$(dirname $d)
    case $method in
      none) ;;
      cp) cp -a --reflink=never $SRC/$d $T/$d ;;
      reflink) cp -a --reflink=always $SRC/$d $T/$d ;;
      hardlink) cp -al $SRC/$d $T/$d ;;
    esac
  done
  c=$(date +%s%3N)
  (cd $T && maint | bash -e > $R/proto-$method-maint.log 2>&1); rc=$?
  e=$(date +%s%3N)
  echo "$method copy_ms=$((c-s)) maintenance_ms=$((e-c)) total_ms=$((e-s)) exit=$rc" | tee -a $R/proto.txt
done
