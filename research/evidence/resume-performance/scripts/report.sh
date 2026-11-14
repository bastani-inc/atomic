#!/usr/bin/env bash
# report.sh <project> <stage>: phase JSON for the latest run of that stage
RP=${RP:-/fast/tmp/resume-perf}; R=$RP/runs/$1; L=$(grep "^$2 " $R/summary.txt | tail -1)
s=$(echo $L | sed 's/.*start=\([0-9]*\).*/\1/'); f=$(echo $L | sed 's/.*firstRequest=\([0-9]*\).*/\1/')
python3 $RP/harness/analyze.py $R/$2-trace2.json --start $s --first-request $f --blueprint-times $R/$2-blueprint-times.txt
