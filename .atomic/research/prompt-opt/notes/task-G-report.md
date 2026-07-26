# Task G report — current cross-model prompt-engineer guidance

## Result

Rewrote the prompt-engineer skill and its three progressive-disclosure references for GPT-5.6, Claude Opus 5, and Claude Fable 5. The skill now practices delete-first, outcome-first prompting and no longer recommends response prefilling or visible chain-of-thought output.

The directory contains exactly four files: `SKILL.md` and the three references. No scripts, assets, or separate example files were present.

## Files changed and counts (`wc -lc`)

| File | Before | After |
| --- | ---: | ---: |
| `packages/workflows/skills/prompt-engineer/SKILL.md` | 263 lines / 8,354 chars | 67 lines / 5,374 chars |
| `packages/workflows/skills/prompt-engineer/references/core_prompting.md` | 137 lines / 4,895 chars | 97 lines / 5,551 chars |
| `packages/workflows/skills/prompt-engineer/references/advanced_patterns.md` | 271 lines / 13,395 chars | 114 lines / 9,358 chars |
| `packages/workflows/skills/prompt-engineer/references/quality_improvement.md` | 193 lines / 7,219 chars | 118 lines / 7,873 chars |
| **Total** | **864 lines / 33,863 chars** | **396 lines / 28,156 chars** |

## Frontmatter before and after

Before:

```yaml
name: prompt-engineer
description: Create, improve, or optimize prompts using best practices.
```

After:

```yaml
name: prompt-engineer
description: Create, improve, optimize, evaluate, or troubleshoot prompts for GPT-5.6, Claude Opus 5, and Claude Fable 5.
```

The `name` is byte-identical. The description now triggers accurately for model-specific prompt creation, evaluation, and troubleshooting.

## Removed guidance and superseding citations

- **All positive response-prefilling guidance** from the router and quality reference. Claude 4.6+ rejects a final partial assistant turn with 400; current replacements are explicit output instructions, structured outputs, tools, or post-processing (`claude-best-practices.md:404-438`; rubric §2.17).
- **Chain-of-thought as the primary complex-reasoning technique**, including the assertion that reasoning must be printed and the recommended private-deliberation/answer tag pattern. Opus 5 and Fable 5 use adaptive thinking; Fable 5 prompts that solicit reproduced reasoning can trigger `reasoning_extraction` (`claude_build-with-claude_thinking.md:41-50,291-365`; `claude_build-with-claude_prompt-engineering_prompting-claude-fable-5.md:170-176`; rubric §§2.12, 3.4).
- **Legacy manual thinking-budget claims** that do not apply to these target models. Current Claude guidance uses adaptive thinking plus effort, with `max_tokens` as the hard request cap (`claude_build-with-claude_effort.md:17-23,101-117`; `claude_build-with-claude_thinking-steering-and-cost.md:11-38,876-890`).
- **Generic self-correction and repeated recheck instructions.** Opus 5 self-corrects natively; these instructions increase cost without improving results (`claude_build-with-claude_prompt-engineering_prompting-claude-opus-5.md:63-83`; rubric §2.1).
- **Universal step narration, inflated technique claims, repetitive matrices, and non-behavioral examples.** These are GPT-5.6 deletion targets (`openai-gpt56-prompting.md:11-31`) and are too prescriptive for Fable 5 (`claude_build-with-claude_prompt-engineering_prompting-claude-fable-5.md:170-175`).

Still-valid rules from the baseline inventory remain in compact form: clarity, context and motivation, roles, conditional sequential instructions, XML structure, 3–5 relevant/diverse examples when useful, chaining, parallel independent work, long-document organization, quote grounding, uncertainty, citations, structured output, retrieval grounding, input screening, policy boundaries, monitoring, and defense in depth.

## Added guidance — acceptance criterion B8

- [x] **GPT-5.6 section:** lean outcome-first contracts; contradiction removal; `text.verbosity`; preserved/baseline reasoning effort; direct/parallel tool behavior; Responses versus Chat Completions tool compatibility; measured ~10–15% score gain, 41–66% token reduction, and 33–67% cost reduction.
- [x] **Claude Opus 5 section:** complete specification up front; native self-correction; effort sweep; explicit length contract because effort does not reliably shorten visible output; sparse progress; scope and delegation controls; thinking-disabled hazards.
- [x] **Claude Fable 5 section:** reduced legacy scaffolding; adaptive-thinking/effort behavior; grounded status claims; action boundaries; no-promise ending; context-budget caution; `reasoning_extraction` handling.
- [x] **Delete-first workflow:** explicit delete and never-delete lists, measured motivation, and one-change-at-a-time evaluation.
- [x] **Agentic structure:** `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`, including an end-to-end example.
- [x] **Tool routing:** callable-tool filtering, conditional routes, prerequisites, return/error descriptions, retries/fallbacks/stops, parallel versus dependent calls, direct versus programmatic calling.
- [x] **Effort and verbosity:** GPT and Claude controls separated; Opus 5's visible response requires an explicit word/section contract.
- [x] **Delegation damping:** independence/size threshold, no recheck delegation, one-agent preference, concurrency cap, synthesis requirement.
- [x] **`reasoning_extraction`:** Fable 5 refusal/fallback risk and safe evidence/conclusion/API-summary replacements.
- [x] **Absolutes discipline:** absolutes reserved for invariants; judgment expressed as decision rules.
- [x] **Long-context query-last:** documents first, query last, with Anthropic's measured up-to-~30% improvement.
- [x] **Grounded progress:** claims tied to current-session tool results; Anthropic's “nearly eliminated” measured result included.
- [x] **No-prefill rule:** explicit warning plus current replacements.
- [x] **Thinking-word caution:** instruction prose prefers “consider,” “evaluate,” and “assess.”
- [x] **Progressive disclosure:** router includes a clear read-when table; fundamentals live in core, agentic/model patterns in advanced, and optimization/evaluation/troubleshooting in quality.

## Surviving prefill grep

Command:

```text
rg -n -i 'prefill|pre-fill|prefilled' packages/workflows/skills/prompt-engineer/
```

Output:

```text
packages/workflows/skills/prompt-engineer/SKILL.md:46:- Do not prefill the final assistant response: Claude 4.6 and later return a 400 error. Use explicit format instructions, structured outputs, tools, or post-processing instead.
packages/workflows/skills/prompt-engineer/references/quality_improvement.md:81:Do not prefill the final assistant turn. Claude 4.6 and later reject it with a 400 error. To suppress preambles, instruct the model to begin with the outcome; for JSON or classifications, use structured outputs, enums, or tools.
```

Both are unambiguous anti-pattern warnings.

## Surviving reasoning-hazard grep with context

Command:

```text
rg -n -i -C 2 'explain your (reasoning|thinking|thought)|show your (reasoning|thinking|work)|narrate|think out loud|internal (reasoning|deliberation)|reasoning process|thought process' packages/workflows/skills/prompt-engineer/
```

Output:

```text
packages/workflows/skills/prompt-engineer/SKILL.md-45-- For high-stakes or grounded work, require claims to cite available evidence, permit uncertainty, and define what happens when evidence is missing.
packages/workflows/skills/prompt-engineer/SKILL.md-46-- Do not prefill the final assistant response: Claude 4.6 and later return a 400 error. Use explicit format instructions, structured outputs, tools, or post-processing instead.
packages/workflows/skills/prompt-engineer/SKILL.md:47:- Do not request internal reasoning as response text. On Claude Fable 5 this can trigger `reasoning_extraction` and force fallback; request conclusions, evidence, observed behavior, citations, or validation results instead.
packages/workflows/skills/prompt-engineer/SKILL.md-48-- In instruction text, prefer “consider,” “evaluate,” or “assess” over “think” and its variants, especially for configurations with model thinking disabled.
packages/workflows/skills/prompt-engineer/SKILL.md-49-
--
packages/workflows/skills/prompt-engineer/references/quality_improvement.md-109-| High latency/cost | Excess prompt text or effort | Delete first, then compare one lower effort level |
packages/workflows/skills/prompt-engineer/references/quality_improvement.md-110-| Long-context miss | Query precedes large documents | Put documents first and query last; Anthropic measured up to ~30% improvement |
packages/workflows/skills/prompt-engineer/references/quality_improvement.md:111:| Fable 5 refusal/fallback | Prompt solicits internal reasoning text | Request evidence and conclusions; consume API-provided summaries if needed |
packages/workflows/skills/prompt-engineer/references/quality_improvement.md-112-
packages/workflows/skills/prompt-engineer/references/quality_improvement.md-113-## Model and Effort Regression Checks
--
packages/workflows/skills/prompt-engineer/references/advanced_patterns.md-31-- Define action boundaries and a no-promise stop rule. If an autonomous turn ends with an unexecuted plan or a request for permission already granted, continue with tools; stop only when complete or blocked on user-only input.
packages/workflows/skills/prompt-engineer/references/advanced_patterns.md-32-- Avoid surfacing context-token countdowns because they can prompt early wrap-up.
packages/workflows/skills/prompt-engineer/references/advanced_patterns.md:33:- Requests to echo, narrate, or explain internal reasoning as response text can trigger the `reasoning_extraction` refusal category and force fallback. Request cited evidence, conclusions, observed outputs, and validation receipts instead. If an application needs available reasoning visibility, consume API-provided summarized adaptive-thinking blocks rather than asking the model to generate a reconstruction.
packages/workflows/skills/prompt-engineer/references/advanced_patterns.md-34-
packages/workflows/skills/prompt-engineer/references/advanced_patterns.md-35-## Agentic Prompt Structure
```

Each match is deliberate anti-pattern instruction: `SKILL.md:47` states the prohibition and redirects to observable artifacts; `quality_improvement.md:111` diagnoses the unsafe symptom and gives the supported replacement; `advanced_patterns.md:33` teaches the vendor-named hazard and safe adaptive-thinking/evidence alternatives. None asks the model to reveal private deliberation.

## Filename preservation

`ls packages/workflows/skills/prompt-engineer/references/` returns exactly:

```text
advanced_patterns.md
core_prompting.md
quality_improvement.md
```

The required reference literals remain unchanged:

- `references/core_prompting.md`
- `references/advanced_patterns.md`
- `references/quality_improvement.md`

## Gates

- `bun run check:file-length`: **passed** — 2,450 tracked files checked; all four changed files are below 500 lines.
- `git diff --check` on the four skill files: **passed**.
- `bun run test:unit`: **failed in unrelated prompt/resource tests** — 4,203 passed, 2 skipped, 14 failed across 553 files. No failure asserted on prompt-engineer skill content, so tests were not modified. Failures reported by the suite:
  1. `removed provider active surfaces > builtin workflow and subagent model policies contain no removed-provider candidates`
  2. `goal create_pr > injects no-PR guardrails into intermediate goal prompts`
  3. `open-claude-design > runs reference-discovery by default and feeds the generator reference inspiration`
  4. `open-claude-design > runs /skill:impeccable shape and init in one discovery stage`
  5. `open-claude-design setup > runDiscoveryAndInit > runs one discovery stage for shape + init and parses the structured brief/output_type/references`
  6. `open-claude-design setup > reference discovery > buildReferenceDiscoveryPrompt names every gallery + the playwright bootstrap`
  7. `goal > uses schema-backed reviewer stages without prompt tool nudges`
  8. `ralph > adds workflow cwd context to every Ralph stage prompt`
  9. `goal > renders Codex-style goal continuation context`
  10. `goal > sanitizes reviewer comparison base branch input`
  11. `goal > persists a goal ledger and completes only after reviewer quorum`
  12. `ralph > uses schema-backed Ralph reviewer stages without prompt tool nudges`
  13. `generate-and-filter keeps the full shortlist when shortlist_size equals num_candidates`
  14. `workflow stage bundled resources > discovers bundled subagent definitions from the packaged repo`

The unit failures reference files outside Task G's allowed edit scope; no silent test rewrites were made.