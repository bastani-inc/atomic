# Possible-stage scan benchmark (#4359)

Measures the static possible-stage scan that runs synchronously before every workflow launch. It scans every builtin workflow definition and the stage-prediction fixtures with the scanner of each given revision, copied out of git, and reports the median time per round.

```sh
bun run scripts/perf/possible-stages-scan/benchmark.ts --revisions base=<rev>,current=HEAD --rounds 25 --warmup 5
```

Options: `--revisions label=revision,...` (default `base=origin/main,current=HEAD`), `--rounds` (default 15), `--warmup` (default 3), `--out <file>` (all samples as JSON). Set `GIT_DIR` to read the revisions from another clone.

## What it measures

Each revision's `possible-stages.ts` and the one module it imports are written to a temporary directory laid out like `packages/workflows`, with `builtin` linked to this checkout's builtin definitions, so every revision resolves builtin references the same way. Each round scans every definition once per revision; revisions run interleaved, rotating which goes first, and the warm-up rounds are discarded. Before timing, the script checks that every revision returns the same `stages` and `warnings` for every definition.

## Results

A crabbox runner (Azure D16ads_v6: AMD EPYC 9V74, 16 vCPU), Linux 7.0, Bun 1.4.4, 14 definitions (10 builtin workflows and 4 prediction fixtures), 25 rounds after 5 warm-up rounds, 2026-11-05.

| variant | scanner sources measured | definitions with uncertainties | median ms/round | min | max | median ms/definition |
|---|---|---:|---:|---:|---:|---:|
| base | #4358's decision-service branch, before #4359 | — | 73.5 | 70.6 | 76.2 | 5.248 |
| eager candidate index | #4359 commit "show stage predictions in the run detail and prove them live" | 14 | 92.3 | 88.8 | 100.2 | 6.592 |
| lazy candidate index | #4359 commit "pin stage-prediction edges that survived mutation, and fix helper parameter positions" | 14 | 81.6 | 76.9 | 89.1 | 5.826 |

Every revision returned the same `stages` and `warnings` for every definition. Building the candidate index only for files with an uncertain call site cuts the scan time this change added from 18.8 ms to 8.1 ms per round (25.6% to 11.0% over the base). Every definition measured has at least one uncertain call site, so the remaining time is candidate extraction for those sites.
