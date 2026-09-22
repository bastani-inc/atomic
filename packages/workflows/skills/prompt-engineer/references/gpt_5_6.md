# GPT-5.6 prompting and migration

Use this reference for the GPT-5.6 family. Guidance checked on September 5, 2026 against [OpenAI's GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6). Snippets below are adaptations for prompt authors, not verbatim official quotes. Keep these defaults separate from [GPT-6 Astra](gpt_6_astra.md) and [GPT-5.5](gpt_5_5.md).

## When moving from an older prompt stack

Observed behavior: GPT-5.6 often maintains or improves quality with fewer tokens, especially when prompts and tool descriptions are lean. Over-specified legacy prompts can waste context and constrain useful judgment.

Prompt adjustment: preserve product requirements and measured fixes, but remove repeated instructions, redundant examples, and irrelevant tools one group at a time. Evaluate the chosen variant on the actual workload: `gpt-5.6` routes to Sol for flagship capability, Terra balances quality and price, and Luna targets efficient high-volume work. API names do not guarantee the agent catalog exposes those variants.

Adaptable prompt:

```text
Define the result, constraints, approval boundaries, required evidence, and output shape once. Let the model choose routine steps. Keep examples only when they encode a product requirement or correct a measured failure. Remove repeated process instructions unless the exact path is part of the requirement.
```

Caveats: OpenAI reports leaner internal coding-agent prompts improved scores and reduced token/cost ranges in a sample; treat those as directional, not guaranteed. Track behavior in long sessions, where repeated tool and prompt content compounds.

## When authorization or mutation scope is ambiguous

Observed behavior: GPT-5.6 can infer the user's intended level of work, but broad or repeated approval language can still cause unnecessary stops.

Prompt adjustment: distinguish answer/review/diagnose requests from fix/build/change requests, and name confirmation boundaries once.

Adaptable prompt:

```text
For requests to answer, explain, review, diagnose, or plan, inspect the relevant materials and report findings without editing.

For requests to fix, build, update, or change, make the requested in-scope local changes and run relevant non-destructive validation without asking first.

Ask before external writes, destructive actions, purchases, credential changes, deployments, publishing, or material scope expansion when they are not already explicitly authorized, and honor any mandatory confirmation gate. Stop when the requested result and required checks are complete, or name the smallest blocking decision.
```

Caveats: if the user explicitly asks for review-only/no-edit work, that wins. Prompt text does not override repository safety rules or host permissions.

## When answers become too terse

Observed behavior: GPT-5.6 tends to be more concise than GPT-5.5. Migrated prompts that also demand brevity can lose caveats, evidence, or next steps.

Prompt adjustment: say what a short answer must retain and what can be cut. Use `text.verbosity` for request-level detail when the API path supports it, then prompt task-specific length and content.

Adaptable prompt:

```text
Lead with the conclusion. Keep the evidence needed to support it, any material caveat, and the next action. Trim introductions, repetition, generic reassurance, optional background, and secondary examples first.

If the user reports a problem, acknowledge the specific issue before the next step. Omit generic praise and sign-offs.
```

Caveats: do not let brevity remove required output fields, citations, validation status, or uncertainty that changes a decision.

## When effort, pro mode, or prior reasoning needs tuning

Observed behavior: GPT-5.6 supports `none`, `low`, `medium`, `high`, `xhigh`, and `max`, with default `medium`. The guide recommends preserving GPT-5.5/5.4 effort on migration, then comparing one level lower. Pro mode can improve difficult tasks but adds latency and bills aggregated model work.

Prompt adjustment: keep the prompt outcome-focused. Do not ask for private reasoning or multiple visible candidate answers merely because pro mode or high effort is enabled.

Adaptable prompt:

```text
Use the selected effort or mode to produce one complete answer that satisfies the task. Do not expose private reasoning. For difficult analysis, show conclusions, supporting evidence, assumptions, and unresolved risks. Prefer the lowest effort or mode that passes the same representative evaluations.
```

Caveats: use `high`, `xhigh`, `max`, or pro mode only where measured quality gain justifies latency and cost. With persisted reasoning, use `all_turns` for stable goals and `current_turn` when earlier reasoning is no longer relevant; preserve API-returned items when manually replaying history.

## When a tool-heavy workflow needs reduction

Observed behavior: Programmatic Tool Calling can help bounded workflows that filter, join, rank, deduplicate, aggregate, or validate large tool results. Multiple calls alone do not justify it.

Prompt adjustment: declare which stage is eligible, which tools it may call, the output schema, evidence requirements, retry/concurrency limits, and what remains direct model judgment.

Adaptable prompt:

```text
Use programmatic tool calling only for this bounded stage: [stage]. Eligible tools: [tools]. Use documented input and output fields only. Reduce the intermediate results to this schema: [schema], including evidence needed for the final answer.

Stop when [condition] is met. Retry transient failures at most [N] times. Do not repeat completed calls or perform side-effecting actions. Use direct tool calls for semantic judgment, approvals, source inspection, and final validation.
```

Caveats: the application must enable PTC, opt tools in, handle `program` and `program_output` items, and preserve `call_id`/`caller` linkage. A correct program result is not enough if the final answer drops a citation, field, or caveat. Prompt text does not enable PTC in Atomic or another harness.

## When frontend or visual work is part of the task

Observed behavior: GPT-5.6 improves frontend aesthetics, layout, visual hierarchy, and design judgment, but good prompting still names product context and required states.

Prompt adjustment: describe the user, first screen, design-system constraints, familiar controls, responsive behavior, empty/loading/error states, and generated-UI defaults to avoid.

Adaptable prompt:

```text
Build the interface for [user] trying to [goal]. Prioritize first-screen clarity, familiar controls, accessible contrast, responsive layout, and visible loading, empty, and error states. Align with [design system or brand constraints]. Avoid generic hero sections, nested decorative cards, placeholder instructional text, ornamental gradients, and controls that look clickable but are not.

Render or inspect the result before finalizing. Fix clipping, spacing, hierarchy, missing states, and broken responsive behavior.
```

Caveats: if the host cannot render or inspect the UI, report that limitation and use the best static evidence available. Do not claim visual validation from code inspection alone.

## Compatibility notes

Verify provider and SDK support before adopting these controls.

- Model choice: `gpt-5.6` routes to Sol; choose Sol, Terra, or Luna by workload and configured availability.
- API path: use Responses for reasoning, tool-calling, and multi-turn work.
- Effort: supported values are `none`, `low`, `medium`, `high`, `xhigh`, `max`; default is `medium`.
- Pro mode: keep the selected model and set `reasoning.mode: "pro"`; do not invent a separate model slug. Effort remains independent.
- Persisted reasoning: GPT-5.6 defaults to `all_turns`; use `previous_response_id` or preserve prior user inputs and every response output item. With `store: false` or Zero Data Retention, replay encrypted reasoning items returned by the API.
- Caching: implicit caching remains; cache writes cost 1.25× uncached input. Track cached and cache-write tokens. Use explicit breakpoints where useful and replace `prompt_cache_retention` with `prompt_cache_options.ttl`.
- Images: `original` or `auto` preserve dimensions unless a side exceeds 65,535 pixels; images still over the 30,000-patch limit are rejected.
- Safeguards: real-time cyber/biology classifiers can refuse requests or pause streaming. Handle refusals and delays honestly; do not prompt around safeguards. For individual users, send a privacy-preserving `safety_identifier` when supported.

## Validate the prompt change

Compare a normal task, a terse-answer case, a tool-heavy reduction, a frontend/visual case if relevant, and a permission-boundary case. Measure task success, final-answer completeness, required evidence, latency, tokens, cost, and refusal handling. Change one prompt, model, effort, or API feature at a time.
