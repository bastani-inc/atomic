#!/usr/bin/env bash
# runner-rerun.sh: after runner.sh, the stages its first pass got wrong (stores extracted to another path than
# machine A's, fastapi's archive missing .venv), then the warm-VM stages for Atomic on the same 4-vCPU shape.
set -u; source $(dirname $0)/common.sh
while pgrep -f "[h]arness/vm/runner.sh" > /dev/null; do sleep 20; done
harness/run-project.sh fastapi pack
for P in ripgrep fastapi; do
  R=$RP/runs/$P
  for rep in 1 2; do
    load "$P rerun rep$rep" | tee -a $R/summary.txt
    harness/run-project.sh $P runnerstores runnerfull
    mkdir -p $R/rerun$rep && for s in runnerstores runnerfull; do mv $R/$s-* $R/rerun$rep/ 2>/dev/null; done
  done
done
R=$RP/runs/atomic; load "atomic warm vm" | tee -a $R/summary.txt
harness/run-project.sh atomic cold warmstores reuse
REUSE_BACK=20 harness/run-project.sh atomic reuse
harness/run-project.sh atomic warmlocal
mkdir -p $R/warm && for s in cold warmstores warmlocal; do mv $R/$s-* $R/warm/ 2>/dev/null; done
