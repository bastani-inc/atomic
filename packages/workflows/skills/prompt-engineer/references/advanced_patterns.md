# Advanced Prompting Patterns

Use these patterns for agents, tools, long context, multi-stage work, or model-specific tuning. Keep the common prompt portable; add a model-specific branch only when behavior or API controls differ.

## Model-Family Guidance

### GPT-5.6

- Prefer a lean, outcome-first contract with explicit success criteria, dependencies, tool routes, and stopping conditions. GPT-5-class models follow contracts closely, so remove contradictions and repeated rules.
- Set `text.verbosity` (`low`, `medium`, or `high`) for the request's default detail, then specify task-specific length and structure in the prompt. GPT-5.6 is concise by default; broad brevity instructions can make it too terse.
- Preserve the existing reasoning effort as a baseline. Compare that level and one lower on representative evals; use `high`, `xhigh`, or `max` only when measured quality justifies the cost.
- Expose only relevant tools. Parallelize independent reads, keep dependent calls sequential, and synthesize retrieved results before acting.
- Prefer the Responses API for reasoning with tools. In Chat Completions, function tools require effective reasoning `none`; do not silently trade away required tools or reasoning.

OpenAI measured leaner system prompts improving internal coding-agent scores by roughly 10–15% while reducing total tokens 41–66% and cost 33–67%. Treat these as directional and validate on your workload.

### Claude Opus 5

- Give the complete specification up front and allow the model to execute. Remove generic self-review instructions: Opus 5 already self-corrects and repeated rechecks add cost without quality gain.
- Start at `high` effort, compare `low` and `medium` where quality holds, and use `xhigh` for demanding coding or agentic work. Effort controls reasoning volume, cost, and latency; it does **not** reliably shorten visible responses.
- Constrain user-facing and written deliverable length explicitly, for example: “Lead with the outcome; use at most 300 words and three short sections.”
- Set a sparse progress cadence because Opus 5 produces frequent agentic updates: one sentence before the first tool call, then updates only for material findings or plan changes.
- Limit task expansion and delegation. It can perform large end-to-end tasks, but may add work or spawn subagents unless the prompt defines scope and a delegation decision rule.
- Keep adaptive thinking enabled when practical. Disabling it can leak tool calls as text or internal XML; at `xhigh` and `max`, disabling thinking returns a 400 error.

### Claude Fable 5

- Remove legacy prescriptive scaffolding. Fable 5 follows brief instructions strongly, sustains long autonomous runs, and can overplan or overbuild when higher effort meets an ambiguous task.
- Start at `high`; use `xhigh` for the hardest capability-sensitive work and `medium` or `low` for routine or interactive work. Adaptive thinking is required; manual extended-thinking budgets and disabling thinking are unsupported.
- Add grounded progress reporting for long runs: each completion claim should point to a tool result from the current session, with failed, skipped, or unverified work labeled accurately. Anthropic reports this nearly eliminated fabricated status reports in its tests.
- Define action boundaries and a no-promise stop rule. If an autonomous turn ends with an unexecuted plan or a request for permission already granted, continue with tools; stop only when complete or blocked on user-only input.
- Avoid surfacing context-token countdowns because they can prompt early wrap-up.
- Requests to echo, narrate, or explain internal reasoning as response text can trigger the `reasoning_extraction` refusal category and force fallback. Request cited evidence, conclusions, observed outputs, and validation receipts instead. If an application needs available reasoning visibility, consume API-provided summarized adaptive-thinking blocks rather than asking the model to generate a reconstruction.

## Agentic Prompt Structure

Use this compact structure for autonomous or tool-using prompts:

```text
Role: Maintain the customer account workflow.
Goal: Resolve the reported issue end to end.
Success criteria:
- decide eligibility from policy and account evidence
- complete every authorized action
- return completed_actions, customer_message, and blockers
Constraints: Keep changes in scope; confirm external, destructive, or costly actions.
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

## Delegation Damping

Both Opus 5 and Fable 5 can over-delegate. For an orchestrator, use one decision rule:

```text
Delegate only work that is genuinely independent and too large to finish in a handful of tool calls. Do not use subagents merely to recheck your own work. Prefer one subagent over several and cap concurrency.
```

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

Current Claude models allocate reasoning adaptively. Set effort first, then add a targeted prompt only if measured triggering remains wrong. `effort` is soft guidance; `max_tokens` is the hard per-request cap shared by reasoning and response text. Leave enough room for both.

Do not use visible chain-of-thought instructions or private-deliberation tags as a prompting technique. They are obsolete and can trigger Fable 5 safeguards. Ask for an answer supported by evidence, calculations, test results, or a concise decision rationale that does not solicit private deliberation.

In instruction prose, prefer “evaluate,” “assess,” or “consider” over “think,” particularly when Claude reasoning is disabled. Keep thinking configuration and effort stable within cache-sensitive conversations; changing effort invalidates Claude prompt-cache breakpoints.

## Prompt Chaining and Examples

Chain prompts when distinct stages need separate context, permissions, models, or output contracts—not merely because a task has several steps. Each stage gets one goal, a validated handoff schema, and its own stop rule. Useful pipelines include Research → Outline → Draft → Edit and Extract → Transform → Analyze → Present.

Run independent stages in parallel when they do not share mutable state. Use fresh-context review for genuinely high-risk artifacts when independence adds value; avoid automatic generate-review-repeat loops that duplicate current models' native self-correction.

Few-shot examples remain useful for unusual formats, classifications, and edge cases. Keep 3–5 only when evals show value, use `<examples>` and `<example>` tags for mixed prompts, and ensure every example obeys the written contract.