---
title: "Subagents"
description: "Run focused Atomic child agents"
---

# Subagents

Atomic bundles `@bastani/subagents`, an extension for running focused child agents with their own context. Use it when a task benefits from isolation, parallel investigation, background execution, or a specialist pass for locating code, analyzing behavior, researching references, debugging, or simplifying code.

You do not need to install anything separately when you use `@bastani/atomic`.

## Start with natural language

Ask Atomic to coordinate subagents in plain language:

```text
Map the authentication flow with focused subagents before we change it.
```

```text
Run a parallel review composition: one pass for current behavior, one for failure modes, and one for existing patterns.
```

```text
Research the upstream library behavior online, then compare it with our local implementation.
```

Atomic decides whether to call the bundled `subagent` tool, which specialist fits each part, and whether the work should run as a single child, parallel group, chain, foreground run, or background run.

## Subagent execution is non-interactive

Supported subagent launches start immediately without opening a preview/editor prompt or waiting for terminal input. This applies to single, parallel, chain, foreground, background, fanout, prompt-template, and human-entered `/run`, `/chain`, `/parallel`, and `/run-chain` execution. Ask any necessary questions in the parent conversation before delegating.

The human slash commands remain registered and continue to use their separate parsing and event-bridge path, including background and fork flags.

Subagents now run and return their results directly. Atomic does not infer acceptance gates from prompt wording, inject `acceptance-report` instructions into child prompts, parse or strip `acceptance-report` blocks, or reject completed child runs because changed-file, test, or review evidence is missing. Put any evidence or validation requirements directly in the task text you give the parent or child agent.

Completed subagent runs report their transitive usage back to the parent session. The parent footer's dollar figure therefore includes foreground and async/background subagent spend (including nested subagents) exactly once, while the footer token badges and context percentage remain scoped to the parent session.

## Migration from acceptance gates

If you have older subagent calls, saved chains, or custom agents that used the removed gate fields:

- Remove `acceptance` properties from `subagent()` calls, `tasks` entries, `chain` steps, static parallel task items, and dynamic fanout parallel templates. Atomic no longer reads these fields; JSON chain rewrites drop legacy copies.
- Remove `completionGuard: false` from agent frontmatter and custom agent definitions. The no-mutation completion guard no longer exists, so the override has no effect and management rewrites strip it.
- Move validation, command, evidence, review, or residual-risk requirements into the natural-language task text passed to the parent or child agent.

## Bundled agents

Atomic currently bundles these agents from `@bastani/subagents`:

| Agent | Use it for | Edit files? |
|---|---|---|
| `codebase-locator` | Find relevant files, directories, tests, configs, and docs for a topic. | No |
| `codebase-analyzer` | Explain how specific code works and trace data flow with file references. | No |
| `codebase-pattern-finder` | Find similar implementations, conventions, and test examples to model after. | No |
| `codebase-research-locator` | Locate prior `research/` and `specs/` documents related to the task. | No |
| `codebase-research-analyzer` | Extract decisions, constraints, and still-relevant conclusions from prior local docs. | No |
| `codebase-online-researcher` | Research official docs, ecosystem behavior, and open-source source references online. | Can write research notes |
| `debugger` | Reproduce, diagnose, and fix failures or unexpected behavior. | Yes |
| `code-simplifier` | Clean up recently changed code while preserving behavior. | Yes |

Read-oriented agents should inspect and report. `debugger` and `code-simplifier` can edit files, so run them with an explicit scope and validation target.

## Review compositions

Atomic does not bundle a single generic review agent. Instead, compose specialists with distinct angles and let the parent session synthesize their findings before applying any fix.

Common review angles:

| Angle | Specialist pattern |
|---|---|
| Current behavior and regressions | `codebase-analyzer` inspects the changed flow and cites file/line evidence. |
| Failure modes | `debugger` runs in inspect-only mode to reproduce or reason about likely failures without editing. |
| Fit with project conventions | `codebase-pattern-finder` compares the patch with existing local examples. |
| Prior decisions | `codebase-research-locator` finds relevant docs, then `codebase-research-analyzer` extracts applicable constraints. |
| External API or library conformance | `codebase-online-researcher` checks authoritative sources and version-specific behavior. |

Example request:

```text
Review the current diff with fresh-context specialists: analyze correctness, inspect failure modes without editing, and compare the implementation to existing patterns. Synthesize only issues worth fixing now.
```

Useful prompt templates include `/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, `/parallel-handoff-plan`, and `/parallel-cleanup`. Treat them as reusable compositions, not as separate bundled agent names.

## Background work and control

Foreground subagents stream progress in the conversation. Background subagents keep working after control returns to you and report completion later.

Natural-language examples:

```text
Run the local research scan in the background.
```

```text
Show me the current async subagent runs.
```

Tool examples:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references.", async: true })
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "continue with the test failures" })
subagent({ action: "doctor" })
```

Use `interrupt` when you want a resumable stop. Use `resume` to send a follow-up to a reachable async child, or to revive a completed child from its saved session when the run has enough metadata. Use `doctor` for read-only setup diagnostics.

Background runs are detached. If Atomic has no useful independent work while a background subagent runs, it should end the turn instead of polling in a loop; the run will notify the originating session when it completes.

When a workflow graph overlay is open, Atomic also publishes the live async subagent summary into the shared status surface. The below-editor async widget remains available when the workflow overlay is hidden, and the overlay statusline keeps the run count/state visible while the graph fills the terminal.

## Context and execution modes

Subagents can run with fresh or forked context:

- `context: "fresh"` starts a separate child with only the task and selected agent context.
- `context: "fork"` creates a real branched child session from the parent session leaf. It fails fast if the parent session cannot be forked; it does not silently downgrade to fresh context.

For adversarial review or research, prefer fresh context so the specialist inspects the repository directly. Use forked context when a writer needs the parent conversation history in a separate branch.

For parallel implementation work, `worktree: true` can give each child an isolated git worktree so concurrent edits do not clobber each other.

Fresh child processes use normal Atomic package discovery when an agent omits `extensions`, so bundled lightweight MCP, web-access, and Intercom wrappers are available just as they are in the parent. An explicit `extensions` field (including an empty list) intentionally switches the child to extension-allowlist mode and excludes unlisted builtins; it does not inherit the parent's normal discovery set.

Top-level parallel calls support up to 50 subagents after expanding each task's optional `count`. The extension's `parallel.maxTasks` setting defaults to 50 and can enforce a lower task limit; `parallel.concurrency` independently controls how many of those children run at once.

When a subagent call, parallel task, chain step, or background run uses a `cwd`, Atomic validates that working directory before starting the child runtime. Missing or non-directory paths are reported as `cwd` problems instead of lower-level process-spawn errors, so failures point at the requested child workspace rather than at the runtime binary.

## Nested and fanout boundaries

Child-safety boundaries are enforced by the bundled subagent extension:

- Normal child sessions do not receive the `subagent` tool or the parent-only subagents skill.
- Child context is filtered to remove parent orchestration artifacts, old control/status messages, and prior parent `subagent` tool calls/results.
- Non-fanout children are instructed that they are not the parent orchestrator and must not propose or run subagents.
- Nested fanout is available only for explicitly authorized agents whose resolved tools include `subagent`. Authorized fanout children receive narrower instructions that limit delegation to the assigned fanout.
- The recursion guard defaults to a hard maximum of five delegated subagent levels. `ATOMIC_SUBAGENT_MAX_DEPTH`, extension `config.maxSubagentDepth`, and agent frontmatter can choose a lower value from `0` to `5`; higher values are clamped.

This keeps the parent session responsible for orchestration unless you deliberately choose a fanout-capable custom agent.

## Custom agents

Custom agents are Markdown files with YAML frontmatter and a system prompt body. Common locations are:

| Scope | Path |
|---|---|
| User | `~/.atomic/agent/agents/**/*.md` |
| Project | `.atomic/agents/**/*.md` |

A small custom read-only inspection agent:

```markdown
---
name: strict-inspector
description: Inspect code for correctness and regressions
tools: read, search, bash
model: anthropic/claude-sonnet-4
fallbackModels: openai/gpt-5-mini
inheritProjectContext: true
---

You are a read-only inspector. Inspect the current diff, cite evidence with file paths, and return only issues worth fixing now. Do not edit files.
```

If an agent or chain step uses an explicit empty `tools: []` allowlist together with `outputSchema`, Atomic starts the child with only `structured_output` enabled for the required final answer. It does not omit `--tools` and accidentally restore default tools. Path-only tool entries remain extension paths and do not create a builtin allowlist by themselves. The child prompt-runtime extension is loaded before user/tool extensions so its schema-backed `structured_output` tool is registered before explicit allowlists are applied.

## Structured output schemas

Chain and parallel steps can declare an `outputSchema` when the parent needs reliable machine-readable handoff data. Atomic passes that schema directly to a `structured_output` tool backed by the shared Atomic factory. The child should call `structured_output` when it is done:

```ts
structured_output({
  files: ["src/auth.ts"],
  risks: ["missing regression test"],
})
```

`outputSchema` is a plain JSON Schema descriptor object. It may describe object, array, or primitive final values, and the child should pass a JSON value that matches that schema directly. Atomic no longer adds object-root restrictions, sidecar metadata, transcript-finality checks, or duplicate-call guards. The child runtime writes the tool arguments to `output.json`; the parent validates that captured JSON against the schema, reads it back as `result.structuredOutput`, and exposes it in named-chain references under `outputs.name.structured`. If the child exits without calling `structured_output`, or the captured value fails schema validation, Atomic retries up to three times with a corrective prompt that quotes the exact contract/validation error and reminds the child to call `structured_output` rather than returning plain JSON.

Children without `outputSchema` do not receive `structured_output` from Atomic's default tool registry. They can still use a custom extension-provided terminating tool if you explicitly add one.

Dynamic fanout `collect.outputSchema` validates the collected result array after child runs finish.

## Fallback models

Agents can define ordered `fallbackModels` for retryable provider or model failures such as rate limits, quota/auth problems, unavailable models, network timeouts, or 5xx errors. Atomic tries the requested primary model first, then configured fallbacks, and finally appends the current user-selected model as the last fallback candidate when available.

A candidate that cannot serve the current request — for example an HTTP 400/413/422 bad/unprocessable/payload-too-large request, an unsupported tool or parameter, a context-length/context-window overflow, or a `too large` / `invalid_request` error — is treated as request/context incompatible and the chain advances to the next candidate rather than stopping. This means that if none of the configured candidates are applicable to the request, Atomic falls back to the currently selected user model instead of failing outright.

Each foreground and background model candidate is bounded by a per-attempt idle watchdog (default 5 minutes without child stdout, stderr, or JSON child events) and an absolute wall-clock cap (default 60 minutes). An in-flight tool execution counts as activity, so a slow, quiet tool call (a long build or test run that streams nothing until it finishes) is not mistaken for a stalled attempt; only the wall-clock cap bounds such attempts. If either watchdog trips, Atomic terminates that child attempt, records a retryable timeout in `modelAttempts`, and continues to the next fallback candidate. The defaults can be overridden with `ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS` and `ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS`; `ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS` controls SIGTERM-to-SIGKILL escalation. Setting the idle or wall-clock variable to `0` (or a negative value) disables that timeout entirely; non-numeric values are ignored and the default applies. The kill-grace period cannot be disabled — `0`, negative, or non-numeric values fall back to its default so escalation always stays bounded.

When registry availability shows that a known candidate provider has no configured auth, Atomic records a skipped model attempt before spawning a child. Unknown/custom providers are still attempted, and the current user-selected model appended as the final fallback is never filtered out by this pre-spawn check.

Fallbacks do not retry ordinary task failures, validation failures, tool failures, cancellations, or workflow-code errors. Because a fallback may send the same prompt and context to a different provider, choose models that match your cost, privacy, and data-handling requirements.

Each candidate can also carry its own reasoning effort — see [Reasoning levels](#reasoning-levels).

## Reasoning levels

Set the reasoning (thinking) effort for each model candidate with a `model_name:thinking_effort` suffix on `model` and on every `fallbackModels` entry. Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` — the same shorthand used by `atomic --model sonnet:high`. `xhigh` and `max` are used only when the selected model's capability map supports them.

```markdown
---
name: deep-reviewer
description: Adversarial reviewer for risky diffs
tools: read, search, bash
model: anthropic/claude-sonnet-4:high
fallbackModels: openai/gpt-5:medium, anthropic/claude-haiku-4-5:off
---
```

Because the effort travels with each model string, every primary and fallback candidate is self-contained: a fallback can run at a different effort than the primary, so a high-effort primary degrades gracefully to a cheaper, lower-effort fallback.

**Migrate off the legacy `thinking` field.** The separate `thinking:` frontmatter field is deprecated. It still works as a default for any candidate that has no suffix, and a suffix always wins, but new agents should encode the effort directly on `model` and `fallbackModels`:

```diff
-model: openai/gpt-5.5
-fallbackModels: anthropic/claude-opus-4-8
-thinking: xhigh
+model: openai/gpt-5.5:xhigh
+fallbackModels: anthropic/claude-opus-4-8:xhigh
```

`fallbackThinkingLevels` exists only as an optional compatibility helper: it is aligned by index to `fallbackModels` and supplies a fallback candidate's effort only when that fallback entry has no suffix. Prefer suffixed model strings instead. Attempt metadata reports the resolved model and the effective reasoning effort used for each attempt.

## Related docs

- [Workflows](/workflows) for multi-stage reusable automation.
- [Skills](/skills) for reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) for user and project configuration.
