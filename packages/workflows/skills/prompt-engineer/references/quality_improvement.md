# Prompt Quality Improvement

Optimize against representative behavior, not prompt aesthetics. Preserve user-visible outcomes and contracts while making the smallest measurable change.

## Delete-First Workflow

OpenAI measured leaner system prompts scoring roughly 10–15% higher on internal coding-agent evals while using 41–66% fewer total tokens and costing 33–67% less. Results vary, but the direction is clear: deletion is the default edit.

### Delete

- repeated statements of the same rule;
- generic self-verification nagging and legacy verifier scaffolding;
- over-triggering absolutes such as “use this tool in every case” when routing depends on context;
- step-by-step process narration for behavior the model already performs;
- examples that do not alter measured behavior;
- tool descriptions for tools the agent cannot call;
- contradictions, obsolete workarounds, decorative roles, filler, and redundant summaries.

### Never delete

- the user-visible outcome;
- success criteria and stopping conditions;
- safety, business, evidence, and permission constraints;
- context-dependent tool-routing and prerequisite rules;
- required output shape, fields, enums, length, and validation;
- explicit user-provided values and downstream parser contracts.

Reserve absolute language for true invariants. Convert judgment calls into conditions: “Use web search when current or externally verifiable information is required” is safer than a universal tool mandate.

### Optimize vertically

1. Record a working baseline on representative inputs.
2. Remove one group of instructions, examples, or tools.
3. Rerun the same cases and compare outcomes.
4. Restore anything whose removal causes a real regression.
5. Add the smallest targeted instruction for the remaining measured failure.

Do not rewrite a working prompt stack and change effort, model, and tools simultaneously; that makes causality impossible to identify.

## Evaluation Contract

Choose cases that represent normal traffic, hard edge cases, missing evidence, tool failures, and adversarial inputs. Measure:

- task success and human-visible quality;
- schema validity, required fields, and parser success;
- factual support, citation placement, and uncertainty behavior;
- tool choice, arguments, retries, loop count, and completion rate;
- latency, input/output/reasoning tokens, cache behavior, and cost per successful task;
- scope control, permission handling, and stopping behavior.

Run multiple trials when sampling variance matters. Compare the current prompt with one surgical variant at a time. A shorter prompt is an improvement only when it continues to pass the behavior contract.

## Grounded Accuracy

Prompting can reduce hallucinations but cannot eliminate them. Select controls based on the task:

```text
Use only the supplied documents for factual claims. Cite the source beside each consequential claim. Label inference separately from directly supported fact. If the documents do not contain required evidence, state what is missing rather than guessing.
```

For long or noisy sources, ask for relevant quotations before synthesis. For ordinary answers, requiring every sentence to quote a source can harm readability; define which claims need support. Permit “I don't know” or a narrower answer when evidence is absent.

For long agent runs, ground status as well as final claims:

```text
Before reporting progress, audit each claim against a tool result from this session. Report failed, skipped, or unverified work plainly, and call work complete only when the cited validation supports it.
```

This compact evidence rule replaces repeated requests to recheck work. Anthropic reports that grounding progress against tool results nearly eliminated fabricated status reports in its tests.

## Consistent Output

Use, in order of preference:

1. an explicit output contract with required sections, length, allowed values, and missing-data behavior;
2. structured outputs or a tool schema for machine-consumed data;
3. 3–5 relevant and diverse examples when the format or classification remains ambiguous;
4. parser validation and bounded retries;
5. focused prompt chaining when stages need separate contracts.

Do not prefill the final assistant turn. Claude 4.6 and later reject it with a 400 error. To suppress preambles, instruct the model to begin with the outcome; for JSON or classifications, use structured outputs, enums, or tools.

## Security and Prompt Injection

Prompt policy is one layer, not a complete security boundary.

- Separate untrusted content from instructions with clear tags and describe its data-only role.
- Define allowed actions, prohibited actions, refusal behavior, and escalation paths in plain language.
- Validate inputs, tool arguments, permissions, and outputs at system boundaries.
- Use moderation or a lightweight screening model when the risk profile warrants it.
- Monitor repeated abuse and anomalous tool behavior; enforce access control and destructive-action approval in application code.
- Use defense in depth for high-risk systems because no single prompt blocks every jailbreak or injection.

Safety invariants may use `NEVER` or `MUST`; stylistic preferences and tool judgment generally should not.

## Troubleshooting

| Symptom | Assess first | Surgical response |
| --- | --- | --- |
| Misunderstood task | Missing outcome, audience, reason, or conflicting rules | Clarify the destination and delete contradictions |
| Inconsistent shape | Vague fields, optionality, or length | Add a schema/output contract; add examples only if needed |
| Unsupported claims | Undefined evidence scope or missing-data behavior | Require cited support, distinguish inference, permit uncertainty |
| Missing tool call | User asked for suggestions rather than action, or routing is vague | State the authorized action and a conditional route |
| Excess tool calls | Repeated prerequisites, aggressive triggers, no stop rule | Deduplicate and define evidence-based stopping |
| Agent stops early | Permission boundary is vague or final plan substitutes for action | Define authorized actions and completion/blocker stop rules |
| Agent overbuilds | Scope and success criteria are broad | Name the requested scope and exclude unrelated features or refactors |
| Too much delegation | No size or independence threshold | Add delegation damping and a concurrency cap |
| Long visible answer | No explicit output length contract | Specify preserved content, omissions, sections, and word limit |
| High latency/cost | Excess prompt text or effort | Delete first, then compare one lower effort level |
| Long-context miss | Query precedes large documents | Put documents first and query last; Anthropic measured up to ~30% improvement |
| Fable 5 refusal/fallback | Prompt solicits internal reasoning text | Request evidence and conclusions; consume API-provided summaries if needed |

## Model and Effort Regression Checks

Preserve the current model and effort as the baseline before tuning. For GPT-5.6, test the same reasoning effort and one level lower. For Claude Opus 5 and Claude Fable 5, start from `high`, then compare lower levels where quality holds and higher levels only for capability-sensitive work.

Effort is not a substitute for missing success criteria, routing, dependencies, validation, or stop rules. On Opus 5, effort does not reliably control visible response length; use an explicit length and shape contract.

When a prompt regresses, inspect a small set of real traces, classify the observable failure, locate the likely instruction or contradiction, make one surgical edit, and rerun those same traces. Stop iterating when the acceptance threshold is met or the remaining issue belongs in model choice, runtime controls, tools, retrieval, or application enforcement rather than prompt prose.