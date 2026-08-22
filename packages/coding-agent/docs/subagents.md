---
title: "Subagents"
description: "Run focused Atomic child agents"
---

# Subagents

Atomic bundles `@bastani/subagents`, an extension for bounded specialist delegation with separate context while the parent remains in control. Use a single agent or parallel fan-out when isolation or a specialist pass materially helps with locating code, analyzing behavior, researching references, reproducing actual failures, or simplifying code. Keep interactive, exploratory, conceptual, and conversation-led work inline when direct user steering is more useful.

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

Atomic decides whether delegation adds value, which specialist fits each bounded part, and whether the work should run as a single child, parallel group, or forked-context run. Multiple steps, files, tests, validation, or parallelism alone do not require a workflow; clearly delegated long-running autonomous work that needs durable stages, checkpoints, resumability, HIL, gates, retries, or loops is usually better served by a workflow.

## Subagent execution is non-interactive

Supported subagent launches start immediately without opening a preview/editor prompt or waiting for terminal input. This applies to single, parallel, forked, fanout, prompt-template, and human-entered `/run` and `/parallel` execution. Ask any necessary questions in the parent conversation before delegating.

The human slash commands remain registered and continue to use their separate parsing and event-bridge path, including fork flags.
Prompt-template delegation comes from the separately installed `pi-prompt-template-model` extension, whose `requestDelegatedRun` emits `prompt-template:subagent:request`. If that caller must survive an extension reload, import `registerPromptTemplateBridgeRequestSettlement` from `@bastani/subagents`, register it before the emit, and unregister it from the normal response, cancellation, or abort path. The hook rejects the caller only when the old bridge drops a stale response emit; normal completion still arrives through `prompt-template:subagent:response`. Atomic cannot register this opt-in for an out-of-tree emitter.

Subagents now run and return their results directly. Atomic does not infer acceptance gates from prompt wording, inject `acceptance-report` instructions into child prompts, parse or strip `acceptance-report` blocks, or reject completed child runs because changed-file, test, or review evidence is missing. Put any evidence or validation requirements directly in the task text you give the parent or child agent.

## Foreground supervisor coordination

When a foreground child calls `contact_supervisor` with `need_decision` or `interview_request`, Atomic intercepts the request at the child before Intercom sends it or reserves a reply waiter. The exact live child interrupts into retained `paused` state, and the parent `subagent` call returns with the unmodified question, run ID, child identity, and a `subagent({ action: "resume", id, message })` hint. The parent stays free to answer in its next turn; `resume` sends that answer back into the same retained child session. A foreground `intercom.ask` follows this path only when both its target and the child's launching-parent target resolve to the same broker session ID.

For a parallel foreground run, one claimed parent ask interrupts every active sibling as a retained set and closes the worker gate. Tasks still queued behind the concurrency limit never launch or request supervisor authorization. Resuming the bare run ID sends the supplied answer only to the asking child and gives each other still-paused released sibling a neutral continuation prompt; a released sibling that completed at the ask boundary remains terminal and does not block the paused members. Each resumed child reuses its original cwd, Intercom group, output and model/skill settings, session, canonical index, and isolated worktree while receiving fresh control callbacks, detach coordination, and supervisor authorization. Dirty worktree contents remain untouched across repeated pauses; diff capture and cleanup wait until the released set terminates. A second blocking parent ask after resume can pause the current active set again.

`intercom.send`, `contact_supervisor` progress updates, and `intercom.ask` calls resolved to a sibling or other peer keep their existing Intercom delivery path. The exact foreground owner still uses the probe/commit detach handshake for those messages, including workflow-stage first refusal and parallel sibling release. Fire-and-forget sends and progress updates create no reply waiter. Non-parent blocking asks keep the single race-safe reply-waiter slot, exact threaded replies, and the normal "Already waiting for a reply" refusal for competing asks.

Paused children keep their canonical session file and may resume. Successfully completed children are terminal and cannot resume; start a new subagent call for follow-up work after completion. Children remain in-process `AgentSession` instances governed by the shared Rust control plane, with no child OS process, PID polling, or detached placeholder to recover.

When the Intercom bridge is active, the parent may load and connect its Intercom runtime before the initial child `runSync` to issue a broker capability for that exact child. The child's own connection remains tool-driven. A claimed `contact_supervisor` decision or interview still pauses before the child sends or reserves a reply waiter; `intercom.ask` connects the child to resolve both targets, while ordinary sends, progress updates, and non-parent asks connect on their existing paths.

Non-interactive in-process child sessions run the extension `session_start` lifecycle before their first prompt, so typed admission can register and activate child-only tools such as `contact_supervisor`. Lazy Intercom result relays still initialize from the most recent turn/tool lifecycle context when needed. If no context is available at all, the relay acknowledges the announcement as undelivered—the `subagent` tool then falls back to returning results inline—instead of recording connection errors in the session transcript.

Atomic's implementation adapts the prompt foreground release and later-result recovery contracts proven in `nicobailon/pi-subagents` commits `1b55c8c`, `589e51e`, `68fb528`, and `9dfe3df`; it retains Atomic's broker and raw-TypeScript architecture rather than copying upstream's filesystem transport.

## Migration from acceptance gates

If you have older subagent calls or custom agents that used the removed gate fields:

- Remove `acceptance` properties from `subagent()` calls, task entries, and parallel task items. Atomic no longer reads these fields.
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
| `codebase-online-researcher` | Research official docs, ecosystem behavior, and open-source source references online; it may persist reusable research notes. | Research notes only |
| `debugger` | Reproduce a concrete failure, prove its root cause, apply the smallest in-scope fix, and rerun the failing scenario. | Yes |
| `code-simplifier` | Simplify recently changed code under its behavior-preservation “doors” rubric. | Yes |
| `worker` | Implement an approved task or handoff, validate the narrow change, and escalate product, architecture, or scope decisions to its supervisor. | Yes |

The bundled definitions keep their routing and model frontmatter but use compact, outcome-first bodies: role and goal, success criteria, constraints and tool routes, output contract, and stop rules where applicable. Report-producing agents ground progress claims in tool results and return concise evidence rather than narrating internal reasoning. Read-oriented agents inspect and report. `debugger`, `code-simplifier`, and `worker` can edit files, so give them an explicit scope and validation target. The debugger should finish an in-scope diagnosis by applying and validating the fix, not stop at a proposed patch.

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

Useful prompt templates include `/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, `/parallel-handoff-plan`, and `/parallel-cleanup`. Treat them as reusable compositions, not as separate bundled agent names. Their task templates define the requested outcome, evidence and delegation boundaries, downstream output shape, and an explicit stop rule; preserve those contracts when adapting a template.

## Foreground work and control

Foreground subagents stream progress in the conversation and return their results before the call completes.

Natural-language examples:

```text
Run the local research scan.
```

```text
Show me the current subagent status.
```

Tool examples:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references." })
```

Use `interrupt` when you want a resumable stop. Use `resume` for a paused, detached, or otherwise reachable retained child. A successfully completed child is not resumable; launch a fresh child for follow-up work. Use `doctor` for read-only setup diagnostics.

Status, interrupt, list, and resume use the Rust registry and status watch for live children. A parent-ask pause also keeps an in-memory retained run record so bare run-ID resume can continue the full released parallel set. Terminal delivery is an in-memory bounded envelope with the artifact and run-history record persisted once. There is no PID polling, result-claim file, stale-run reconciliation, or detached runner process.

Inside workflow stages, completion delivery observes the stage generation boundary. A completion received before the boundary closes is queued through the stage AgentSession and processed before the stage publishes its terminal snapshot. A completion that arrives after close is routed once to the parent/main chat and cannot reopen or append to the completed stage transcript. Explicit post-mortem stage chat is still available separately.

Live progress and completed results show each step's resolved model, effective reasoning level, and applied Codex fast-mode marker, including after a model fallback; parallel steps keep their metadata separate.

## Orchestrator model and group policy

Atomic applies the same delegation policy to any parent chat or workflow stage that orchestrates subagents. A named agent uses the model and fallback sequence declared by its agent definition, so the orchestrator normally omits the subagent tool's explicit `model` argument. An override needs either the user's exact model request or a documented task-specific reason recorded before launch; model diversity alone is not enough.

If an agent declares no model or fallback policy, the orchestrator consults the role guidance in [Model selection](/models/model-selection), then calls `workflow({ action: "models" })` when that tool is available. It may pin only a returned `fullId` and may add a thinking suffix only when the model entry lists that level. When the catalog tool is unavailable, the catalog is empty, or no recommended model is present, the child stays unpinned and the orchestrator reports the limit instead of inventing a model or inspecting credentials.

Each workflow invocation automatically receives one stable, non-`"default"` Intercom group as typed admission policy. Its stages and delegated children carry that group across single, parallel, and follow-up work unless a call explicitly overrides `group`. Outside workflows, children inherit the launching session's resolved group. This isolates workflow runs from unrelated runs and the main chat while `contact_supervisor` retains its authorized cross-group route.

## Context and execution modes

Subagents can run with fresh or forked context:

- `context: "fresh"` starts a separate in-process child session with only the task and selected agent context.
- `context: "fork"` creates a real branched child session from the parent session leaf. It fails fast if the parent session cannot be forked; it does not silently downgrade to fresh context.

For adversarial review or research, prefer fresh context so the specialist inspects the repository directly. Use forked context when a writer needs the parent conversation history in a separate branch.

For parallel implementation work, `worktree: true` can give each child an isolated git worktree so concurrent edits do not clobber each other.

Fresh child sessions use normal Atomic package discovery when an agent omits `extensions`, so bundled lightweight MCP, web-access, and Intercom wrappers are available just as they are in the parent. An explicit `extensions` field (including an empty list) intentionally switches the child to extension-allowlist mode and excludes unlisted builtins; it does not inherit the parent's normal discovery set.

Top-level parallel calls support up to 50 subagents after expanding each task's optional `count`. The extension's `parallel.maxTasks` setting defaults to 50 and can enforce a lower task limit; `parallel.concurrency` independently controls how many of those children run at once, while the Rust turn limiter admits at most four running turns per parent.

When one assistant response emits several sibling execution-mode `subagent` tool calls, Atomic collects that synchronous burst before starting a child and runs it as one indexed parallel set. Each original tool call still receives one result containing only the children it requested, and its live result, progress, control, and artifact updates are projected to that same route without sibling data. The TUI redraws the shared run as one aggregate parallel widget rather than retaining one widget per original call. A single call keeps its original SINGLE or PARALLEL mode, calls awaited in sequence remain separate runs, and management actions bypass collection. An execution call that arrives after a child has started still receives the existing in-progress rejection. Prefer one explicit `{ tasks: [...] }` call when planning parallel work; burst collection handles sibling calls emitted by a model.

For a collected burst, each call contributes its top-level `agent` task first and then its `tasks` entries in array order. Atomic preserves duplicates, expands `count` in place, and applies the configured task cap after flattening and expansion; the hard maximum remains 50. Each call-level `cwd` selects that call's agent-discovery scope and child base directory. A task-level `cwd` stays relative to that call base and changes only that child's execution directory, not agent discovery. This per-origin discovery rule applies only to collected sibling calls; an ordinary explicit `{ tasks: [...] }` call keeps one discovery scope from its top-level `cwd`. Per-call and per-task `group` values also stay with their originating children. Shared run options must match across every sibling call: `concurrency`, `worktree`, `context`, `share`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, and `agentScope`. A mismatch rejects the whole burst before any child launches and names the incompatible field.

For a collected `worktree: true` burst, every call-level `cwd` must resolve to the same path. That common path becomes the shared worktree root; differing origins reject the burst before launch, and any task-level `cwd` must still resolve to that root. Each projected caller result keeps shared worktree diff text and terminal control guidance while its child results and standard child-output sections remain route-local.

Subagent tasks, parallel items, and the top-level call accept a `group` field that sets the spawned child's [Intercom](/intercom) home group, so same-group subagents can intercom each other while staying isolated from other groups. A named string joins that group; `true` auto-generates one shared UUID group per parallel set. Precedence is `explicit subagent group > inherited current-session group > config > "default"`. Workflow stages carry their runtime-owned invocation group, so children launched without `group` automatically join the workflow group; callers do not need to copy or generate an ID. In other sessions, omission inherits that launching session's resolved group. The child group is applied only when the child has Intercom access (the peer `intercom` tool or subagent-only `contact_supervisor` tool); a child without Intercom receives no group. `contact_supervisor` still reaches the supervisor across group boundaries because Atomic requests a broker capability during typed admission and binds the child's registration to the issuing supervisor. Foreground paths use exact child scopes. The lightweight Intercom wrapper lazy-loads the authorization provider; provider failures abort launch, while hosts without a provider omit supervisor metadata instead of exposing a broken channel.

When a subagent call or parallel task uses a `cwd`, Atomic validates that working directory before starting the child runtime. Missing or non-directory paths are reported as `cwd` problems instead of lower-level runtime errors.

Single-agent calls also accept `reads: string[] | false`. Atomic prepends those files as read context for foreground execution through the same in-process session path, including `/run agent[reads=a.md+b.md]`. Relative entries resolve against the effective child `cwd` (including a relative top-level `cwd` resolved from the parent); absolute entries are unchanged. Invalid values fail before the child session starts.

Single-agent calls accept `progress: boolean` in foreground and resumed mode. `progress: true` creates a run-scoped `progress.md` under isolated subagent artifact storage and instructs the child to maintain it without writing `progress.md` into the child `cwd`; `progress: false` disables an agent's `defaultProgress`. When `progress` is omitted, the agent's default is inherited, except that inherited progress is suppressed for read-only tasks (`progress: true` still explicitly opts in). Foreground runs remove this run-owned progress storage after the child exits when `artifacts: false`, including children temporarily detached for intercom coordination. This is separate from `includeProgress: true`, which only includes detailed runtime progress telemetry in the final tool result and does not create or maintain a file.

```ts
subagent({ agent: "worker", task: "Implement the approved fix.", progress: true })
```

## Delegation and child boundaries

Child-safety boundaries are enforced by typed admission policy and the bundled subagent extension:

- In-process child sessions load bundled extensions through normal discovery. The `subagent` tool may therefore be registered when the child's active tool selection permits it, including the default no-allowlist case; an explicit allowlist may omit it. Tool presence does not grant fanout. The bundled subagents skill remains parent-only and is stripped from child prompts, including fanout-authorized children.
- Child context is filtered to remove parent orchestration artifacts, old control/status messages, and prior parent `subagent` tool calls/results.
- Children are instructed that they are not the parent orchestrator and must complete their assigned task directly rather than delegating.
- Delegation is exactly one level deep and is not configurable. A session admitted as a subagent child is refused every launch, `resume`, and `interrupt`; only `list`, `get`, `status`, and `doctor` stay available. A management-restricted child is also refused `create`, `update`, and `delete`.
- The rule is enforced twice: the subagent executor refuses a child before any run starts, and the Rust admission door refuses a child deeper than the single permitted level. Admitted depth is typed admission state, never inherited from process environment state.

This keeps the parent session responsible for orchestration.

## Custom agents

Custom agents are Markdown files with YAML frontmatter and a system prompt body. Keep the body outcome-first and locally complete: state the role or goal, observable success criteria, constraints and context-dependent tool routes, required output shape, and stop conditions. Reserve absolute wording for true invariants, request evidence and conclusions rather than private reasoning, and avoid repeated self-check instructions. Common locations are:

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

## Role and goal
Inspect the current diff for correctness and regressions without editing files.

## Success criteria
Cite each actionable issue with file:line evidence and the observed failure or risk.

## Output and stop rule
Return only issues worth fixing now. Stop when the relevant diff and affected call paths have been inspected, or name the evidence you could not access.
```

## Fallback models

Agents can define ordered `fallbackModels` for retryable provider or model failures such as rate limits, quota/usage-limit exhaustion (for example a provider reporting `The usage limit has been reached`, or `usage_limit_reached`/`insufficient_quota` codes), auth problems, unavailable models, network timeouts, or 5xx errors. Atomic tries the requested primary model first, then configured fallbacks, and finally appends the current user-selected model as the last fallback candidate when available. The main chat and workflow stages share one failure classifier, so auth, model-availability, request-incompatibility, and transport signals are handled consistently. Cancellations, safety refusals, and task/tool failures are never retried on another model.

A candidate that cannot serve the current request — for example an HTTP 400/413/422 bad/unprocessable/payload-too-large request, an unsupported tool or parameter, a context-length/context-window overflow, or a `too large` / `invalid_request` error — is treated as request/context incompatible and the fallback sequence advances to the next candidate rather than stopping. This means that if none of the configured candidates are applicable to the request, Atomic falls back to the currently selected user model instead of failing outright.

Model fallback decisions use structured provider and attempt causes. There is no per-attempt idle watchdog, no child wall-clock kill cap, and no timeout-regex classification: a quiet provider response is allowed to finish, and only an explicit termination or provider failure supplies a retryable cause. Numeric process exit codes are not used as an outcome discriminator.

When registry availability shows that a known candidate provider has no configured auth, Atomic records a skipped model attempt before starting the in-process turn. Unknown/custom providers are still attempted, and the current user-selected model appended as the final fallback is never filtered out by this pre-admission check.

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
- [Intercom](/intercom) for cross-session messaging and supervisor escalation.
- [Skills](/skills) for reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) for user and project configuration.
