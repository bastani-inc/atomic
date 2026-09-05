# Advanced Prompting Patterns

Use these patterns for agents, tools, long context, multi-stage work, or model-specific tuning. Keep the common prompt portable; add a model-specific branch only when behavior or API controls differ.

## Choose model-specific guidance separately

The [skill's model table](../SKILL.md#model-guides) routes to one page per model, each linked to its official source. Read the target page before selecting effort, verification cadence, delegation, or API controls. Keep those differences out of a shared prompt unless the application deliberately branches by model.

## Agentic Prompt Structure

Use this compact structure for autonomous or tool-using prompts:

```text
Role: Maintain the customer account workflow.
Goal: Resolve the reported issue end to end.
Success criteria:
- decide eligibility from policy and account evidence
- complete every authorized action
- return completed_actions, customer_message, and blockers
Constraints: Keep changes in scope; confirm external, destructive, or costly actions when authorization is missing.
Tools: Retrieve policy before deciding; use the account tool only after identity and eligibility are established.
Output: Lead with the outcome; return the three required fields in valid JSON.
Stop rules: Answer when required evidence and actions are complete. If one required fact is missing, ask for that smallest field. Stop on a permission or policy block and name it.
```

State the current work layer—research, design, implementation, review, or external coordination—when crossing layers would change authorization. For long work, request a short initial preamble and sparse outcome-based progress updates, not routine tool-call narration.

## Tool Routing

Tool descriptions should say what the tool does, when it applies, important return fields, side effects, permissions, and error behavior. Omit tools the agent cannot call or the task cannot need.

Write decision rules rather than aggressive triggers:

```text
Check the recent local cache first. Fetch only when the required artifact is absent or stale.
Before an account mutation, retrieve the governing policy and current account state.
If a search is empty or suspiciously narrow, try one or two materially different queries before reporting no result.
```

Independent reads can run in parallel; calls whose parameters depend on earlier output stay sequential. Do not guess tool arguments. Define retries, fallback, and a stop condition. Validate the final user-visible result as well as tool success.

Use programmatic tool calling only for bounded deterministic reduction such as filtering, joining, ranking, deduplication, batching, or aggregation of large structured results. Prefer direct calls when each result changes the next decision, approval is required, or citations and semantic judgment must remain visible.

## Delegation and independent verification

Delegate bounded independent work when the expected time or quality benefit exceeds coordination cost. Define ownership, expected evidence, and concurrency limits. Preserve required independent reviews.

Calibrate additional delegation and verification to the target model. Opus 5 often needs redundant self-checking removed; Fable 5's guide recommends periodic independent verification for long work; Astra and Opus 4.8 may need encouragement to delegate. Do not turn any of these tendencies into a blanket rule for every task.

Keep orchestration asynchronous when the harness supports it, synthesize all returned work, and prevent agents from editing the same surface concurrently.

## Long Context

Place long documents and data near the top, with the instruction or query at the end. Anthropic measured up to about 30% better response quality from query-last ordering, especially for complex multi-document inputs.

```xml
<documents>
  <document index="1">
    <source>report-a.pdf</source>
    <document_content>...</document_content>
  </document>
  <document index="2">
    <source>report-b.csv</source>
    <document_content>...</document_content>
  </document>
</documents>

Using only these documents, compare the reported risks. Cite the source beside each claim and state material conflicts or missing evidence. Return at most 500 words.
```

Quote grounding can focus retrieval in noisy inputs. Require only quotes that support consequential claims; excessive extraction can waste context and obscure synthesis.

## Adaptive Thinking and Effort

Check the target model's thinking default, supported effort levels, and output budget before tuning. Effort names do not guarantee equal reasoning volume across versions. On supported Claude thinking requests, `max_tokens` covers both thinking and visible response; leave room for both. Change effort separately from prompt wording to identify the cause of regressions.

Do not use visible chain-of-thought instructions or private-deliberation tags as a prompting technique. They are obsolete and can trigger Fable 5 safeguards. Ask for an answer supported by evidence, calculations, test results, or a concise decision rationale that does not solicit private deliberation.

Keep earlier conversation items intact when replaying state. Caching and thinking-history binding rules differ by model and API; read the model page before changing effort, system instructions, or the replayed prefix.

## Prompt Chaining and Examples

Chain prompts when distinct stages need separate context, permissions, models, or output contracts—not merely because a task has several steps. Each stage gets one goal, a validated handoff schema, and its own stop rule. Useful pipelines include Research → Outline → Draft → Edit and Extract → Transform → Analyze → Present.

Run independent stages in parallel when they do not share mutable state. Use fresh-context review when required or when independence adds value, and bound repair conditions. Additional review loops should address a task-specific risk or measured model behavior.

Few-shot examples remain useful for unusual formats, classifications, and edge cases. Keep 3–5 only when evals show value, use `<examples>` and `<example>` tags for mixed prompts, and ensure every example obeys the written contract.