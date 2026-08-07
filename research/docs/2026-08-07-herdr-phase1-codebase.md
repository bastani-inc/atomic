---
date: 2026-08-07 13:54:18 +04
researcher: GPT-5.6 Luna
git_commit: ad21551632b154af6275ec95470303f6ebcd5b02
branch: herdr-phase1
repository: atomic-monorepo
topic: "Phase 1 Herdr reporter and extension block-door codebase research"
tags: [research, codebase, herdr, extensions, session-lifecycle, tui]
status: complete
last_updated: 2026-08-07
last_updated_by: GPT-5.6 Luna
breaking_changes_allowed: false
compatibility_context: "Phase 1 is additive. Existing extension events, UI signatures, session-manager types, SDK exports, and non-Herdr behavior must remain compatible."
---

# Research

## Research question

Document the current Atomic codebase seams for Phase 1 of the Herdr integration: the extension block API and events, blocking UI wrapping, project-trust prompt, Herdr reporter lifecycle and transport, tests, docs, and compatibility constraints. The binding contract is `/tmp/herdr-review/phase1-spec.md`; it controls behavior where it differs from older RFC material.

## Compatibility context

Breaking changes are not allowed. The requested public additions are `ExtensionAPI.awaitUserDecision()` and the `agent_blocked`/`agent_unblocked` event types. Existing event payloads, `ExtensionUIContext` method signatures, `ReadonlySessionManager`, SDK export behavior, and all non-Herdr paths are compatibility-sensitive.

## Summary

- The extension system has typed `pi.on()` overloads, a string-keyed internal handler map, and one generic runner path for ordinary lifecycle events. No block type, block state, or block events exist today.
- `createExtensionContext()` exposes `ctx.ui` through one guarded getter at `runner-context.ts:110-115`. This is the common seam for `select`, `confirm`, `input`, `custom`, and `editor`; the host implementations already preserve cancellation and rejection behavior through their promises.
- Project trust is a separate startup path. `resolveProjectTrusted()` calls `ProjectTrustContext.ui.select()` directly, before the normal session runner is bound. It is not covered by the `ExtensionContext.ui` getter.
- `agent_end` carries the final message list, while `agent_settled` carries no payload and is emitted only after retry waits, queued continuations, and post-compaction continuation. A reporter can remember an error from `agent_end` and decide the final state at `agent_settled` without a grace or debounce timer.
- Built-ins are inline extension factories in `src/extensions/index.ts`, passed into `DefaultResourceLoader` from `main.ts`. File extensions load before inline factories, but the current loader does not expose the paths loaded in the current cycle; the deferral check therefore needs a loader-cycle path seam.
- Herdr uses newline-delimited `{id, method, params}` requests on a session-global Unix socket (a named pipe on Windows). Reports need the pane id on every request. Herdr rejects lower *and equal* sequence values for a source while still acknowledging the request, so session, state, and release messages need one high-water sequence counter and one ordered writer.
- The checked-in worktree is clean and no implementation files were changed. `packages/workflows` has no role in this Phase 1 scope.

## Contract traceability

The following are direct clauses from the binding spec, recorded here as implementation constraints rather than new design:

- Activation requires `HERDR_ENV === "1"`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH`; env is captured inside each factory invocation; only `ctx.mode === "tui"` reports; a loaded `herdr-agent-state.ts`/`.js` file silences the built-in for that cycle.
- `awaitUserDecision(label, reason)` returns a `UserBlock`. Reasons are `dialog`, `project_trust`, `workflow_prompt`, and `supervisor_ask`. Release is idempotent and only the returned handle can end its block. Blocks are reference-counted and the oldest label wins.
- The five wrapped UI methods are `select`, `confirm`, `input`, `custom`, and `editor`. Their return values, cancellation, and thrown errors must be unchanged.
- State precedence is user blocks, failure-blocked, active, then idle. `agent_start` makes the reporter working. `agent_settled` with `ctx.isIdle() === true` makes it idle unless the final assistant message ended with `stopReason: "error"`, in which case it makes it blocked with a short error message.
- Reporting is serialized and coalesces queued state to the latest value. Socket failures are silent and bounded to a 500 ms attempt plus one 1,500 ms retry. Quit drains the queue and sends `pane.release_agent` last. Non-quit shutdown drops queued work and silences the old instance.
- Session identity is obtained from the typed `ReadonlySessionManager`; an absolute session path wins over the session id. Reports use exactly `source: "herdr:atomic"`, `agent: "atomic"`, and states `working | idle | blocked`. Prompt text, tool arguments, and model output never cross the socket.

## Detailed findings

### 1. Extension API and event plumbing

`ExtensionAPI` is declared in `packages/coding-agent/src/core/extensions/api-types.ts:69-122`. Its `on()` overloads list every public event, including `session_start`, `session_shutdown`, `agent_start`, `agent_end`, `agent_settled`, `tool_call`, `project_trust`, and `input`. There is no `awaitUserDecision` member or block type yet.

`ExtensionEvent` is the union in `packages/coding-agent/src/core/extensions/event-types.ts:27-53`. `RunnerEmitEvent` in `runner-events.ts:47-81` excludes event classes with special return semantics, but ordinary lifecycle events—including the new block events—fit the generic path. `ExtensionRunner.emit()` creates a fresh guarded context and calls `runGenericHandlers()` (`packages/coding-agent/src/core/extensions/runner.ts:428-432`). Handler errors are caught and reported by the runner rather than propagated to the caller for this path (`runner-events.ts:100-128`).

Factories receive an object created by `createExtensionAPI()` (`packages/coding-agent/src/core/extensions/loader-api.ts:31-242`). Registration calls write into the extension record; action calls delegate through the shared `ExtensionRuntime`. The runtime is created with throwing action stubs during extension loading (`packages/coding-agent/src/core/extensions/loader-runtime.ts:24-29,45-66`) and receives live actions in `ExtensionRunner.bindCore()` (`runner.ts:170-251`). A block service therefore has two observable phases: it must have a typed registration surface while loading, and a live runner-bound operation when a handler or UI wrapper calls it.

`pi.events` is a separate synchronous-looking event-bus API (`packages/coding-agent/src/core/event-bus.ts:3-32`) used for extension-to-extension channels. It is distinct from `pi.on()` lifecycle handlers. The Herdr reporter's required `agent_blocked` and `agent_unblocked` subscriptions belong to the typed lifecycle event path, not the external event-bus channel.

The public type barrels are `packages/coding-agent/src/core/extensions/index.ts:43-184` and `packages/coding-agent/src/index-extensions.ts:1-137`. Existing public exports must remain unchanged except for additive block/event types required by the contract.

### 2. Current UI surfaces and the wrapping seam

`ExtensionUIContext` is defined in `packages/coding-agent/src/core/extensions/ui-types.ts:141-295`. The five contract methods have these signatures:

- `select(title, options, opts?) -> Promise<string | undefined>`
- `confirm(title, message, opts?) -> Promise<boolean>`
- `input(title, placeholder?, opts?) -> Promise<string | undefined>`
- `custom<T>(factory, options?) -> Promise<T>`
- `editor(title, prefill?, opts?) -> Promise<string | undefined>`

Dialog options carry an optional `AbortSignal` and timeout (`ui-types.ts:16-22`). `custom()` also carries component abort and overlay options (`ui-types.ts:231-259`). The contract does not include `hostSessionPicker()` or `hostInputForm()` in the five methods to wrap.

`createExtensionContext()` returns guarded lazy accessors. Its `ui` getter calls `source.assertActive()` and then `source.getUIContext()` (`packages/coding-agent/src/core/extensions/runner-context.ts:107-115`). `mode`, `sessionManager`, and other context values use the same stale-context guard. This is the one shared accessor before event handlers and tools see the host UI, so a proxy created there covers all normal `ctx.ui` callers without changing host implementations or public UI method signatures.

The host implementations preserve the relevant promise behavior already:

- TUI selector/input/editor paths resolve on selection, cancel, or abort and remove their abort listeners (`packages/coding-agent/src/modes/interactive/interactive-extension-ui.ts:14-211`).
- TUI custom UI rejects on abort or factory failure and closes/disposes the mounted component before rejecting (`packages/coding-agent/src/modes/interactive/interactive-extension-custom-ui.ts:56-223`).
- RPC `select`, `confirm`, and `input` resolve cancellation/default values through `createDialogPromise()` (`packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts:42-83,109-153`); RPC editor has its own pending-request path (`rpc-extension-ui.ts:270-287`).

The wrapping layer must await the original method and release its own block in `finally`; it must not translate an abort, alter an original return value, catch a rejection, or replace an error. The accessor is lazy today, so capturing a stale UI object or eagerly spreading the context would change existing stale-instance behavior; the file explicitly warns against that at `runner-context.ts:203-210`.

### 3. Project-trust prompt is a separate path

`ProjectTrustContext` is not `ExtensionContext`. It has `cwd`, `mode`, `hasUI`, and a restricted `ui` containing only `select`, `confirm`, `input`, and `notify` (`packages/coding-agent/src/core/extensions/agent-events.ts:151-173`). The CLI creates it in `packages/coding-agent/src/cli/project-trust.ts:7-47`.

`resolveProjectTrusted()` first emits `project_trust` handlers, then falls back to `selectProjectTrustOption()` (`packages/coding-agent/src/core/project-trust.ts:29-40,48-98`). The fallback invokes `ctx.ui.select()` directly. In normal startup this happens while `DefaultResourceLoader.reload()` is still resolving trust: it loads a pre-trust extension set and invokes the resolver before final extensions and the session runner are created (`packages/coding-agent/src/core/resource-loader-reload.ts:145-161`; `resource-loader-reload.ts:96-133`).

This means the required `reason: "project_trust"` block cannot be obtained solely by wrapping `ExtensionContext.ui` or by waiting for `session_start`. The project-trust path needs access to the same block lifetime while it calls the restricted `ProjectTrustContext.ui` method. The existing public `ProjectTrustContext` shape and the `resolveProjectTrusted()` option shape are otherwise unchanged in the current code.

### 4. Agent lifecycle timing and error observation

The extension event types define `AgentStartEvent` with only `type`, `AgentEndEvent` with `messages`, and `AgentSettledEvent` with only `type` (`packages/coding-agent/src/core/extensions/agent-events.ts:50-64`). `agent_end` is emitted with the agent event's message list (`packages/coding-agent/src/core/agent-session-events.ts:399-405`).

The prompt path emits `agent_settled` in a `finally` block after awaiting the agent turn, retry wait, queued continuations, pending post-compaction continuation, and the agent event queue (`packages/coding-agent/src/core/agent-session-prompt.ts:240-254`). This timing is stronger than `agent_end` for the final pane state: an error seen at `agent_end` can still be followed by a retry, while an error retained until settled represents the final outcome under the Phase 1 contract. No retry-grace or idle-debounce timer exists in the current host path or is needed by this lifecycle event.

The runner's `isIdle` binding reads `!this.isStreaming` (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:219-230`). The reporter should therefore use the `ctx.isIdle()` check at `agent_settled` rather than assume that every settled event means idle.

Session teardown emits `session_shutdown` before disposing the old session for reload and replacement (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:270-283`; `packages/coding-agent/src/core/agent-session-runtime.ts:251-259`). The reason union is exactly `quit | reload | new | resume | fork` (`packages/coding-agent/src/core/extensions/session-events.ts:80-86`). Public disposal emits `reason: "quit"` and awaits handlers before disposal (`agent-session-runtime.ts:478-484`). A non-quit reporter can therefore silence itself during the shutdown callback, while a quit handler can await a final queue drain and release.

A fresh runner is built during `_buildRuntime()` from the current loaded extension records and a new `ExtensionRunner` (`packages/coding-agent/src/core/agent-session-tool-registry.ts:172-194`). `bindExtensions()` then applies UI/mode bindings and emits the session-start event (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:12-35`). The reporter must bind the first session-manager object by identity and ignore events from other in-process session objects that share extension registrations.

`ReadonlySessionManager` is a typed `Pick` of `SessionManager` (`packages/coding-agent/src/core/session-manager-types.ts:224-240`). The relevant methods are `getSessionFile(): string | undefined` and `getSessionId(): string` (`packages/coding-agent/src/core/session-manager-core.ts:186-204`). No public signature change is needed to read those values.

### 5. Built-in extension loading and file-based deferral

`packages/coding-agent/src/extensions/index.ts:1-6` currently contains one hidden bundled inline extension row for llama.cpp. `main.ts` prepends the built-in rows to user factories (`packages/coding-agent/src/main.ts:162-175`) and passes them through `resourceLoaderOptions.extensionFactories` (`main.ts:436-450`). The Herdr row is therefore expected to remain a second row in this file; the existing llama directory is not a grouping target.

The loader resolves file extensions first and then loads inline factories. The final-set path builds the ordered file extension set and calls `loadExtensionFactories()` after file loading (`packages/coding-agent/src/core/resource-loader-extensions.ts:48-87`). The default reload assigns the final extension result only after that work (`packages/coding-agent/src/core/resource-loader-reload.ts:253-278`). `DefaultResourceLoader` currently exposes `getExtensions()` but no getter for the paths actually loaded in the current cycle (`packages/coding-agent/src/core/resource-loader-types.ts:37-49`; `resource-loader-core.ts:179-181`).

A raw disk existence check cannot distinguish a discovered, enabled, and successfully loaded `herdr-agent-state.ts`/`.js` from a disabled or failed path. The required deferral source is therefore a cycle-local list of loaded file paths captured before inline factory execution. The list must also refresh on `/reload`; the current loader reload path has a distinct new extension set each cycle.

The activation env is not currently captured by any Herdr module in this worktree. The binding contract requires capture inside the factory, not module initialization, because the same process can load sessions for different Herdr panes. The factory can return before registering lifecycle handlers when the three env values are absent. The mode gate is available only when `session_start` supplies `ctx.mode`; the existing RPC binding can expose `mode: "tui"` only when an isolated custom UI host exists (`packages/coding-agent/src/modes/rpc/rpc-session-binding.ts:83-94`), so `hasUI` is not a sufficient Herdr gate.

### 6. Herdr transport and wire behavior

The local Herdr findings and source clone establish these facts:

- `PaneReportAgentParams` carries `pane_id`, `source`, `agent`, `state`, optional `message`, optional `seq`, and optional session id/path (`/tmp/herdr-review/herdr/src/api/schema/panes.rs:318-332`). The session-report shape also carries an optional `session_start_source` (`panes.rs:334-347`). Release carries pane/source/agent/seq (`panes.rs:388-395`).
- Requests are serialized as one JSON object followed by `\n`, and the response is one JSON line (`/tmp/herdr-review/herdr/src/api/client.rs:158-173`). The protocol has no `jsonrpc` field. The socket is Unix local IPC on Unix and a named pipe on Windows; `HERDR_SOCKET_PATH` is session-global, so every request must include `pane_id`.
- Herdr accepts a report at the wire layer before semantic sequence handling completes. `accept_hook_report()` rejects `seq <= last_seq` for a source and silently returns false (`/tmp/herdr-review/herdr/src/terminal/state.rs:1553-1567`). Equal values are rejected as well as lower values.
- The protocol's enum also has `unknown`, but Phase 1 sends only `working`, `idle`, and `blocked`. The reporter identity is always `source: "herdr:atomic"` and `agent: "atomic"`.
- The shipped Pi asset uses a 500 ms attempt followed by one 1,500 ms attempt (`/tmp/herdr-review/herdr/src/integration/assets/pi/herdr-agent-state.ts:21-54`), reads `HERDR_ENV`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` (`pi/herdr-agent-state.ts:10-19`), and closes each request after an acknowledgement/data event. It does not require a continuous drain loop.
- The Pi asset prefers an absolute session path, then an id, and includes that reference in state/session reports (`pi/herdr-agent-state.ts:73-127,130-142`). Its reference queue coalesces state to the newest pending value (`pi/herdr-agent-state.ts:145-172`). Phase 1 must extend the single-writer ordering to session and release messages too; direct session writes must not race the state queue.

The local Herdr checkout has uncommitted additions for `herdr:atomic` in its authority and session-source lists. The clean-baseline research artifacts `/tmp/herdr-review/findings-protocol.md`, `findings-integrations.md`, and `adversarial-review.md` record that those lists were absent in the verified baseline. Phase 1 explicitly excludes upstream Herdr work, so deployed Herdr authority/session behavior remains version-dependent; the Atomic reporter itself must still use the exact wire identity and must not edit the Herdr checkout.

### 7. Reporter state and queue shape in the existing reference

The Pi integration is the nearest local reference, but it is not a Phase 1 implementation. It uses module-level sequence state, per-factory session references, `agentActive`, a block counter, a latest-state queue, and `session_start`/`agent_start`/`agent_settled` handlers (`/tmp/herdr-review/herdr/src/integration/assets/pi/herdr-agent-state.ts:56-257`).

The Phase 1 state differs from that reference in binding ways:

- Source/agent are Atomic values, not Pi values.
- Failure-to-block comes from the final assistant `stopReason: "error"` at settled time, not a retry timer.
- There are no retry-grace, idle-debounce, or `ATOMIC_HERDR_*_MS` knobs.
- `agent_blocked`/`agent_unblocked` are typed extension lifecycle events driven by the block door, rather than an untyped `herdr:blocked` channel.
- A module-scope high-water mark survives factory/runner replacement in one process. Every session, state, and release message consumes that same counter.
- Quit alone releases; reload/new/resume/fork silences and drops queued work.

### 8. Existing tool and approval paths

`tool_call` is already a typed extension hook (`packages/coding-agent/src/core/extensions/tool-events.ts:67-81`) and its result can block tool execution with a reason (`packages/coding-agent/src/core/extensions/event-results.ts:13-17`). The agent installs this hook in `agent-session-tool-hooks.ts:6-28`. No separate core tool-approval prompt API was found in the current source. Built-in `ask_user_question` mounts a `ctx.ui.custom()` component (`packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts:69-117`), so that path goes through the required custom-UI wrapper when called with an extension context.

The Phase 1 B5 clause therefore depends on the host surface actually used by an approval flow. The current source exposes `tool_call` interception and normal `ctx.ui` dialogs, but no additional approval surface outside those paths was found during this pass.

### 9. Test and documentation surfaces

The coding-agent package runs its own Vitest project (`packages/coding-agent/package.json:62-78`; `packages/coding-agent/vitest.config.ts:44-63`). Its default test timeout is 30 seconds on non-Windows and 90 seconds on Windows for this pre-existing package project (`vitest.config.ts:5-10`). The root project uses one 30-second shared timeout and no worker/file-parallelism overrides (`vitest.config.ts:14-42`). Root test conventions use Vitest with `node:assert/strict` (`test/unit/workflow-activity.test.ts:1-4`), while older package tests also use Vitest's `expect` assertions.

The requested fake-socket scenarios have a natural package-test home beside the existing extension tests. Current package tests create temporary directories and runners with `SessionManager.inMemory()` (`packages/coding-agent/test/extensions-input-event.test.ts:12-35`). Existing network tests use Node server lifecycle helpers; no Herdr-specific socket fixture exists.

The current `CHANGELOG.md` has an empty `## [Unreleased]` section at lines 1-4. Existing user-facing extension documentation is `packages/coding-agent/docs/extensions.md`; it already documents `ctx.ui` interaction, custom UI, lifecycle events, and extension API sections (`docs/extensions.md:3-55,111-156`). No Herdr page or block-door section exists today.

The acceptance test set from the binding spec maps to: pure reducer table; type-level absence of string/number unblock; exact ordered fake-socket reports; nested block reference counting; error-to-blocked; duplicate settle suppression; successor sequence high-water; quit drain/release; env no-op; loaded-vs-present deferral; and transparent UI wrapping for values, cancellation, and errors.

## Current architecture connections

```text
main.ts
  └─ builtInExtensions + user factories
       └─ DefaultResourceLoader.reload()
            ├─ file extensions
            └─ inline factories (built-ins)
                 └─ Extension records + shared ExtensionRuntime
                      └─ AgentSession._buildRuntime()
                           └─ ExtensionRunner
                                ├─ bindCore / UI / mode
                                ├─ createExtensionContext()
                                │    └─ guarded ctx.ui getter
                                └─ emit(session/agent/tool events)

project trust is earlier and separate:
resource-loader reload
  └─ pre-trust extension set
       └─ resolveProjectTrusted()
            ├─ project_trust handlers
            └─ ProjectTrustContext.ui.select() fallback
```

The block service must be visible to both the normal runner/UI path and the earlier project-trust path while preserving the existing public context shapes. The Herdr reporter observes the normal runner lifecycle and block events, captures the first bound session identity, and owns only its bounded outbound transport.

## Historical and external research references

- `/tmp/herdr-review/phase1-spec.md` — binding Phase 1 objective and acceptance criteria.
- `/tmp/herdr-review/findings-protocol.md` — Herdr request shapes, sequence ordering, authority, transport, and timeout findings.
- `/tmp/herdr-review/findings-integrations.md` — Herdr environment injection, Pi asset behavior, and file-based integration path.
- `/tmp/herdr-review/adversarial-review.md` — baseline authority/session-registration caveat, sequence continuity, and non-quit staleness concerns.
- `/tmp/herdr-review/issue-2210-comment.md` — design-review corrections, including the settled-event model and removal of OMP timer assumptions.
- `/tmp/herdr-review/herdr/src/integration/assets/pi/herdr-agent-state.ts` — local reference integration, read-only reference for transport and lifecycle shape.

No Herdr-specific document was present under the repository's `research/` directory before this report.

## Open questions and findings for the implementation stage

1. The current project-trust fallback runs before a normal `ExtensionRunner` exists. The implementation stage must identify the internal block-manager handoff that covers this prompt without changing the public `ProjectTrustContext` or `ExtensionUIContext` signatures.
2. The block event dispatch must avoid re-entering or deadlocking an in-progress generic runner emission when a wrapper calls `awaitUserDecision()` synchronously before it awaits its UI promise.
3. The loaded-extension-path getter must expose the paths from the current cycle before inline factories run, including the empty/deferred-extension case, and must not use filesystem existence as the deferral signal.
4. The exact short-message bound for block labels and final provider errors is not specified beyond the privacy requirement that only short text is sent. The implementation/test stage needs to use one stable bounded representation without sending prompt or model content.
5. Full Herdr lifecycle authority and session restore depend on the deployed Herdr version's `herdr:atomic` registration. Phase 1 itself does not modify Herdr; tests of Atomic should assert its own exact wire payload and sequencing rather than assume an upstream change is present.
6. Non-quit shutdown can leave an in-flight socket attempt that cannot be synchronously cancelled by the old instance. The required behavior is to drop queued work and silence the instance; the queue/release test should distinguish dropped queued messages from an already-started bounded attempt.

## Code references

- `packages/coding-agent/src/core/extensions/api-types.ts:76-122` — public extension API and event overloads.
- `packages/coding-agent/src/core/extensions/agent-events.ts:50-64,151-173` — agent lifecycle and project-trust types.
- `packages/coding-agent/src/core/extensions/event-types.ts:27-53` — extension event union.
- `packages/coding-agent/src/core/extensions/runner.ts:272-283,428-432` — mode/UI binding and generic event emission.
- `packages/coding-agent/src/core/extensions/runner-context.ts:107-115,203-210` — guarded UI getter and lazy-context constraint.
- `packages/coding-agent/src/core/extensions/ui-types.ts:141-295` — blocking UI method signatures.
- `packages/coding-agent/src/core/project-trust.ts:29-98` — trust prompt and fallback selection.
- `packages/coding-agent/src/core/resource-loader-reload.ts:145-161,253-278` — trust timing and inline factory timing.
- `packages/coding-agent/src/core/agent-session-prompt.ts:240-254` — settled-event timing.
- `packages/coding-agent/src/core/agent-session-runtime.ts:251-259,478-484` — shutdown reasons and ordering.
- `packages/coding-agent/src/core/session-manager-types.ts:224-240` — typed read-only session manager.
- `packages/coding-agent/src/extensions/index.ts:1-6` — built-in extension rows.
- `packages/coding-agent/CHANGELOG.md:1-4` — empty Unreleased section.
- `packages/coding-agent/docs/extensions.md:3-55` — current extension documentation surface.
