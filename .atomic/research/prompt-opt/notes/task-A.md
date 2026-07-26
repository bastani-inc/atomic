# Task A prompt rewrite notes

## Measurements and rubric trace

Counts are from `wc -lc` (lines, then characters), comparing `HEAD` to the rewritten files.

| File | Before → after lines | Before → after characters | Rubric rules applied |
| --- | ---: | ---: | --- |
| `code-simplifier.md` | 140 → 85 | 20,557 → 8,622 | §2.1, §2.3–2.5, §2.8, §2.10–2.13, §2.16, §3.1 |
| `codebase-analyzer.md` | 158 → 55 | 7,176 → 4,114 | §2.1, §2.3–2.5, §2.8, §2.11–2.13, §3.1 |
| `codebase-locator.md` | 112 → 53 | 4,649 → 3,432 | §2.1, §2.3–2.5, §2.8, §2.11–2.13, §3.1 |
| `codebase-online-researcher.md` | 301 → 102 | 18,176 → 8,290 | §2.1, §2.3–2.5, §2.8, §2.11–2.14, §3.1 |
| `codebase-pattern-finder.md` | 235 → 57 | 7,283 → 3,499 | §2.1, §2.3–2.5, §2.8, §2.11–2.13, §3.1 |
| `codebase-research-analyzer.md` | 180 → 58 | 8,195 → 4,226 | §2.1, §2.3–2.5, §2.8, §2.11–2.13, §3.1 |
| `codebase-research-locator.md` | 145 → 48 | 6,421 → 3,508 | §2.1, §2.3–2.5, §2.8, §2.11–2.13, §3.1 |
| `debugger.md` | 92 → 54 | 7,066 → 4,909 | §2.1, §2.3–2.5, §2.8, §2.10–2.13, §3.1 |
| `worker.md` | 55 → 49 | 4,425 → 3,809 | §2.1, §2.4–2.5, §2.8, §2.10–2.11, §2.16, §3.1 |

All report-producing agents now contain exactly one grounding clause (§2.8) and exactly one selective length contract (§2.11). Bodies use outcome-first Role/Goal, Success, Constraints/Tools, Output, and Stop sections where applicable (§2.4); reasons are attached to material routing and evidence rules (§2.5).

## Deduplication ledger

- `code-simplifier.md`: merged repeated joint/name rules (inventory R4–R5, R40, R50–R51) into **The doors rubric #1**; honesty rules (R6–R7, R42, R52, R64) into **#3**; illegal-state rules (R8–R9, R45, R59, R62) into **#6**; dangerous-door/chokepoint rules (R12–R13, R46–R47, R56, R63) into **#7–#8**; stranger-over-time rules (R10–R11, R49, R84) into **#10**; public-boundary rules (R17–R18, R61–R62) into **classification**; and repeated validation rules (R33–R38, R44) into **#5** plus **Validation**.
- `codebase-analyzer.md`: merged implementation/data-flow lists (R2–R16, R29–R40) into **Success criteria**; evidence/tool repetition (R17–R20, R44–R50) into **Tools and evidence** plus **Output**; recency repetition (R21–R28, R50) into one contextual-doc rule; and the documentarian/non-critic rules (R41–R42, R54–R64) into **Constraints**.
- `codebase-locator.md`: merged category and omission rules (R2–R16, R39–R40) into **Success criteria**; tool/search pattern narration (R17–R28, R31, R35) into **Tools** and one coverage list; and repeated read-only/non-critic rules (R30, R36–R47) into **Constraints**.
- `codebase-online-researcher.md`: merged cache rules (R9, R48, R93, R100, R112) into **Tools and routing**; fetch fallback rules (R17–R21, R51, R56, R94, R112) into one ordered route; full-SHA permalink rules (R10, R22, R30–R45, R86–R87, R112) into **Success criteria**, **Research modes**, and **Output** without repeating the derivation; search-quality lists (R47–R82, R88–R102) into mode-specific decision rules; and the troubleshooting table (R103–R111) into **Quality and recovery**, retaining every behavior-changing recovery while expressing automatic 403 handling once.
- `codebase-pattern-finder.md`: merged pattern categories and extraction lists (R2–R30, R72–R90) into **Success criteria**; evidence/output repetition (R13–R16, R91–R96) into **Success criteria** and **Output**; and non-evaluation rules (R97, R102–R110) into **Constraints** plus the evidence-based preference exception.
- `codebase-research-analyzer.md`: merged extraction/filter/quality filters (R2–R16, R35–R57, R59–R66) into **Success criteria** and **Constraints**; recency rules (R17–R29, R65) into **Recency and evidence**; and replaced the long transformation example (R58) with the same behavior-bearing fields in **Output**.
- `codebase-research-locator.md`: merged directory/category lists (R2–R23, R43–R50, R53) into **Success criteria**; newest-first repetition (R14, R24–R27, R56) into one ordering rule; tier derivation (R28–R37) into one byte-faithful three-tier policy; and read-only guidance (R51, R57–R61) into **Tools**, **Constraints**, and **Stop rule**.
- `debugger.md`: merged duplicated web routing (R4–R9, R20–R24, R39) into **Tools**; duplicated diagnosis workflow (R27–R39) into **Success criteria**; retained the TDD-before-tests and never-suppress-test invariants once in **Invariants**; and merged report rules (R40–R46) into **Output** and **Stop rule**.
- `worker.md`: merged context-reading rules (R3, R18, R24–R27) into **Role and goal** and **Work and validation**; narrow-scope rules (R8, R14–R16) into one scope clause; escalation repetition (R5, R19–R20) into **Decision and escalation contract** while retaining every `contact_supervisor`/`intercom` route and wait condition; and report/coordination rules (R12, R21–R23, R28–R33) into **Output** and **Stop rule**.

## Preservation check

Checked every rewritten body against its section of `baseline/rule-inventory.md`. No distinct semantic rule was eliminated outright. Removed material was repetition, process narration, or an illustrative example whose behavior-bearing instruction survives in the named section above. All applicable protected tool/skill/path literals remain. Frontmatter values were not intentionally changed, including descriptions.

## Deliberately retained

- `code-simplifier.md`: retained the door metaphor, all ten door checks, public/interior classification, ambiguity/clarification triggers, effect chokepoints, trust transitions, airlock placement, behavior-path validation, and deferred-finding report shape because these are the agent's distinctive decision rubric.
- `codebase-analyzer.md` and research agents: retained exact recency thresholds and source-order rules because they change retrieval and inclusion behavior.
- `codebase-pattern-finder.md`: retained the evidence-based “preferred approach” exception despite the general no-evaluation rule because repository evidence can establish an observed convention.
- `codebase-online-researcher.md`: retained full-SHA construction, tagged-version handling, raw URL preference, video modes, concurrency facts, and all failure recoveries that change behavior.
- `debugger.md`: retained `ALWAYS` for loading `tdd` before test edits and `NEVER` for suppressing failing tests; these are permitted true invariants. Retained legacy installer/debugger command literals solely under the hard preservation contract.
- `worker.md`: retained the complete `contact_supervisor` escalation and stay-alive contract, `intercom` fallback, progress routing, no-routine-handoff rule, and `progress.md` behavior.
