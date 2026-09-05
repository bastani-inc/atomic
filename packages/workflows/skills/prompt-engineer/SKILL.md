---
name: prompt-engineer
description: Write, migrate, or troubleshoot prompts for GPT-6 Astra, GPT-5.6, and current Claude models.
---

# Prompt Engineering Skill

Create or revise prompts for the user's target model. Keep shared guidance portable across GPT-6 Astra, GPT-5.6, Claude Opus 5, and Claude Fable 5; load model-specific advice only when relevant.

## Use This Skill For

- Writing task, system, agent, or tool prompts
- Improving consistency, accuracy, security, structure, or cost
- Migrating legacy prompts to current models
- Selecting examples, XML structure, prompt chains, or model effort
- Diagnosing prompt regressions or tool-routing failures

## Workflow

1. Establish the user-visible outcome, audience, use case, model family, authorization boundaries, required output, and representative failure cases. Ask only for information whose absence would materially change the prompt.
2. Read the relevant references below.
3. Delete obsolete or redundant guidance before adding text.
4. Shape complex prompts as `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`; omit sections that do not change behavior.
5. Test one surgical change at a time on representative inputs. Compare task success, output validity, tool behavior, latency, tokens, and cost.
6. Deliver the revised prompt plus a brief change summary and validation plan. Keep the response focused: lead with the prompt or outcome, retain decisions and caveats, and omit background that does not change the user's next action.

## Progressive Disclosure

| Read | When | Covers |
| --- | --- | --- |
| `references/core_prompting.md` | Creating or repairing any prompt | Clarity, context, roles, success criteria, constraints, output contracts, examples, XML, grounding |
| `references/advanced_patterns.md` | Building agents, tool workflows, long-context prompts, chains, or model-specific variants | GPT-5.6, Claude Opus 5, Claude Fable 5, tool routing, stopping, delegation, adaptive thinking |
| `references/gpt_6_astra.md` | Targeting or migrating to GPT-6 Astra | Completion, skill conflicts, testing, delegation, writing, API compatibility |
| `references/quality_improvement.md` | Optimizing, evaluating, securing, or troubleshooting a prompt | Delete-first workflow, evals, hallucination reduction, consistency, security, regression diagnosis |

Read only the references needed for the task. Resolve their paths from this skill directory.

## Cross-Model Baseline

- State the destination and completion bar; leave routine path selection to the model.
- Give relevant context and a short reason for important constraints.
- Reserve `ALWAYS`, `NEVER`, `MUST`, and `only` for safety rules, required fields, forbidden actions, and other true invariants. Use decision rules for judgment calls.
- Specify user-facing or machine-consumed output length, sections, format, and validation requirements.
- Use consistent descriptive XML tags when a prompt mixes instructions, context, examples, or documents. Tags are optional for simple prompts.
- Use 3–5 relevant, diverse examples when examples measurably improve format, tone, or edge-case behavior; remove examples that do not change behavior.
- For high-stakes or grounded work, require claims to cite available evidence, permit uncertainty, and define what happens when evidence is missing.
- Do not prefill the final assistant response: Claude 4.6 and later return a 400 error. Use explicit format instructions, structured outputs, tools, or post-processing instead.
- Do not request internal reasoning as response text. On Claude Fable 5 this can trigger `reasoning_extraction` and force fallback; request conclusions, evidence, observed behavior, citations, or validation results instead.
- In instruction text, prefer “consider,” “evaluate,” or “assess” over “think” and its variants, especially for configurations with model thinking disabled.

## Quick Selection Guide

| Need | Primary approach | Reference |
| --- | --- | --- |
| Better clarity or tone | Outcome, audience, context, specific role | `references/core_prompting.md` |
| Reliable shape | Explicit output contract, schema, relevant examples | `references/core_prompting.md` |
| Complex autonomous task | Agentic structure plus success and stop rules | `references/advanced_patterns.md` |
| Tool-choice failures | Context-dependent routing and prerequisite rules | `references/advanced_patterns.md` |
| Long documents | Documents first, query last, source metadata | `references/advanced_patterns.md` |
| Deep analysis | Adaptive thinking and calibrated effort | `references/advanced_patterns.md` |
| Multi-stage workflow | Focused prompt chain with explicit handoffs | `references/advanced_patterns.md` |
| Hallucinations | Evidence scope, citations, uncertainty behavior | `references/quality_improvement.md` |
| Inconsistent output | Schema, examples, parser validation | `references/quality_improvement.md` |
| Security or injection risk | Policy boundaries, input controls, layered defenses | `references/quality_improvement.md` |
| Excess cost or latency | Delete-first optimization and effort sweep | `references/quality_improvement.md` |

## Invariants

Prompting reduces but does not eliminate errors. Validate critical outputs with domain-appropriate checks, especially in high-stakes applications. Preserve safety, business, evidence, permission, and downstream parser constraints while optimizing.