# Claude Fable 5.1 prompting

Use this reference for Fable 5.1 migration or observed changes in progress reporting, tool batching, completion, and conversation replay. Distilled from [Anthropic's Fable 5.1 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1), checked September 5, 2026. Existing Fable 5 prompts are a useful baseline; adjust for observed differences.

## Sweep effort again

Start at the default `high`, then evaluate `low`, `medium`, `xhigh`, and `max` on your tasks. Matching effort names across Fable versions does not mean matching reasoning volume. Lower effort can save cost where quality holds, but `low` is less likely to search or retrieve current information.

For long prose or code deliverables, prefer `high` unless higher effort improves measured quality. At `xhigh` and `max`, the model may spend substantial output budget preparing a deliverable before writing the answer. Set `max_tokens` for both thinking and the final response. If needed, tell it the actual output limit and ask it to reserve room for the deliverable, without asking it to expose private reasoning.

## Make progress visible

Fable 5.1 produces fewer updates during long tool sequences. Check the client before adding prompting: progress-update `thinking` blocks are empty with the default `thinking.display: "omitted"`. The guide describes `display: "updates"` with beta header `thinking-display-updates-2026-08-18`, or `"summarized"` for updates plus summarized reasoning. Verify provider and SDK support and render the returned updates; these settings do not imply Atomic support.

Remove old instructions that suppress narration. If more updates are still needed, specify a sparse cadence and content:

```text
Before a long operation, briefly state what it will establish. Report material findings and blockers as work proceeds. The final response should cover the whole requested task and its validation, not just the last step.
```

Tell the model when tool output is hidden from the user, so it does not rely on a command's output as its user-facing explanation.

## Batch independent work

In coding and computer-use loops, implied independent calls can be issued one per turn. A short reminder after tool results can reduce unnecessary round trips: "Batch independent tool calls in this turn; keep calls that need earlier results sequential."

The guide places repeated reminders in turn-scoped system messages with `clear_at: "next_user_message"` and beta header `mid-conversation-system-clear-at-2026-08-21`. Without that beta, append the reminder after `tool_result` blocks in the same user message. Preserve earlier turns unchanged. This is an integration pattern to implement only where the request path supports it.

When subagents are supported, let the launch tool return promptly, deliver results later, and provide a separate wait tool. The lead can continue independent work while children run. Preserve task ownership, concurrency limits, and dependencies; prompt text alone does not create asynchronous orchestration.

## Preserve conversation history

Append assistant turns exactly as returned, including thinking blocks. Do not rewrite earlier system instructions, tool lists, messages, or per-turn reminders while replaying thinking from the old prefix.

For accounts created on or after August 31, 2026, the guide states that Fable 5.1 thinking blocks bind to the exact producing conversation. A changed prefix can return a 400. The beta `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, with `thinking-binding-controls-2026-08-01`, drops affected blocks instead; inspect `input_transformations` to diagnose edits. Do not treat dropping blocks as preserving their reasoning.

Use supported mid-conversation system messages for updates and server-side compaction or context editing for trimming. If compacting on the client, a simple safe shape is a new summary plus the new user turn, carrying no old thinking blocks. Tell the summary to retain task constraints, decisions, unfinished work, and exact identifiers needed to continue. Evaluate compaction timing against current cache costs rather than inheriting an early-compaction rule.

## Finish the requested work within scope

Define completion through implementation, inspection, and repairs when those are requested. For unattended execution, say that the user is not watching only when that is true. Continue already-authorized steps instead of ending with "Next, I'll..." or asking permission again. Preserve explicit confirmation gates and ask for a blocking decision when necessary.

Constrain nearby fixes, extra features, and committed test code to the requested outcome. Keep required checks and meaningful regressions. Prefer targeted edits for small and medium changes; whole-file rewrites are appropriate when the file is short or most of it changes.

## Tune writing, retrieval, and vision

Break dense prose into short sentences and paragraphs. Remove blanket anti-formatting rules inherited from earlier models; allow headers, lists, and emphasis when they clarify structure. For source summaries, give one complete example that distinguishes paraphrases from quoted passages, attributes both, and explains why it is correct. Adapt any tool names in examples to the actual environment.

At `low` effort, require current facts to be checked with available search or retrieval tools. Search unfamiliar names as supplied rather than treating recognition as proof of current knowledge. If omissions persist, evaluate a higher effort level for those turns.

For dense charts and images, provide the original media and crop/zoom tools. A cropped, enlarged region lets the model inspect details instead of guessing from a whole-image view.

## Handle refusals and validate

Treat `stop_reason: "refusal"` as an explicit outcome. For benign coding false positives, supply documentation for unfamiliar languages, ask about bugs rather than relying solely on compile-check phrasing, and remove unnecessary base64 blobs from tool output. These measures clarify legitimate tasks; they do not authorize bypassing safeguards. Do not solicit internal reasoning as response text.

Test a long tool loop, a current-information query at low effort, and a history replay before rollout. Check visible updates, result correlation, completion, scope, and quoted-source attribution. Compare exact outgoing request prefixes if replay fails. No prompt-only test proves a provider supports the beta integration features above.
