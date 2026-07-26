# Task G implementation notes

## Scope inventory

The skill directory contains only:

- `SKILL.md`
- `references/core_prompting.md`
- `references/advanced_patterns.md`
- `references/quality_improvement.md`

All four contained stale prompt guidance and were rewritten. No scripts, assets, or examples exist in the directory.

## File counts (`wc -lc`)

| File | Before | After |
| --- | ---: | ---: |
| `packages/workflows/skills/prompt-engineer/SKILL.md` | 263 lines / 8,354 chars | 67 lines / 5,374 chars |
| `packages/workflows/skills/prompt-engineer/references/core_prompting.md` | 137 lines / 4,895 chars | 97 lines / 5,551 chars |
| `packages/workflows/skills/prompt-engineer/references/advanced_patterns.md` | 271 lines / 13,395 chars | 114 lines / 9,358 chars |
| `packages/workflows/skills/prompt-engineer/references/quality_improvement.md` | 193 lines / 7,219 chars | 118 lines / 7,873 chars |
| **Total** | **864 lines / 33,863 chars** | **396 lines / 28,156 chars** |

## Frontmatter

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

`name` is byte-identical. The description was tightened to route model-specific prompt creation, evaluation, and troubleshooting requests to this skill.

## Changes by file

### `SKILL.md`

Removed the legacy technique-first workflow, repeated matrices and resource lists, response-prefilling recommendations, and chain-of-thought-as-primary guidance. Response prefilling is unsupported on Claude 4.6+ and returns 400 (`claude-best-practices.md:404-438`; rubric §2.17). Reasoning-reproduction guidance can trigger Fable 5 `reasoning_extraction` (`claude_build-with-claude_prompt-engineering_prompting-claude-fable-5.md:170-176`; rubric §2.12).

Added a concise router, a clear read-when table, outcome-first workflow, cross-model invariants, output length/shape contract, absolutes discipline, no-prefill warning, thinking-word caution, and a selection guide. This implements rubric §§2.1-2.5, 2.11-2.13, 2.17 and §3.4.

### `references/core_prompting.md`

Removed universal XML/process prescriptions, repetitive domain examples, the private-deliberation tag pattern, and inflated claims that precision or roles inherently ensure accuracy. The private-deliberation output pattern is superseded by adaptive thinking and the Fable 5 extraction safeguard (`claude_build-with-claude_thinking.md:41-50,312-365`; Fable guide:170-176). Non-behavioral examples and routine process narration are explicit GPT-5.6 trim targets (`openai-gpt56-prompting.md:11-31`).

Added the portable prompt contract, observable success and stop rules, authorization boundaries, explicit user-facing length/shape examples, structured-output guidance, conditional XML and example use, grounding, uncertainty, and layered security. This implements rubric §§2.2-2.6, 2.10-2.12 and preserves the still-valid clarity, role, XML, examples, evidence, uncertainty, and defense-in-depth rules from the baseline inventory.

### `references/advanced_patterns.md`

Removed visible chain-of-thought as a primary technique, the recommended private-deliberation/answer tag pattern, the claim that reasoning must be printed, manual-budget rules that do not apply to the three target models, generic self-correction loops, and the long non-behavioral spec-workflow example. Adaptive thinking is current on Opus 5 and Fable 5 (`claude_build-with-claude_thinking.md:41-50,291-319`); effort is the primary steering control (`claude_build-with-claude_effort.md:17-23,101-117`; `claude_build-with-claude_thinking-steering-and-cost.md:11-38`). Fable rejects reasoning-reproduction prompts (`claude_build-with-claude_prompt-engineering_prompting-claude-fable-5.md:170-176`), and Opus 5 does not benefit from generic rechecks (`claude_build-with-claude_prompt-engineering_prompting-claude-opus-5.md:63-83`).

Added concrete GPT-5.6, Claude Opus 5, and Claude Fable 5 sections; agentic `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`; tool routing; direct versus programmatic calls; parallel/dependent call rules; delegation damping; grounded progress; no-promise endings; query-last ordering; adaptive-thinking and effort controls; prompt chaining; and example guidance. Sources: `openai-gpt56-prompting.md:7-31,33-65,98-166,194-223,259-289`; Opus guide:15-105; Fable guide:33-176; rubric §§2.4, 2.7-2.16 and §3.4.

### `references/quality_improvement.md`

Removed response prefilling, visible step-by-step logic requests, repeated verification instructions, universal quote requirements, and process-heavy security examples. Prefilling is superseded by explicit instructions, structured outputs, tools, or post-processing (`claude-best-practices.md:404-438`). Reasoning-text requests are unsafe on Fable 5 (Fable guide:170-176), while generic self-verification compounds Opus 5 native behavior (Opus guide:63-83).

Added the delete-first workflow with measured OpenAI results, never-delete categories, one-change-at-a-time evaluation, grounded status claims, consistency controls, layered security, a failure-oriented troubleshooting table, model/effort regression checks, and Opus 5's explicit response-length requirement. Sources: `openai-gpt56-prompting.md:7-31,61-96,168-223,279-291`; `claude-best-practices.md:243-276,322-438`; Opus guide:27-83; Fable guide:41-80; rubric §§2.1-2.3, 2.8, 2.11-2.13, 2.17.

## Preservation confirmations

The reference filenames are unchanged and remain exactly:

- `references/core_prompting.md`
- `references/advanced_patterns.md`
- `references/quality_improvement.md`

Tool/API literals retained where relevant include `text.verbosity`, `system`, `user`, `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`, `reasoning_extraction`, `max_tokens`, and the named model families. Every still-current baseline rule survives in compact form; only vendor-superseded guidance, repetition, non-behavioral examples, and process narration were removed.

## Deliberate hazard mentions

The remaining grep matches are warnings, not instructions to reveal private deliberation:

- `SKILL.md:47` states the prohibition and redirects to evidence and conclusions.
- `advanced_patterns.md:33` describes the Fable 5 `reasoning_extraction` trigger and the safe API-summary/evidence alternatives.
- `quality_improvement.md:111` is a troubleshooting row identifying the unsafe prompt symptom and its replacement.

The two remaining `prefill` matches (`SKILL.md:46`, `quality_improvement.md:81`) are explicit “Do not prefill” warnings with supported replacements.