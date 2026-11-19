# Claude Fable 5 prompting

Use this reference for long autonomous tasks, progress reliability, delegation, memory, and migration from Opus 4.8. Distilled from [Anthropic's Fable 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5), checked November 9, 2026. Apply model-specific changes to observed failures rather than importing every instruction into every task. The prompt snippets below are adaptations for reuse in your own prompts, not verbatim quotes from Anthropic's guide, except the one labeled as Anthropic's reassurance.

## Turns run much longer by default

Hard tasks can run for many minutes per request, and autonomous runs can extend for hours, especially when the model gathers context, builds, and self-verifies. On ambiguous tasks, keep the model from overplanning:

```text
When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue in user-facing messages. If you are weighing a choice, give a recommendation, not an exhaustive survey. This does not apply to thinking blocks.
```

## Higher effort can widen scope on routine work

Lower effort still performs well on routine or interactive tasks. At higher effort on routine work, the model can gather context and deliberate beyond what the task needs, alongside strong verification and rigorous output. To curb unrequested scope growth:

```text
Do not add features, refactors, or abstractions beyond the task. Use the simplest design that fully satisfies the request. Avoid speculative handling for impossible scenarios, while preserving existing validation, required checks, and meaningful safety boundaries.
```

## Short instructions steer strongly; enumerating every case is unnecessary

Fable 5 follows brief instructions well. Un-steered, it can elaborate beyond what a task needs, especially at higher effort: surveying unpursued options, explaining root causes at length, or narrating what the next line does. A short brevity instruction replaces a long list of forbidden patterns:

```text
Lead with the outcome. Your first sentence after finishing should answer "what happened" or "what did you find." Supporting detail comes after. Being readable and being concise are different things; drop details that don't change what the reader would do next, but don't compress the writing into fragments or arrow chains.
```

The same brevity principle applies to checkpoint behavior; state the actual stopping condition rather than every case:

```text
Pause when a required approval, a destructive or irreversible action, a material scope decision, or missing input prevents progress. Otherwise continue already-authorized work without asking again. State the blocker rather than ending on a promise.
```

## Progress claims need grounding in actual tool results

On long autonomous runs, ask the model to audit its own status claims before reporting them:

```text
Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that.
```

Anthropic reports this nearly eliminated fabricated status reports in its testing; measure the effect on your own workload rather than assuming it transfers unchanged.

## Long-session summaries need re-grounding, not working shorthand

In extended agentic conversations, Fable 5 can write final summaries in the same dense, arrow-chain shorthand useful while working between tool calls, which a reader who did not see the work cannot follow:

```text
Your final summary is for a reader who did not see the work. Lead with the outcome, then explain what you need from them. Replace working shorthand and arrow chains with plain sentences that identify the relevant files, commits, or flags. Keep supporting evidence and material limitations.
```

## Unrequested actions and destructive commands need explicit boundaries

The model can occasionally take actions nobody asked for (drafting an unrequested email, creating defensive backup branches). Name what is and is not authorized, and require evidence before a state-changing command:

```text
When the user is describing a problem or thinking out loud rather than requesting a change, the deliverable is your assessment; report findings and stop. Before running a command that changes system state (restarts, deletes, config edits), check that the evidence actually supports that specific action. A signal that pattern-matches to a known failure may have a different cause.
```

## Rare early stops need a bounded continuation, not indefinite prompting

Deep into a long session, Fable 5 can occasionally end a turn with a text-only statement of intent instead of the matching tool call, or ask permission when it already has enough to proceed. For genuinely unattended pipelines, add a standing reminder:

```text
The user is not watching this unattended run in real time. Continue reversible actions already authorized by the request without routine check-ins. If the next step you describe is available and authorized, take it rather than ending on a promise. Stop when the task is complete, a required approval or budget boundary is reached, or no work can advance without a blocking decision or protected access.
```

If the harness re-prompts automatically, cap the number of continuations and surface a stuck task for review; that cap is harness policy, not part of Anthropic's guide.
Use the unattended wording only when it is true; retain interactive approval gates. A task asking only for findings does not authorize a fix.

## Context-budget countdowns trigger handoff offers

In very long sessions the model can occasionally suggest a new session, offer to summarize and hand off, or trim its own work. Anthropic says this is most often triggered when the harness shows a remaining-token countdown. Avoid surfacing context-budget counts where possible. If the harness must show them, Anthropic's reassurance is:

```text
You have ample context remaining. Do not stop, summarize, or suggest a new session on account of context limits. Continue the work.
```

Use it only when the statement is true for the host.

## Delegation scales with explicit ownership, not implicit trust

Fable 5 dispatches and sustains parallel subagents readily. Give explicit delegation conditions, independent file or task ownership, and expected evidence; prefer asynchronous communication over blocking on the slowest subagent:

```text
Delegate independent subtasks to subagents and keep working while they run. Intervene if a subagent goes off track or is missing relevant context.
```

For long-running work, a stated verification interval with fresh-context verifier subagents against the specification tends to outperform self-critique:

```text
Establish a method for checking your own work at an interval of [X] as you build. Run this every [X interval], verifying your work with subagents against the specification.
```

Apply this where the workload and orchestration policy call for it. Do not carry Opus 5's removal of generic verification into Fable 5 as a universal rule, and do not impose periodic verifier loops on trivial edits; required repository checks remain binding regardless.

## Memory across runs needs an explicit place to write

Where authorized, give the model a persistent notes file and instructions for maintaining it:

```text
Store one lesson per file with a one-line summary at the top. Record corrections and confirmed approaches alike, including why they mattered. Don't save what the repo or chat history already records; update an existing note rather than duplicating it; delete notes that turn out to be wrong.
```

To bootstrap from prior sessions: "Reflect on the previous sessions we've had together. Use subagents to identify core themes and lessons, and store them in [X]." Do not let memory become authorization for unrelated edits, and avoid retaining secrets unnecessarily.

## Verbatim mid-task content needs a dedicated delivery path

For long asynchronous agents where the user must see specific content exactly as written before the task ends (a generated snippet, a direct answer mid-loop), the source recommends a client-side tool whose input is rendered verbatim rather than summarized. Defining the tool is not enough; pair it with an explicit instruction naming when to use it, and reserve it for user-facing content, not narration:

```text
Between tool calls, when you have content the user must read verbatim, call send_to_user with that content. Use it only for user-facing content, not for narration or reasoning.
```

Confirm the host actually implements such a tool before referring to it in a prompt.

## Requests for its reasoning can trigger refusals

Fable 5 runs safety classifiers for offensive cybersecurity, biology and life-sciences content, and extraction of its reasoning. Benign work in these areas can still be refused. Do not ask the model to echo, transcribe, or reconstruct its internal reasoning in the response; that request pattern can trigger the `reasoning_extraction` refusal category, and server-side fallback with `fallbacks: "default"` does not retry those refusals. Audit migrated skills and system prompts for show-your-thinking instructions. A short explanation of the answer or a summary of the actions taken is still fine; read thinking blocks when the application needs reasoning visibility.

## Validate the prompt change

Evaluate a difficult bounded task, a routine edit, and an interrupted long run. Check completion, authorization, scope, accurate status, and actual tool execution. Change one prompt variable at a time.
