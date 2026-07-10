I don’t have a file write/edit tool available in this subagent session, so I could not update `/workspaces/atomic/progress.md` or write the requested markdown file directly. Below is the complete content intended for:

`/workspaces/atomic/research/docs/2026-07-10-transitive-cost-coding-agent-analysis.md`

---

# Transitive Cost Coding-Agent Analysis

## Overview

`packages/coding-agent` currently accounts for usage by summing assistant-message usage in the current `AgentSession`/`SessionManager` only. Descendant work already produces usable session files and, in some subagent paths, usage summaries, but there is no current coding-agent door that rolls those costs into the parent session’s footer, `/session` stats, export header, or a transitive context/cost surface.

The clean attachment point for a `TransitiveUsageAggregator` is `AgentSession`: it is the object already handed to the footer, interactive event subscriber, SDK callers, and extension command contexts, and it is assembled through additive method modules and public/internal surface interfaces.

## Entry Points

- `packages/coding-agent/src/core/agent-session.ts:68-181` — `AgentSession` class, constructor, and prototype method installation.
- `packages/coding-agent/src/core/agent-session-methods.ts:77-249` — internal method surface for `AgentSession`.
- `packages/coding-agent/src/core/agent-session-methods.ts:251-331` — public `AgentSession` surface exposed to SDK/TUI consumers.
- `packages/coding-agent/src/modes/interactive/components/footer.ts:38-128` — current footer usage/cost rendering.
- `packages/coding-agent/src/core/agent-session-export.ts:13-55` — current self-only `getSessionStats()`.
- `packages/coding-agent/src/core/session-manager-types.ts:18-29` — session header linkage fields, including `parentSession`, `internal`, and workflow metadata.
- `packages/coding-agent/src/core/session-manager-core.ts:436-490` — resume/list APIs and `includeInternal` behavior.
- `packages/coding-agent/src/core/event-bus.ts:3-33` — shared event bus shape used by extensions.
- `packages/subagents/src/shared/types-results.ts:75-82` — subagent `Usage` shape.
- `packages/workflows/src/shared/store-types.ts:135-230` — workflow `StageSnapshot` shape, currently without usage.

## Current Self-Only Usage Accounting

### Footer usage line

`getUsageLine()` in the footer computes totals from `session.sessionManager.getEntries()` (`footer.ts:53`) and includes only entries where `entry.type === "message"` and `entry.message.role === "assistant"` (`footer.ts:53-54`).

For each assistant message, it adds:

- input tokens from `entry.message.usage.input` (`footer.ts:55`)
- output tokens from `entry.message.usage.output` (`footer.ts:56`)
- cache-read tokens from `entry.message.usage.cacheRead` (`footer.ts:57`)
- cache-write tokens from `entry.message.usage.cacheWrite` (`footer.ts:58`)
- cost from `entry.message.usage.cost.total` (`footer.ts:59`)

The footer then renders the cost as `$${totalCost.toFixed(3)}` when `totalCost` is non-zero or the selected model uses OAuth subscription auth (`footer.ts:97-104`). Context usage is separately read from `session.getContextUsage()` (`footer.ts:67-74`) and rendered as a percentage of the current model context window (`footer.ts:107-120`).

Important shape distinction: the footer’s token badges and cost are currently computed from all session entries, while `getContextUsage()` is based on the current branch/context state rather than a transitive descendant tree.

### Session stats command

`getSessionStats()` sums only `this.state.messages` (`agent-session-export.ts:14-36`). For assistant messages it counts tool calls and adds input/output/cache/cost (`agent-session-export.ts:26-35`). It returns:

- token object with `input`, `output`, `cacheRead`, `cacheWrite`, and `total` (`agent-session-export.ts:46-52`)
- scalar `cost` (`agent-session-export.ts:53`)
- `contextUsage` from `this.getContextUsage()` (`agent-session-export.ts:54`)

The interactive `/session` command calls `this.session.getSessionStats()` (`interactive-slash-commands.ts:357-358`) and renders message counts, tokens, and cost from that self-only result (`interactive-slash-commands.ts:361-387`). There is currently no `/context` command in `interactive-input-handling.ts`; the existing adjacent command is `/session`, dispatched only for exact `text === "/session"` (`interactive-input-handling.ts:318-321`).

### HTML export header

The HTML export template computes stats over exported entries by summing assistant-message token/cost fields (`template.js:1335-1371`). It renders total cost as the sum of cost components, then `$${totalCost.toFixed(3)}` (`template.js:1376-1410`). The split template copy does the same in `template-js/entries-navigation.js:210-285`.

### Usage shape in coding-agent sessions

The documented per-message `Usage` shape is:

- `input`
- `output`
- `cacheRead`
- `cacheWrite`
- `totalTokens`
- `cost.input`
- `cost.output`
- `cost.cacheRead`
- `cost.cacheWrite`
- `cost.total`

This is documented in `packages/coding-agent/docs/session-format.md:101-113`.

## AgentSession Attachment Shape

### Current construction pattern

`AgentSession` is a facade class whose responsibilities are installed from sibling method modules. The class stores core dependencies such as `agent`, `sessionManager`, `settingsManager`, resource loader, model registry, extension runner state, and async job manager (`agent-session.ts:68-129`). The constructor receives an `AgentSessionConfig`, initializes those fields, subscribes to the underlying `Agent`, installs tool hooks, and builds runtime state (`agent-session.ts:130-158`).

Prototype methods are installed through:

- `installAgentSessionAccessors(...)` (`agent-session.ts:164`)
- `Object.assign(AgentSession.prototype, ...)` with method module objects (`agent-session.ts:165-181`)

That means an additive `TransitiveUsageAggregator` fits the existing pattern as either:

1. a private/protected field initialized in the constructor, plus methods added to the public/internal surfaces; or
2. a small sibling method module assigned alongside `agentSessionExportMethods` at `agent-session.ts:180`.

### Public/internal interface additions

The authoritative type surfaces are:

- `AgentSessionMethodSurface` (`agent-session-methods.ts:77-249`)
- `AgentSessionPublicSurface` Pick list (`agent-session-methods.ts:251-327`)
- `AgentSessionInternalSurface` private/internal fields (`agent-session-methods.ts:333-392`)

For `getTransitiveUsage()` to be reused by footer, slash commands, SDK callers, and exports, it should be added to `AgentSessionMethodSurface` and the `AgentSessionPublicSurface` Pick list. For the write-side chokepoint, `attributeDescendantUsage(report)` can be public if first-party extensions/subsystems need direct access, or internal plus event-bus subscription if all cross-component reporting flows through the bus. The requested door shape suggests it should be an `AgentSession` method because the footer already receives only `AgentSession` (`footer.ts:38-42`, `footer.ts:153-170`).

### Current event flow and UI invalidation

`AgentSession.subscribe()` stores listeners in `_eventListeners` and returns an unsubscribe function (`agent-session-events.ts:375-381`). `_emit()` synchronously invokes all listeners (`agent-session-events.ts:10-13`). Interactive mode subscribes through `this.session.subscribe(...)` (`interactive-agent-events.ts:4-7`) and calls `handleEvent()` for each session event (`interactive-agent-events.ts:10`).

The interactive handler invalidates the footer before switching on every event (`interactive-agent-events.ts:15`) and explicitly invalidates/renders for context-window changes (`interactive-agent-events.ts:87-90`), message end (`interactive-agent-events.ts:153-198`), agent end (`interactive-agent-events.ts:246-273`), and compaction events (`interactive-agent-events.ts:302-337`, `interactive-agent-events.ts:362-386`).

Implementation guidance from the current flow:

- A descendant-usage update should become an `AgentSessionEvent` variant if the interactive UI should react via the existing `session.subscribe()` path.
- The event handler should mirror `context_window_changed`: invalidate `usageMeter` and call `ui.requestRender()` (`interactive-agent-events.ts:87-90`).
- `UsageMeterComponent.invalidate()` is currently a no-op because render pulls live session data (`footer.ts:165-170`), so the important side effect is the render request, not cached recomputation.

## Door Shapes

### `getTransitiveUsage()`

The requested `getTransitiveUsage()` door should be a pure read on `AgentSession`, shaped around the coding-agent `Usage` object, not the subagent scalar-cost shape.

Suggested shape grounded in existing code:

```ts
interface TransitiveUsage {
  self: Usage;
  descendants: Usage;
  total: Usage;
  complete: boolean;
}
```

The `self` calculation should reuse the same source as the footer currently uses: assistant messages in `session.sessionManager.getEntries()` (`footer.ts:53-59`) if the footer’s “cumulative all entries” semantics are preserved. `getSessionStats()` currently uses `state.messages` instead (`agent-session-export.ts:14-36`), so callers need to decide whether they want footer-style cumulative entries or active-branch state stats. The RFC’s status-bar path aligns with the footer’s `getEntries()` behavior.

`total` should be produced by adding cost and token fields from `self` and `descendants`, preserving the coding-agent cost object documented in `session-format.md:101-113`.

### `attributeDescendantUsage(report)`

The write-side door should be an idempotent keyed upsert, because existing descendant events can be delivered at least once or replayed from files:

```ts
interface DescendantUsageReport {
  rootSessionId: string;
  childRunId: string;
  kind: "subagent" | "workflow-stage" | "workflow-run";
  usage: Usage;
  settled: boolean;
}
```

Grounding:

- `AgentSession` already has a stable `sessionId` accessor in its method surface (`agent-session-methods.ts:90-92`) and public surface (`agent-session-methods.ts:264-266`).
- `SessionManager` exposes `getSessionId()` (`session-manager-core.ts:190-192`).
- Subagent foreground results carry a run id in `Details.runId` (`types-results.ts:269-275`).
- Workflow stages have `StageSnapshot.id`, `sessionId`, and `sessionFile` (`store-types.ts:135-138`, `store-types.ts:200-207`).

The report should be refused/ignored when `report.rootSessionId` does not match the current session id. The update should replace the existing entry for `childRunId`, not add to it. That maps to the current architecture because footer rendering can then be a read over `self + Map.values()`.

### `walkDescendantUsage(root)`

`walkDescendantUsage(root)` should be the reconciliation/pull path. Current durable linkage exists in session headers and session lists:

- session headers can include `parentSession` (`session-manager-types.ts:18-25`)
- internal workflow sessions are marked with `internal?: boolean` and workflow metadata (`session-manager-types.ts:25-29`)
- listed `SessionInfo` includes `parentSessionPath`, `internal`, and `workflow` (`session-manager-types.ts:195-207`)
- `SessionManager.list()` excludes internal sessions unless `includeInternal: true` (`session-manager-core.ts:468-475`)
- `SessionManager.listAll()` also excludes internal sessions unless `includeInternal: true` (`session-manager-core.ts:478-490`)

Because workflow stages are intentionally internal, a descendant walk that is meant to include workflow stage spend must list with `includeInternal: true`.

Session file reading primitives:

- `loadEntriesFromFile()` reads JSONL session files and parses each complete line (`session-manager-storage.ts:36-78`)
- malformed lines return `null` from `parseSessionEntryLine()` and are skipped (`session-manager-storage.ts:26-32`)
- `SessionManager.open()` opens a path and uses `loadEntriesFromFile()` (`session-manager-core.ts:426-433`)
- `setSessionFile()` throws for a non-empty file that parses as no valid session (`session-manager-core.ts:94-107`)

Implementation guidance:

- Use `SessionInfo.path` and `SessionInfo.parentSessionPath` to build a descendant tree.
- Include internal sessions for workflow stages.
- Sum each session file once by session id/path.
- Mark `complete: false` when a listed descendant cannot be opened or has an unreadable/invalid session file.
- Do not invoke this on every footer render; current footer rendering is synchronous and cheap (`footer.ts:169-170`).

## Subagent Usage Flow

### Foreground subagents

Subagent foreground usage uses a different shape from coding-agent session usage:

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
```

Defined in `packages/subagents/src/shared/types-results.ts:75-82`.

During foreground execution, `execution-attempt.ts` listens to child process JSONL events. On `message_end` with an assistant message, it:

- increments `result.usage.turns` (`execution-attempt.ts:288-292`)
- adds `u.input`, `u.output`, `u.cacheRead`, `u.cacheWrite` (`execution-attempt.ts:293-298`)
- adds scalar cost from `u.cost?.total` (`execution-attempt.ts:299`)
- updates progress token count as input plus output (`execution-attempt.ts:300`)

Fallback attempts are aggregated with `sumUsage()` (`execution-run-sync.ts:123-138`), and the final `SingleResult.usage` is replaced with the aggregate usage across attempts (`execution-run-sync.ts:172`). `sumUsage()` adds all scalar subagent usage fields in place (`execution-utils.ts:10-17`).

Foreground `SingleResult` includes:

- `usage` (`types-results.ts:236-245`)
- `sessionFile` (`types-results.ts:251`)
- `modelAttempts` (`types-results.ts:247-248`)

For a foreground direct report into `attributeDescendantUsage(report)`, scalar subagent usage must be converted to the coding-agent `Usage` cost-object shape. A direct conversion can preserve known totals:

- `input`, `output`, `cacheRead`, `cacheWrite`
- `totalTokens = input + output + cacheRead + cacheWrite`
- `cost.total = usage.cost`
- component costs default to zero unless a session-file walk is used for exact cost components

### Async/background subagents

Async/background runners also accumulate scalar usage from child JSONL events. In `subagent-runner-streaming.ts`, assistant `message_end` events add input/output/cache/cost into an `emptyUsage()` accumulator (`subagent-runner-streaming.ts:131-140`). `emptyUsage()` returns scalar `cost: 0` and `turns: 0` (`subagent-runner-utils.ts:21-23`).

The async final result file currently writes:

- `id`, `agent`, `mode`, `success`, state, summary (`subagent-runner-finalize.ts:89-97`)
- each child result with `sessionFile`, model fields, artifacts, structured output (`subagent-runner-finalize.ts:97-114`)
- top-level `sessionId` and `sessionFile` (`subagent-runner-finalize.ts:123-125`)

It does not currently write aggregate usage or transitive usage in that result payload (`subagent-runner-finalize.ts:89-132`).

The result watcher emits `SUBAGENT_ASYNC_COMPLETE_EVENT` with the result-file data plus `runId`, nested children, and normalized child results (`result-watcher.ts:193-211`). The subagents extension subscribes to that event through `pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete)` (`extension/index.ts:414-417`). The async job tracker’s `handleComplete()` only updates UI job status and rerenders widgets (`async-job-tracker.ts:366-386`); it does not forward usage to coding-agent.

Token-only async status exists separately:

- `parseSessionTokens()` finds the latest session file in a session directory (`session-tokens.ts:5-20`)
- it sums `usage.inputTokens ?? usage.input` and `usage.outputTokens ?? usage.output` from JSON lines (`session-tokens.ts:23-39`)
- async sequential and parallel runners use that token data for status/progress (`subagent-runner-sequential.ts:73-87`, `subagent-runner-parallel.ts:132-136`)

Implementation guidance:

- Async result files need an additive usage field if the event path should push usage without walking the child session file.
- The event bus payload emitted at `result-watcher.ts:193-211` is the natural place to carry the same report shape used by `attributeDescendantUsage(report)`.
- Existing async tracker rerender logic can remain UI-job-specific; the coding-agent session-level aggregator should subscribe through a single event-bus funnel.

## Workflow Usage Flow

### Stage sessions

Workflow stages create in-process SDK `AgentSession`s, not subprocesses. `buildRuntimeAdapters()` creates stage adapters that call either an injected `createAgentSession`, `pi.createAgentSession`, a test stub, or production `createAgentSession` from `@bastani/atomic` (`wiring.ts:282-310`). The comments state that each stage gets an in-process pi SDK `AgentSession` and `stage.prompt()` delegates to `AgentSession.prompt()` (`wiring.ts:266-272`).

`StageSessionController` lazily creates the session:

- `ensureSession()` creates the initial session on first demand (`stage-runner-controller.ts:90-95`)
- `ensureSessionFromFile()` reattaches from a session file (`stage-runner-controller.ts:97-101`)
- `sessionMeta()` exposes `sessionId` and `sessionFile` from the stage session (`stage-runner-controller.ts:195-197`)

The stage factory captures this metadata:

- `captureStageSessionMeta()` reads `innerCtx.__sessionMeta()` (`executor-stage-factory.ts:191-194`)
- it writes `sessionId` and `sessionFile` into the `StageSnapshot` (`executor-stage-factory.ts:194-195`)
- it calls `activeStore.recordStageSession(...)` when either exists (`executor-stage-factory.ts:196`)
- it calls `opts.onStageSession` with the snapshot (`executor-stage-factory.ts:197`)

`callStage()` invokes `runtime.captureStageSessionMeta()` after ensuring a session for certain model/fallback paths (`executor-stage-call.ts:123-125`) and again after the stage call finishes (`executor-stage-call.ts:180-181`).

### Stage snapshots and persistence

`StageSnapshot` currently includes `sessionId`, `sessionFile`, model/fallback metadata, and attachability state (`store-types.ts:200-230`). It has no `usage` field.

`recordStageEnd()` copies terminal fields from the stage snapshot into the store. It copies `sessionId` and `sessionFile` (`store-stage-methods.ts:90-110`), but there is no usage field to copy.

Stage-end persistence appends `sessionId` and `sessionFile` to the persistence payload (`executor-stage-factory.ts:248-267`), but no usage. Durable checkpoints also preserve session metadata:

- `recordStageSessionCheckpoint()` records session id/file for resumable stages (`stage-primitive.ts:50-65`)
- `checkpointMetadata()` includes `sessionId` and `sessionFile` (`stage-primitive.ts:230-240`)

Implementation guidance:

- `recordStageUsage(stageId, usage)` should be a store-level addition near `recordStageSession()`, because `recordStageSession()` already owns the “stage session metadata changed” mutation and notification path (`store-stage-methods.ts:134-150`).
- `StageSnapshot.usage?: Usage` would be additive and should be copied in `recordStageEnd()` alongside `sessionId`/`sessionFile`.
- Since workflow stages are separate `AgentSession`s with session files, exact cost can also be reconstructed by `walkDescendantUsage()` from `stage.sessionFile`.

## Session Manager and Descendant Discovery

### Header linkage

Session headers support a parent-file link via `parentSession?: string` (`session-manager-types.ts:18-25`). They also support `internal?: boolean` and workflow metadata (`session-manager-types.ts:25-29`).

New sessions can receive `parentSession`, `internal`, and workflow metadata through `NewSessionOptions` (`session-manager-types.ts:31-38`). Headers are created by `createSessionHeader()`, which writes those optional fields when provided (`session-manager-entries.ts:34-52`).

Workflow-created sessions are marked internal in `createAgentSession()` when `options.orchestrationContext?.kind === "workflow-stage"` (`sdk.ts:134-145`). This calls `sessionManager.markSessionInternal()` with workflow run/stage ids and stage name (`sdk.ts:138-144`). `markSessionInternal()` updates the header and rewrites the file if already flushed (`session-manager-core.ts:152-159`).

### Resume/list behavior

Internal workflow sessions are hidden from ordinary resume history unless `includeInternal` is true:

- `findMostRecentSession()` filters internal headers unless `includeInternal` is true (`session-manager-storage.ts:142-155`)
- `SessionManager.continueRecent()` defaults `includeInternal` to false (`session-manager-core.ts:436-449`)
- `SessionManager.list()` defaults `includeInternal` to false (`session-manager-core.ts:468-475`)
- `SessionManager.listAll()` defaults `includeInternal` to false (`session-manager-core.ts:478-490`)
- `listSessionsFromDir()` prefilters internal headers before full transcript parse when `includeInternal` is false (`session-manager-list.ts:145-180`)

CLI startup behavior:

- `--resume` opens the selector with `SessionManager.list()` and `SessionManager.listAll()` using defaults, so internal workflow sessions are excluded (`main-session.ts:195-207`)
- `--continue` calls `SessionManager.continueRecent()` using defaults, so internal workflow sessions are excluded (`main-session.ts:212-214`)
- explicit `--session` resolves via `resolveSessionPath()` and `SessionManager.list()`/`listAll()` defaults for id matching (`main-session.ts:38-64`, `main-session.ts:171-193`)

Interactive `/resume` behavior:

- `/resume` dispatches to `showSessionSelector()` (`interactive-input-handling.ts:403-406`)
- the selector uses `SessionManager.list()` and `SessionManager.listAll()` without `includeInternal` (`interactive-session-routing.ts:219-227`)
- selecting a path calls `handleResumeSession()` (`interactive-session-routing.ts:228-231`)
- `handleResumeSession()` calls `runtimeHost.switchSession()` and then re-renders the current state (`interactive-session-routing.ts:260-280`)

Runtime switch behavior:

- `switchSession()` opens the selected file with `SessionManager.open()` (`agent-session-runtime.ts:207-209`)
- it tears down the current session with reason `"resume"` (`agent-session-runtime.ts:210`)
- it creates a new runtime with `sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile }` (`agent-session-runtime.ts:211-218`)
- it calls `finishSessionReplacement()` to rebind UI/session references (`agent-session-runtime.ts:220`)

Implementation guidance for `walkDescendantUsage(root)` on load/resume:

- On new `AgentSession` creation for an existing session, `createAgentSession()` restores session context from `sessionManager.buildSessionContext()` (`sdk.ts:157-159`) and sets `agent.state.messages` from existing messages (`sdk.ts:440-442`).
- A transitive aggregator seeded on load/resume should run after the `SessionManager` is known and the `AgentSession` exists, because the aggregator needs the current session id/file and must be attached to that newly-created session.
- Interactive resume already rebinds the whole session (`agent-session-runtime.ts:185-191`, `agent-session-runtime.ts:220`), so the aggregator should live on the new `AgentSession`, not on `InteractiveModeBase`.

## Event Bus Subscription

The event bus is a simple channel/data emitter:

- `emit(channel, data)` (`event-bus.ts:3-5`, `event-bus.ts:15-17`)
- `on(channel, handler)` returning unsubscribe (`event-bus.ts:5`, `event-bus.ts:18-28`)
- async handler errors are caught and logged (`event-bus.ts:19-24`)

Extensions receive this as `pi.events` (`extensions/api-types.ts:314-315`). The loader constructs the extension API with `events: eventBus` (`loader-api.ts:204-205`), and extension loader core creates or reuses an event bus (`loader-core.ts:126-139`).

Implementation guidance:

- The report channel can be one event bus channel, e.g. `"usage:descendant-rollup"`, carrying `DescendantUsageReport`.
- The subscriber should be installed once per `AgentSession` and should call only `attributeDescendantUsage(report)`.
- Since `AgentSession` currently does not expose the `ResourceLoader`’s private event bus, the subscription needs either:
  - an additive event bus field in `AgentSessionConfig`, or
  - an additive `eventBus` accessor from the resource loader, or
  - wiring in the extension layer that receives `pi.events` and calls an exposed `AgentSession` method through command context.
- The first two keep the aggregation chokepoint inside coding-agent rather than spread across extensions.

## `/context`, `/session`, `/cost`, Load, and Resume Behavior

Current interactive commands include `/session`, not `/context`, in the direct command dispatcher. `/session` displays self-only stats via `getSessionStats()` (`interactive-input-handling.ts:318-321`, `interactive-slash-commands.ts:357-387`).

`/reload` reloads settings/resources and rebuilds extension runtime without switching session files:

- interactive command calls `this.session.reload()` (`interactive-slash-commands.ts:50-52`)
- `AgentSession.reload()` emits `session_shutdown` on reload, reloads settings/resources, rebuilds runtime, and emits `session_start` if bindings exist (`agent-session-extension-bindings.ts:242-265`)

Implementation guidance:

- A new `/cost` command can call `walkDescendantUsage(root)` and then reseed the aggregator through the same keyed report map.
- If a `/context` summary line is added, it should call `getTransitiveUsage()` for the cost line while continuing to use `getContextUsage()` for context-window percentage, because `getContextUsage()` is explicitly per current session/model (`agent-session-export.ts:59-103`).
- Load/resume seeding should happen for:
  - CLI `--session` / `--resume` / `--continue`, because all flow into `createAgentSession()` with an existing `SessionManager` (`main-session.ts:138-224`, `sdk.ts:157-159`)
  - interactive `/resume`, because it creates a replacement runtime/session (`agent-session-runtime.ts:194-221`)
  - `/import`, because it opens the imported session and creates a replacement runtime with resume reason (`agent-session-runtime.ts:352-386`)
- `/reload` should preserve or re-subscribe the existing session’s aggregator event-bus listener because it rebuilds extension runtime in-place rather than creating a new `AgentSession` (`agent-session-extension-bindings.ts:242-265`).

## Footer Integration Guidance

Current footer split:

- token badges come from cumulative self assistant entries (`footer.ts:45-65`, `footer.ts:76-95`)
- cost comes from that same self-only accumulation (`footer.ts:50-59`, `footer.ts:101-104`)
- context percentage comes from `session.getContextUsage()` (`footer.ts:67-74`, `footer.ts:107-120`)

For “cost-only transitive”:

1. Keep token badge computation as-is from self entries.
2. Replace only `totalCost` rendering with `session.getTransitiveUsage().total.cost.total`.
3. Use `getTransitiveUsage().complete` to render a dim `~` prefix when incomplete.
4. Keep context percent self-only via `session.getContextUsage()`.

This preserves the current context behavior and avoids making context-window percentage transitive, which would not match the existing `getContextUsage()` model.

## Data Flow: Proposed Transitive Cost

1. Parent `AgentSession` is created with `SessionManager` and session id (`agent-session.ts:130-158`).
2. A `TransitiveUsageAggregator` is initialized on that `AgentSession`.
3. The footer calls `session.getTransitiveUsage()` during render (`footer.ts:169-170`).
4. Foreground subagent completion reads `SubagentToolResult.details.results[].usage` (`types-results.ts:269-275`, `types-results.ts:236-245`) and reports converted usage through `attributeDescendantUsage(report)`.
5. Async subagent completion emits a report through `pi.events` from the result watcher path (`result-watcher.ts:193-211`).
6. Workflow stage completion records `StageSnapshot.usage` and emits a stage rollup after `recordStageEnd()` (`store-stage-methods.ts:90-132`, `executor-stage-factory.ts:231-267`).
7. `attributeDescendantUsage(report)` keyed-upserts the child contribution.
8. The aggregator emits an `AgentSessionEvent` such as `descendant_usage_changed`.
9. Interactive event handling invalidates `usageMeter` and requests render, mirroring `context_window_changed` (`interactive-agent-events.ts:87-90`).
10. On load/resume or `/cost`, `walkDescendantUsage(root)` lists sessions including internal workflow sessions, walks `parentSessionPath`, opens descendant session files, sums assistant usage once per session, and reseeds the keyed map.

## Key Patterns

- **Facade + method modules:** `AgentSession` is a facade with implementation methods assigned from modules (`agent-session.ts:164-181`).
- **Session-file durable source:** JSONL session files hold assistant usage in message entries and are read by `SessionManager.open()` / storage helpers (`session-manager-core.ts:426-433`, `session-manager-storage.ts:36-78`).
- **Event subscription for UI:** interactive mode listens to `AgentSession` events via `session.subscribe()` and manually requests renders (`interactive-agent-events.ts:4-10`, `interactive-agent-events.ts:87-90`).
- **Extension event bus:** first-party extensions communicate over string channels with `pi.events` (`event-bus.ts:3-33`, `extensions/api-types.ts:314-315`).
- **Internal session hiding:** workflow stage sessions are intentionally hidden from standard resume lists unless `includeInternal` is true (`session-manager-types.ts:25-29`, `session-manager-core.ts:468-490`).

## Configuration and Compatibility Notes

- Session header additions are already optional/additive in shape (`session-manager-types.ts:18-29`).
- `StageSnapshot` has many optional metadata fields and can accept an additive `usage?: Usage` without changing existing required fields (`store-types.ts:135-230`).
- Async result JSON is already loosely consumed as object data and emitted with spread fields (`result-watcher.ts:193-211`), so an additive `transitiveUsage`/`usage` field can flow without changing current consumers.
- `AgentSessionPublicSurface` is a Pick list, so new public methods must be explicitly added there (`agent-session-methods.ts:251-327`).

## Implementation Guidance Summary

1. Attach `TransitiveUsageAggregator` to `AgentSession`, initialized in the constructor next to other session-owned state (`agent-session.ts:130-158`).
2. Add `getTransitiveUsage()` to `AgentSessionMethodSurface` and `AgentSessionPublicSurface` (`agent-session-methods.ts:77-327`).
3. Add `attributeDescendantUsage(report)` as the only write door into descendant totals.
4. Store descendant reports in a `Map<childRunId, report>` and replace on duplicate keys.
5. Shape all public aggregate usage as coding-agent `Usage`, not subagent scalar-cost `Usage`.
6. Convert subagent `Usage.cost: number` to coding-agent `Usage.cost.total`.
7. Add an event-bus subscriber for a single descendant-rollup channel and funnel it into `attributeDescendantUsage(report)`.
8. Emit a session event after successful aggregation updates so interactive UI can invalidate the usage meter and request render.
9. Add `StageSnapshot.usage?: Usage`, store copy logic, and persistence copy logic near existing `sessionId/sessionFile` paths.
10. Implement `walkDescendantUsage(root)` as the reconciliation path using `SessionManager.list/listAll(..., { includeInternal: true })`, `SessionInfo.parentSessionPath`, and session-file assistant usage summation.
11. Use `getTransitiveUsage().total.cost.total` only for the footer `$` figure; keep token badges and `getContextUsage()` self-only.
12. Seed/reseed aggregation on session creation/resume/import and on the future `/cost` command, not on every render.