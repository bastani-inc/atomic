#!/usr/bin/env bash
# runner.sh: the ephemeral-runner stages on a 4-vCPU VM shaped like a GitHub-hosted runner, two repetitions.
# Needs CACHE_URL and CACHE_SAS (an Azure Blob container, the storage actions/cache uses).
set -u; source $(dirname $0)/common.sh
for P in ${PROJECTS:-ripgrep fastapi atomic}; do
  R=$RP/runs/$P
  harness/run-project.sh $P prepare machineA pack
  for rep in 1 2; do
    load "$P rep$rep" | tee -a $R/summary.txt
    harness/run-project.sh $P runnercold runnerstores runnerfull
    mkdir -p $R/rep$rep && for s in runnercold runnerstores runnerfull; do mv $R/$s-* $R/rep$rep/ 2>/dev/null; done
  done
done
