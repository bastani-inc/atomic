# Claude Opus 5 prompting

Distilled from [Anthropic's Opus 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5), checked September 22, 2026. Existing Opus 4.8 prompts are a useful baseline. The snippets below are adaptable examples, not verbatim quotations or instructions to add all at once. Start with the behavior you observe and compare representative tasks after each change.

## When an end-to-end task is incomplete or drifts in scope

Give the full specification, intended result, constraints, and completion criteria up front. Opus 5 can carry difficult multi-file work through to completion without a prescribed sequence of routine steps, but may add work to a narrow request. State the boundary as well as the outcome.

```text
Implement the requested retry behavior in the client and its existing tests. Preserve the public API and unrelated behavior. Finish implementation and the repository's required checks. Make routine implementation decisions yourself; ask only when different interpretations would materially change the work. Report unrelated improvements rather than adding them.
```

Replace the example's scope with the actual request. This is not authorization to edit when the user asked only for an assessment, nor to proceed through an approval gate.

## When replies or written deliverables run long

Effort controls thinking, not reliable visible-response length. Specify chat length and artifact length separately. Prefer a positive example of the desired answer to a long list of forbidden phrases.

```text
Lead with the result and its material caveats. Keep the chat reply under 200 words unless I request detail. If a report is requested, cover its required sections without boilerplate or repeated summaries; the report's requested length is separate from the chat limit.
```

Keep evidence needed to support consequential claims. Do not shorten the actual deliverable merely because the status message should be brief.

## When agentic narration overwhelms the work

Opus 5 narrates readily. Specify when updates are useful and what they contain rather than suppressing all communication.

```text
Before the first tool call, give one sentence about the immediate goal. While working, update me only for a material finding, a change of direction, or a blocker. Finish with what changed, what was checked, and what remains unresolved.
```

For a more interactive product, increase that cadence explicitly. If correction narration is distracting, add: "State a correction briefly when it changes the user's code, conclusions, or decisions; fix inconsequential slips without a separate announcement." Never hide a consequential error.

## When repeated verification consumes time

Opus 5 self-corrects and verifies without generic reminders. Remove inherited advisory rules such as "double-check everything" or "always launch a verifier" when evaluations show no benefit. Replace them with the actual acceptance checks.

```text
Run the specified regression tests and required repository checks. Report their results and any limits. Do not add repeated verification passes unless a failure, uncertainty, or explicit requirement gives them a purpose.
```

This does not remove mandated tests, independent reviews, or evidence requirements. For bug discovery, vague severity filters can suppress valid findings; when a separate ranking pass is intended, use:

```text
Find supported bugs within the requested files. For each, give the trigger, evidence, impact, and location. Separate discovery from ranking; do not discard a supported finding merely because it is not high severity.
```

Do not apply that discovery instruction when the user explicitly requested only high-severity findings.

## When small tasks spawn too many agents

Permit delegation for substantial independent tracks and keep trivial work local. Give each delegate a non-overlapping scope and a concrete return contract.

```text
Keep work you can finish in a few tool calls local. Delegate only a substantial independent task that can overlap useful work you will do yourself. Give it file ownership and an evidence-based result to return. Use the smallest team that helps and obey the host's concurrency and spend limits.
```

Required independent review still applies. Prompt text does not enforce a concurrency cap; enforce limits in the host.

## When visual or document work misses details

Re-test workarounds inherited from older models. Provide templates for office deliverables and image tools for detailed visual work, rather than only asking the model to think harder.

```text
Use the supplied template and preserve its required sections. For each figure taken from the chart, inspect the relevant axis, legend, and units with the available crop or zoom tool. If the source is unreadable, mark the value uncertain instead of estimating it silently.
```

Use only tools actually available and authorized. Compare image inspection against higher effort rather than assuming higher effort is the cheaper solution.

## When thinking-disabled output contains fake tool calls or markup

Prefer thinking enabled with lower effort. If an integration must disable thinking, remove rules forbidding thought and use one combined instruction:

```text
You may give a brief user-facing sentence before a tool call. Use the actual tool interface, not printed call syntax. If no tool can express the requested action, say so rather than inventing a call. Keep internal or system markup out of the response.
```

Validate structured tool events in the host: printed syntax is not execution. Do not name internal thinking tags or ask for private reasoning as a workaround.

## Validate the prompt change

A custom system prompt does not inherit a harness preset's delegation instructions; restate the ones you need. Test a narrow edit, a review, a long report, and actual tool execution; compare scope, output length, supported findings, latency, and cost. Label checks not run.
