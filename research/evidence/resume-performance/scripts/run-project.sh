#!/usr/bin/env bash
# Usage: run-project.sh <project> <stage...>
# Stages of the first round: prepare machineA cold warmstores warmlocal
# Stages of the second round (Azure VMs, research/evidence/resume-performance/vm.md):
#   pack          after machineA: tar machine A's package stores, its extension cache and its worktree's ignored
#                 directories with zstd and upload them to $CACHE_URL/<project>-*.tar.zst?$CACHE_SAS (the trusted
#                 prebuild of an actions/cache flow)
#   runnercold    a new runner: new HOME, empty stores, NO extension transpile cache, page cache dropped
#   runnerstores  runnercold + package stores and extension cache downloaded and extracted first (timed separately)
#   runnerfull    runnerstores + the worktree's build output, extracted by the blueprint's first maintenance step
#   reuse         worktree reuse prototype: the worktree warmstores restored, its tracked files reset to the
#                 snapshot (and, with REUSE_BACK=<n>, to a commit n commits older first), then maintenance on top
set -u
P=$1; shift
RP=${RP:-/fast/tmp/resume-perf}; HN=$RP/harness; R=$RP/runs/$P
JITI=$RP/smoke/homeA/.atomic/agent/cache
mkdir -p $R
seed_home() { mkdir -p $1/.atomic/agent; [ -d $1/.atomic/agent/cache ] || cp -a $JITI $1/.atomic/agent/cache; }
maint_cmds() { python3 - "$HN/projects/$P.yaml" "${1:-initialize maintenance}" <<'PY'
import sys,yaml
d=yaml.safe_load(open(sys.argv[1]))
for sec in sys.argv[2].split():
  for s in d.get(sec) or []: print(s["run"])
PY
}
now() { date +%s%3N; }
drop_caches() { sync; echo 3 | sudo -n tee /proc/sys/vm/drop_caches > /dev/null 2>&1 || true; }
session_id() { node $HN/q.mjs $R/homeA/.atomic/workflows/journal.sqlite "select id from session_sessions where cwd='$R/work' order by created_at desc limit 1" | python3 -c 'import sys,json;print(json.loads(sys.stdin.readline())["id"])'; }
fetch_cache() { # fetch_cache <name> <dest dir>: download + extract one archive, prints bytes
  local f=$R/dl-$1.tar.zst; rm -f $f
  curl -fsS -o $f "$CACHE_URL/$P-$1.tar.zst?$CACHE_SAS" && mkdir -p $2 && tar -I zstd -xf $f -C $2 && stat -c %s $f; rm -f $f; }
resume_once() { # resume_once <stage> <home> : one timed resume, as in the first round
  ( source $HN/env.sh; cd $2
    export GIT_TRACE2_EVENT=$R/$1-trace2.json; rm -f $GIT_TRACE2_EVENT
    s=$(now)
    ATOMIC_TIMING=1 $ATOMIC_CLI --session $SID -p "CONTINUE-$P-$1" < /dev/null > $R/$1-session.log 2>&1
    e=$(now)
    req=$(grep "CONTINUE-$P-$1" $RP/mock-requests.jsonl | tail -1 | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["t"])')
    echo "$1 start=$s firstRequest=$req end=$e ttfp_ms=$(( req-s ))${EXTRA:+ $EXTRA}" | tee -a $R/summary.txt
    stat -c "%n %.3W %.3Y" $2/.atomic/agent/worktree-snapshots/blueprint-logs/* > $R/$1-blueprint-times.txt 2>/dev/null; rm -rf $R/$1-blueprint-logs; cp -a $2/.atomic/agent/worktree-snapshots/blueprint-logs $R/$1-blueprint-logs 2>/dev/null
    ls -d $2/.atomic/agent/worktree-snapshots/worktrees/* > $R/$1-worktrees.txt ) ; }
new_home() { rm -rf $1; mkdir -p $1/.atomic/workflows; cp $R/homeA/.atomic/workflows/journal.sqlite $1/.atomic/workflows/; }
for stage in "$@"; do
case $stage in
prepare)
  rm -rf $R/work $R/work.away && cp -a --reflink=auto $RP/src/$P $R/work
  mkdir -p $R/work/.atomic && cp $HN/projects/$P.yaml $R/work/.atomic/blueprint.yaml ;;
machineA)
  ( H=$R/homeA S=$R/stores-A; seed_home $H; source $HN/env.sh; cd $R/work
    s=$(now); maint_cmds | bash -e > $R/machineA-install.log 2>&1; echo "machineA install exit=$? ms=$(( $(now)-s ))" | tee -a $R/summary.txt
    export GIT_TRACE2_EVENT=$R/machineA-trace2.json; rm -f $GIT_TRACE2_EVENT
    s=$(now); $ATOMIC_CLI -p "SETUP:echo '<!-- resume-perf -->' >> README.md && echo note > RESUME_NOTE.md" < /dev/null > $R/machineA-session.log 2>&1
    echo "machineA session start=$s end=$(now)" | tee -a $R/summary.txt
    unset GIT_TRACE2_EVENT
    s=$(now); $ATOMIC_CLI -p "hello" --no-session < /dev/null > /dev/null 2>&1; echo "baseline no-session -p ms=$(( $(now)-s ))" | tee -a $R/summary.txt )
  echo "session $(session_id)" | tee -a $R/summary.txt
  [ -d $R/work ] && mv $R/work $R/work.away ;;
pack)
  W=$R/work.away; [ -d $W ] || W=$R/work
  # the outermost ignored directories (a tool's own `.gitignore` of `*`, as in `.venv`, makes Git list inner ones too)
  DIRS=$(cd $W && git ls-files -z --others --ignored --exclude-standard --directory | python3 -c '
import sys
ds = sorted(p[:-1] for p in sys.stdin.read().split("\0") if p.endswith("/") and not p.startswith(".atomic/"))
top = [d for d in ds if not any(d.startswith(o + "/") for o in ds if o != d)]
print(" ".join(top))')
  for spec in "stores:$R/stores-A:." "jiti:$R/homeA/.atomic/agent/cache:." "build:$W:$DIRS"; do
    IFS=: read -r name dir paths <<< "$spec"  # DIRS is one line, space-separated
    s=$(now); (cd $dir && tar -I 'zstd -T0 -3' -cf $R/$P-$name.tar.zst $paths); c=$(now)
    curl -fsS -X PUT -H "x-ms-blob-type: BlockBlob" -T $R/$P-$name.tar.zst "$CACHE_URL/$P-$name.tar.zst?$CACHE_SAS"; u=$(now)
    echo "pack $name bytes=$(stat -c %s $R/$P-$name.tar.zst) tar_ms=$((c-s)) upload_ms=$((u-c)) paths=$paths" | tee -a $R/summary.txt
    rm -f $R/$P-$name.tar.zst
  done ;;
runnercold|runnerstores|runnerfull)
  # The stores go back to machine A's path, as ~/.cargo, ~/.npm and ~/.cache/uv sit at one path on every runner:
  # cargo fingerprints hold absolute paths, so a registry at another path rebuilds every crate.
  SID=$(session_id); H=$R/home-$stage; S=$R/stores-A; rm -rf $S $R/buildcache; new_home $H
  drop_caches
  s=$(now); EXTRA=""
  if [ $stage != runnercold ]; then
    b1=$(fetch_cache stores $S); b2=$(fetch_cache jiti $H/.atomic/agent/cache)
    EXTRA="stores_bytes=$b1 jiti_bytes=$b2"
  fi
  if [ $stage = runnerfull ]; then # the blueprint's first maintenance step extracts it into the restored worktree
    mkdir -p $R/buildcache; curl -fsS -o $R/buildcache/build.tar.zst "$CACHE_URL/$P-build.tar.zst?$CACHE_SAS"
    EXTRA="$EXTRA build_bytes=$(stat -c %s $R/buildcache/build.tar.zst)"; export BENCH_BUILD_CACHE=$R/buildcache/build.tar.zst
  else unset BENCH_BUILD_CACHE; fi
  EXTRA="$EXTRA cache_download_ms=$(( $(now)-s ))"
  export EXTRA; resume_once $stage $H ;;
cold|warmstores|warmlocal)
  SID=$(session_id)
  case $stage in
    cold) H=$R/homeB; S=$R/stores-B; rm -rf $H $S ;;
    warmstores) H=$R/homeC; S=$R/stores-B; rm -rf $H ;;
    warmlocal) H=$R/homeC; S=$R/stores-B
       for w in $H/.atomic/agent/worktree-snapshots/worktrees/*; do rm -rf "$w"; done ;;
  esac
  [ -f $H/.atomic/workflows/journal.sqlite ] || new_home $H
  seed_home $H
  unset BENCH_BUILD_CACHE; EXTRA=""; resume_once $stage $H ;;
reuse)
  # The worktree warmstores restored (warmlocal deletes it, so run reuse before warmlocal or after a fresh warmstores).
  W=$(head -1 $R/warmstores-worktrees.txt); H=$R/homeC S=$R/stores-B
  ( source $HN/env.sh; cd $W
    TREE=$(git write-tree 2>/dev/null; true); SNAP=$(git rev-parse HEAD)
    target=$SNAP; [ -n "${REUSE_BACK:-}" ] && target=$(git rev-parse HEAD~$REUSE_BACK)
    # what reuse does to the tracked files: move HEAD, reset the index and files, keep ignored directories
    s=$(now); git checkout -q --detach $target && git reset -q --hard && git clean -qfd -e .atomic; r=$(now)
    maint_cmds maintenance | BENCH_BUILD_CACHE= bash -e > $R/reuse${REUSE_BACK:+-back$REUSE_BACK}-maint.log 2>&1; rc=$?; m=$(now)
    echo "reuse${REUSE_BACK:+ back=$REUSE_BACK} reset_ms=$((r-s)) maintenance_ms=$((m-r)) exit=$rc" | tee -a $R/summary.txt
    git checkout -q --detach $SNAP && git reset -q --hard ) ;;
esac
done
