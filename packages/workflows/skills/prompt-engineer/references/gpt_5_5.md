# GPT-5.5 prompting and migration

Use this reference when targeting `gpt-5.5`. Guidance checked on September 5, 2026 against [OpenAI's GPT-5.5 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5). Snippets below are adaptations for prompt authors, not verbatim official quotes. Reevaluate legacy prompts against this model; do not assume [GPT-5.6](gpt_5_6.md) or [GPT-6](gpt_6.md) has the same defaults.

## When starting or migrating a complex workflow

Observed behavior: GPT-5.5 works best from an outcome-first contract. It follows specific instructions literally and thoroughly, so inherited step lists and repeated rules can make it mechanical or over-constrained.

Prompt adjustment: state the destination, success criteria, permitted side effects, evidence rules, output shape, and stopping conditions. Keep step-by-step process only where the product requires that exact path.

Adaptable prompt:

```text
Resolve the user's request end to end within the authorized scope.

Success means:
- the requested result is complete
- allowed local actions are completed before the final answer
- consequential factual claims are supported by evidence or labeled assumptions
- required validation is run or its absence is explained
- blockers name the smallest missing input or permission

Choose the efficient path. Do not trade correctness, required evidence, or approval boundaries for fewer tool calls.
```

Caveats: reserve `always`, `never`, `must`, and `only` for true invariants such as permissions, safety, required fields, or forbidden actions. Use conditional rules for searching, clarifying, tool use, delegation, and persistence.

## When the product needs a particular tone or format

Observed behavior: GPT-5.5 is direct and task-oriented by default, with more polish than earlier models. Customer-facing products may need explicit warmth, rationale, or structure; internal tools may need terse answers.

Prompt adjustment: separate personality from collaboration rules and output format. Define observable writing choices rather than broad labels.

Adaptable prompt:

```text
Tone: steady, direct, and practical. Acknowledge the user's specific issue when they report a problem. Avoid generic praise, sign-offs, and filler reassurance.

Collaboration: make reasonable assumptions when the request is clear enough to attempt. Ask only when missing information would materially change the answer or create meaningful risk.

Output: lead with the answer. Keep material caveats, required evidence, and next steps. Use short paragraphs by default; use bullets only when they improve comparison or scanning.
```

Caveats: do not use tone instructions to hide uncertainty, omit caveats, or soften required refusal/permission boundaries. Set `text.verbosity` intentionally where supported; visible length is separate from reasoning quality.

## When a long or tool-heavy task feels slow to start

Observed behavior: GPT-5.5 may spend time reasoning or preparing tool calls before visible output. A short preamble can improve perceived responsiveness without narrating private reasoning.

Prompt adjustment: request a brief user-visible first step for multi-step tasks, then let work continue.

Adaptable prompt:

```text
For a multi-step or tool-using task, begin with one short user-visible update that acknowledges the request and states the first useful step. Then continue with the task. Do not narrate every tool call or reveal private reasoning.
```

Caveats: avoid preambles for latency-critical single-turn answers where the extra text is noise. If your application manually replays assistant items, preserve returned `phase` values exactly.

## When retrieval can sprawl or under-support claims

Observed behavior: GPT-5.5 handles grounded workflows well when evidence rules and retrieval budgets are explicit. Without them, it may search too much or overstate missing evidence.

Prompt adjustment: define what needs citation, when another retrieval is warranted, and how to behave when evidence is absent.

Adaptable prompt:

```text
For ordinary Q&A, start with one broad search using short, discriminative terms. Search again only when the core question remains unanswered, a required fact is missing, a specific source must be read, the user asked for exhaustive coverage, or an important claim would otherwise be unsupported.

Do not search again merely to improve wording, add optional examples, or cite nonessential detail. Absence of evidence is not proof of a factual no. State uncertainty, use placeholders, or ask for the smallest missing input when needed.
```

Caveats: user requests for comprehensive research, regulated evidence, legal/business-critical decisions, or source-specific summaries may require broader retrieval. For creative drafts, distinguish source-backed facts from generated wording.

## When drafting creative or customer-facing artifacts

Observed behavior: GPT-5.5 can produce polished drafts, but polish can tempt it to fill gaps with unsupported specifics.

Prompt adjustment: state which claims must be sourced and which parts may be creative.

Adaptable prompt:

```text
Write a useful draft, but keep factual claims grounded. Use provided or retrieved evidence for product capabilities, customer names, metrics, dates, roadmap status, legal/compliance claims, and competitive comparisons. Do not invent specifics to make the draft sound stronger.

If support is missing, use a placeholder, a generic phrasing, or a clearly labeled assumption. Preserve the requested length, genre, and structure unless the user asks to change them.
```

Caveats: unsupported placeholder text is acceptable only when the user can review or fill it. Do not present assumptions as facts.

## When the task needs validation

Observed behavior: GPT-5.5 benefits from concrete validation instructions, especially in coding, planning, and visual work. Generic “double-check” prompts are weaker than naming the check.

Prompt adjustment: identify relevant checks and what to report when they cannot run.

Adaptable prompt:

```text
After making changes, run the most relevant available validation: targeted tests for changed behavior, type or lint checks when applicable, build checks for affected packages, or a minimal smoke test when full validation is too expensive. If validation cannot run, say why and name the next best evidence.
```

For visual artifacts:

```text
Render the artifact before finalizing when the environment supports it. Inspect layout, clipping, spacing, missing content, responsive behavior, and visual consistency. Revise until the rendered result matches the requirements, or report that rendering was unavailable.
```

Caveats: do not turn validation into repeated self-check loops with no new evidence. Keep required repository checks and user-requested regressions.

## Compatibility notes

Verify the actual SDK and provider before changing configuration.

- API path: use Responses for reasoning, tool-calling, and multi-turn work.
- Effort: default is `medium`. Evaluate `low` for latency-sensitive tasks that still need tools or planning. Reserve `none` for latency-critical work that does not need reasoning or chained tools. Increase to `high` or `xhigh` only for measured quality gains.
- Effort regressions: resolve contradictory instructions, open-ended tools, and weak stopping rules before increasing effort; more reasoning can increase unnecessary searching when the contract is unclear.
- Structured outputs: prefer supported schema validation over duplicating an entire schema in prose; keep semantic requirements, missing-data behavior, and validation rules in the prompt.
- Continuations: use `previous_response_id` or replay relevant returned output items for stateless/ZDR flows. Preserve assistant `phase` values unchanged when manually replaying history; do not add `phase` to user messages.
- Caching: keep static instructions first and dynamic user context last. Use `prompt_cache_key` consistently for shared prefixes and track cached tokens.
- Compaction: preserve completed actions, active assumptions, IDs, tool outcomes, unresolved blockers, and the next concrete goal.
- Dates: the official guide says GPT-5.5 knows the current UTC date. Add explicit date/timezone context only for business-specific, policy-effective, user-local, or other non-UTC references.
- Images: unset/`auto` uses `original` behavior up to 10,240,000 pixels or 6,000 pixels per dimension; explicit `high` preserves up to 2,500,000 pixels or 2,048 pixels; `low` resizes above 512 pixels more aggressively. Check cost and accuracy on visual tasks.
- Tool features, hosted tools, tool search, compaction, and phase handling are not enabled merely by mentioning them in an Atomic skill.

## Validate the prompt change

Compare representative normal, missing-evidence, tool-failure, style-sensitive, visual if relevant, and permission-boundary cases. Measure accuracy, completeness, token use, end-to-end latency, required evidence, and whether the model stops at the right time. Change one prompt, model, or effort variable at a time.
