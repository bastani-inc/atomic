# PR #1844 real interactive E2E and cache benchmark

Status: **benchmark complete; evidence approved**. Product, tests, and docs were not edited by this benchmark worker. Nothing was committed, pushed, or posted to the PR. The recorded final evidence approval is `APPROVED — final tmux/cache evidence review`.

## Attribution and preflight

- Run root: `.atomic/evidence/pr-1844-20260717/`
- Git HEAD: `01490d715ad136be47eee124b54f24c7a697c179`
- Final dirty diff hash: `b154719ec8608e1c6b439938b0afbd47d12343a0ddabcbae796503a62f75ed83`
- Final dirty-path-list hash: `eb23f9b3546dcd43a6223b7df67cd75f31cbee8c1ca13bbfdee8db77f0b66a39`
- Compiled CLI hash: `222f4d1a9493043055bbca61d4f1e183a79f19741c8af56694d3cab7e4cd245e`
- Bun `1.3.14`; tmux `3.7b`
- Real model: `openai-codex/gpt-5.6-sol:off`; listed provider window `372000`
- Final corrected build passed. Final bounded real smoke exited successfully with exact `AUTH_OK`.

The run preserves two resolved preflight failures: an initial TS1294 build failure and an initial provider rejection of an unsupported explicit cache-breakpoint field. After independent product fixes and rebuilds, the exact smoke passed and the scenarios used the final compiled CLI above.

## Scenario A — near-boundary large tool result

A run-specific extension generated 9,000 deterministic numbered lines (503,999 characters) in memory from short arguments. Its TUI renderer displayed only the line count, character count, and hash. Calibration measured 283,100 normalized real-provider tokens. A fresh session used local window `262130`, yielding `107.999847%` while remaining below the real 372,000 provider cap.

The real-provider automatic compaction succeeded as `full-collapse`, prompt version 4, planned rung. It deleted 2 of 292 capped planning-view lines and reduced estimated planning tokens from 126,621 to 4,033 (96.8%). The low planning line count is expected: the temporary planner view caps oversized tool output, while durable storage does not. No Scenario A failure diagnostic exists.

The session and its pre-boundary backup each retain the full 503,999-character tool result with identical hash `81eb940995a647f577e03ca3b6e59fd7078290e1c573c822a5707a9a74c715d3`. Each has one tool call, one matching result, and zero unmatched pairs. The follow-up returned exact `CONTINUATION_OK pr1844-functional`. See `functional-pane.txt`, `results.json`, and `a-integrity.json`.

## Scenario B — native Codex cache benchmark

Each retained pair used 8 deterministic alternating user/assistant pairs with 40 physical lines per message, then a small real normal request. Real pre-compaction usage was 22,567–22,568 tokens and the prepared region had 659 lines. The exact pre-compaction journal was copied, with only the header identifier changed, into a key-isolated cold process. Body hashes match for all three pairs.

Warm `/compact` ran in the process that made the normal request and retained its captured provider prefix. Cold `/compact` reopened the paired history without an active snapshot and therefore used isolated planning. The public Bun analyzer parses each private event log and computes `elapsed_ns = session_compact_ns - before_compact_ns`; all three nanosecond scalars are retained per row in `samples.csv`.

- Warm samples: 8,072.885 ms, 8,648.739 ms, 7,012.364 ms; median 8,072.885 ms.
- Cold samples: 22,430.960 ms, 24,998.884 ms, 24,775.392 ms; median 24,775.392 ms.
- Median delta: 16,702.507 ms; warm/cold ratio 0.32584; median reduction 67.42%.
- Every warm sample reported provider-native cache read 22,272, write 0, hit true.
- Isolated cold results omitted cache telemetry by design; absence is not rewritten as zero.

Honest conclusion: this run shows a clear warm benefit—every retained warm measurement is faster than every cold measurement, with authoritative nonzero native Codex cache reads. It does not claim universal latency; provider variance and planner-output variance remain real.

## Failures and variance

Early cache sample 1 used string-form seeded user content and fell back isolated; it is excluded rather than relabeled. Warm samples 2, 3, and 4 produced malformed non-`KEEP` planner output and private diagnostics. Sample `2r` was the one fresh paired retry. Samples 5 and 6 reused the same declared deterministic workload and exact small prompt as successful `2r`. All failures remain local under `raw/`.

No fabricated video was created; terminal tmux evidence is the applicable artifact.

## Product validation and approvals

`validation.json` records the exact final-tree commands and safe outcomes: focused 98, unit 3,686, integration 250, total 4,034; typecheck, lint, 2,209-file length gate, build, 32-page docs check, shrinkwrap, diff check, 12 hooks, and issues-file absence all passed. Fresh independent product reviews approved **final overflow/session/tool** and **final exact-once prompt-cache**. The repaired bundle received the exact final approval `APPROVED — final tmux/cache evidence review`.

## Evidence layout and rerun

The repaired public bundle contains exactly 17 files: 10 top-level public files and 7 files under `harness/`.

- `results.json` — safe scalar outcomes; Scenario B cross-references its generated summary.
- `benchmark-summary.json` — statistics deterministically derived from private event boundaries.
- `samples.csv` — all six retained measurements with both event timestamps and elapsed nanoseconds.
- `validation.json` — final-tree product validation and approval context.
- `functional-pane.txt` — recent sanitized Scenario A pane excerpt.
- `a-integrity.json` — durable hash/length, tool-pair, continuation, and paired-history checks.
- `raw-artifacts.json` — hashes, sizes, file modes, directory modes, and zero-bad-mode summary for every local raw artifact.
- `tmux-sessions.txt` — task session names captured for the original run.
- `command-manifest.md` — commands and environment names only.
- `harness/` — seven run-specific rerun files: `analyze-run.ts`, `clone-session.ts`, `e2e-extension.ts`, `index-raw.ts`, `run-cache-pair.sh`, `seed-history.ts`, and `wait-for.ts`. `run-cache-pair.sh` accepts only retained IDs `2r`, `5`, or `6`, maps each to explicit UUIDs, writes sessions/workloads under `../raw/`, and uses the bounded Bun `wait-for.ts` helper.
- `../raw/` — mode-0700 local-only journals, backups, diagnostics, full panes, logs, sessions, and isolated workloads. Every file is mode 0600. This exact directory is locally Git-excluded and must not be committed.

Re-derive safe outputs with `bun public/harness/analyze-run.ts <RUN_ROOT>`. After the final scan and private writes, enforce private modes and run `bun public/harness/index-raw.ts <RUN_ROOT>` last. Historical provider/planner failures described above remain preserved privately; rerunning a retained pair replaces only that pair's private session/workload/log artifacts.

## Public secret scan and manual inspection

Every public file was manually inspected. The exact all-public scan command used a fragmented pattern so the evidence document does not match its own rule:

```sh
P='author''ization|bear''er|a''pi[ _-]?k''ey|acc''ess|refr''esh|client[ _-]?secr''et|sk''-|session[ _-]?tok''en|cook''ie|private[ _-]?k''eys?|auth[.]j''son|BEGIN [A-Z ]*PRIVATE K''EY'
rg -n -i "$P" .atomic/evidence/pr-1844-20260717/public
```

Result: exit status `1`, exactly `0` matches. Public files contain no raw prompt/content body, giant generated body, credential path, or private absolute backup path. The public tree remains small; every harness file is below 500 lines.
