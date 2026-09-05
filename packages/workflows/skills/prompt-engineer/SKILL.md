---
name: prompt-engineer
description: Write, evaluate, migrate, or troubleshoot prompts for GPT and Claude models.
---

# Prompt engineering

Create or revise prompts for the user's target model. Keep the common prompt portable and load only the relevant model guide. Each model page distills its official source into practical instructions; defaults, effort levels, and API features do not transfer automatically between models or providers.

## Workflow

1. Establish the outcome, audience, model, authorization, output, and representative failures. Ask only for missing information that materially changes the prompt.
2. Read the needed shared reference and the target model's page below. Resolve paths from this skill directory.
3. Remove obsolete or redundant guidance before adding text. Preserve binding requirements.
4. For complex prompts, use `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`; omit sections that do not change behavior.
5. Change one prompt or configuration variable at a time and compare representative cases. Measure task success, output validity, tool behavior, latency, tokens, and cost where available.
6. Deliver the revised prompt, a brief change summary, and validation evidence or a plan. Label checks that were not run.

## Shared references

| Read | When |
| --- | --- |
| `references/core_prompting.md` | Defining clarity, context, roles, output, examples, or grounding |
| `references/advanced_patterns.md` | Designing agents, tool routing, delegation, long context, or handoffs |
| `references/quality_improvement.md` | Auditing accumulated skills/repository instructions, optimizing, evaluating, securing, or troubleshooting prompts |

## Model guides

| Target | Read | Main distinctions |
| --- | --- | --- |
| GPT-6 Astra | `references/gpt_6_astra.md` | Completion and approval pauses, instruction sensitivity, proportionate verification, API migration |
| GPT-5.6, Sol, Terra, Luna | `references/gpt_5_6.md` | Lean prompts, concise defaults, effort sweep, pro mode, programmatic tools, caching |
| GPT-5.5 | `references/gpt_5_5.md` | Outcome-first baseline, retrieval limits, explicit validation, assistant phase replay |
| Claude Fable 5.1 | `references/claude_fable_5_1.md` | Progress visibility, batching, thinking-history binding, completion and output budget |
| Claude Fable 5 | `references/claude_fable_5.md` | Long-run completion, grounded progress, task-sized independent verification, refusal handling |
| Claude Opus 5 | `references/claude_opus_5.md` | Separate response length from effort, remove redundant verification, bound delegation |
| Claude Opus 4.8 | `references/claude_opus_4_8.md` | Explicit adaptive thinking, literal scope, tool triggering, design alternatives |
| Claude Sonnet 5 | `references/claude_sonnet_5.md` | Changed thinking default, unsupported manual budgets/sampling, literal scope and review recall |

For a migration, read both source and target pages when both are listed. For a cross-model prompt, keep common requirements in the main contract and isolate only the differences that affect behavior. Do not load every page for a single-model task.

## Common rules

- State the result and completion bar; leave routine path selection to the model.
- Give relevant context and a short reason for important constraints.
- Reserve absolute language for true invariants such as safety, permission, required fields, and forbidden actions. Use conditional rules for judgment calls.
- Specify output length, sections, format, and validation when the user or a parser depends on them. Use schemas for machine output where supported.
- Use descriptive XML tags to separate mixed instructions, context, examples, and untrusted documents when helpful. Simple prompts need no markup.
- Keep examples only when they improve measured behavior. Ensure they obey the written contract.
- Require evidence for consequential claims, permit uncertainty, and define what happens when evidence is missing.
- Request conclusions, evidence, observed behavior, and validation results. Do not ask the model to reconstruct private reasoning in response text.
- Calibrate verification and delegation to the model and task. Preserve required checks, real approval gates, and the harness's concurrency and execution rules.
- Validate API compatibility before recommending parameters. A provider capability is not proof that Atomic or another host exposes it.

Prompting reduces errors but does not eliminate them. Preserve safety, business, evidence, permission, and downstream parser constraints while optimizing.
