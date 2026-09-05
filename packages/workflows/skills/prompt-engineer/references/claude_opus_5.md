# Claude Opus 5 prompting

Use this reference for Opus 5 response length, scope, verification, and delegation tuning. Distilled from [Anthropic's Opus 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5), checked September 5, 2026. Existing Opus 4.8 prompts are a useful starting point; retest effort and remove obsolete instructions selectively.

## Give the complete task and calibrate effort

Provide the specification, intended result, relevant constraints, and completion criteria up front. Opus 5 performs well on difficult multi-file and end-to-end work, but narrow tasks still need an explicit scope boundary to prevent unrequested additions.

Start at the default `high`. Evaluate `low` and `medium` wherever quality holds, including code review, and use `xhigh` for demanding coding or agentic tasks. Effort controls thinking volume and latency; reducing it does not reliably shorten the visible response.

## Control response and artifact length separately

Specify conversation length and the length of written deliverables directly. Reports and Markdown files can run long even when chat replies are brief. Positive examples of the desired communication style are more useful than a long list of forbidden phrases.

```text
Lead with the result and its material caveats. Keep the chat response under 200 words. Write a report only if requested; keep that report within the requested sections and length. Preserve evidence needed to support the conclusions.
```

Opus 5 narrates agentic work readily. For a quiet interface, request an initial short update followed by messages for material findings or blockers. If more interaction is useful, give examples and specify its cadence. Limit correction narration to errors that affect the user's understanding or next action.

## Remove redundant verification, retain required checks

Opus 5 self-corrects and verifies without generic reminders. Review inherited instructions such as "double-check every answer," "always add a final verification step," or "use a subagent to verify." Remove redundant advisory instructions when evaluations show no benefit; they can compound with native behavior and waste work.

This does not cancel repository checks, requested regression tests, independent review requirements, or evidence needed for a completion claim. Keep those concrete obligations and constrain work to the requested outcome.

For bug finding, vague severity filters can suppress valid findings because the model follows them literally. If a separate stage ranks or filters findings, ask the discovery stage to cover supported bugs first. In a single pass, state a concrete reporting threshold and honor any severity restriction the user explicitly requested.

## Bound delegation

Opus 5 delegates readily. Allow substantial independent tracks where the benefit exceeds coordination cost, specify file ownership and evidence, and cap concurrency or spend in application code. Avoid splitting a small task merely to create parallel work.

The guide names Claude Code and Claude Agent SDK controls `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, and `max_budget_usd`, requiring Claude Code 2.1.217 or later. These are not Atomic controls. With a custom system prompt, do not assume the Claude Code preset's delegation instruction is present.

## Keep thinking enabled when practical

Thinking is on by default. It can be disabled only at effort `high` or below; `xhigh` and `max` require it. Prefer enabled thinking with lower effort for cost-sensitive work rather than disabling it without evaluation.

With thinking disabled, the model can write a tool call as visible text instead of emitting structured `tool_use`, so nothing executes. It can also emit internal XML. Remove instructions forbidding thinking or reasoning, which can increase leakage.

If the integration must disable thinking, explain that brief user-facing text before a tool call is allowed, that it may answer directly when no tool fits, and that internal markup does not belong in the response. The guide favors a general markup rule over naming particular internal tags. Still validate actual structured tool calls; printed syntax is not execution. Do not ask for private reasoning text as a workaround.

## Vision and rollout checks

For dense charts, documents, diagrams, or visual replication, provide tools to crop, inspect, and verify images. Re-evaluate old vision workarounds before retaining them. For office tasks, supply required templates and styles instead of relying on generic preferences.

Compare representative edits, a review task, and a long deliverable at several effort levels. Inspect output length, supported findings, scope, delegation cost, and actual tool execution. Consult the source's linked migration guide before changing API controls, and verify that the chosen provider and host expose them.
