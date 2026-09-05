# Claude Fable 5 prompting

Use this reference for long autonomous tasks, progress reliability, delegation, and migration from Opus 4.8. Distilled from [Anthropic's Fable 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5), checked September 5, 2026. Apply model-specific changes to observed failures rather than importing every instruction into every task.

## Calibrate effort and task size

Start at `high` for most tasks. Use `xhigh` for the most capability-sensitive work and evaluate `medium` or `low` for routine or interactive tasks. Higher effort can improve verification on difficult work but also encourage unnecessary context gathering and planning on small tasks.

Give the model a complete goal, why it matters, and observable completion criteria. Test demanding end-to-end work as well as simple edits when evaluating adoption. Keep nearby refactors, defensive additions, and unrelated deliverables outside the requested scope.

Hard requests can run for many minutes and autonomous tasks much longer. Review streaming, client timeouts, progress indicators, and asynchronous monitoring for the actual workload. Do not raise repository test budgets or change execution policy merely because long model turns are possible.

## Use brief, explicit boundaries

Fable 5 follows short instructions strongly. Prefer a concise scope and output contract over lists of every possible over-elaboration. Specify necessary checkpoints once and preserve real permission requirements.

```text
Complete the requested change and its required validation. Keep edits within the stated scope. Continue work already authorized by the request; pause only for a blocking decision, missing permission, or unavailable prerequisite. Report completed work and the evidence for it in plain language.
```

If a turn ends with an unexecuted intention, continue with the actual tool call when authorized. Do not treat a plan as completion. Avoid exposing remaining-context countdowns that encourage premature handoffs. If the application compacts automatically, explain that behavior accurately rather than promising unlimited context.

## Ground progress and communicate clearly

Before reporting progress, compare each claim with actual tool results from the current session. Label failures, skipped checks, and unverified work. Anthropic reports this rule reduced fabricated status reports in its tests; verify its effect on your own workload.

For long conversations, prefer readable sentences over arrow chains, compressed implementation labels, or references to reasoning the user never saw. Lead with the outcome and retain the evidence and caveats the reader needs.

If the product needs an exact deliverable or direct reply displayed mid-task, the guide recommends a send-to-user tool whose input the client renders verbatim. Pair it with instructions identifying when to use it; defining the tool alone may not trigger use. Reserve it for content intended for the user, not internal reasoning or routine narration. Confirm the host implements such a tool before referring to it in a prompt.

## Delegate and verify according to the task

Fable 5 readily dispatches and sustains parallel subagents. Give explicit delegation conditions, independent ownership, and result expectations. Prefer asynchronous communication where supported. Long-lived delegates can reuse context across related subtasks, but they still need scope boundaries and a current assignment.

For long-running work, the official guide recommends a stated verification interval and fresh-context verifier subagents against the specification. Apply that pattern when the workload and orchestration policy call for it. Do not copy Opus 5's removal of generic verification into Fable 5 as a universal rule, or impose periodic verifier loops on trivial edits. Required repository checks remain binding.

When authorized, provide a small persistent notes file for lessons that should carry between runs. Record useful decisions and evidence, and review prior sessions to seed it. Do not turn memory into permission for unrelated edits or retain secrets unnecessarily.

## Remove obsolete instructions safely

Review legacy skills and procedures for overly prescriptive steps that worsen default performance. Propose or make instruction changes only within the user's authorization. Preserve safety, parser contracts, permission boundaries, and required validation while testing whether a shorter prompt improves results.

Do not ask the model to echo, transcribe, or reconstruct private reasoning in response text. The guide warns that this can trigger `reasoning_extraction` refusals and fallback to Opus 4.8. Request conclusions, citations, observed outputs, and validation evidence. If supported, consume API-provided thinking blocks for available reasoning visibility rather than asking the model to recreate them.

The source also describes possible refusals in offensive cybersecurity and biology or life-sciences work. Handle refusal and fallback explicitly under application policy; a prompting guide does not override those safeguards.

## Check the change

Evaluate a difficult bounded task, a routine edit, and an interrupted long run. Check completion, authorization, scope, accurate status, and actual tool execution. Compare effort levels separately from prompt changes. This prompting guide does not establish API compatibility for every provider or Atomic integration; consult the linked model introduction before changing request parameters.
