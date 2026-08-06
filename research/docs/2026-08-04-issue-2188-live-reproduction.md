# Issue #2188 live reproduction during spec research (2026-08-04)

While gathering research for issue #2188 in this very session, the reported failure mode
reproduced on all three research subagents launched as one parallel fan-out (parent run
`ac0bbf74`, three children, agents `codebase-analyzer` ×2 and `codebase-online-researcher`).

## What happened

| Child | Task | Outcome |
| --- | --- | --- |
| run-0 `codebase-analyzer` | subagents process-spawn runtime analysis | idle-killed at 300 000 ms ("Subagent model attempt timed out after 300000ms without child activity."), revived as run `3fb5bf49`, completed |
| run-1 `codebase-analyzer` | workflows in-process runtime analysis | finished its analysis, then idle-killed **while composing its final answer**; revived as run `86146133`, completed |
| run-2 `codebase-online-researcher` | Codex subagent design research | idle-killed at 300 000 ms, revived as run `b9169aa8`, completed |

100 % of the fan-out was idle-killed exactly once. Every child had done substantial paid
work before the kill (tens of tool calls, large cache reads). Each was revived from its
saved session file and completed on the second attempt.

## Secondary signal: false-positive attention nudges

Both revived runs (`3fb5bf49`, `b9169aa8`) triggered "needs attention (no observed
activity for 60s)" advisories while running `gpt-5.6-luna · thinking max` — long
reasoning/final-write stretches with no tool calls. The activity tracker
(`needsAttentionAfterMs = 60_000` in `packages/subagents/src/runs/shared/subagent-control.ts`)
is byte/tool driven, same blind spot as the kill-capable watchdog
(`packages/subagents/src/runs/shared/attempt-watchdog.ts`): model streaming/thinking is
not counted as liveness.

## Why the second attempts survived

The revived children were instructed to begin emitting their final markdown immediately.
A long single generation still risks the 300 s idle window; two of three landed within it.
The workflows analyzer (run-1) was killed precisely because a several-minute final
composition produces no stdout events between deltas when the provider does not stream
reasoning.

## Relevance to the spec

- Confirms the issue's core claim: silence-based watchdogs kill productive children whose
  quiet periods are provider-side thinking or long generations, not hangs.
- Confirms the failure hits the *most valuable* children hardest: the ones with the most
  accumulated context (and sunk cost) do the longest quiet finals.
- The retry-classification loop (`timed out` → retryable) restarts the attempt on a
  fallback candidate from scratch, multiplying spend; manual revival from the session file
  was the only way to preserve the sunk work.
