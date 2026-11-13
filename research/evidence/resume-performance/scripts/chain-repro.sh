#!/usr/bin/env bash
# chain-repro.sh <project>: resume on machine B (already done by run-project.sh cold), work one more turn there,
# then resume on a third "machine" D while B's restored worktree is out of the way. Filed as #4732.
set -u
P=$1; RP=/fast/tmp/resume-perf; R=$RP/runs/$P; SID=$(grep "^session" $R/summary.txt | awk '{print $2}')
( H=$R/homeB S=$R/stores-B; source $RP/harness/env.sh; cd $H && $ATOMIC_CLI --session $SID -p "SETUP:echo second-machine >> README.md" < /dev/null )
node $RP/harness/capture-once.mjs "$(head -1 $R/cold-worktrees.txt)"   # remotes [] and history treated as unpushed
mv $R/homeB/.atomic/agent/worktree-snapshots/worktrees $R/homeB/.atomic/agent/worktree-snapshots/worktrees.moved
rm -rf $R/homeD; mkdir -p $R/homeD/.atomic/workflows $R/homeD/.atomic/agent
cp $R/homeB/.atomic/workflows/journal.sqlite $R/homeD/.atomic/workflows/
cp $R/homeA/.atomic/agent/*.json $R/homeD/.atomic/agent/; cp -a $R/homeA/.atomic/agent/cache $R/homeD/.atomic/agent/
( H=$R/homeD S=$R/stores-B; source $RP/harness/env.sh; cd $H && $ATOMIC_CLI --session $SID -p "CONTINUE-third" < /dev/null )
mv $R/homeB/.atomic/agent/worktree-snapshots/worktrees.moved $R/homeB/.atomic/agent/worktree-snapshots/worktrees
