# GPT-5.5 prompting and migration

Use this reference when targeting `gpt-5.5`. Guidance checked on September 5, 2026 against [OpenAI's GPT-5.5 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5). Reevaluate legacy prompts against this model; do not assume [GPT-5.6](gpt_5_6.md) or [GPT-6 Astra](gpt_6_astra.md) has the same defaults.

## Build an outcome-first baseline

Start with the smallest prompt that preserves the product contract. Specify the result, success criteria, permitted side effects, evidence scope, output, and stopping conditions. Keep step-by-step instructions where the path itself matters; remove routine process prescriptions and repeated rules.

GPT-5.5 follows instructions literally and thoroughly. Reserve absolute words for true invariants such as permissions and required fields. Use conditional rules for searching, clarifying, tool use, and persistence. For coding agents, explicitly cover reuse, delegation, validation, and when to continue or ask for help.

```text
Resolve the reported issue within the authorized scope. Complete allowed actions before answering. Use the minimum sufficient evidence and cite consequential factual claims. Continue when a useful fallback can resolve a missing fact. Stop once the requested result and required checks are complete; otherwise ask for the smallest blocking input. Do not trade correctness or required evidence for fewer tool calls.
```

## Separate personality, collaboration, and format

The default style is direct and task-oriented. If a product needs warmth or a more expressive voice, say what that means in observable writing choices. Keep personality short and separate from collaboration rules about questions, assumptions, proactivity, and uncertainty.

Set `text.verbosity` intentionally. The default is `medium`; test `low` for concise responses. Visible response length is separate from reasoning quality. Define the audience, required content, word budget, or section count when needed. Prefer prose for ordinary explanations and use formatting when it helps the reader compare or scan.

```text
Preserve the requested artifact, length, structure, and genre. Improve clarity and correctness without adding claims, sections, or a promotional tone. Lead with the answer, retain material caveats and next steps, and omit repetition and generic reassurance.
```

For streaming, multi-step tasks, a one- or two-sentence preamble can improve perceived responsiveness while the work continues. State the first useful step; do not narrate every tool call or expose private reasoning.

## Bound retrieval and ground creative work

Start ordinary Q&A with a broad search using discriminative terms. Retrieve again when the core question remains unanswered, a required fact is missing, a specific source must be read, the user requests comprehensive coverage, or an important claim would otherwise lack support. Do not keep searching merely to polish wording or cite optional detail.

Absence of evidence is not evidence of a factual "no." State uncertainty or ask for missing information. For drafts, slides, summaries, and launch copy, distinguish creative wording from product, customer, metric, roadmap, date, and capability claims. Support concrete claims with sources; use placeholders or labeled assumptions when evidence is missing.

## Make verification concrete

Give the model tools to check its output and ask for the checks the task needs: affected tests, applicable lint/type checks, package builds, or a minimal smoke test when full validation cannot run. Keep required repository checks. Report what could not run and the next best available evidence.

For visual work, render and inspect layout, clipping, spacing, missing content, and consistency before finalizing. For plans, identify requirement coverage, files/APIs/resources, data flow or state transitions, validation, failure behavior, and material open questions. This GPT-5.5 encouragement to verify should not become repeated self-check mandates in every later model's prompt.

## API and state checks

Use the Responses API for reasoning, tool-calling, and multi-turn work. Verify the actual SDK and provider before changing configuration.

| Area | GPT-5.5 guidance |
| --- | --- |
| Effort | The default and balanced starting point is `medium`. Evaluate `low` for latency-sensitive tasks that still need tools or planning. Reserve `none` for latency-critical work that does not need reasoning or chained tools. Increase to `high` or `xhigh` only for measured quality gains. |
| Effort regressions | Resolve contradictory instructions, open-ended tools, and weak stopping rules before increasing effort. More reasoning can increase searching or reduce quality when the contract is unclear. |
| Structured output | Prefer a supported Structured Outputs schema over duplicating the entire schema in prompt prose. Retain semantic requirements, missing-data behavior, and validation. |
| Continuations | Use `previous_response_id`, or replay the relevant returned output items for stateless/ZDR flows. Preserve each assistant item's original `phase` unchanged when managing history manually. |
| Phase | Intermediate assistant updates use `commentary`; completed answers use `final_answer`. Do not add `phase` to user messages. Check preambles, repeated tool calls, and final completion in the actual continuation loop. |
| Caching | Keep static instructions first and dynamic user context last. Use `prompt_cache_key` consistently for shared prefixes and track cached tokens. Do not silently apply GPT-5.6's caching migration contract to this model. |
| Compaction | Preserve completed actions, active assumptions, IDs, tool outcomes, unresolved blockers, and the next concrete goal. |
| Dates | The official guide says GPT-5.5 knows the current UTC date. Avoid redundant date injection unless the application needs a business timezone, policy-effective date, user-local date, or other specific reference date. |

Put tool-specific inputs, side effects, retry safety, and errors in concise tool descriptions. Keep cross-tool policy in the main instructions. Use hosted tools where they fit; use custom tools for internal systems and business-specific effects. Tool search can defer definitions in a large catalog. None of these API features is enabled merely by mentioning it in an Atomic skill.

## Image migration

The guide says unset/`auto` image detail uses `original` behavior, preserving images up to 10,240,000 pixels or a 6,000-pixel dimension limit. Explicit `high` preserves images up to 2,500,000 pixels or a 2,048-pixel dimension limit. `low` resizes images above a 512-pixel dimension limit more aggressively than earlier models. Check detail, cost, and visual task accuracy against the [image guide](https://developers.openai.com/api/docs/guides/images-vision); do not substitute GPT-5.6's limits.

Compare the migration on representative normal, missing-evidence, tool-failure, and permission-boundary cases. Measure accuracy, completeness, token use, and end-to-end latency. Change one prompt, model, or effort variable at a time so a regression has an identifiable cause.
