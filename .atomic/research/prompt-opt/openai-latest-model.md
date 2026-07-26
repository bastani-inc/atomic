---
latestModelInfo:
  model: gpt-5.6-sol
  migrationGuide: /api/docs/guides/upgrading-to-gpt-5p6-sol.md
  promptingGuide: /api/docs/guides/prompt-guidance-gpt-5p6.md
---

# Using GPT-5.6

## Introduction

GPT-5.6 sets a new quality and efficiency baseline for complex production workflows. GPT-5.6 is especially token-efficient and improves frontend aesthetics, including layout, visual hierarchy, and design judgment.

GPT-5.6 also introduces a new naming scheme. The `gpt-5.6` alias routes requests to `gpt-5.6-sol`, the model for flagship capability. Use `gpt-5.6-terra` for strong performance at a lower price and `gpt-5.6-luna` for efficient, high-volume workloads.

When migrating from GPT-5.5 or GPT-5.4, start with your current GPT-5.5 or GPT-5.4 reasoning setting, then test the same setting and one level lower on representative tasks. GPT-5.6 can often maintain or improve quality with fewer tokens, but the best setting depends on your workload.

## What is new

- **Programmatic Tool Calling:** GPT-5.6 can write JavaScript to call eligible tools, pass results between calls, and process intermediate outputs in a hosted runtime. Use [Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) for bounded, tool-heavy workflows that do not require fresh model judgment between each step. Programmatic Tool Calling is ZDR-compatible with no additional container costs.
- **Multi-agent [beta]:** [Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent) lets a GPT-5.6 instance coordinate multiple subagents in parallel and synthesize their results. Similar to ultra mode in Codex, this can reduce wall-clock time and improve performance for complex tasks that divide cleanly into independent workstreams. Multi-agent is available as a beta feature in the Responses API as we iterate on developer feedback.
- **Explicit prompt caching:** GPT-5.6 lets you mark exactly which reusable prompt prefixes OpenAI caches. You can still use automatic caching in implicit mode. OpenAI bills cache writes at 1.25× the uncached input rate, while cache reads remain discounted. Learn how to [configure prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- **Persisted reasoning:** GPT-5.6 can reuse available reasoning items across turns to improve multi-turn quality and cache efficiency. Use `reasoning.context` to select the behavior. Learn how to [preserve reasoning across calls](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-across-calls).
- **Max reasoning effort:** GPT-5.6 supports `max` reasoning effort for demanding tasks that need more exploration and verification. If you currently use `xhigh`, compare both settings on representative workloads.
- **Pro mode:** GPT-5.6 can perform more model work to improve reliability on difficult tasks and return a single final answer. Enable it with `reasoning.mode: "pro"` when quality matters more than latency and token usage. Learn how to [use pro mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode).
- **Token efficiency:** GPT-5.6 reaches frontier performance with fewer output tokens.
- **Frontend design:** GPT-5.6 creates more polished and usable websites and applications, with stronger layout, visual hierarchy, and design judgment.
- **Intent understanding:** GPT-5.6 can better infer the user's underlying goal and intended level of work from context, so you often do not need to prescribe every step. Continue to provide domain context, hard constraints, approval boundaries, and success criteria. Tell the model when an important ambiguity should trigger a question.
- **Original image detail:** GPT-5.6 preserves the original dimensions of images sent with `original` or `auto` detail instead of resizing them to a patch budget or pixel-dimension limit. Large images can use more input tokens and increase latency. Learn how to [choose an image detail level](https://developers.openai.com/api/docs/guides/images-vision#choose-an-image-detail-level).

## Safeguards

When using GPT-5.6 models, users may encounter safeguards that block or refuse some requests due to real-time cyber and biology misuse classifiers that are run as model outputs are generated. Other requests may take longer because generation is paused for several seconds mid-stream while these classifiers synchronously review outputs. Safeguards may occasionally intervene on legitimate work, particularly in dual-use areas where defensive and offensive activity can initially look similar.

If your application serves individual end users, send a stable, privacy-preserving `safety_identifier` with each request. See [Implement safety identifiers](https://developers.openai.com/api/docs/guides/safety-best-practices#implement-safety-identifiers) for guidance.

We are continuously evolving these safeguards so that they are robust and effective in holding up to adversarial pressure, while preserving access to legitimate work such as code review, vulnerability research, patch development, debugging, security education, and defensive testing.

<div id="migrate-to-gpt-56" aria-hidden="true"></div>

## Migration quickstart

### Migrate with Codex

Codex can apply the recommended changes in this guide with the [OpenAI Docs skill](https://github.com/openai/skills/tree/main/skills/.curated/openai-docs).

```text
$openai-docs migrate this project to the GPT-5.6 model family
```

To use this skill in other coding agents, download it from the [OpenAI skills repository](https://github.com/openai/skills/tree/main/skills/.curated/openai-docs).

### Update API and model parameters

- Choose the target model for the workload. Use `gpt-5.6-sol` for frontier capability, `gpt-5.6-terra` for a balance of intelligence and cost, or `gpt-5.6-luna` for efficient, high-volume workloads. The `gpt-5.6` alias routes requests to `gpt-5.6-sol`.
- Use the [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses) for reasoning, tool-calling, and multi-turn workflows.
- Set `reasoning.effort` intentionally. GPT-5.6 supports `none`, `low`, `medium`, `high`, `xhigh`, and `max`.
  - If you are migrating from GPT-5.5 or GPT-5.4, preserve your current reasoning effort as the baseline, then compare one level lower.
  - If you use `none`, keep it as your latency baseline and also test `low` when the workflow benefits from reasoning or tool use.
  - Use `medium` as a balanced starting point and `low` for latency-sensitive workloads.
  - Use `high` or `xhigh` when more reasoning produces a measured quality gain.
  - Reserve `max` for the hardest quality-first workloads. Compare `max` and `xhigh` to find the best quality, latency, and cost tradeoff for your use case.
- To use pro mode, keep your selected GPT-5.6 model and set `reasoning.mode` to `pro` in the Responses API; do not switch to a separate Pro model slug. Choose `reasoning.effort` independently. If you omit it, GPT-5.6 defaults to `medium` in both standard and pro modes. See [reasoning mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode) for a request example and billing details.
- Configure persisted reasoning based on how much prior reasoning is still relevant.
  - Omit `reasoning.context` or set it to `auto` to use the model's default. Check the response's `reasoning.context` field to confirm the effective mode.
  - Set `reasoning.context` to `all_turns` when the task's goals, assumptions, and priorities stay stable across turns.
  - With `all_turns`, continue with `previous_response_id` to make reasoning from earlier responses available to the model.
  - When managing history manually, preserve and resend previous user inputs and every response output item. For `store: false` or Zero Data Retention, replay the encrypted reasoning items that the API returns by default.
  - Set `reasoning.context` to `current_turn` when earlier reasoning is no longer relevant.
- Review prompt caching. You do not need to change code to keep using implicit caching. Because GPT-5.6 cache writes cost 1.25× the uncached input rate, track `cached_tokens` and `cache_write_tokens` to understand net cost. Use explicit breakpoints or `prompt_cache_options.mode: "explicit"` to avoid unnecessary writes, and replace `prompt_cache_retention` with `prompt_cache_options.ttl`.
- To use Programmatic Tool Calling, add the `programmatic_tool_calling` tool and opt eligible tools in with `allowed_callers`. Update your application to handle `program` items, program-issued function calls, and `program_output` items while preserving each call's `call_id` and `caller` linkage. See the [Programmatic Tool Calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) for request and continuation examples.
  - Benchmark the PTC-enabled workflow on representative tasks. Compare task success, final-answer completeness, required evidence, total tokens, latency, and cost. Fewer calls, turns, or intermediate outputs are improvements only when the final answer still meets the required quality bar.

## Prompting best practices

### Favor leaner prompts

Removing repeated instructions and examples and simplifying tool descriptions can improve task performance and token efficiency. In a sample of internal coding-agent eval runs, configurations with leaner system prompts improved evaluation scores by roughly 10–15% while reducing total tokens by 41–66% and cost by 33–67%. Results will vary by workload, so treat these ranges as directional and validate changes on representative tasks from your own application.

To simplify prompts without losing important guidance:

- Start with a prompt and tool set that already works. Remove one group of instructions, examples, or tools at a time, then rerun the same evals.
- State each instruction once.
- Expose only tools relevant to the task, and keep their descriptions concise and precise.
- Keep examples and style guidance when they encode a product requirement or correct a measured gap.
- Track context both at the start of a run and as the conversation grows. Long sessions can amplify repeated prompt and tool content.

### Define autonomy and approval boundaries

GPT-5.6 can be proactive and persistent when carrying out multi-step tasks. Define what level of action each request authorizes so the model can continue safe, in-scope work without unnecessary pauses while stopping before external, destructive, costly, or scope-expanding actions.

A compact policy is usually sufficient:

```text
For requests to answer, explain, review, diagnose, or plan, inspect the relevant
materials and report the result. Do not implement changes unless the request also
asks for them.

For requests to change, build, or fix, make the requested in-scope local changes
and run relevant non-destructive validation without asking first.

Require confirmation for external writes, destructive actions, purchases, or a
material expansion of scope.
```

Name safe local actions explicitly, such as reading files, inspecting logs, editing in-scope code, and running tests. Keep the policy in one place and state each rule once. Repeating instructions such as “ask first,” “do not mutate,” or “wait for approval” can cause unnecessary approval requests for safe, expected actions.

### Set response length and style

GPT-5.6 tends to be more concise by default than GPT-5.5. When migrating, check whether broad brevity instructions such as “Be concise” or “Keep it short” are still useful. They may be unnecessary for some tasks and can sometimes make responses too brief. Keep them when they reliably produce the output your application needs.

For more consistent control across requests, use `text.verbosity` to set the default level of detail, then use the prompt for task-specific requirements.

#### Set a default with `text.verbosity`

Choose `low`, `medium`, or `high` as the default level of detail for a request. In the prompt, specify any task-specific length, structure, or required content. See [Set up `text.verbosity`](https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-textverbosity) for an API example.

#### Specify what a short answer must include

When a task calls for a shorter answer, identify the information the model must preserve and the detail it can omit. For example:

```text
Lead with the conclusion. Include the evidence needed to support it, any material
caveat, and the next action. Omit secondary detail and repetition.

Keep all required facts, decisions, caveats, and next steps. Trim introductions,
repetition, generic reassurance, and optional background first.
```

This gives the model a clear priority order: preserve the content needed to complete the task, then remove lower-value detail.

#### Define the tone

Broad labels such as “friendly” or “empathetic” can be ambiguous. Describe the writing choices that define your product's tone, such as how directly to state the answer, when to acknowledge a problem, and whether reassurance or a sign-off is appropriate.

```text
State the answer directly. If the user reports a problem, acknowledge the
specific issue before giving the next step. Use reassurance only when it is
relevant. Omit generic praise and unnecessary sign-offs.
```

### Pro mode

#### Choose pro mode when quality matters most

Pro mode is a Responses API execution mode that applies more model work to a request before returning a single final answer. It can improve reliability on difficult tasks, but it increases latency and aggregates the tokens from that work in reported usage. Those tokens are billed at the selected model's standard token rates.

Use pro mode when a marginal quality improvement materially affects the outcome and the task is difficult enough to benefit, such as complex optimization, high-value coding or review, or deep analysis with clear evaluation criteria. Prefer standard mode for routine, latency-sensitive, or high-volume work, and whenever your evaluations do not show a meaningful gain from pro mode.

Reasoning mode and reasoning effort are independent. Pro mode works with any GPT-5.6 model and its supported reasoning efforts. Start with the same model and effort as your standard-mode baseline, then compare configurations on representative tasks instead of assuming that the highest effort is always the best tradeoff.

#### Configure pro mode in the API

Enable pro mode in the API request. Keep the same outcome-focused prompt you use in standard mode: state the goal, relevant context, constraints, required evidence, success criteria, and output format. You do not need to ask the model to “use pro mode,” “think harder,” or generate several candidate answers.

For example:

```text
Review this database migration plan for failure modes that could cause data loss
or extended downtime. For each finding, cite the relevant step, estimate impact
and likelihood, and recommend a specific mitigation. Return the five most
important risks in severity order.
```

#### Compare quality and cost

Compare standard and pro modes on the same representative tasks. Measure task success, answer completeness, required evidence, total tokens, latency, and cost. Use pro mode selectively where its quality or reliability gain justifies the extra model work.

Learn more in the [reasoning mode guide](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode).

### Programmatic Tool Calling

#### Choose Programmatic Tool Calling by task shape

Programmatic Tool Calling (PTC) works best for bounded workflows where code can process several tool results or large intermediate outputs and return a much smaller structured result. Use it for filtering, joining, ranking, deduplication, aggregation, validation, or other predictable processing.

Multiple, parallel, or dependent calls alone do not justify Programmatic Tool Calling. Prefer direct, non-PTC tool calls when:

- One call is sufficient
- The intermediate outputs are already small
- Each result may change the model’s next decision
- An action requires approval
- The final output must preserve citations or native artifacts

#### Make routing instructions task-specific

Do not rely on tool availability or generic instructions such as “use Programmatic Tool Calling efficiently” to produce the right route. When both direct and programmatic calling are available, explicitly state:

- Which bounded stage should use Programmatic Tool Calling.
- Which tools it may call.
- The exact output schema and required evidence.
- Concurrency, retry, and stopping limits.
- Which work should remain direct.

Tool descriptions should document their expected return fields, types, and error behavior. If the model cannot determine the return shape before writing the program, prefer direct tool calling so it can inspect the result before deciding how to use it.

If both routes are needed, define one clear handoff and tell the model not to switch routes or repeat completed work.

For example:

```text
<tool_orchestration>
Use Programmatic Tool Calling for [bounded stage] using only [eligible tools].
Run independent calls concurrently when safe. Use only documented tool input
and output fields.

Process and reduce the intermediate results, then emit exactly [output schema],
including the evidence needed for the final answer.

Stop when [condition] is met. Retry transient failures at most [R] times.
Do not repeat completed calls or perform side-effecting actions. If a required
result is still missing, return a clear structured failure.

Use direct tool calls for [semantic judgment, approval, or final validation].
</tool_orchestration>
```

#### Assess the final answer

The `program_output` item and final assistant `message` are separate outputs; make sure to test both. In theory, a program can return the correct records while the message omits a required field, citation, or caveat.

Compare direct and programmatic calling on the same representative tasks. Check whether the final response is correct, complete, and includes the required evidence. Then compare total tokens, latency, cost, calls, turns, and retries. Count lower resource use as an improvement only when the response still passes your existing evals.

Learn more in the [Programmatic Tool Calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling).