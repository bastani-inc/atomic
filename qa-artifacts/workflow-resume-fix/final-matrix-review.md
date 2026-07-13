# Final `/workflow resume` Matrix Review

## Recommendation: REJECT as a fully evidenced matrix

The artifacts cover all 14 authoritative scenario IDs exactly once and show **13 behavioral passes, 1 valid fixture/environment failure, and no demonstrated Atomic product failure**. However, several mandatory assertions lack independently inspectable evidence. I therefore accept the product outcome provisionally, but **reject the package as a complete authoritative matrix certification**.

## Confirmed

- All 14 IDs from the authoritative matrix are present in `complete-matrix-summary.json:7-117` and in 14 per-scenario `result.json` files.
- Aggregate accounting is consistent: 14 total, 13 pass, 1 environment failure, 0 product failures (`complete-matrix-summary.json:3-6`).
- Raw captures show real full-screen Atomic TUI selectors, workflow graphs, refusals, and completions.
- Handler-specific responses strongly corroborate `/workflow resume` execution:
  - completed-run refusal (`completed-run-exclusion/raw/03-direct-refusal.txt:17`)
  - active-run refusal (`active-duplicate-resume-refused/raw/03-direct-prefix.txt:17-18`)
  - rapid duplicate refusal (`rapid-resume-command-burst/raw/03-burst-refusal-main.txt:17-20`)
  - stale-row revalidation (`stale-picker-row-revalidation/raw/04-stale-selection.txt:17`)
  - incompatibility refusal (`incompatible-definition-on-resume/raw/02-first-resume-with-v2.txt:52-56`)
- Marker files support singular side effects across successful scenarios.
- Exact Ctrl-C termination is demonstrated by `dead=1 status=0` (`exact-session-after-ctrl-c/raw/02-exit-status.txt:1`).
- SIGKILL termination is supported by the pre-kill PID and post-kill `dead` evidence (`sigkill-after-next-prompt-render/raw/process-before-kill.txt:1`, `process-after-kill.txt:1`).
- Incompatible-definition handling is repeatable and non-mutating:
  - both attempts return the same refusal (`raw/02-first-resume-with-v2.txt:52-56`, `raw/03-second-resume-repeat.txt:52-63`)
  - before/after durable JSON is byte-identical
  - markers contain no V2 execution (`raw/markers.jsonl:1-2`).

## Environment Failure Validation

`recoverable-failure-resume` is genuinely an invalid fixture outcome rather than an Atomic resume failure:

- Initial intentional failure used run `3b126e79-d884-411c-83ce-7566a9125c63` (`raw/01-intentional-failure.txt:17-30`).
- The failed root remained discoverable with one checkpoint (`raw/02-selector.txt:23-30`).
- Resume reused the same run and replayed its checkpoint (`raw/05-terminal-status.txt:17-25`).
- Markers are singular for `checkpoint-before`, intentional failure, recovery, and final (`raw/markers.jsonl:1-4`).
- The preserved fixture branch performs only `ctx.tool(...)` and, after checkpoint replay, creates no graph stage (`raw/fixture-defect.txt:1-13`).
- Atomic consequently reports the documented no-stage validation failure (`raw/fixture-defect.txt:15-34`).

Classification as an environment/fixture failure is supported.

## Evidence Discrepancies

1. **Literal command provenance is not independently preserved.**
   `remaining-matrix-report.md:5` declares that literal `/workflow resume` commands and real selectors were used, but no tmux command transcript or harness containing the submitted keystrokes is included. Raw captures generally begin after TUI redraw, so the exact entered command cannot be independently verified for every scenario.

2. **Multiple-root deterministic ordering is not proven.**
   The selector displays two identical rows without IDs or timestamps (`multiple-resumable-roots/raw/03-two-roots-selector.txt:23-31`). It proves two candidates, but not their identities, one-per-root uniqueness, or deterministic recency order. Independent completion is supported by distinct marker triplets (`raw/markers.jsonl:1-6`).

3. **Stale-row helper exit is not proven.**
   Helper completion is visible (`stale-picker-row-revalidation/raw/03-helper-completed.txt:4-14`), but no PID/dead/exit-status artifact proves the helper process exited before stale selection, as explicitly required by the matrix.

4. **Rapid-burst injection payload is not preserved.**
   The response proves one resume plus one already-running refusal (`rapid-resume-command-burst/raw/03-burst-refusal-main.txt:17-30`), and timing shows a roughly 23 ms interval (`raw/burst-timing.txt:1-2`). No artifact records that two literal commands were delivered in one tmux `send-keys` IPC call.

5. **SIGKILL synchronization lacks the required unique marker.**
   The pre-kill capture shows a completed first input and a second pending input (`sigkill-after-next-prompt-render/raw/01-second-prompt-before-sigkill.txt:3-20`), but it does not display the unique second-prompt fixture text/marker. Thus synchronization on that unique marker, rather than generic graph state, is not independently demonstrated.

6. **Cleanup evidence is scoped and declarative.**
   `remaining-scenario-processes-after-cleanup.txt` and `remaining-secret-scan.txt` are empty, supporting zero matches, but neither records the scan command or scope. The report explicitly describes the delegated 12 scenarios (`remaining-matrix-report.md:3-7`); equivalent process/socket/secret cleanup evidence for the two parent-run scenarios is not separately preserved.

7. **A contradictory diagnostic appears in the multiple-root transcript.**
   After a completion card for run `d48f5754…`, a retained-run inspection reports it as failed with `workflows cannot invoke workflows from workflow stages` (`multiple-resumable-roots/raw/05-one-root-selector.txt:29-51`), while the TUI background and markers show completion (`:69-72`; `raw/markers.jsonl:4-6`). This does not establish a resume product failure, but the report does not reconcile the contradictory status text.

## Final Decision

- **Product-fix conclusion:** provisionally accept — no remaining Atomic `/workflow resume` failure is demonstrated.
- **Complete authoritative matrix:** **REJECT** until the missing command, ordering, helper-exit, burst-payload, unique-SIGKILL synchronization, and complete cleanup provenance are supplied or rerun with those artifacts preserved.