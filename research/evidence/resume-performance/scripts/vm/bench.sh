#!/usr/bin/env bash
# bench.sh: the first round's stages on an idle VM, two repetitions, plus the worktree-reuse prototype.
set -u; source $(dirname $0)/common.sh
for P in ${PROJECTS:-ripgrep fastapi atomic}; do
  R=$RP/runs/$P
  for rep in 1 2; do
    if [ $rep = 1 ]; then harness/run-project.sh $P prepare machineA; fi
    load "$P rep$rep" | tee -a $R/summary.txt
    harness/run-project.sh $P cold warmstores reuse
    REUSE_BACK=20 harness/run-project.sh $P reuse
    harness/run-project.sh $P warmlocal
    mkdir -p $R/rep$rep && for s in cold warmstores warmlocal; do mv $R/$s-* $R/rep$rep/ 2>/dev/null; done
  done
done
