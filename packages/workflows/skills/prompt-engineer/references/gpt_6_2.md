# GPT-6.2 Astra and Sol prompting and migration

Use this reference when targeting `gpt-6.2-astra` or `gpt-6.2-sol`, or migrating from GPT-6.1 Sol, GPT-6 Astra, or GPT-6 Sol. Distilled from [OpenAI's GPT-6.2 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.2-astra), the [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) and [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) model pages, and the [keep the prefix unchanged](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged) guide, checked November 18, 2026. For GPT-6.1 Sol, see [gpt_6_1_sol.md](gpt_6_1_sol.md); for GPT-6.1 Terra, see [gpt_6_1_terra.md](gpt_6_1_terra.md).

OpenAI offers the guide's prompts as a starting point for the whole GPT-6.2 family and says they address behaviors seen on GPT-6.2 Astra and Sol. Its behavior list is written for Astra. Apply a template only to a failure you observe on your model and workload. The snippets below are adaptations, not verbatim OpenAI quotations.

## Choosing Astra or Sol

OpenAI positions GPT-6.2 Astra for the most demanding tasks and GPT-6.2 Sol for complex work at lower cost, its "go-to model for everyday work, from coding to powering agents at scale". This is positioning, not a measured result for your workload. Standard API prices are $8 input and $40 output per million tokens for Astra, and $2 and $10 for Sol, the same as GPT-6.1 Sol. Compare both on representative tasks at the same effort before choosing.

## Start with the task contract

Keep the outcome, relevant context, task boundaries, evidence, output format, and completion criteria explicit. Begin with the prompt that already works, then change one prompt or configuration variable at a time.

```text
Complete [requested outcome] using [relevant context]. Stay within [scope].
Preserve [binding constraints] and stop before [actions requiring approval].
Return [required format], including [evidence and validation results].
If a required fact is unavailable, identify it rather than inventing it.
```

Replace the placeholders with the actual task. A review-only request does not authorize implementation, and a local coding request does not authorize publishing or external writes.

## When migrating effort

Both models reject reasoning effort `none`. OpenAI's migration checklist recommends `medium` for a new integration and `low` in place of an existing `none` or `minimal`. OpenAI's Codex catalog lists `low`, `medium`, `high`, `xhigh`, and `max` for both. A prompt cannot enable an unsupported effort or replace the request configuration. Both models support Chat Completions, but tool calling requires the Responses API.

Keep the prompt fixed while comparing efforts. Measure completion, correctness, tool behavior, latency, tokens, and cost. OpenAI notes that higher effort can help the model persist through final checks on long tasks; treat that as a hypothesis to test, not a default.

## When answers are too terse or carry working shorthand

OpenAI reports that GPT-6.2 Astra writes more concisely and directly by default than earlier models. When migrating, revisit instructions such as "be concise": they may now cut required content. Name what the response must keep instead.

```text
Lead with [conclusion]. Use the terms the user and sources use, and keep the
technical detail that makes the answer precise. Include [required facts,
evidence, and material caveats]. Give enough context to follow the reasoning.
```

During long tasks, the model can carry shorthand from its reasoning, tool calls, or other agents into the final answer. Ask for a self-contained result:

```text
Write the final answer for a reader who has not seen your progress updates.
Do not reuse working shorthand, abbreviations, or phrasing from your reasoning,
tool calls, or instructions to other agents.
```

For material drafted for someone else, such as an email or an external post, tell the model who will read it and what background that reader lacks. When editing existing text, tell it to keep the author's content and wording except where the user asked for changes.

## When it stops to confirm work it was authorized to do

OpenAI reports that when intent is unclear, GPT-6.2 Astra may propose a next step and wait for confirmation. For work that can proceed without supervision, state the outcome and which decisions need the user.

```text
Continue the authorized, in-scope work until [completion criteria] are met.
Make reasonable, reversible assumptions and state them. Stop only when the scope
changes significantly, you are blocked, the user must decide, or before
[irreversible or destructive actions and other approval boundaries].
Before finishing, check that every part of the request is done and verified.
```

OpenAI's own template also encourages actions such as creating worktrees, resolving merge conflicts, and opening draft pull requests. Include such actions only when the application authorizes them; keep real approval gates, review-only scope, and publishing limits. If the host offers an asynchronous question tool, the model can ask while continuing independent work. Write that instruction only when the tool exists.

## When code changes ignore project conventions

OpenAI reports that GPT-6.2 Astra tends to write more efficient code than its predecessors. Describe the conventions and the behavior existing callers rely on rather than assuming the model will infer them.

```text
Reuse existing logic, types, and APIs where they preserve correctness. Before
consolidating or removing code, keep the behavior its callers rely on unless the
task changes it. Add tests when [project rule], or to catch a regression the
existing suite would miss. Prefer readable code over shorter code, and avoid
abstractions that add indirection without removing complexity.
```

Adjust the test rule to the repository: OpenAI's template skips new tests unless they are requested, required, or catch a specific regression, which conflicts with projects that require tests for every change.

## When a frontend lacks the intended look

If the interface needs a particular look, name the imagery and typography, including a typeface when it matters. Ask for interface text only where it informs, helps navigation or action, or was requested. A reference image, from design software or generated, can carry details that are hard to describe; ask the model to build, render, and refine against it when the host can render.

## When the conversation prefix changes

Starting with GPT-6.2, the API drops reasoning items when it detects changes to earlier conversation history, a model downgrade, or a change of end user or organization. Without them, quality can decline and the model may repeat earlier work. Edits to the prefix also cut prompt-cache reuse from the changed point onward.

- Append new or changed instructions as a new message instead of editing an earlier system or developer message.
- Put reusable instructions in a `developer` message as the first item of `input`. Starting with GPT-6.2, the Responses API appends the top-level `instructions` field after `input`, so text there is not part of a cacheable prefix; keep `instructions` for guidance that applies only to the current request.
- Leave the request's `tools` parameter and the order of its definitions unchanged. To add tools mid-conversation, append an `additional_tools` input item with the `developer` role and a `tools` array, and replay it at its original position on later requests; to narrow which tools a turn may call, use `tool_choice` with `allowed_tools`. Changing the `tools` list itself is a prefix change. See OpenAI's [keep the prefix unchanged](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged) table.
- Change reasoning effort or output format mid-conversation through the API's configuration updates, not by editing the original request.
- Shorten long tool output before it first reaches the model rather than truncating it afterwards.

These are host behaviors, not prompt wording. Check what the application actually sends before relying on them, and keep the opening instructions stable across turns.

## Validate one adjustment

Use a representative normal task, a multipart coding task, an early-stop case, a format-sensitive answer, a writing task for an external reader, and a permission-boundary case. Compare the unchanged baseline with one adjustment at the same effort. Verify completion, output validity, required evidence, tool calls, respected approval boundaries, and cost. Then compare effort or model separately if needed. Report checks that were not run; do not claim an improvement without observed results.
