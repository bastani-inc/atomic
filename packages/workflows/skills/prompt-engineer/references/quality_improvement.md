# Prompt Quality Improvement

Optimize against representative behavior, not prompt aesthetics. Preserve user-visible outcomes and contracts while making the smallest measurable change.

## Delete-First Workflow

OpenAI's [GPT-5.6 guide](gpt_5_6.md) reports leaner system prompts scoring roughly 10–15% higher on internal coding-agent evals while using 41–66% fewer total tokens and costing 33–67% less. Treat these as workload-specific measurements. Test deletions against your own baseline.

### Delete

- repeated statements of the same rule;
- generic self-verification reminders that duplicate the target model's behavior without improving measured outcomes;
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

## Audit accumulated skills and repository instructions

The following audit distills [Eric Provencher's advice on X](https://x.com/pvncher/status/2095991462416490862), read September 5, 2026. It is practitioner guidance for instruction maintenance, not an API specification or a measured guarantee for every model or harness.

- Keep skill descriptions short and specific about when to load them. Prefer "Plan and validate database migrations" to "Use for anything involving databases." Too many broad or competing descriptions make routing harder. Provencher reports that Codex truncates descriptions when too many skills are installed; do not assume Atomic has the same truncation behavior.
- Keep a multi-purpose skill's root file a small router. Put task-specific procedures and scripts in references, and load only the branch needed. This saves context and avoids unrelated instructions changing the task.
- Revisit inherited recipes after model upgrades. Replace rigid itineraries for routine judgment with outcomes, necessary dependencies, and completion criteria. Evaluate changes across the models used by repository contributors; guidance that helps Sol or Luna may overconstrain Astra.
- Review `AGENTS.md` requirements in proportion to the task. A typo fix rarely needs a full repository map or a stack of design documents. Keep contextual pointers current and retain required pre-edit inspection and repository checks; propose changes to binding instructions rather than silently ignoring them.
- Make permission boundaries concrete. If the environment actually uses disposable local fixtures with no production access, authorize running and repairing those tests as one workflow. Do not generalize that permission to production or publication, and do not ask again at every already-authorized step.
- Define completion before work starts, including running the implementation, inspecting results, and repairing failures when requested. A first-pass review gate is a deliberate stopping point; remove an accidental gate only when authorized. For broader exploration, state what to investigate and where to stop.

Treat each audit change as a hypothesis. Compare representative tasks, including a small edit and a real approval boundary, before removing a rule globally. OpenAI's [Astra guide](gpt_6_astra.md) adds model-specific advice for excessive testing, early stops, and instruction conflicts.

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

This evidence rule helps reduce unsupported progress claims; it does not replace required verification. The [Fable 5 guide](claude_fable_5.md) reports benefits from grounding status and separately recommends independent verification for long work. Keep those distinct from Opus 5's advice to remove redundant self-checks.

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
| Too little delegation on Astra | No explicit permission or independence rule | Allow bounded parallel work when it saves time or improves quality |
| Long visible answer | No explicit output length contract | Specify preserved content, omissions, sections, and word limit |
| High latency/cost | Excess prompt text or effort | Delete first, then compare one lower effort level |
| Long-context miss | Query precedes large documents | Put documents first and query last; Anthropic measured up to ~30% improvement |
| Fable 5 refusal/fallback | Prompt solicits internal reasoning text | Request evidence and conclusions; consume API-provided summaries if needed |

## Model and Effort Regression Checks

Preserve the current model and effort as the baseline before tuning. Read the relevant page from the [model table](../SKILL.md#model-guides) for migration defaults and supported controls. Effort names do not imply equal reasoning volume across models. Compare lower levels where quality holds and higher levels only where the gain justifies cost; do not silently change thinking defaults, output budgets, or API compatibility.

Effort is not a substitute for missing success criteria, routing, dependencies, validation, or stop rules. On Opus 5, effort does not reliably control visible response length; use an explicit length and shape contract.

When a prompt regresses, inspect a small set of real traces, classify the observable failure, locate the likely instruction or contradiction, make one surgical edit, and rerun those same traces. Stop iterating when the acceptance threshold is met or the remaining issue belongs in model choice, runtime controls, tools, retrieval, or application enforcement rather than prompt prose.