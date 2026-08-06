# Workflows In-Process Session Runtime

## Overview

Workflow stages use Atomic’s SDK `AgentSession` directly in the host process. `buildRuntimeAdapters()` does not spawn a subprocess or parse NDJSON; stage prompts delegate to the SDK session directly (`packages/workflows/src/extension/wiring.ts:360-365`). The extension factory creates these adapters once and passes them into the workflow runtime (`packages/workflows/src/extension/extension-factory.ts:70-76`).

## Entry Points

- `packages/workflows/src/extension/extension-factory.ts:70-76` — calls `buildRuntimeAdapters(pi)` and supplies the resulting adapters to workflow runtime state.
- `packages/workflows/src/extension/wiring.ts:376-421` — exports `buildRuntimeAdapters()`, returning an `agentSession.create()` adapter.
- `packages/coding-agent/src/core/sdk.ts:79` — defines and exports `createAgentSession()`.
- `packages/coding-agent/src/index.ts:146-188` — re-exports `createAgentSession`, `CreateAgentSessionOptions`, `CreateAgentSessionResult`, `AgentSession`, `SessionManager`, and resource-loader APIs from the package root.
- `packages/coding-agent/package.json:1-26` — package name is `@bastani/atomic`; its root export points to `dist/index.js`.

## Runtime Adapter Wiring

`buildRuntimeAdapters()` resolves the session factory in this order:

1. `RuntimeAdapterBuildOptions.createAgentSession`.
2. `pi.createAgentSession`.
3. A test stub when `NODE_TEST_CONTEXT` or `NODE_ENV=test` is present.
4. A lazy dynamic import of `createAgentSession` from `@bastani/atomic` (`packages/workflows/src/extension/wiring.ts:367-388`).

The production path dynamically imports the SDK, prepares stage options, invokes `sdk.createAgentSession(sessionOptions)`, and returns the SDK session. The SDK result also contains `extensionsResult` and an optional model-fallback message, but the workflow adapter consumes the session and optionally exposes a compatible settings manager (`packages/workflows/src/extension/wiring.ts:137-153`).

Before calling the SDK, the adapter removes workflow-only fields such as `schema`, `mcp`, `fallbackModels`, and `group` (`packages/workflows/src/extension/wiring.ts:214-226`). It then adds workflow policy exclusions:

- `workflow` is always excluded.
- `ask_user_question` is also excluded for non-interactive runs.
- The stage orchestration context is attached when stage metadata is available (`packages/workflows/src/extension/wiring.ts:288-307`).

After creation, the adapter binds a stage-specific extension UI context when the run is interactive or has stage metadata and the returned session implements `bindExtensions()` (`packages/workflows/src/extension/wiring.ts:309-357`, `packages/workflows/src/extension/wiring.ts:403-415`).

## SDK `createAgentSession`

### Export and options

`CreateAgentSessionOptions` supports:

- `cwd` and `agentDir`.
- `model`, `thinkingLevel`, `fallbackModels`, and `scopedModels`.
- `tools`, `excludedTools`, `noTools`, and `customTools`.
- `resourceLoader`, `sessionManager`, and `settingsManager`.
- `modelRuntime`, `sessionStartEvent`, and `orchestrationContext` (`packages/coding-agent/src/core/sdk-types.ts:16-80`).

The `model` option is a `Model<Api>` object. When omitted, the SDK first attempts to restore the model from an existing session, then uses settings, then chooses an available model (`packages/coding-agent/src/core/sdk.ts:121-158`; `packages/coding-agent/docs/sdk.md:453-456`). Thinking level is restored or read from settings and then clamped to the selected model’s capabilities (`packages/coding-agent/src/core/sdk.ts:160-179`).

Tool selection is name-based. If `tools` is omitted, default built-ins are enabled unless `noTools` changes that. `excludedTools` is applied after the allowlist/default selection (`packages/coding-agent/src/core/sdk-types.ts:41-64`; `packages/coding-agent/docs/sdk.md:514-547`).

There is no direct `systemPrompt` property on `CreateAgentSessionOptions`. System-prompt configuration belongs to `ResourceLoader`; `DefaultResourceLoaderOptions` supports `systemPrompt`, `appendSystemPrompt`, and override callbacks (`packages/coding-agent/src/core/resource-loader-types.ts:69-106`). The session rebuilds its system prompt from the loader’s prompt, appended prompt, loaded skills, context files, selected tools, excluded tools, and tool snippets (`packages/coding-agent/src/core/agent-session-state.ts:91-126`).

### Creation sequence

`createAgentSession()`:

1. Resolves `cwd` from `options.cwd`, the session manager’s cwd, or `process.cwd()`.
2. Resolves `agentDir`.
3. Creates or refreshes a `ModelRuntime`.
4. Creates a `SettingsManager`.
5. Creates a `SessionManager` unless one was supplied.
6. Marks workflow-stage sessions as internal with run/stage metadata.
7. Creates and reloads a default resource loader when one was not supplied.
8. Restores existing messages/model/thinking state.
9. Builds the `Agent` with the selected model, thinking level, tool policy, stream function, retry settings, steering mode, and follow-up mode.
10. Constructs `AgentSession` and returns it with `extensionsResult` (`packages/coding-agent/src/core/sdk.ts:79-113`, `packages/coding-agent/src/core/sdk.ts:115-188`, `packages/coding-agent/src/core/sdk.ts:241-388`).

### Stage resource loading

Workflow stages normally use `prepareAtomicStageSessionOptions()` before SDK creation. A supplied `resourceLoader` is preserved unchanged. Otherwise, the helper resolves cwd, creates a settings manager, constructs `DefaultResourceLoader`, copies inherited resource-loader paths/settings, disables only the workflows package’s extension entry, and reloads resources (`packages/workflows/src/extension/atomic-stage-session.ts:50-110`, `packages/workflows/src/extension/atomic-stage-session.ts:134-143`).

The inherited snapshot can contain extension paths, skill paths, prompt paths, themes, built-in package paths, trust state, system-prompt sources, and resource-disable flags (`packages/coding-agent/src/core/resource-loader-types.ts:51-67`). Resource reloads are serialized because the helper temporarily removes inherited subagent-child environment flags from the process environment while reloading (`packages/workflows/src/extension/atomic-stage-session.ts:153-188`).

## Per-Stage Configuration

`StageOptions` extends the SDK session options and adds workflow fields such as `schema`, `mcp`, `fallbackModels`, `fallbackThinkingLevels`, `sessionDir`, `context`, `forkFromSessionFile`, `resumeFromSessionFile`, and `group` (`packages/workflows/src/shared/types.ts:181-208`; `packages/workflows/src/shared/authoring-contract-stage.ts:162-191`).

The stage runner transforms these options before session creation:

- `buildStageSessionOptions()` inserts the selected fallback candidate’s model and reasoning level, removes workflow fallback lists for that attempt, and optionally reopens a saved session (`packages/workflows/src/runs/foreground/stage-runner-session-options.ts:13-37`).
- `stripWorkflowOnlyOptions()` creates workflow-internal `SessionManager` instances for new, resumed, or forked sessions and attaches workflow session metadata (`packages/workflows/src/runs/foreground/stage-runner-options.ts:6-79`).
- `stageOptionsWithStructuredOutput()` adds a `structured_output` custom tool when a schema is configured and ensures it is allowed by the tool policy (`packages/workflows/src/runs/foreground/stage-runner-structured-output.ts:63-87`).
- `StageSessionController.applyCandidateThinking()` stores the candidate’s effective thinking level before session creation; the level is applied immediately when the session is attached (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:151-154`, `packages/workflows/src/runs/foreground/stage-runner-controller.ts:624-628`).
- Explicit model/fallback attempts are created and retried by the controller; retryable failures can replace the current session with the next candidate (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:223-269`, `packages/workflows/src/runs/foreground/stage-runner-controller.ts:575-603`).

A stage’s default resource loader supplies project/global extensions, skills, prompt templates, themes, and context files. Skill commands and prompt templates are expanded for ordinary prompts, steering, and follow-up messages (`packages/coding-agent/src/core/agent-session-prompt.ts:97-115`, `packages/coding-agent/src/core/agent-session-prompt.ts:382-413`).

## Streaming Events and UI Delivery

The SDK exposes `AgentSession.subscribe()`, which receives assistant message deltas, thinking deltas, tool execution start/update/end, message lifecycle, agent lifecycle, turn lifecycle, queue updates, compaction, and retry events (`packages/coding-agent/docs/sdk.md:312-377`). SDK listeners are invoked after extension-event processing; `message_end` then persists user, assistant, tool-result, or custom messages (`packages/coding-agent/src/core/agent-session-events.ts:151-191`).

The workflow layer buffers listeners registered before lazy session creation. Once a session is attached, pending listeners are subscribed to the SDK session and any missed queue state is replayed (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:140-149`, `packages/workflows/src/runs/foreground/stage-runner-controller.ts:416-452`).

The public stage context exposes `subscribe()` by delegating to the controller (`packages/workflows/src/runs/foreground/stage-runner-context.ts:171-173`). The live `StageControlHandle` delegates subscriptions to the same context (`packages/workflows/src/runs/foreground/executor-stage-control.ts:212-217`). The TUI subscribes when a stage chat mounts and passes each event to `ChatSessionHost.applyAgentEvent()` (`packages/workflows/src/tui/stage-chat-view-state.ts:97-121`, `packages/workflows/src/tui/stage-chat-view-live-events.ts:9-19`).

The stage control handle also maintains lifetime subscriptions for tool-execution replay and queued-message state (`packages/workflows/src/runs/foreground/executor-stage-control.ts:33-40`). Delivery activity can be published before the SDK’s `agent_start`, allowing the attached stage chat to show working state across the full accepted delivery (`packages/workflows/src/runs/foreground/executor-stage-control.ts:215-217`; `packages/workflows/src/tui/stage-chat-view-state.ts:112-119`).

For interactive stages, `bindExtensions()` receives a UI context whose standard UI methods delegate to the host UI. `custom()` routes through `StageUiBroker` and the run/stage signal; unavailable UI rejects with an explicit error (`packages/workflows/src/extension/wiring.ts:314-357`). `ask_user_question` tool events are observed by the stage factory and converted into brokered stage prompts and store state (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:188-217`).

## Steering and Follow-Up Messages

The public stage context exposes `sendUserMessage`, `steer`, and `followUp` (`packages/workflows/src/runs/foreground/stage-runner-context.ts:155-169`). The stage-control layer provides an admission-aware `sendUserMessage()` path:

- If the session is idle, the content starts a new prompt.
- If the session is streaming, the default delivery is `followUp` unless an explicit delivery mode is supplied.
- SDK sessions supporting `sendUserMessage()` receive the content and delivery mode directly.
- Older adapters fall back to `steer()` or `followUp()` for strings and reject non-string content (`packages/workflows/src/runs/foreground/stage-runner-send-user-message.ts:62-133`).

The SDK’s `sendUserMessage()` normalizes text/image content and invokes `prompt()` with `streamingBehavior` set to the selected mode (`packages/coding-agent/src/core/agent-session-prompt.ts:420-457`). During streaming, `prompt()` queues steering or follow-up text instead of starting another immediate provider turn (`packages/coding-agent/src/core/agent-session-prompt.ts:104-119`). SDK steering is delivered before the next LLM call after current tool work; follow-up is delivered after the agent has no remaining tool or steering work (`packages/coding-agent/src/core/agent-session-prompt.ts:373-413`).

Queue insertion emits `queue_update`, records the text in the corresponding queue, and forwards the message to the underlying agent queue (`packages/coding-agent/src/core/agent-session-message-queue.ts:38-77`). The queue is visible through `pendingMessageCount`, `getSteeringMessages()`, and `getFollowUpMessages()` (`packages/coding-agent/src/core/agent-session-accessors.ts:99-107`; `packages/coding-agent/src/core/agent-session-methods.ts:304-350`).

`workflow send` resolves a stage handle and chooses delivery based on `delivery`, stage status, and streaming state. `auto` steers a streaming stage, `prompt` starts/queues a prompt, and `followUp` queues trailing work (`packages/workflows/src/extension/workflow-tool-send.ts:229-371`). It performs a synchronous final admission check against terminal workflow state before SDK mutation (`packages/workflows/src/extension/workflow-tool-send.ts:255-280`).

When a queued message enters a running stage, the stage control sets `resumeContinuationPending`. The tracked stage caller drains that flag and may inject `RESUME_CONTINUATION_PROMPT` after the original call completes (`packages/workflows/src/runs/foreground/executor-stage-control.ts:113-140`; `packages/workflows/src/runs/foreground/executor-stage-call.ts:82-115`).

## Pause, Interrupt, Abort, and Generation Closure

A controlled stage pause is implemented above the SDK:

1. `StageSessionPause.requestPause()` optionally invokes the SDK queue pause gate.
2. It calls `session.abort()`.
3. It waits for the abort boundary and keeps the original stage prompt suspended.
4. `resume()` releases held queue work and resolves the suspended prompt with an optional message (`packages/workflows/src/runs/foreground/stage-runner-pause.ts:37-79`, `packages/workflows/src/runs/foreground/stage-runner-pause.ts:115-199`).

The SDK queue pause gate synchronously holds queued steering/follow-up work. Resuming releases that hold but does not itself start a new provider turn (`packages/coding-agent/src/core/agent-session-queue-pause.ts:28-68`).

`StageControlHandle.pause()` requests the controlled pause, records the stage as paused, cascades pause state to dependent stages, and forces durable session metadata capture (`packages/workflows/src/runs/foreground/executor-stage-control.ts:143-160`). `resume()` restores the stage, releases scheduler barriers, updates continuation state, and optionally sends a resume message (`packages/workflows/src/runs/foreground/executor-stage-control.ts:162-210`).

The stage chat’s interrupt command uses `pause()` for pending/running/awaiting-input stages; terminal stages use the underlying SDK session’s `abort()` directly (`packages/workflows/src/tui/stage-chat-view-state.ts:232-241`). At the workflow command level, `interruptRun()` is an alias for `pauseRun()` and therefore performs resumable interruption rather than destructive cancellation (`packages/workflows/src/runs/background/status.ts:472-482`).

The executor’s abort signal is bound to the current stage session. Aborting the signal calls `session.abort()` and rejects any controlled pause (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:320-334`). Tracked calls race stage work against the same signal (`packages/workflows/src/runs/foreground/executor-stage-call.ts:120-134`, `packages/workflows/src/runs/foreground/executor-abort.ts:412-432`).

Before finalization, the executor seals the workflow-stage admission boundary, waits for admitted work, waits for the SDK agent to become idle, and drains its event queue (`packages/workflows/src/runs/foreground/executor-stage-call.ts:256-258`, `packages/coding-agent/src/core/agent-session-message-queue.ts:177-185`). Late custom messages are routed through `orchestrationContext.lateMessageRouter`; intercom messages are emitted through the Atomic event surface, while other messages use the main-chat sender (`packages/workflows/src/extension/wiring.ts:229-285`, `packages/coding-agent/src/core/agent-session-message-queue.ts:129-138`).

Parallel fail-fast and workflow-exit cleanup seal generation, abort the session, close the generation, finalize the stage snapshot, and release the control handle (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:403-430`).

## Session Files and Transcripts

Atomic sessions are append-only JSONL trees whose entries use `id`/`parentId` relationships (`packages/coding-agent/src/core/session-manager-core.ts:49-83`). A persistent session is created with `SessionManager.create()`, opened with `SessionManager.open(path)`, continued with `continueRecent()`, or made non-persistent with `inMemory()` (`packages/coding-agent/src/core/session-manager-core.ts:444-471`).

The default session directory encodes cwd beneath `<agentDir>/sessions/`; the default agent directory is Atomic’s configuration directory (`packages/coding-agent/src/core/session-manager-paths.ts:7-22`). New persistent sessions choose a timestamp/session-id JSONL path (`packages/coding-agent/src/core/session-manager-core.ts:124-148`). `message_end` persistence appends ordinary user, assistant, and tool-result messages to that file (`packages/coding-agent/src/core/agent-session-events.ts:168-191`).

Workflow-specific session handling is performed before SDK creation:

- `sessionDir` selects the directory used by `SessionManager.create()`.
- `resumeFromSessionFile` uses `SessionManager.open()`.
- `context: "fork"` with `forkFromSessionFile` uses `SessionManager.forkFrom()`.
- A host-selected non-default session directory is passed through workflow runtime options (`packages/workflows/src/runs/foreground/stage-runner-options.ts:30-79`, `packages/workflows/src/extension/runtime.ts:161-175`).
- Workflow sessions are marked internal with `{ runId, stageId, stageName }`, so normal recent-session listings exclude them while explicit workflow reopening remains possible (`packages/coding-agent/src/core/sdk.ts:92-103`; `packages/coding-agent/src/core/session-manager-core.ts:151-160`).

Stage session metadata is captured lazily after session creation and written into the stage snapshot and workflow persistence entries (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:238-247`, `packages/workflows/src/runs/foreground/executor-stage-factory.ts:314-339`). The snapshot stores `sessionId` and `sessionFile`; `transcriptPath` is an alias derived from `sessionFile` (`packages/workflows/src/extension/workflow-stage-results.ts:39-59`).

Live transcript inspection reads `handle.messages`. Detached inspection reads the snapshot and retained session path (`packages/workflows/src/extension/workflow-tool-inspection.ts:107-137`). If a path exists and no explicit `tail`/`limit` is supplied, the workflow tool returns the path rather than inlining the file; explicit previews are bounded (`packages/workflows/src/extension/workflow-stage-results.ts:114-163`). Post-mortem reopening requires a completed stage with a session file whose JSONL contains a valid Atomic session header and at least one usable context-bearing message (`packages/workflows/src/runs/foreground/postmortem-stage-chat.ts:61-104`, `packages/workflows/src/shared/session-transcript.ts:29-50`).

## Usage and Cost Per Stage

The SDK exposes `AgentSession.getSessionStats()`. It scans session entries, counts messages/tool calls, sums assistant/tool-result/branch-summary usage, and returns input/output/cache token totals and accumulated cost (`packages/coding-agent/src/core/agent-session-export.ts:14-55`; `packages/coding-agent/src/core/agent-session-methods.ts:292-295`).

The workflow stage runtime does not expose `getSessionStats()` in `StageSessionRuntime`, and the workflow executor never calls it (`packages/workflows/src/runs/foreground/stage-runner-types.ts:41-89`). `StageSnapshot` stores session metadata, model/fallback metadata, timing, result, and failure fields, but no usage or cost fields (`packages/workflows/src/shared/store-types.ts:161-249`). `StageEndPayload` likewise contains duration, result/error, model-session identifiers, and replay metadata but no usage/cost fields (`packages/workflows/src/shared/persistence-session-entries.ts:81-100`).

Workflow transcript previews also reduce messages to role, text, tool name, output, and timestamp, omitting usage/cost (`packages/workflows/src/extension/workflow-stage-results.ts:20-26`, `packages/workflows/src/extension/workflow-stage-results.ts:182-203`). Therefore, stage-level usage/cost remains available in the SDK session statistics or raw session transcript, but is not captured into the workflow stage snapshot or stage-end persistence payload. During model fallback, an old session can be retired and a new session adopted; delivery ownership transfers, while stage metadata is updated from the currently attached session (`packages/workflows/src/runs/foreground/stage-runner-replacement.ts:5-40`, `packages/workflows/src/runs/foreground/executor-stage-factory.ts:238-247`).

## Concurrency Control

Each workflow run creates one `ConcurrencyLimiter`. Its configured limit comes from an input `max_concurrency` value or workflow configuration; the default is `4` (`packages/workflows/src/engine/run.ts:237-262`, `packages/workflows/src/runs/shared/concurrency.ts:71-75`, `packages/workflows/src/extension/config-loader.ts:49-65`, `packages/workflows/src/extension/config-loader.ts:182-186`).

Tracked stage calls acquire the limiter before eager session creation or prompt execution and release it in a `finally` block (`packages/workflows/src/runs/foreground/executor-stage-call.ts:120-134`, `packages/workflows/src/runs/foreground/executor-stage-call.ts:292-334`). Stage objects themselves can be created before their SDK sessions; sessions are normally created lazily inside a tracked call (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:156-161`, `packages/workflows/src/runs/foreground/executor-stage-call.ts:159-171`).

`ctx.parallel()` has a separate worker limit. `mapParallelSteps()` normalizes invalid concurrency to the number of steps, starts at most that many workers, preserves result order, aggregates failures when fail-fast is disabled, and rejects on the first failure when fail-fast is enabled (`packages/workflows/src/runs/foreground/executor-direct-helpers.ts:31-118`). Thus parallel-step worker concurrency and the per-run stage limiter both participate in stage execution.

Parallel fail-fast creates a shared scope, records active stages, and invokes each active stage’s skip routine on the first failure (`packages/workflows/src/engine/primitives/parallel.ts:38-70`). Each skipped stage aborts and closes its SDK session before finalization (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:408-417`).

## Intercom Group Inheritance

Every workflow runtime derives a stable group from the top-level root run: `workflow:<rootRunId>` (`packages/workflows/src/engine/runtime.ts:100-103`; `packages/workflows/src/shared/intercom-group.ts:4-10`). The stage factory passes this group into stage metadata (`packages/workflows/src/engine/runtime.ts:116-136`; `packages/workflows/src/runs/foreground/executor-stage-factory.ts:154-164`).

Stage group resolution is:

1. Explicit stage `group`.
2. The workflow invocation group.
3. A fresh UUID for a surviving `group: true`.
4. No override when the stage has no intercom access (`packages/workflows/src/shared/intercom-group.ts:27-57`).

`parallel()` resolves `group: true` once per parallel set, so all items in that set share one generated UUID (`packages/workflows/src/engine/primitives/parallel.ts:28-37`).

The resolved group is placed in `orchestrationContext.intercomGroup`. The intercom extension resolves a session’s home group with precedence of orchestration context, environment, config, then `"default"` (`packages/intercom/group.ts:24-45`). A stage’s subagent tooling reads the stage group from the current orchestration context and passes explicit/inherited group values to child runs; explicit child group wins over inherited stage group, and `true` resolves to a shared parallel UUID (`packages/subagents/src/runs/shared/intercom-group.ts:14-50`; `packages/subagents/src/runs/foreground/subagent-executor-single.ts:183-222`).

## Errors, Provider Timeouts, and Idle Watchdog

Stage creation errors propagate from the adapter and SDK. Prompt-time validation rejects missing/unresolved models and missing authentication before a non-streaming prompt starts (`packages/coding-agent/src/core/agent-session-prompt.ts:121-155`). Provider authentication and request setup errors also propagate through the SDK stream function (`packages/coding-agent/src/core/sdk.ts:249-305`).

Workflow model fallback retries only failures classified as retryable; aborted or non-retryable failures are rethrown and become stage failures through the executor’s failure classification path (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:575-603`, `packages/workflows/src/runs/foreground/executor-stage-call.ts:276-291`).

The SDK has provider-level HTTP idle timeout and retry settings. The default HTTP idle timeout is `600_000` ms (`packages/coding-agent/src/core/http-dispatcher.ts:1-5`), and the SDK chooses the stream timeout from explicit stream options, provider retry settings, or the configured HTTP idle timeout (`packages/coding-agent/src/core/sdk.ts:262-269`).

The workflow stage path has no separate idle watchdog or per-stage timeout option. `StageSessionController.promptWithPauseResume()` awaits `activeSession.prompt()` and only reacts to pause/resume or the executor abort signal (`packages/workflows/src/runs/foreground/stage-runner-controller.ts:470-515`). `raceAbort()` installs only an `AbortSignal` listener and has no timer (`packages/workflows/src/runs/foreground/executor-abort.ts:412-432`). The available stage/session option types contain no stage timeout field (`packages/workflows/src/shared/types.ts:185-208`, `packages/coding-agent/src/core/agent-session-types.ts:175-181`).

## Reusable SDK Runtime vs. Workflow-Specific Runtime

### SDK/runtime pieces present in the in-process path

- `createAgentSession()` and `AgentSession` lifecycle methods (`packages/coding-agent/src/core/sdk.ts:79-388`; `packages/coding-agent/src/core/agent-session-methods.ts:304-382`).
- `SessionManager` JSONL persistence, reopening, branching, and in-memory sessions (`packages/coding-agent/src/core/session-manager-core.ts:444-471`).
- `DefaultResourceLoader` and inherited skills/extensions/prompts/system-prompt configuration (`packages/coding-agent/src/core/resource-loader-types.ts:37-106`; `packages/workflows/src/extension/atomic-stage-session.ts:69-110`).
- Model/runtime selection, tool allowlists/blocklists, custom tools, thinking levels, event subscriptions, steering/follow-up queues, queue pause gates, abort, disposal, and `getSessionStats()` (`packages/coding-agent/src/core/sdk-types.ts:16-92`; `packages/coding-agent/src/core/agent-session-methods.ts:304-382`).
- Direct event delivery from the SDK session to consumers through `subscribe()` (`packages/coding-agent/src/core/agent-session-events.ts:432-489`).

### Workflow-specific pieces

- Stage graph creation, parent tracking, scheduler barriers, run/store snapshots, lifecycle persistence, and fail-fast behavior (`packages/workflows/src/runs/foreground/executor-stage-factory.ts:63-117`, `packages/workflows/src/engine/run.ts:237-262`).
- Workflow-only option rewriting for schema output, MCP scope, model fallback, worktrees, session classification, and intercom groups (`packages/workflows/src/runs/foreground/stage-runner-options.ts:30-79`, `packages/workflows/src/runs/foreground/stage-runner-structured-output.ts:63-87`).
- Stage UI broker, attached stage-chat rendering, delivery-activity projection, and `ask_user_question` routing (`packages/workflows/src/extension/wiring.ts:314-357`, `packages/workflows/src/tui/stage-chat-view-state.ts:112-121`).
- Controlled pause/resume semantics, scheduler cascade pause, workflow admission boundaries, late-message routing, and continuation-prompt injection (`packages/workflows/src/runs/foreground/stage-runner-pause.ts:37-199`, `packages/workflows/src/runs/foreground/executor-stage-control.ts:143-210`).
- Workflow graph concurrency and parallel-set group generation (`packages/workflows/src/runs/shared/concurrency.ts:9-67`, `packages/workflows/src/engine/primitives/parallel.ts:17-73`).
- Workflow stage snapshots and lifecycle persistence, which retain session identifiers and paths but not SDK usage/cost totals (`packages/workflows/src/shared/store-types.ts:234-249`, `packages/workflows/src/shared/persistence-session-entries.ts:81-100`).

## Unverified Details

No runtime execution was performed; these findings describe the source-level in-process path.