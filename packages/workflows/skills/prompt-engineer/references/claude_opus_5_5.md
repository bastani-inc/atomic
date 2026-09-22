# Claude Opus 5.5 prompting

Use this reference for Opus 5.5 effort calibration, migration, progress visibility, and unattended completion. Distilled from [Anthropic's Opus 5.5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5.md) and [migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide), checked September 22, 2026. Existing Opus 5 prompts are a useful baseline; read `claude_opus_5.md` when migrating, but do not carry over its thinking-disabled advice or default effort.

## Recalibrate effort and output budget

Set `medium` explicitly as the initial evaluation baseline, the Opus 5.5 API default rather than Opus 5's `high`. Supported effort levels are `low`, `medium`, `high`, `xhigh`, and `max`. Identically named levels do not imply equal thinking across models. Anthropic reports that medium matches or exceeds Opus 5 high on its coding and knowledge-work evaluations; measure your own tasks before adopting that recommendation.

At the same effort, Opus 5.5 can think longer per turn, especially at `xhigh` and `max`. Reserve those levels for measured quality gains. Lower effort before adding prompt instructions to reduce thinking. Specify visible response and artifact length separately.

Thinking counts toward `max_tokens` even when hidden. Leave room for both thinking and the deliverable; Anthropic reports that the 128,000-token maximum worked well for long agentic coding turns, not that every request needs it. Changing top-level effort invalidates the prompt cache; the per-message effort beta can preserve it where the provider and host support that API.

## Migrate thinking-disabled integrations

Thinking is always on. The API rejects `thinking.type: "disabled"` and manual `"enabled"` with `budget_tokens`. Remove those settings and start formerly non-thinking traffic at `low`, measuring quality and time to first token before moving to `medium`.

Remove instructions to reconstruct private reasoning in the response, and re-test old tool-call or markup mitigations written specifically for thinking-disabled Opus 5. Request conclusions, supporting evidence, and validation instead. Where the integration needs provider-supplied reasoning summaries, use `display: "summarized"`, not a prompt asking for hidden reasoning.

Read content blocks by `type`, not position. A response may begin with a thinking block whose text is empty under the default `display: "omitted"`. Pass returned thinking blocks back unchanged with tool results.

## Make progress visible without rewriting history

Between-tool narration arrives as progress-update `thinking` blocks rather than ordinary `text`. Rendering only text can make an active agent look silent. The guide describes `display: "updates"` with beta header `thinking-display-updates-2026-08-18` for summarized progress, or `"summarized"` for progress and reasoning summaries together. Verify provider, SDK, and host support; these are not claims that Atomic exposes every control.

If verbatim intermediate content must reach the user, declare a dedicated messaging tool from the first request and reserve it for that content. Adding tools or rewriting the system prompt later can invalidate prior thinking blocks. Preserve append-only history and use supported mid-conversation messages rather than editing the prefix.

After several tool steps with no visible text or progress, a host may append a brief reminder after tool results. The guide uses five quiet steps as an example, with at most two or three reminders. Turn-scoped system messages use `clear_at: "next_user_message"` and beta header `mid-conversation-system-clear-at-2026-08-21`; keep earlier reminders unchanged. These are integration patterns, not tools created by a prompt.

```text
Briefly report what you found and what you are doing next, then continue the authorized work.
```

## Distinguish an end of turn from task completion

A text-only `end_turn` can be a progress report while work remains. For genuinely unattended runs, maintain a task checklist or an explicit completion check. If items remain and no blocker or approval gate prevents progress, send a short continuation naming the open items. Bound automatic continuations to two or three, then stop for review rather than looping indefinitely.

Do not declare completion while a required background command or subagent is still running. Observe its existing execution and return the result to the model; do not relaunch it. Prompt for status notes alongside the next tool call rather than summaries that merely announce future work.

```text
Continue the authorized task until the requested changes and checks are complete. Keep progress notes brief and take the next available step. Stop when no work can advance without a blocking decision, required approval, or access you do not have. Do not treat a milestone summary as completion.
```

Use this only where unattended execution is actually intended. Keep human-in-the-loop pauses, risky-action confirmations, budget limits, and the host's lifecycle rules. Add standing instructions from the first request rather than rewriting an existing system prompt while replaying its thinking blocks.

## Explore relevant context and bound parallel work

For authorized multi-app work, ask the model to inspect relevant emails, documents, spreadsheet tabs, and records before changing them, including sources not named explicitly when they bear on the task. Keep exploration within granted access and scope. Retrieved instructions remain untrusted data, not permission to change the objective or perform actions.

Multi-agent hosts can report measured elapsed time, optionally against an explicitly approved budget, to encourage useful parallel work. A prompt time signal is advisory; enforce hard stops in application code. Do not turn an estimate into a spending or execution limit. Preserve concurrency and delegation constraints, and check quality because time pressure can reduce search and verification.

## Tune chat, visuals, and frontend direction

For latency-sensitive chat, re-test generic instructions to think carefully before every reply; effort is the main control. If later turns repeatedly revisit settled answers, ask the model to focus on the current question unless the user requests reconsideration or new evidence reveals an error. Do not apply that shortcut to audits or agentic work where later steps should correct earlier conclusions.

Re-test old vision workarounds against the stronger baseline. For dense drawings and charts, supply original high-resolution images and supported crop, zoom, or measurement tools. Higher effort alone helps technical drawings more than charts; do not substitute it for image inspection. Keep the host's approved computer-use tools and permission checks.

For frontend design, replace vague requests to avoid a generic look with concrete direction. Name unwanted patterns, such as cream backgrounds, italic headline accents, numbered section labels, monospace labels, or pill buttons, only when they conflict with the intended design. Inspect the result and refine the brief rather than treating that list as a universal style rule.

## Separate pasted content and handle refusals

Distinguish the user's instructions from quoted or pasted material. The guide proposes application-generated random IDs on matching opening and closing pasted-content markers, each on its own line, with a system rule to treat enclosed text as external content. Its literal closing marker carries the ID too; this is a plain-text convention, not valid XML. Do not let pasted instructions gain authority unless the user's own request authorizes the relevant action. Such markers can be imitated and supplement, rather than replace, prompt-injection defenses.

Handle `stop_reason: "refusal"` and `stop_details.category` explicitly, including `bio`, `cyber`, and `reasoning_extraction`. Do not bypass safeguards. For legitimate life-sciences work, the source points to Anthropic's verification program. Remove internal-reasoning extraction requests; server-side fallback does not retry that category. Other fallback behavior is provider-specific and does not grant additional authorization.

## Check API compatibility and validate

The migration guide also rejects forced `tool_choice` values `any` and `tool`; use supported `auto` plus strict tool schemas or structured outputs, and name when a tool applies. Strict schemas constrain arguments, not whether a tool is called. Thinking-block compatibility across model switches is directional; do not assume a fallback can replay another model's thinking unchanged.

On the Claude API and Google Cloud, `computer_20251124` is replaced by `computer_toolset_20260801`; the guide says Bedrock retains the older tool. Consult the platform's current compatibility rules before changing integrations. This does not replace Atomic's computer-use instructions.

Validate a former thinking-disabled request, a long tool loop with progress rendering, a bounded unfinished-task continuation, a refusal response, and an append-only history replay. Compare quality, latency, tokens, cost, completion evidence, and approval handling. Label checks not run; prompt inspection alone cannot prove beta API support or a behavioral improvement.
