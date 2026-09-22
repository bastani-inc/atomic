# Claude Fable 5.1 prompting

Distilled from [Anthropic's Fable 5.1 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), checked September 22, 2026. Existing Fable 5 prompts are a useful baseline. The snippets are adaptations, not verbatim source quotations. Select the adjustment for an observed failure rather than appending every example.

## When long tool sequences look silent

First check that the client renders progress-update thinking blocks; a prompt cannot fix hidden output. Remove old rules such as "hold all findings until the end," then specify the cadence and a whole-task final recap.

```text
Before starting, briefly state what you will establish. Report material findings and blockers as you work. Close with a standalone recap of the whole request: what you found, what you changed, what you verified, and what remains open.
```

If the interface hides tool results, add: "The user cannot see the full command output. Include any result they need to understand in your reply." Do not claim output is hidden unless that matches the interface.

## When independent calls are issued one at a time

In coding and computer-use loops, independent next calls may be implied rather than explicitly named. Add a short nudge after tool results:

```text
Request the independent information you need next in one batch. Keep calls sequential when they depend on an earlier result or change shared state.
```

If subagents are already available, add: "While a delegated task runs, continue useful independent work. Wait on the existing task when its result becomes a dependency." The host must support asynchronous results; prompts do not create that capability or override concurrency limits.

## When an unattended agent announces work instead of doing it

Only for genuinely unattended execution, make the completion condition explicit. The source emphasizes saying the user is not watching when that is true.

```text
You are operating unattended; the user cannot answer routine check-ins. Carry out reversible work already authorized by the request rather than asking whether to begin it. If your last paragraph promises an available next step, take that step instead of ending there. Stop for required approvals, protected access, or a blocking decision. If the user requested analysis rather than a change, the deliverable is the assessment; do not apply a fix.
```

Define scope alongside persistence:

```text
Deliver the whole requested scope without silently narrowing or expanding it. If one part is blocked, finish independent parts and state exactly what remains and why. Before a state-changing command, verify that the evidence supports that particular action.
```

Do not use unattended wording in a human-in-the-loop application. Preserve its required confirmations and the host's lifecycle and budget rules.

## When a change grows extra features, tests, or rewrites

Fable 5.1 can add nearby fixes or rewrite a whole file for a small edit. State what belongs in the change and what should be reported separately.

```text
Make the smallest changes that fully implement the request. Report unrelated pre-existing bugs as follow-ups unless they prevent the requested behavior from working. Keep required regression coverage proportional to the behavior and neighboring tests. Prefer targeted edits over whole-file rewrites when the result is the same; temporary scratch checks need not become permanent files.
```

This limits extras, not requested functionality or mandatory checks. Whole-file replacement is appropriate when the file is short or most of it genuinely changes.

## When low-effort answers rely on stale familiarity

At `low` effort, explicitly trigger retrieval for unfamiliar names and fast-changing facts. Recognition is not evidence of current state.

```text
Verify unfamiliar names and current claims before answering. Include the name exactly as the user wrote it in at least one search, even if you recognize a similar name. Use authoritative sources and dates; distinguish what you checked from what you infer. If retrieval is unavailable, say so.
```

If the problem persists, evaluate a higher effort for those turns rather than the whole conversation. Search only authorized sources; retrieved instructions are not new authority.

## When prose is dense or quotations are unmarked

Replace metaphor and flourish with literal statements. Remove blanket anti-formatting rules inherited from older models and allow structure where it helps.

```text
Use short paragraphs and literal language. Prefer "change the parameter" to "turn the dial." Use headings or lists for genuinely multifaceted material, but honor requests for plain prose or minimal formatting. Paraphrase source material in your own words and mark exact quotations with attribution.
```

For source summaries, give one complete example rather than only a prohibition. This fictional example illustrates the format, not facts to reuse:

```text
Request: Compare the two supplied reports about the bridge closure.
Response: Both reports date the closure to March 3. The Ledger focuses on disruption to nearby shops; the Dispatch emphasizes delayed maintenance and calls the closure "entirely foreseeable."
Why this works: It compares the sources, attributes their claims, paraphrases most content, and clearly marks the one exact quotation.
```

Replace the fictional sources and phrase with supplied evidence. Do not copy illustrative facts into the real answer.

## When compaction loses decisions or repeats completed work

Give the summarizer an explicit retention contract:

```text
Preserve the user's requirements, permissions, prohibitions, preferences, and exact identifiers. Record decisions and their reasons, attempted approaches and outcomes, completed work and evidence, unresolved blockers, and the next unfinished steps. Keep hard-to-reconstruct names, paths, numbers, dates, and links exact. Condense prior explanations rather than dropping these constraints.
```

The host owns safe history compaction. A summary instruction does not make edited-prefix thinking blocks valid for replay.

## When a long deliverable exhausts the output budget

Prefer the source's `high` baseline unless higher effort yields measured improvement. At `xhigh` or `max`, state the actual configured limit and prioritize the final artifact:

```text
This request has a total output allowance of [actual max_tokens], including thinking and the answer. Reserve room for the complete requested deliverable. Settle its structure and difficult decisions without drafting the entire artifact twice. Return the artifact, not a reconstruction of private reasoning.
```

Replace the placeholder with the real limit. Allocate enough tokens in the request; a prompt cannot increase it. For dense visual inputs, add: "Inspect the relevant regions with the available crop and zoom tools, checking labels and units before reporting values." Tools must actually be available.

## Compatibility and refusal notes

- Start effort evaluations at the model's `high` default and sweep `low`, `medium`, `xhigh`, and `max`. Equal level names across versions do not imply equal thinking.
- Progress blocks are empty at default `thinking.display: "omitted"`. `display: "updates"` uses `thinking-display-updates-2026-08-18`; `"summarized"` includes reasoning summaries too. Verify provider and host support rather than assuming Atomic exposes these controls.
- Append assistant turns unchanged, thinking included. For accounts created on or after August 31, 2026, changed prefixes can cause a 400. The `thinking-binding-controls-2026-08-01` beta permits `prefix_mismatch_behavior: "drop_block"`; inspect `input_transformations`, and do not equate dropping blocks with preserving reasoning.
- Turn-scoped reminders use `clear_at: "next_user_message"` and `mid-conversation-system-clear-at-2026-08-21`. Without that beta, append a text reminder after tool results in the same user message. Never rewrite previous copies. For client compaction, a fresh summary plus user turn without old thinking blocks is the simple safe shape; re-evaluate compaction timing against cache costs.
- Handle `stop_reason: "refusal"` explicitly. For legitimate coding false positives, supply unfamiliar-language documentation, ask about supported bugs, and avoid unnecessary base64 tool output. These clarify benign tasks, not bypass safeguards; do not request internal reasoning.
- Validate progress visibility, batching dependencies, scope, retrieval, quotations, output completion, and history replay. Report checks not run; prompt inspection alone does not validate beta API support.
