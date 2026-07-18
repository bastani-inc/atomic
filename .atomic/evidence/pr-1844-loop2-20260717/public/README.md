# PR #1844 LOOP-2 PROVISIONAL PRE-REPAIR real Codex/tmux evidence

> **PROVISIONAL PRE-REPAIR LOOP-2 EVIDENCE** for the superseded product SHA `03157e16ba1e06aee9614ceb487b85038931fb1d`; it is not final evidence for the repaired tree. The older `.atomic/evidence/pr-1844-20260717/` tree is LOOP-1 historical evidence only and was not altered.

Status: pre-repair scenarios complete; independent evidence approval is **NOT APPLICABLE** to the repaired tree, whose final-commit rerun and approval remain **PENDING**. This run made no product, test, or product-doc edits and performed no commit, push, PR comment, or merge.

## Attribution and preflight

- Run root: `.atomic/evidence/pr-1844-loop2-20260717/`
- HEAD/source product commit: `03157e16ba1e06aee9614ceb487b85038931fb1d`
- Live `origin/main` at start: `a870f3f6feee4d52af5debab6b696908ea1dd4df`, verified ancestor of HEAD.
- Remote PR #1844 head/old lease at start: `65e9b233ead4b53c89b3ca27d1d87ee1ed0a11e1`.
- Tracked worktree and index were clean at start. Pre-existing unrelated untracked paths were recorded only as sorted line hashes, never diff bodies.
- Compiled CLI SHA-256: `222f4d1a9493043055bbca61d4f1e183a79f19741c8af56694d3cab7e4cd245e`.
- Bun `1.3.14`; tmux `/opt/homebrew/bin/tmux`, version `3.7b`.
- Real model `openai-codex/gpt-5.6-sol:off`; model listing reported a 372,000-token context window.
- The exact mandated build passed. An isolated compiled-CLI smoke used normal global credentials, explicit isolated cwd/session directory/UUID, disabled unrelated resources, exited 0, and returned exact `AUTH_OK`. No credential material is included.

## Scenario A — fresh near-boundary large tool result

A named tmux session used the compiled CLI and the run-specific `e2e_blob` extension. Short arguments `lines=9000,width=48` deterministically generated 503,999 characters in memory. The renderer and public pane show only lines, characters, and SHA-256 `81eb940995a647f577e03ca3b6e59fd7078290e1c573c822a5707a9a74c715d3`.

Fresh real-provider normalized usage was 283,121 tokens. The local effective window was 262,130, giving `108.00785869606683%`, within the requested 106–110% band and below the actual 372,000 provider cap. Genuine automatic overflow compaction succeeded with reason `overflow`, format `full-collapse`, prompt version 4, planned rung. The bounded planner view had 292 lines and 126,636 estimated tokens; it retained 290 lines, deleted 2, and produced 4,033 estimated tokens (96.8% reduction). The final session directory contains zero diagnostics.

The pre-boundary backup exists. Both backup and live session parse, retain the full 503,999-character result with the same hash, contain one matching tool call/result and zero unmatched IDs/names. The backup is a byte prefix of the append-only live journal; it has no boundary/continuation, while the live journal has exactly one boundary and exact post-compaction `CONTINUATION_OK pr1844-loop2-functional`. The temporary planner view was 292 lines while durable tool content was 9,000 physical lines, demonstrating bounded request-local elision without durable truncation.

One setup failure is preserved privately: the first attempt combined `--no-tools` with the explicit extension, disabling the tool and timing out. The corrected final session used `--no-builtin-tools --tools e2e_blob`.

## Scenario B — fresh cold/warm cache benchmark

Each retained pair used eight deterministic alternating user/assistant pairs of 40 physical lines, followed by one real small normal warm request. The cold clone changed only its header/session identity and opened with no active prefix snapshot. Warm/cold pre-compaction journal body hashes match within all three pairs.

Timing is `session_compact.atNs - session_before_compact.atNs`, using `process.hrtime.bigint` scalars. Exact boundaries are in `samples.csv`.

| Pair | Warm ms | Warm cache read / hit | Cold ms | Cold cache telemetry |
|---|---:|---|---:|---|
| 1 | 3,546.256250 | 22,272 / true | 23,391.437458 | absent |
| 2 | 5,783.256042 | 22,272 / true | 27,176.501166 | absent |
| 3 | 7,735.189583 | 22,272 / true | 23,357.163959 | absent |

Warm median/min/max: 5,783.256042 / 3,546.256250 / 7,735.189583 ms. Cold median/min/max: 23,391.437458 / 23,357.163959 / 27,176.501166 ms. Median cold-minus-warm delta is 17,608.181416 ms; warm/cold ratio is 0.24723816363932327; cold/warm ratio is 4.044683010422384; median reduction is 75.27618363606767%. The retained ranges do not overlap, so this run supports a warm latency benefit, subject to real provider/planner variance.

All retained warm results report exact provider/model/API, nonzero native cache reads, and `cacheHit:true`. Cold cache telemetry is absent and never rewritten as zero. Scalar-only normal-request payload proof shows 17 distinct input items, 43,573 input bytes, zero repeated item-hash kinds, identical input hash across retained pairs, request-bound provider input usage 22,557, and total usage 22,569. This proves the captured normal request used request-bound provider accounting and fit; it did not suffer byte-only false rejection. Direct compaction planner transport does not re-emit the extension payload hook, so no hidden compaction-suffix telemetry is invented. Separately, each retained session has one successful compaction result/boundary, paired backup body hashes match, and warm native cache telemetry proves reuse.

Failures and retries are not relabeled: malformed warm planner output occurred in pair 2's initial attempt, a pair 3 attempt, and pair 1's first payload-proof attempt; preserved panes/events identify them. Successful measurements collected before the scalar payload hook were preserved under `raw/superseded/` but are excluded from this table. The first payload-hook collection criterion incorrectly expected a second hook from direct planner transport; those attempts are retained and disclosed. Retained samples are the final successful three warm/three cold records in `samples.csv`. Retry collection replaced failed session directories after preserving panes/events, so the provider-generated diagnostic JSON files named in failure panes are not retained; the bundle does not reconstruct their contents.

## Layout and rerun

- `results.json`: attribution, functional metrics, benchmark conclusion, and failure disclosure.
- `samples.csv`: all six retained boundary timestamps, telemetry, stats, and safe request proof scalars.
- `benchmark-summary.json`: deterministic aggregate statistics and overlap result.
- `functional-pane.txt`: bounded sanitized tmux excerpt.
- `functional-session-tool-integrity.json`: session/backup/tool/hash/boundary and pair-history integrity.
- `validation.json`: retained pre-repair validation counts and review dispositions, explicitly provisional; final repaired-SHA validation/evidence rerun and approval are pending.
- `raw-artifacts.json`: every local private directory/file with mode, size, and hash.
- `tmux-sessions.txt`: task session inventory before cleanup.
- `command-manifest.md`: rerun command shapes with placeholders only.
- `harness/`: Bun/TypeScript and shell harness; scripts invoke Bun only for JavaScript/TypeScript execution.
- `../raw/`: local-only mode-0700 tree; every file mode 0600. It is excluded by the exact local Git exclude line for this new raw directory.

Run `bun public/harness/analyze-run.ts <RUN_ROOT>` to regenerate scalar outputs, then enforce private modes and run `bun public/harness/index-raw.ts <RUN_ROOT>` last. No video applies; terminal tmux proof is the appropriate evidence.

## Sanitization

Every public file is manually inspected. The final exact fragmented scan is recorded privately and reports exit 1 / zero matches. Public artifacts contain no giant tool body, prompt bodies, sensitive account material, or private absolute backup paths. All public harness TypeScript/JavaScript files are below 500 lines.
