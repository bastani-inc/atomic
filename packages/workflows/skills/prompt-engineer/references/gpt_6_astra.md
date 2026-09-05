# GPT-6 Astra prompting and migration

Use this reference when targeting `gpt-6-astra`, migrating a prompt to Astra, or diagnosing early stops, excessive verification, or conflicting skills. Keep other model variants separate. Guidance checked on September 5, 2026 against [OpenAI's model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).

## Define completion and permission once

Astra follows detailed instructions closely and may ask questions where earlier models made assumptions. Define the intended finished result, including implementation, inspection, repairs, and any authorized final action. Treat action requests such as "can you fix this" as requests to do the work. Continue through work already authorized by the conversation; ask when a missing decision would materially change the result or permission is actually absent.

Before asking for final approval, prepare the authorized, reversible work so the user can review a concrete result. Do not turn this into blanket permission for destructive actions, publication, deployment, or external mutations. Preserve higher-priority policy, repository requirements, and explicit user boundaries.

Adapt this example to the real environment:

```text
Implement the requested fix and verify the affected behavior. The local tests use disposable fixtures and have no production access. Run them, repair failures caused by this change, and rerun affected checks without asking again. Complete the repository's required checks. Stop when the requested behavior and required checks pass, or when a specific missing decision or permission blocks progress. Prepare a reviewable diff; deployment is not authorized.
```

If exploration beyond the first implementation is intended, name the questions to explore and the stopping condition. Avoid an automatic "pause after first implementation" rule unless that review gate is needed.

## Audit instructions that change behavior

Astra is sensitive to skills and repository instruction files. Check the relevant loaded instructions for conflicting completion rules, stale model workarounds, mandatory broad research, or approval language that blocks already-authorized work. Use the instruction audit in [quality_improvement.md](quality_improvement.md) when these symptoms appear.

Explicit user preferences override advisory skill defaults, subject to system/developer instructions and real authorization requirements. A skill cannot grant permission or override higher-priority policy. When a skill causes an unexpected pause or scope change, identify its exact `SKILL.md` path, quote the instruction, and distinguish its requirement from your interpretation. Do not silently remove binding constraints in the name of brevity.

## Calibrate testing and delegation

Run checks appropriate to the change and all required repository checks. Broaden or repeat them only after a new change, a failure, or an unresolved concern. Avoid tests that merely repeat implementation text for reversible, low-impact edits. Keep regression tests that exercise behavior and failure modes.

Astra may delegate less than desired. When the application supports collaboration, explicitly allow independent tasks to run in parallel if that saves time or improves quality. Give each delegate a bounded objective, ownership, and expected evidence; respect the harness's concurrency limits. Keep dependent work sequential and synthesize results before acting. Claude-specific delegation damping is not an Astra default. Inter-agent messages should be legible to humans, with proper spacing and clear identifiers.

## Control writing directly

Astra tends toward detailed, formatted responses. Specify the audience, necessary detail, and output shape instead of assuming the concise defaults of GPT-5.6. Prefer a clear first sentence and short paragraphs. Use lists or tables when they help comparison or sequence. Use familiar words and concrete verbs; remove stock conclusions, repeated slogans, unnecessary contrasts, and technical jargon that does not help the reader. Preserve consequential caveats and validation evidence.

```text
Lead with the result. Use short, plain paragraphs and include only the evidence, caveats, and next action needed by this reader. Use a list only for parallel items. Avoid canned headings such as "Bottom line" and unnecessary contrasts such as "This isn't X, it's Y."
```

## API migration checks

These are API capabilities, not promises that every agent harness exposes them. Verify the SDK, provider, and request path before adding parameters.

| Area | Astra migration rule |
| --- | --- |
| Model and effort | Set `model: "gpt-6-astra"`. Preserve existing effective reasoning effort; when migrating from `none` or `minimal`, start with `low` and evaluate. Astra does not support `none`. Use `reasoning.effort` in Responses or `reasoning_effort` in Chat Completions. |
| Tools | Use Responses for tool calling. Astra supports Chat Completions, but tool calling requires Responses. |
| Sampling and log probabilities | Remove `temperature`, `top_p`, and `top_logprobs`. Remove Chat Completions `logprobs`; remove `message.output_text.logprobs` from Responses `include`. |
| Cache migration | From GPT-5.5 or earlier, replace `prompt_cache_retention` with `prompt_cache_options.ttl: "30m"`. Review cache boundaries and cache-write billing in the [caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences). |
| Changing effort | In supported standard single-agent requests, use a `configuration_update` input item to change effort without changing request-level `reasoning.effort` and the cached prompt prefix. The update persists until replaced. Check the [compatibility limits](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation) first. |
| EU data residency | Use Standard processing. Astra does not support `service_tier: "fast"` or `"priority"` with EU data residency. Fast mode has no latency SLA. |

Async tools can free the model to handle independent work while a tool runs. Mark a supported function or custom tool `async: true`; the application still executes the tool, manages pending work, and returns its result with the original `call_id`. Do not assume dependency ordering or cancellation happens automatically. See [async tool calling](https://developers.openai.com/api/docs/guides/async-tool-calling).

Mid-turn steering over Responses WebSockets can carry revised instructions into a continuation while preserving completed work. Reconcile completed actions, pending tool results, and the new scope rather than repeating side effects. Consult the [steering event flow](https://developers.openai.com/api/docs/guides/steering) before implementing it. Prompt text alone does not enable async execution or steering in Atomic or another harness.

## Check the change on representative cases

Compare a normal task, an early-stop case, and a permission boundary case. Check whether the agent completes authorized work, asks only blocking questions, runs the required checks without repetitive expansion, and respects forbidden actions. For API migrations, also validate the request payload and tool-result flow. Keep prompt edits, model changes, and effort experiments separate so failures have an identifiable cause. Do not claim a measured improvement without running the comparison.
