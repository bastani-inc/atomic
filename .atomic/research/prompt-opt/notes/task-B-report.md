# Task B report

Rewrote all seven chain task templates into outcome-first Goal → Constraints/tools → Output → Stop rule prompts while preserving the baseline rule inventory.

## Files and size (`wc -lc`)

| File | Before → after |
| --- | ---: |
| `gather-context-and-clarify.md` | 20 / 1,566 → 27 / 2,201 |
| `parallel-cleanup.md` | 60 / 4,344 → 61 / 4,791 |
| `parallel-context-build.md` | 57 / 3,623 → 43 / 3,502 |
| `parallel-handoff-plan.md` | 79 / 4,748 → 47 / 4,401 |
| `parallel-research.md` | 58 / 3,055 → 34 / 2,959 |
| `parallel-review.md` | 52 / 3,931 → 47 / 4,258 |
| `review-loop.md` | 48 / 4,495 → 39 / 4,596 |

Counts are lines / characters. Growth in the smaller templates comes from the required grounding, delegation, explicit-length output, scope, and stop contracts.

## Template-variable preservation

| File / variable | Before → after |
| --- | ---: |
| context build `{outputs.requestScope}` | 1 → 1 |
| context build `{outputs.codebasePatterns}` | 1 → 1 |
| context build `{outputs.validationRisks}` | 1 → 1 |
| context build `{previous}` | 1 → 1 |
| handoff `{outputs.externalReference}` | 1 → 1 |
| handoff `{outputs.localContext}` | 1 → 1 |
| handoff `{outputs.implementationStrategy}` | 1 → 1 |
| handoff `{previous}` | 1 → 1 |

The task's exact lowercase regex matches only the two `{previous}` occurrences because the existing `outputs.*` names are camelCase; its before/after result is also 1 → 1 for each file. A camelCase-aware comparison confirms every `outputs.*` occurrence above. `$@` is also 1 → 1 in every template.

## Rules deduplicated

- `gather-context-and-clarify.md`: no duplicated source rule; specialist evidence and parent synthesis remain separate actor contracts.
- `parallel-cleanup.md`: read-only guidance survives once in Constraints; “do not blindly apply” is merged into synthesis; invocation scope occurs once near the top.
- `parallel-context-build.md`: repeated role/output descriptions are consolidated into the specialist bullets and one unique-contribution/Open Questions contract; the synthesis list lives under Output.
- `parallel-handoff-plan.md`: specialist selection and later role guidance are one evidence-need list; parent synthesis, handoff contents, and user summary are consolidated under Output.
- `parallel-research.md`: the specialist catalog and numbered angle catalog are one four-angle list; question-specific routing follows once.
- `parallel-review.md`: inspect-only guidance is one universal read-only rule covering writable agent types; synthesis and “do not blindly apply” are one rule; invocation scope occurs once.
- `review-loop.md`: specialist/angle narration is compressed into reviewer options plus one conditional selection rule; early-stop wording lives only in Stop rule.

All edits trace to rubric §§1.5–1.7, 2.1, 2.3–2.9, 2.11–2.14, 2.16–2.17, and 3.2. The baseline inventory at lines 655–883 was checked rule by rule; no distinct semantic rule was eliminated. No structured-output fields or `stop_review_loop` derivation rules existed in these seven templates.

## Hazard grep

Command:

```sh
rg -n -i 'explain your (reasoning|thinking|thought)|show your (reasoning|thinking|work)|narrate|think out loud|chain[- ]of[- ]thought|internal (reasoning|deliberation)|reasoning process|thought process|double.check|re-?verify|verify your own|prefill' packages/subagents/prompts/
```

Output: **no matches**.

Additional validation: exact grounding clause present once in all seven files; `## Stop rule` present once in all seven files; `git diff --check` passes.
