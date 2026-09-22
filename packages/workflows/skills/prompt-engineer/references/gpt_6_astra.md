# GPT-6 Astra prompting and migration

Use this reference when targeting `gpt-6-astra`, migrating a prompt to Astra, or diagnosing early stops, excessive verification, under-delegation, or writing-style drift. Guidance checked on September 5, 2026 against [OpenAI's model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra). Snippets below are adaptations for prompt authors, not verbatim official quotes.

## When it asks before doing authorized work

Observed behavior: Astra is more likely than earlier GPT models to ask focused questions when missing information could change the outcome. That is useful for risky ambiguity, but it can stall tasks where the conversation already authorizes reversible local work.

Prompt adjustment: define what counts as authorized progress, what still needs approval, and that approval should happen after the model prepares a concrete result. Do not use this to bypass destructive actions, deployments, external writes, purchases, or scope changes.

Adaptable prompt:

```text
Infer the user's intended result from the current request and prior conversation. When the request asks to fix, build, inspect, draft, or update something, do the authorized local and reversible work instead of stopping at a plan or asking whether to proceed.

Complete the work that can be done safely first: inspect relevant context, make in-scope changes, run non-destructive checks, and prepare a concrete result. Ask when a missing decision would materially change the result, permission is absent, or a required approval gate applies. Do not re-request authorization already granted. Deployment, publishing, merging, and irreversible changes require explicit authorization.
```

Caveats: keep real approval gates. If the user asked for review-only work, do not edit. If the task is broad exploration, name the exploration questions and stopping point instead of asking Astra to persist indefinitely.

## When skills or repo instructions change behavior

Observed behavior: Astra follows loaded instructions closely, including `AGENTS.md`, skills, and other context files. Stale or conflicting guidance can cause early pauses, broad research, or unrequested review gates.

Prompt adjustment: tell it how to surface instruction conflicts and how to prioritize explicit user direction against advisory skill text, without weakening higher-priority instructions.

Adaptable prompt:

```text
Follow applicable instructions according to their actual priority. Treat skills and reference files as task guidance, not permission to change the user's requested outcome or override higher-priority requirements.

If a loaded instruction makes you pause, ask permission, expand scope, or leave requested work unfinished, name the exact file, quote the relevant sentence, and explain whether it is a binding requirement or an advisory interpretation. Do not silently discard security, permission, validation, or repository rules.
```

Caveats: this is diagnostic guidance. It does not authorize ignoring project rules or policy. Use the shared instruction-audit reference when conflicts repeat.

## When responses are too formatted or too long

Observed behavior: Astra tends toward detailed Markdown, recurring phrases, tables, and broad explanations. It can be steered strongly toward a product's house style.

Prompt adjustment: state the audience, first sentence, permitted structure, and what to trim first. Avoid generic style labels alone.

Adaptable prompt:

```text
Lead with the result in a plain sentence. Use short paragraphs by default. Use bullets or a table only when the information is parallel, sequential, or easier to compare.

Preserve the evidence, material caveats, and next action the reader needs. Trim introductions, generic reassurance, stock conclusions, repeated contrasts, and jargon that does not help the reader act. Do not use canned headings such as "Bottom line" unless the requested format requires them.
```

Caveats: do not trim contractual fields, citations, validation evidence, or warnings the user needs. For technical audiences, plain language still includes exact identifiers, commands, and API names when they matter.

## When it under-delegates or over-serializes work

Observed behavior: Astra can use parallel collaborators effectively, but may delegate less than a harness expects unless told when parallelism is useful.

Prompt adjustment: identify independent tracks, expected evidence, and synthesis rules. Prompting cannot create subagents or raise concurrency limits; the host must provide those tools.

Adaptable prompt:

```text
When the host provides collaboration tools, parallelize independent work that can save time or improve quality. Give each delegate a bounded objective, owned files or sources, and the evidence it must return. Keep dependent work sequential. Synthesize results before editing or making claims, and respect the host's concurrency, cost, and ownership limits.

Messages to other agents may be read by humans. Use clear spacing, exact identifiers, and enough context for the recipient to act without guessing.
```

Caveats: do not split a small task just to use parallelism. Delegation is not approval to widen scope or skip validation.

## When it tests too broadly or repeats checks

Observed behavior: Astra can be thorough on coding tasks and may run broader or repeated verification than a small change needs.

Prompt adjustment: name required checks, meaningful targeted checks, and when to broaden.

Adaptable prompt:

```text
Run tests and checks proportionate to the change. For small reversible edits, prefer targeted behavior checks and required repository checks. Broaden or rerun tests when a check fails, you change code after a check, the risk justifies it, or a repository rule requires it.

Do not add tests that merely restate the implementation. Do not repeat a passing check unless a later change could have invalidated it. Report checks that were not run and the best evidence available.
```

Caveats: do not use this to skip required CI-equivalent checks, safety checks, release gates, or user-requested validation.

## Compatibility notes

These are API capabilities, not promises that every agent harness exposes them. Verify the SDK, provider, and request path before adding parameters.

- Model and effort: set `model: "gpt-6-astra"`. Astra does not support `none`; when migrating from `none` or `minimal`, start with `low` and evaluate. Use `reasoning.effort` in Responses or `reasoning_effort` in Chat Completions.
- Tools: use Responses for tool calling. Astra may support Chat Completions, but tool calling requires Responses.
- Sampling/logprobs: remove `temperature`, `top_p`, `top_logprobs`, Chat Completions `logprobs`, and Responses `message.output_text.logprobs` includes where unsupported.
- Caching: when migrating from GPT-5.5 or earlier, replace `prompt_cache_retention` with `prompt_cache_options.ttl: "30m"`; review cache boundaries and cache-write billing.
- Changing effort: `configuration_update` can change effort in supported standard single-agent Responses requests without rewriting the cached prompt prefix. Check compatibility limits first.
- Async tools and mid-turn steering require application support. Prompt text alone does not enable async execution, steering, cancellation, or side-effect reconciliation in Atomic or another harness.
- EU data residency: GPT-6 family data residency is Standard-processing only; Astra fast mode has no latency SLA.

## Validate the prompt change

Compare a normal task, an early-stop case, a style-sensitive answer, a permission-boundary case, and a small coding change. Check whether Astra completes authorized work, asks only blocking questions, names instruction conflicts, uses collaboration only where useful, verifies proportionately, and respects forbidden actions. Change one prompt, model, or effort variable at a time so regressions have an identifiable cause. Do not claim measured improvement without running representative comparisons.
