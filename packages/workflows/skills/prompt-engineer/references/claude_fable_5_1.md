# Claude Fable 5.1 prompting

Distilled from [Anthropic's Fable 5.1 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), checked September 22, 2026. Existing Fable 5 prompts are a useful baseline. The snippets are adaptations, not verbatim source quotations. Select the adjustment for an observed failure rather than appending every example.

## When long tool sequences look silent

If the client hides progress output, a prompt cannot fix that. Otherwise remove old rules such as "hold all findings until the end," then specify the cadence and a whole-task final recap.

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

At lower effort, explicitly trigger retrieval for unfamiliar names and fast-changing facts. Recognition is not evidence of current state.

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

The host owns history compaction; the prompt only controls what the summary keeps. Keep earlier turns unchanged, including thinking. To add a turn-scoped reminder, append it after the tool results in the current user message instead of rewriting an earlier copy, so the cached prefix stays valid.

## When a long deliverable exhausts the output budget

At high effort, a long artifact can run out of output room before it is finished. State the real limit and prioritize the final artifact:

```text
This request has a total output allowance of [actual output limit], including thinking and the answer. Reserve room for the complete requested deliverable. Settle its structure and difficult decisions without drafting the entire artifact twice. Return the artifact, not a reconstruction of private reasoning.
```

Replace the placeholder with the real limit; a prompt cannot raise it. For dense visual inputs, add: "Inspect the relevant regions with the available crop and zoom tools, checking labels and units before reporting values." Tools must actually be available.

## When legitimate coding work is refused

For false-positive refusals on benign coding tasks, supply documentation for unfamiliar languages or libraries, describe the bug you want fixed, and avoid asking for large encoded outputs such as base64 dumps. These clarify a benign task; they do not bypass safeguards. Do not ask for internal reasoning.

## Validate the prompt change

Check progress visibility, batching dependencies, scope, retrieval, quotations, and output completion on representative cases. Report checks not run; reading the prompt is not validation.
