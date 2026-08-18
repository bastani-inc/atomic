# Verification-Scaling Authoring Guidance (Slices D1, V11) — Child Spec

| Document Metadata      | Details                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| Author(s)              | flora131 (with Claude Fable 5)                                          |
| Status                 | In Review (RFC) — all open questions resolved 2026-08-17                |
| Team / Owner           | flora131                                                                |
| Created / Last Updated | 2026-08-17                                                              |
| Parent                 | `specs/2026-08-17-llm-verifier-adoption-program.md` (umbrella)          |
| Issues                 | #2491 (+ its self-verification / operating-points comment)              |
| Research               | `research/docs/2026-08-17-llm-verifier-adoption-scan.md` §3              |
| Slices                 | D1 `verifier/docs-patterns` (now, standalone from main) · V11 `verifier/docs-primitives` (top of Stack V) |
| Targets                | `packages/coding-agent/docs/workflows.md` (starter patterns) · `packages/workflows/README.md` (pattern table) |

## 1. Executive Summary

Custom-workflow authors write judge stages, verifier fan-outs, and bounded loops today, guided by starter patterns that predate the LLM-as-a-Verifier findings. This spec lands the findings **inside the existing pattern flow** — never as a detached essay — in two phases. **D1 (now):** pattern-level guidance that names no unshipped primitive: graded scores over binary verdicts, K repeats with slot swap, criteria decomposition with mean+veto (never unanimity AND), progress magnitude beside the stop bit, pool diversity as an oracle-ceiling bet, the no-logprobs cost constraint, and the self-verification finding (a same-model judge captures most of the selection headroom). **V11 (top of Stack V):** primitive references — inputs, defaults, ledger formats — added to the same sections as each builtin ships. Acceptance is citation fidelity: every number matches the paper, every default matches the shipped code.

## 2. Context and Motivation

`docs/workflows.md` (5,258 lines) documents Tournament, Adversarial verification, Generate-and-filter, and Loop until done as starter patterns; `packages/workflows/README.md` (915 lines) carries the pattern table. Neither says anything about judge-stage design: an author following them today writes a binary `winner` schema (the exact anti-pattern V5 deletes), a unanimity gate (V2's), and a loop with no progress signal (V8's). The findings exist, the numbers are published, and the builtins are being upgraded — the guidance layer is the missing piece, and its pattern-level half has no code dependency at all.

## 3. Goals and Non-Goals

### 3.1 Functional Goals (D1)

- [ ] Each existing starter pattern gains its verification-scaling guidance **in place**: Tournament → graded per-criterion scores, BT preference from score gaps, K repeats with A/B swap, the 26.7%-tie-at-K=1 number; Adversarial verification → criteria decomposition, mean+veto, the `1−(1−p)^K` false-reject argument; Generate-and-filter → same judge guidance; Loop until done → progress magnitude, flat-is-the-stall-signal, never-a-kill-switch.
- [ ] Cross-cutting subsection (one, short, linked from the patterns — not a freestanding essay): the anchored 1–20 scale; the no-logprobs constraint (K-sample averaging at ~16× cost for K=1-logprob parity); pool diversity (oracle 92.1% vs pass@1 83.1%, and the counter-caveat that a chance-level selector makes diversity worse); self-verification (same-model judge: 86.5%/88.0% vs 79.4%/78.7% pass@1); cheap operating points (bo3 `pivots=1, K=2`, bo5).
- [ ] README pattern-table rows annotated where guidance changes what an author should write.
- [ ] Every cited number traceable to research §3 (which cites the paper).

### 3.2 Functional Goals (V11)

- [ ] Primitive references land in the same sections: criteria module usage + `criteria.md` format (after V1–V2), warm-first/prefix layout guidance (after V3), tournament inputs/defaults/ledger (after V5–V6), progress scoring + trend (after V7–V8), goal/ralph re-verification + convergence (after V9–V10). One docs slice at the top of the stack, checked against shipped defaults.

### 3.3 Non-Goals

- [ ] NOT documenting unshipped primitives in D1 (D1 must be true if Stack V never lands).
- [ ] NOT a research-paper summary or appendix; guidance lives where an author's eyes already are.
- [ ] NOT reformatting either file beyond the touched sections (no repo-wide docs churn).
- [ ] NOT changelog entries for D1 (docs guidance is not shipped-package behavior; V11's primitive references ride the same slices' CHANGELOG entries already required by V1–V10 — no doubles).

## 4. Design

### 4.1 Placement map (the "door set" of a docs change is where readers enter)

| Reader entry point | D1 adds | V11 adds |
|---|---|---|
| workflows.md § Tournament pattern | graded-scores/K-swap/BT guidance + numbers | inputs (`pivots`, `n_evaluations`, `seed`, `criteria`, `models`), bo3 default, `comparisons.json` |
| workflows.md § Adversarial verification | criteria decomposition, mean+veto, false-reject math | `criteria` input, `accept_mean: 14`, re-ask semantics, round summary format |
| workflows.md § Generate-and-filter | judge guidance (same as tournament's) | criteria-module usage |
| workflows.md § Loop until done | progress magnitude, flat = stall, containment rule | ledger `progress` entries, K default 1, trend in stop reports |
| workflows.md § new short subsection "Verification scaling" | scale, no-logprobs constraint, diversity/oracle, self-verification, operating points | links to primitive sections |
| README.md pattern table | one-line guidance deltas per row | updated row descriptions as behavior ships |

### 4.2 Fidelity rules

- Numbers appear with their benchmark context (e.g., "Terminal-Bench 2.1 self-verification") — never naked percentages.
- Every V11 default is copied from the shipped code the same slice can see, not from this spec (the spec may drift; the code cannot).
- The containment sentences (trend never kills; `stop_review_loop` stays authoritative) appear wherever the corresponding signal is documented — the docs must not advertise authority the primitives refuse.

## 5. Test Plan

Docs slices carry evidence too (umbrella Evidence protocol, docs-exempt from the line cap but not from proof):

- **D1:** Evidence section lists each edited section with an anchor link; a reviewer (or agent) checks every cited number against research §3's table — the checklist is enumerated in the PR body. `npm run check` still runs (markdown touches nothing, but the gate is uniform).
- **V11:** same, plus a defaults cross-check: for each documented default, the Evidence section quotes the shipped source line (`tournament.ts` input schema, etc.).
- **Interactive verification:** a stranger-across-time test, made executable — an agent is given only the edited Tournament section and asked to draft a judge-stage schema; the draft must use graded per-criterion integer scores, not a binary winner. **Required before D1 goes ready-for-review** (Q2 resolved); prompt-level check, not a CI test.

## 6. Open Questions / Unresolved Issues

All resolved with the owner, 2026-08-17:

- [x] **Q1 — Home:** a short "Verification scaling" subsection inside workflows.md's starter-patterns chapter, linked from each pattern.
- [x] **Q2 — D1 review:** human review **plus** the executable stranger-test before marking ready — the test result is pasted in D1's Evidence section.
