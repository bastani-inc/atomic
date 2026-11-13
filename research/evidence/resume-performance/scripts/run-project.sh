#!/usr/bin/env bash
# Usage: run-project.sh <project> <stage...>; stages: prepare machineA cold warmstores warmlocal
set -u
P=$1; shift
RP=/fast/tmp/resume-perf; HN=$RP/harness; R=$RP/runs/$P
JITI=$RP/smoke/homeA/.atomic/agent/cache
mkdir -p $R
seed_home() { mkdir -p $1/.atomic/agent; [ -d $1/.atomic/agent/cache ] || cp -a $JITI $1/.atomic/agent/cache; }
maint_cmds() { python3 - "$HN/projects/$P.yaml" <<'PY'
import sys,yaml
d=yaml.safe_load(open(sys.argv[1]))
for sec in ("initialize","maintenance"):
  for s in d.get(sec) or []: print(s["run"])
PY
}
session_id() { node $HN/q.mjs $R/homeA/.atomic/workflows/journal.sqlite "select id from session_sessions where cwd='$R/work' order by created_at desc limit 1" | python3 -c 'import sys,json;print(json.loads(sys.stdin.readline())["id"])'; }
for stage in "$@"; do
case $stage in
prepare)
  rm -rf $R/work $R/work.away && cp -a --reflink=always $RP/src/$P $R/work
  mkdir -p $R/work/.atomic && cp $HN/projects/$P.yaml $R/work/.atomic/blueprint.yaml ;;
machineA)
  ( H=$R/homeA S=$R/stores-A; seed_home $H; source $HN/env.sh; cd $R/work
    s=$(date +%s%3N); maint_cmds | bash -e > $R/machineA-install.log 2>&1; echo "machineA install exit=$? ms=$(( $(date +%s%3N)-s ))" | tee -a $R/summary.txt
    export GIT_TRACE2_EVENT=$R/machineA-trace2.json; rm -f $GIT_TRACE2_EVENT
    s=$(date +%s%3N); $ATOMIC_CLI -p "SETUP:echo '<!-- resume-perf -->' >> README.md && echo note > RESUME_NOTE.md" < /dev/null > $R/machineA-session.log 2>&1
    echo "machineA session start=$s end=$(date +%s%3N)" | tee -a $R/summary.txt
    unset GIT_TRACE2_EVENT
    s=$(date +%s%3N); $ATOMIC_CLI -p "hello" --no-session < /dev/null > /dev/null 2>&1; echo "baseline no-session -p ms=$(( $(date +%s%3N)-s ))" | tee -a $R/summary.txt )
  echo "session $(session_id)" | tee -a $R/summary.txt
  [ -d $R/work ] && mv $R/work $R/work.away ;;
cold|warmstores|warmlocal)
  SID=$(session_id)
  case $stage in
    cold) H=$R/homeB; S=$R/stores-B; rm -rf $H $S ;;
    warmstores) H=$R/homeC; S=$R/stores-B; rm -rf $H ;;
    warmlocal) H=$R/homeC; S=$R/stores-B
       for w in $H/.atomic/agent/worktree-snapshots/worktrees/*; do rm -rf "$w"; done ;;
  esac
  if [ ! -f $H/.atomic/workflows/journal.sqlite ]; then mkdir -p $H/.atomic/workflows; cp $R/homeA/.atomic/workflows/journal.sqlite $H/.atomic/workflows/; fi
  seed_home $H
  ( source $HN/env.sh; cd $H
    export GIT_TRACE2_EVENT=$R/$stage-trace2.json; rm -f $GIT_TRACE2_EVENT
    s=$(date +%s%3N)
    ATOMIC_TIMING=1 $ATOMIC_CLI --session $SID -p "CONTINUE-$P-$stage" < /dev/null > $R/$stage-session.log 2>&1
    e=$(date +%s%3N)
    req=$(grep "CONTINUE-$P-$stage" $RP/mock-requests.jsonl | tail -1 | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["t"])')
    echo "$stage start=$s firstRequest=$req end=$e ttfp_ms=$(( req-s ))" | tee -a $R/summary.txt
    stat -c "%n %.3W %.3Y" $H/.atomic/agent/worktree-snapshots/blueprint-logs/* > $R/$stage-blueprint-times.txt 2>/dev/null; rm -rf $R/$stage-blueprint-logs; cp -a $H/.atomic/agent/worktree-snapshots/blueprint-logs $R/$stage-blueprint-logs 2>/dev/null
    ls -d $H/.atomic/agent/worktree-snapshots/worktrees/* > $R/$stage-worktrees.txt ) ;;
esac
done
