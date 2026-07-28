# Task A report

## Outcome

Rewrote all nine subagent definitions into lean, outcome-first prompts while preserving their routing frontmatter, distinct semantic rules, read-only boundaries, tool/path literals, and agent-specific invariants.

## File deltas (`wc -lc`)

| File | Lines | Characters |
| --- | ---: | ---: |
| `packages/subagents/agents/code-simplifier.md` | 140 → 85 | 20,557 → 8,622 |
| `packages/subagents/agents/codebase-analyzer.md` | 158 → 55 | 7,176 → 4,114 |
| `packages/subagents/agents/codebase-locator.md` | 112 → 53 | 4,649 → 3,432 |
| `packages/subagents/agents/codebase-online-researcher.md` | 301 → 102 | 18,176 → 8,290 |
| `packages/subagents/agents/codebase-pattern-finder.md` | 235 → 57 | 7,283 → 3,499 |
| `packages/subagents/agents/codebase-research-analyzer.md` | 180 → 58 | 8,195 → 4,226 |
| `packages/subagents/agents/codebase-research-locator.md` | 145 → 48 | 6,421 → 3,508 |
| `packages/subagents/agents/debugger.md` | 92 → 54 | 7,066 → 4,909 |
| `packages/subagents/agents/worker.md` | 55 → 49 | 4,425 → 3,809 |

## Frontmatter validation

Compared each current frontmatter block directly with `.atomic/research/prompt-opt/baseline/frontmatter.txt` using an exact string comparison.

```text
code-simplifier.md OK
codebase-analyzer.md OK
codebase-locator.md OK
codebase-online-researcher.md OK
codebase-pattern-finder.md OK
codebase-research-analyzer.md OK
codebase-research-locator.md OK
debugger.md OK
worker.md OK
```

Frontmatter diff result: empty. No description was tightened.

## Deduplicated rules

- `code-simplifier.md`: joint naming → **doors rubric #1**; honest names → **#3**; illegal-state typing → **#6**; trust/effect chokepoints → **#7–#8**; stranger-over-time test → **#10**; public contracts → **classification**; path preservation → **#5/Validation**.
- `codebase-analyzer.md`: implementation/data-flow lists → **Success criteria**; evidence requirements → **Tools and evidence/Output**; recency rules → one contextual-doc clause; non-critic prohibitions → **Constraints**.
- `codebase-locator.md`: file categories/required coverage → **Success criteria**; search narration → **Tools**; read-only and non-critic repetition → **Constraints**.
- `codebase-online-researcher.md`: cache checks → **Tools and routing**; fetch fallback chain → one ordered route; full-SHA permalink rules → **Success criteria/Research modes/Output**; query-quality lists → mode decision rules; recovery rows → **Quality and recovery**.
- `codebase-pattern-finder.md`: category/extraction lists → **Success criteria**; code/context/evidence rules → **Success criteria/Output**; no-evaluation repetition → **Constraints**.
- `codebase-research-analyzer.md`: extraction/filter lists → **Success criteria/Constraints**; recency/conflict rules → **Recency and evidence**; illustrative transformation → behavior-bearing **Output** fields.
- `codebase-research-locator.md`: locations/categories → **Success criteria**; newest-first rules → one ordering clause; three-tier derivation → one tier policy; read-only rules → **Tools/Constraints**.
- `debugger.md`: web routing → **Tools**; diagnosis process repetition → **Success criteria**; test invariants → one statement each in **Invariants**; reporting rules → **Output/Stop rule**.
- `worker.md`: context reading → **Role/Work and validation**; narrow scope → one clause; escalation repetition → **Decision and escalation contract**; reporting/coordination repetition → **Output/Stop rule**.

The detailed inventory-ID mapping is in `.atomic/research/prompt-opt/notes/task-A.md`.

## Rules deliberately retained

Retained the simplifier's complete doors rubric and clarification triggers; all exact recency thresholds; the pattern finder's evidence-based preferred-convention exception; online research full-SHA, tag, raw-source, video, batching, caching, and behavior-changing recovery rules; debugger's `tdd`-before-tests and never-suppress-test absolutes; and worker's full `contact_supervisor` escalation/stay-alive contract with `intercom` fallback and `progress.md` handling.

Checked each file against its baseline rule inventory. No distinct semantic rule was eliminated outright; removed text was duplicate wording, prescriptive process narration, or an example whose behavior survives in the rewritten contract.

## Grounding and length contracts

Every one of the nine report-producing agents contains exactly one §2.8 grounding clause and exactly one §2.11 length contract.

## Protected literal validation

Compared applicable P6 literals in each file before and after. Result: all nine files `OK`; no previously present `contact_supervisor`, `intercom`, `playwright-cli`, `tmux`, `tdd`, `fetch_content`, `research/web/`, or `progress.md` literal was lost.

## Hazard grep

Command:

```sh
rg -n -i 'explain your (reasoning|thinking|thought)|show your (reasoning|thinking|work)|narrate|think out loud|chain[- ]of[- ]thought|internal (reasoning|deliberation)|reasoning process|thought process|double.check|re-?verify|verify your own|prefill' packages/subagents/agents/
```

Output: empty (exit status 1, meaning no matches).
