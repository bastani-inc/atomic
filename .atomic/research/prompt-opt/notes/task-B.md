# Task B implementation notes

## Size results (`wc -lc`)

| File | Before | After |
| --- | ---: | ---: |
| `gather-context-and-clarify.md` | 20 lines / 1,566 chars | 27 lines / 2,201 chars |
| `parallel-cleanup.md` | 60 lines / 4,344 chars | 61 lines / 4,791 chars |
| `parallel-context-build.md` | 57 lines / 3,623 chars | 43 lines / 3,502 chars |
| `parallel-handoff-plan.md` | 79 lines / 4,748 chars | 47 lines / 4,401 chars |
| `parallel-research.md` | 58 lines / 3,055 chars | 34 lines / 2,959 chars |
| `parallel-review.md` | 52 lines / 3,931 chars | 47 lines / 4,258 chars |
| `review-loop.md` | 48 lines / 4,495 chars | 39 lines / 4,596 chars |

The smaller source prompts grew only where the required grounding, delegation, downstream-output, length, and stop contracts added semantics. The longer discovery prompts were compressed despite those additions.

## Rubric trace

All seven templates now use outcome-first Goal → request input → Constraints and tools → Output → Stop rule (§2.4, §2.6, §3.2). `$@` remains near the top and instructions follow it (§2.7). Each has one evidence-audit clause (§2.8), one delegation decision rule (§2.9), one independent-read scheduling clause (§2.14), one scope clause (§2.16), an audience/shape/rough-length contract (§2.5, §2.11), and an explicit definition of done (§2.2, §3.2). Judgment-call absolutes were converted to contextual selection rules (§2.3), and procedural repetition was removed (§2.1, §2.12, §2.13, §2.17). Template variables, tool/path literals, and all distinct semantic rules were preserved (§1.5–§1.7).

Per file:

- `gather-context-and-clarify.md`: §2.4/§3.2 destination and stop bar; §2.5/§2.11 user-facing synthesis and interview shape; §2.3 external-research decision rule; §2.8/§2.9/§2.14/§2.16 shared contracts.
- `parallel-cleanup.md`: §2.1 compressed scan prose and repeated read-only/synthesis wording; §2.3 kept “shorter only when clearer” as a decision rule; §2.5/§2.11 report/menu contract; §2.8/§2.9/§2.14/§2.16 shared contracts; §3.2 explicit autofix/no-authorization stop states.
- `parallel-context-build.md`: §2.1 merged duplicate role-output descriptions; §2.5 explains that artifacts feed the downstream planner/writer; §2.7 keeps the primary request before task instructions; §2.11/§3.2 defines synthesis length and shape; §2.8/§2.9/§2.14/§2.16 shared contracts.
- `parallel-handoff-plan.md`: §2.1 merged specialist selection with duplicated role guidance and merged the two final-handoff lists; §2.3 changed unconditional specialist language to evidence-need rules; §2.5/§2.11 makes the downstream-writer contract explicit; §2.7 places the primary request first; §2.8/§2.9/§2.14/§2.16 shared contracts.
- `parallel-research.md`: §2.1 collapsed the duplicate specialist catalog/default-angle catalog; §2.3 selects specialists by question type; §2.5/§2.11 defines the user-facing synthesis; §2.8/§2.9/§2.14/§2.16 shared contracts; §3.2 explicit read-only completion bar.
- `parallel-review.md`: §2.1 consolidated repeated inspect-only and “do not blindly apply” rules; §2.3 preserves approval/autofix decisions; §2.5/§2.11 defines the review report and numbered approval menu; §2.8/§2.9/§2.14/§2.16 shared contracts; §3.2 explicit stop states.
- `review-loop.md`: §2.1 moved repeated early-stop wording into the single stop rule and compressed repeated role/round narration; §2.3 preserves the conditional round, approval, and writer-routing rules; §2.5/§2.11 defines the completion handoff; §2.8/§2.9/§2.14/§2.16 shared contracts; §3.2 preserves all four termination conditions and the 3-round default.

## Deduplication and surviving locations

- `gather-context-and-clarify.md`: no distinct source rule was duplicated; the specialist return and parent synthesis requirements remain separately in `Output` and `Stop rule` because they govern different actors.
- `parallel-cleanup.md`: repeated read-only wording survives once in Constraints (“Both scouts are read-only”); “do not blindly apply” is merged into the synthesis sentence; the invocation scope occurs once near the top; the two scan taxonomies remain because each item is distinct.
- `parallel-context-build.md`: the role-specific artifact description formerly repeated after the specialist list is consolidated into the four role bullets plus the single “unique contribution / Open Questions” sentence. The synthesis list survives once under `Output`.
- `parallel-handoff-plan.md`: the specialist-choice list and later role-guidance sections are consolidated into one evidence-need list. Parent synthesis, handoff contents, and user summary survive once under `Output`.
- `parallel-research.md`: the specialist catalog and numbered angle catalog are consolidated into four angle bullets. Adaptation rules remain in the following question-type sentence; synthesis fields remain under `Output`.
- `parallel-review.md`: the `debugger` inspect-only warning is consolidated into the universal read-only rule covering agent types that can edit. The synthesis list and “do not blindly apply” rule are one sentence. Invocation scope appears once before constraints.
- `review-loop.md`: the specialist catalog and angle selection narration are compressed into reviewer options plus one conditional angle rule. Early-stop wording survives only in `Stop rule`; writer-handoff, approval, material-change, and cap rules remain separate because they are distinct transitions.

## Preservation audit

The baseline inventory entries at `rule-inventory.md:655-883` were checked rule by rule. No distinct semantic rule was eliminated. Frontmatter is byte-identical. All seven `$@` occurrences remain 1 → 1. No structured-output fields or `stop_review_loop` derivation rules existed in these seven source templates, so none were altered. Tool, skill, command, and artifact literals used by these templates remain, including `fetch_content`, `research/web/`, the chain output paths, and `handoff/final-handoff-plan.md`.

Robust variable comparison (the mandated lowercase regex does not match camelCase `outputs.*` names):

| File / variable | Before | After |
| --- | ---: | ---: |
| context build `{outputs.requestScope}` | 1 | 1 |
| context build `{outputs.codebasePatterns}` | 1 | 1 |
| context build `{outputs.validationRisks}` | 1 | 1 |
| context build `{previous}` | 1 | 1 |
| handoff `{outputs.externalReference}` | 1 | 1 |
| handoff `{outputs.localContext}` | 1 | 1 |
| handoff `{outputs.implementationStrategy}` | 1 | 1 |
| handoff `{previous}` | 1 | 1 |

The exact mandated regex produced the same before/after table: one `{previous}` in `parallel-context-build.md` and one in `parallel-handoff-plan.md`; no losses.

## Deliberately retained

The cleanup scan taxonomies, specialist routing rules, autofix permission menus, review-loop transition rules, example artifact paths, and all chain-variable examples remain because each changes routing, permissions, evidence, output addressing, or stopping behavior (§1.7). The repeated shared clauses across separate files were retained because each template executes independently; within each prompt each appears once.

## Validation

- Hazard grep: `NO MATCHES`.
- Template variables: before and after counts identical (table above).
- `$@`: 1 → 1 in every file.
- Grounding clause: present exactly once in all 7 templates.
- `## Stop rule`: present exactly once in all 7 templates.
- `git diff --check` on the seven templates: pass.
