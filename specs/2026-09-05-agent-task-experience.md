---
status: In Review
kind: design-only-rfc
compatibility: breaking-changes-allowed
implementation_authorized: false
owner: Atomic task experience
---

# Atomic unified task experience RFC

| Document metadata | Details |
|---|---|
| Author | Norin Lavaee, with design research assistance |
| Status | In Review. Design proposal, not shipped behavior. |
| Owner | Atomic runtime, subagents, Intercom and workflow UI maintainers |
| Created / updated | 2026-09-05 |
| Compatibility | Breaking API/configuration changes allowed; explicit workflow and messaging guarantees retained |
| Completion gate | Evidence-backed draft ready for human review. Human approval is required before implementation. |

Post-review user decisions and the workflow-chat skill-command amendment are recorded in [the decision addendum](../research/2026-09-06-agent-task-decisions.md). Initial reviewer approval predates these additions; they remain design-only and require review before implementation.

The [confirmed follow-up decisions](../research/2026-09-06-agent-task-final-decisions.md) supersede earlier proposals about crash guarantees, extension isolation and output limits. This revision is reconciled directly at the user's request; the follow-up workflow was stopped before its writer edited artifacts. Earlier independent review remains historical.

A later user amendment adopts the split 5 GiB command-output convention: kill background file-spool commands, truncate drained pipe/PTY output. See [the output-cap amendment](../research/2026-09-06-agent-task-output-cap-amendment.md). This supersedes the earlier truncate-and-continue-only choice.

## 1. Executive Summary

A task should remain visible while it works, regardless of whether its caller is waiting. Today a subagent can continue after Intercom releases the foreground tool call, but the main chat's pending-tool update route has already ended. A separate completion notification arrives later. That is the wrong lifetime for live task UI.

This proposal introduces an owner-scoped Rust task supervisor with TypeScript model sessions, tools and shared terminal projections. `startAgentTask` admits work once. `yieldTaskWait` releases an observation without completing or restarting that work. Explicit background launch, elapsed wait yielding and Intercom coordination use the same task identity and row.

Main and workflow chats share collapsed and Ctrl+O expanded views, with bounded activity, honest state labels and keyboard-accessible overflow. Completion updates the existing row while preserving model-context delivery and genuine messages. Closing an owner cancels unfinished work; changing panes does not.

The deliverable is this RFC, [terminal mockups](../research/2026-09-05-agent-task-mockups.md), [research](../research/2026-09-05-agent-task-design-notes.md), and future implementation slices. Nothing here authorizes runtime implementation.

## 2. Context and Motivation

The [agreed brief](../research/2026-09-05-agent-task-experience-brief.md) is the product contract. [PRODUCT.md](../PRODUCT.md) identifies keyboard-first developers who need to trust long-running agent work. [DESIGN.md](../DESIGN.md) supplies the restrained terminal vocabulary. Evidence is split into [runtime](../research/2026-09-05-agent-task-runtime.md), [Intercom](../research/2026-09-05-agent-task-intercom.md), and [UI](../research/2026-09-05-agent-task-ui-research.md) notes. Those notes retain reference provenance, source snapshots and contradictions; this RFC uses Atomic-native names.

### 2.1 Current State

Atomic already has a Rust N-API control plane. `admitChildSession`, `beginChildAttempt`, `finishChildAttempt` and `terminateChildAttempt` are generated native APIs. `StatusWatch::publish` refuses changes to terminal children. `continued` is nonterminal. TypeScript's in-process runner still executes `session.prompt(...)`; moving bookkeeping into Rust did not move JavaScript model execution there. See runtime research, “Atomic current boundary”.

```text
Intercom inbound message
  ForegroundDetachHandoff probe / commit with exact message + child + generation
    continueDetached(existing running attempt)
      same running.promise; native status continued
      foreground tool returns SingleResult continued / detached
main chat
  tool_execution_end -> pendingTools.delete(toolCallId)
  later pending-only updates no longer find that component
workflow attached chat
  ChatMessageRenderer can find historical toolCallId
  StageToolExecutionBuffer no longer retains yielded tool for reattachment
child eventually settles
  deliverChildResult -> notifyDetachedForegroundChildExit
    subagent-notify display:true / triggerTurn:true
      separate renderer: Spacer(1), padded Box
```

This is source evidence, not a reproduced diagnosis of every blank row. The Intercom note traces storage through `agent-session-message-queue.ts` and distinguishes main pending-tool lookup from the workflow renderer's historical-entry fallback. Do not flatten these into one alleged bug.

Current doors leak meaning in three places:

- `continued` and detached booleans mix foreground wait policy with execution status.
- `tool_execution_end` ends observation routing even when child work continues.
- A completion notification carries both model delivery and a new visual block. Hiding all notifications would lose genuine coordination or completion context.

Local conventions matter. Main `app.tools.expand` defaults to Ctrl+O; workflow attached chat uses the same expansion state. Existing subagent compact rendering shows current activity and available progress. It deliberately avoids timer-driven repaint of old transcript rows because that previously disturbed scrollback. The new projection must not undo that protection. Theme role tokens, not hard-coded palette values, remain authoritative for rendering.

### 2.2 The Problem

Users cannot reliably distinguish “the parent stopped waiting” from “the child finished”. A detached child needs live activity before its result exists. Workflow stage closure also has stronger meaning than a view disappearing: the stage owns cancellation and late-delivery fences.

The design must repair the lifecycle-to-UI boundary without changing broker acceptance, retry identity, terminal child monotonicity, parent-question handoffs or workflow dependency settlement.

## 3. Goals and Non-Goals

### 3.1 Functional Goals

- One admitted task, one execution, one stable owner and task identity across explicit, timed and Intercom background transitions.
- Rust owns task admission, lifecycle ordering, bounded waits, cancellation and supervised process resources. TypeScript owns model sessions, tool adapters, persistence integration and terminal UI.
- Main and attached workflow chats share a task projection and row/detail renderer. Ctrl+O remains global tool expansion.
- A terminal result settles the existing visible row without a duplicate result or empty notification block. Model delivery remains explicit and independently acknowledged.
- Stop unfinished work with its owning session or stage. Preserve accepted transport receipts even when their visible late findings are suppressed.
- Editable workflow chats support stage-local `/skill:<selector> [arguments]` discovery and invocation through the existing skill catalog and session delivery, alongside the shared `/tasks` view.
- Specify runnable future tests through each door, including failures, races, reconnect and platform cleanup.

### 3.2 Non-Goals

- No runtime implementation, shipped-doc change, commit, publication or human approval in this run.
- No daemon, ownership transfer, cross-application live-task restoration or terminal-child revival.
- No broader child delegation permission. Nested UI describes existing authorized ownership trees and nested tools; it does not enable children to launch subagents.
- No replacement model runtime, transport broker, workflow engine, theme system or entire workflow widget project.
- No guarantee that arbitrary hostile JavaScript can be preempted in-process or that an external effect already accepted can be undone. These limits are exposed in §7, not hidden behind a successful cleanup label.

## 4. Proposed Solution (High-Level Design)

### 4.1 System Architecture Diagram

```text
User/model input or Intercom delivery
  TS boundary: existing schema, authorization, cwd/agent resolution
    host-issued owner capability (never a model-supplied owner ID)
      Rust TaskSupervisor, one serialized actor per N-API environment
        owner table + task table + ordered bounded journal
        native command/process handles
        TS runner lease -> asynchronous session.prompt/tools on JS event loop
          reportTaskActivity / reportTaskOutcome
      owner task store -> shared TaskProjection
        Main ChatHost
          TaskGroup -> TaskRow -> TaskDetail
        Workflow ChatHost
          TaskGroup -> TaskRow -> TaskDetail
      TaskCompletionEnvelope -> existing admission + model-message persistence
```

The input boundary is the airlock. A host capability binds the caller to one live owner. Native capability lookup rechecks that owner at admission because closure can race validation. The inside receives resolved task intent, not arbitrary process IDs, trusted owner strings or JavaScript references from a worker thread.

A task store is not a second workflow scheduler. It projects task facts. Only workflow logical settlement advances dependencies.

### 4.2 Architectural Pattern

An owner-scoped actor supervisor with shared read projections. Execution facts are ordered once in Rust; presentation state stays in TypeScript. Subscription recovery uses a snapshot plus cursor, not replaying launching tool calls. The proposal extends the existing N-API distribution boundary rather than adding a new daemon.

### 4.3 Key Components

| Component | Responsibility | Basis |
|---|---|---|
| TaskSupervisor | Immutable owner admission, execution/wait ordering, cancellation and cleanup receipts | Existing native control plane extended |
| Agent task adapter | One JS execution promise per admitted attempt; AbortController bridge; raw progress/result reporting | Existing in-process runner |
| Command task adapter | Native pipe/PTY resource ownership, stdin capability, output bounds, confirmed cleanup | Existing native PTY plus pipe adapter |
| Owner task store | Cursor reconciliation, bounded records, transcript anchor and completion outbox | New TS integration, independent of pendingTools |
| Shared task projection/renderers | Identical rows/details in both hosts; stable selection and bounded viewport | Existing ChatHost and subagent TUI conventions |
| Durable task adapter | Await logical terminal outcome before checkpoint; cancellation fence | Existing ctx.tool boundary |

Future file ownership follows. These are **proposed paths**, not files added in this design run. No deletion is required initially; remove only superseded task-notification rendering branches once integration tests prove their replacement. Do not delete genuine Intercom renderers or legacy historical-message readers.

| Path | Future action | Owns / slice |
|---|---|---|
| `crates/atomic-natives/src/task_supervisor.rs` and `task_supervisor/{owner,task,events,process}.rs` | add | Actor, typed resources and platform cleanup, S1/S2 |
| `crates/atomic-natives/src/lib.rs` | change | Native export registration, S1 |
| `crates/atomic-natives/src/subagent_control/{control,status}.rs` | change | Delegate lifecycle authority rather than parallel terminal reducers, S1/S3 |
| `crates/atomic-natives/src/pty.rs` | change | Supervised PTY handle integration, S2 |
| `crates/atomic-natives/Cargo.toml` | change only if required | Windows process API features for containment, S2; no new publishable package |
| `packages/natives/native/index.js`, `packages/natives/native/index.d.ts` | generate | Existing native build, never hand-edit, S1/S2 |
| `packages/coding-agent/src/core/tasks/{contracts,supervisor,owner-store,completion}.ts` | add | Typed facade, host capabilities, task store, model outbox, S1/S3/S4 |
| `packages/coding-agent/src/core/tasks/transcript.ts` | add | Owner-authorized references to existing session messages for shared prompt/activity/response rendering, S5 |
| `packages/coding-agent/src/core/tools/{bash,bash-pty-native}.ts` | change | Tool-to-command task seam, S2 |
| `packages/coding-agent/src/core/agent-session.ts`, `agent-session-message-queue.ts`, `workflow-stage-admission.ts` in the same `core` directory | change | Owner closure and persisted envelope admission, S3 |
| `packages/subagents/src/runs/inprocess/runner.ts` | change | Same-promise runner lease, S3 |
| `packages/subagents/src/runs/foreground/{inprocess-run-sync,execution-intercom-detach,notify,subagent-executor-single,subagent-executor-parallel-task,subagent-executor-context}.ts` | change | Wait/result split and exact-owner integration, S3 |
| `packages/subagents/src/shared/types.ts`, `packages/subagents/src/extension/tool-rendering.ts` | change | Public yielded shape and row anchor, S3/S4 |
| `packages/intercom/{foreground-detach-handoff,index-heavy,retry-identity}.ts` | targeted change/test seam | Exact handshake mapping; preserve receipt/retry operations, S3 |
| `packages/workflows/src/durable/tool-primitive.ts` | change | Typed terminal-only task adapter at callback boundary, S3 |
| `packages/workflows/src/runs/foreground/stage-tool-execution-buffer.ts` | change | Keep tool replay separate from new task replay, S4 |
| `packages/coding-agent/src/modes/interactive/components/{task-row,task-detail,task-list}.ts` | add | Shared terminal components, S4/S5 |
| `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts` | change | Stable task entry upsert, S4 |
| `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts` | change | Main task subscription independent of pendingTools, S4 |
| `packages/workflows/src/tui/{stage-chat-view-live-events,stage-chat-view-input,widget}.ts` | change | Shared task subscription, input precedence and bounded mount, S4/S5 |
| `packages/coding-agent/src/core/keybindings.ts` | change | Namespaced task actions, S5 |
| Test and fixture files | add/change | Exact ownership listed under each §8 slice |
| `packages/workflows/src/tui/stage-chat-view-state.ts` and the shared ChatHost autocomplete adapter | future change where parity is missing | Stage-local skill discovery and submission, S6 |
| `packages/coding-agent/src/core/{skill-catalog,agent-session-prompt,agent-session-extension-bindings}.ts` and `src/modes/interactive/interactive-autocomplete.ts` | reuse; change only a proven adapter seam | One skill resolver/expansion and source-aware command metadata, S6 |
| `packages/coding-agent/docs/subagents.md`, `packages/coding-agent/docs/keybindings.md` | future change | Migration and task controls, S5, after behavior ships |
| `packages/coding-agent/CHANGELOG.md`, `packages/subagents/CHANGELOG.md`, `packages/intercom/CHANGELOG.md`, `packages/workflows/CHANGELOG.md`, `packages/natives/CHANGELOG.md` | future change where shipped behavior changes | Shipped behavior release notes only, S5 |

Path braces above denote a file set, not literal filenames. Slices may keep helpers in the parent module until extraction is justified. There is no workflow build step and no version bump.

### 4.4 The Door Set at a Glance (Stranger-Across-Time View)

`openTaskOwner`, `startAgentTask` ⚠, `startCommandTask` ⚠, `waitForTask`, `yieldTaskWait`, `foregroundTask`, `cancelTask` ⚠, `closeTaskOwner` ⚠, `writeTaskInput` ⚠, `watchOwnerTasks`, `readTaskOutput`, `readTaskTranscript`, `reportTaskActivity`, `reportTaskOutcome`, `deliverTaskCompletion` ⚠.

Workflow-chat skill invocation reuses `getCommands`, `sendUserMessage`, `steer` and `followUp`. It adds no second skill execution engine or task-owner authority.

## 5. Detailed Design

### 5.1 The Doors (Entrypoint Contracts)

Typed pseudocode below specifies the proposed contract, not generated declarations. TS branded strings are convenience types; native handle lookup is the authority. `Result<T,E>` is exactly `{ok:true,value:T} | {ok:false,error:E}` at the facade. Arrays are ordinary arrays. No frozen collections, wrapper substitutes or label-derived identity.

```ts
type OwnerId = string & Brand<"OwnerId">;
type TaskId = string & Brand<"TaskId">;
type AttemptId = string & Brand<"AttemptId">;
type WaitId = string & Brand<"WaitId">;
type OperationId = string & Brand<"OperationId">;
type Generation = string & Brand<"Generation">;
type Sequence = string & Brand<"Sequence">; // decimal u64 wire value

// Opaque native-backed capabilities; only host binding can construct these.
type HostSession = Capability<"HostSession">;
type OwnerLease = Capability<"OwnerLease">;
type TaskLease = Capability<"TaskLease">;
type RunnerLease = Capability<"RunnerLease">;
type StdinLease = Capability<"StdinLease">;
type WaitLease = Capability<"WaitLease">;
type SubscriptionLease = Capability<"SubscriptionLease">;
type CompletionLease = Capability<"CompletionLease">;

type OwnerScope =
  | {kind:"session"; sessionId:string}
  | {kind:"workflow-stage"; sessionId:string; runId:string; stageId:string; stageAttemptId:string};
type WaitPolicy = {kind:"background"} | {kind:"foreground"; budgetMs?:number};
type YieldReason = "explicit" | "default-background" | "elapsed" | "intercom-coordination" | "input-needed";
type WaitOutcome =
  | {kind:"settled"; taskId:TaskId; result:TaskResult}
  | {kind:"yielded"; taskId:TaskId; waitId:WaitId; reason:YieldReason};

type TaskIntent =
  | {kind:"agent"; agent:string; task:string; description?:string; cwd?:string; parentTaskId?:TaskId}
  | {kind:"command"; command:string; description?:string; cwd?:string; env?:Record<string,string>;
     terminal:{kind:"pipe"} | {kind:"pty"; columns:number; rows:number};
     executionTimeoutMs?:number; parentTaskId?:TaskId};
type SdkStartedTask = {taskId:TaskId; lease:TaskLease}; // SDK only, never JSON
type TaskWaitConfiguration =
  | {kind:"automatic"; commandBudgetMs?:number; agentBudgetMs?:number}
  | {kind:"until-settled"};
```

SDK start doors return TaskLease after launch setup; host lookup supplies SdkStartedTask when needed. Agent tools default to independent launch, not foreground completion waiting. To retain ModelSingleResponse (§5.2), the adapter admits and immediately yields its initial observation with reason default-background; an explicit background request uses explicit. This creates no completion-wait delay or second execution. A terminal outcome already accepted wins instead. No capability is serialized.

`waitForTask` registers its WaitLease synchronously in the host's observation registry before awaiting the outcome. The native timer, exact Intercom handshake and explicit UI yield action address that registered lease. It is not a capability returned to model input. Lower-level `startAgentTask` and `startCommandTask` are the named start doors; there is no additional unguarded `start` API.

| Door / typed signature | One-sentence guarantee | Named failures | Refusals / obligations |
|---|---|---|---|
| `openTaskOwner(host:HostSession, scope:OwnerScope): Result<OwnerLease,OwnerError>` | Establishes a task lifetime for an authorized host scope. | `ScopeMismatch`, `EnvironmentClosing` | Host binding checks scope against the actual session/stage; repeated binding of the same live scope returns the same owner; no reopened closed generation. |
| `startAgentTask(owner:OwnerLease, intent:AgentIntent, operation:OperationId): Promise<Result<TaskLease,StartError>>` ⚠ | Admits one agent execution under its owner. | `OwnerClosing`, `UnknownAgent`, `InvalidCwd`, `DepthExceeded`, `CapacityExhausted`, `DispatchGuardBusy`, `OperationConflict`, `RunnerUnavailable` | Existing delegation permission gate runs first; no caller-chosen owner or terminal restart; exact operation replay returns the admitted task. |
| `startCommandTask(owner:OwnerLease, intent:CommandIntent, operation:OperationId): Promise<Result<TaskLease,StartError>>` ⚠ | Admits one supervised command under its owner. | Shared start errors where applicable, `SpawnFailed`, `ContainmentUnavailable` | Native start is the sole supervised process spawn path; failed containment must not release an unsupervised command. |
| `yieldTaskWait(wait:WaitLease, reason:YieldReason): Result<WaitOutcome,YieldError>` | Releases the named observation. | `UnknownWait`, `StaleGeneration` | Replay returns recorded outcome; terminal already recorded wins; never restarts execution. |
| `waitForTask(task:TaskLease, budgetMs?:number, designation?:HostSession): Promise<Result<WaitOutcome,WaitError>>` | Observes task settlement until the wait budget ends. | `UnknownTask`, `OwnerClosed`, `EnvironmentClosing`, `ScopeMismatch` | Omitted designation means SDK-only observation; a matching host capability atomically designates this wait. Never kills execution on budget expiry. |
| `foregroundTask(task:TaskLease, budgetMs?:number): Promise<Result<WaitOutcome,ForegroundError>>` | Observes an already-live task in the foreground. | `TaskTerminal`, `OwnerClosing`, `UnknownTask` | UI focus is explicit separately; this door cannot admit execution or revive terminal children. |
| `cancelTask(task:TaskLease, cause:CancelCause): Promise<Result<CancelReceipt,CancelError>>` ⚠ | Requests termination of the task's supervised work. | `UnknownTask`, `CleanupFailed` | Receipt states requested versus reaped; repeated cancellation returns recorded outcome/cause; cannot claim undo of external effects. |
| `closeTaskOwner(owner:OwnerLease, cause:OwnerCloseCause): Promise<Result<OwnerCloseReceipt,CloseError>>` ⚠ | Closes the owner's supervised task lifetime. | `CleanupFailed`, `EnvironmentClosing` | Seals admission first; success requires confirmed cleanup of all owned unfinished work; failure retains closing state and diagnostic resources. |
| `writeTaskInput(input:StdinLease, operation:OperationId, data:InputData): Promise<Result<InputReceipt,InputError>>` ⚠ | Submits one input operation to the live task's stdin. | `TaskTerminal`, `StdinClosed`, `InputBackpressure`, `OperationConflict`, `InputDeliveryUnknown` | Capability exists only for writable stdin; empty bytes are a no-op, not EOF; ambiguous writes cannot be blindly replayed. |
| `watchOwnerTasks(owner:OwnerLease, cursor?:Cursor): Result<TaskSubscription,WatchError>` | Observes a consistent owner task projection. | `OwnerClosed`, `StaleGeneration`, `EnvironmentClosing` | Subscription includes snapshot/cursor and lease; live reattach only; stale retained cursor gets a reset snapshot, not invented deltas. |
| `readTaskOutput(task:TaskLease, range:OutputRange): Promise<Result<OutputPage,OutputError>>` | Reads the retained output in the requested range. | `UnknownTask`, `OutputUnavailable` | Returns explicit omitted ranges/truncation; no promise of a complete log after retention cap. |
| `readTaskTranscript(task:TaskLease, cursor?:string): Promise<Result<TaskTranscriptPage,TranscriptError>>` | Reads owner-authorized references to retained task messages. | `UnknownTask`, `ScopeMismatch`, `TranscriptUnavailable` | Bounded task-scoped paging; no new execution, hidden reasoning or synthetic replacement transcript. |
| `reportTaskActivity(runner:RunnerLease, report:ActivityReport): Result<ReportReceipt,ReportError>` | Records activity from the admitted execution. | `StaleAttempt`, `OwnerClosing`, `TaskTerminal`, `ReportConflict` | Lease binds owner/task/attempt/generation; duplicate report IDs are acknowledged once; never changes a terminal outcome. |
| `reportTaskOutcome(runner:RunnerLease, report:OutcomeReport): Result<SettlementReceipt,ReportError>` | Records the execution's first accepted terminal outcome. | `StaleAttempt`, `ReportConflict` | Same terminal replay returns receipt; conflicting late terminal cannot replace it; cancellation fence outranks late success. |
| `deliverTaskCompletion(owner:OwnerLease, completion:CompletionLease): Promise<Result<DeliveryReceipt,DeliveryError>>` ⚠ | Admits the task completion into its owner's model context. | `OwnerClosing`, `PersistenceFailed`, `DeliveryPending` | Only a settled task can mint completion authority; independent message ID and exact stage admission; no new visible result block. |

`AgentIntent` and `CommandIntent` are the matching `TaskIntent` variants. `InputData = {kind:"bytes"; bytes:Uint8Array} | {kind:"eof"}`. `CancelCause = "user" | "owner-close" | "execution-timeout" | "output-limit" | "parent-handoff" | "shutdown"`. Owner-close cause is session close, stage close or app shutdown, not pane detach. Types are proposed; the errors above describe real boundary refusals, not additional content validation. Existing model/tool schemas retain their own errors.

**Per-door rubric.** The guarantee column above answers the single-sentence test. Each row below covers the remaining checks: domain joint and honest limit; pre/invariant/post/never obligations; all exits; real refusals; singular authority boundary; effect home; validation at the edge; stranger readability. Type brands do not replace runtime checks on native or JSON ingress.

| Door | Honest intent and obligation discharge | Failure/retry/concurrency exit audit | Authority / effect / boundary audit |
|---|---|---|---|
| openTaskOwner | Lifetime, not pane; host precondition, immutable scope postcondition | Same live scope converges; closed generation refused | Host binding alone grants owner capability |
| startAgentTask | Starts work, not guarantees success; register before JS dispatch | Operation replay converges; admission/close serialized; dispatch failure terminal | Existing launch policy plus native owner airlock; sole agent-start effect |
| startCommandTask | Starts supervised command, not arbitrary shell detached from owner | Spawn/containment partial failure cleaned before refusal | Existing shell authorization retained; sole command-start effect |
| waitForTask | Observation, not execution timeout | Completion/yield race serialized; cancellation does not masquerade as success | Read/observation only; no new authority |
| yieldTaskWait | Releases only named wait | Duplicate and late requests read recorded outcome | Internal handshake/timer/UI must identify wait lease |
| foregroundTask | Live observation, not resume | Terminal race returns TaskTerminal or recorded settlement if wait already admitted | No execution capability granted; focus does not call start |
| cancelTask | Requests stop, not already reaped | First cause retained; cleanup failure explicit; completed task unchanged | Sole cancellation request path for one task |
| closeTaskOwner | Closes lifetime only after cleanup | Repeated close shares drain; errors remain visible closing state | Host lifetime boundary; fans out through cancelTask, not alternate kill paths |
| writeTaskInput | Submits bytes, not application-level acknowledgement | Exact operation replay returns receipt; ambiguous native write is unknown, not resent | Writable capability checked at input boundary; one stdin effect path |
| watchOwnerTasks | Consistent observation, not persistence/revival | Snapshot/replay atomic cursor; unsubscribe idempotent; queue gap resets | Owner-authorized read; no owner creation on reconnect |
| readTaskOutput | Retained range, not complete history | Empty range returns empty bytes; cap/read failure explicit | Owner task lease and artifact boundary; display sanitization separate |
| reportTaskActivity | Records observed work, not inferred progress | Stale and conflicting reports refused; late running cannot resurrect | Runner-only ingress earns facts once |
| reportTaskOutcome | First accepted result, not all callbacks' claims | Duplicate acknowledgement; terminal conflict leaves result immutable | Runner capability, actor serialization; completion lease minted here only |
| deliverTaskCompletion | Model admission, not broker delivery or rendering | Persist-before-ack; pending retries same completion identity; close fence | Single completion outbox/admission path; genuine messages use their own door |

There is no new HTTP or gRPC service. The transport equivalent is the tool/SDK facade plus N-API calls below. Do not add a generic `execute({action})` native bypass around these guarded effects.

### 5.2 API Interfaces — The Same Doors on the Wire

The model-facing `subagent` launch keeps agent/task intent. Omitted `wait` means independent background launch; `wait:{kind:"foreground",budgetMs?:number}` opts into foreground-first observation and `{kind:"background"}` explicitly selects background. Command tools default to foreground collection and use the same single response; execution timeout stays separate. Proposed `subagent({action:"wait",id,budgetMs?})` resolves an existing task within the caller's owner and calls waitForTask without launching work. Its success is WaitOutcome; errors retain the named WaitError code/message, including unknown task or wrong-owner refusal. Omitted budget uses the explicit-agent-wait default. This is a task-result wait, not a mailbox-idle tool. Schema validation handles malformed input; model arguments cannot supply owner, attempt, designation or native capabilities.

Agent and command intent may include a short `description` for presentation. Omission or empty description uses the documented display fallback; do not rewrite raw task/command text or operation identity. The model-facing wait/result contract does not change when descriptions or render layouts change.

Exact proposed JSON DTOs (brands denote strings, not native objects):

```ts
type StartError = "OwnerClosing"|"UnknownAgent"|"InvalidCwd"|"DepthExceeded"|
  "CapacityExhausted"|"DispatchGuardBusy"|"OperationConflict"|"RunnerUnavailable"|
  "SpawnFailed"|"ContainmentUnavailable";
type ArtifactRef = {kind:"transcript"|"result"; uri:string}; // owner-authorized retained artifact URI
type ModelAdmitted = {kind:"admitted"; observation:WaitOutcome; artifacts?:Array<ArtifactRef>};
type ModelRejected = {kind:"unstarted"; reason:{kind:"rejected"; error:StartFailure}};
type ModelUnstarted = ModelRejected |
  {kind:"unstarted"; reason:{kind:"skipped"; cause:"parallel-group-detach"}};
type StartFailure = {code:StartError; message:string}; // named code union in §5.1
type ModelSingleResponse = ModelAdmitted | ModelRejected;
type ModelParallelResponse = {kind:"parallel"; slots:Array<
  {ordinal:number; outcome:ModelAdmitted|ModelUnstarted}>};
```

Single launches cannot produce the parallel-group-detach skipped variant; parallel slots can. Slot ordinal is the zero-based original input position; exactly one slot per input in original order, including identical inputs. Admission failures occupy their original slots. No task/wait/attempt ID exists on unstarted entries. Each admitted observation contains its own task ID and settled result or yielded wait/reason; there is no group-success result. `artifacts` is absent until references are known; `[]` means known empty. Each URI names retained data, not a live lease, restart handle or promise of permanent availability. Artifact arrays preserve order and duplicates. Raw launch text and transport questions/attachments retain omitted/empty distinctions; DTO conversion never trims or deduplicates them. All public DTO fields are those shown, not a spread of SDK objects.

Default independent parallel launch validates and admits each accepted slot before returning, even when concurrency leaves it queued. A queued admitted task has its stable task/attempt ID and a yielded observation with reason `default-background`; `task-admitted` records `execution.kind:"queued"`. No runner starts until capacity is available. Admission failure returns `ModelRejected` in its original slot. Queued work remains owned by the live session/stage and starts exactly once under the configured concurrency limit; owner close cancels it before dispatch. The returned observation is not proof of running or completed execution. Task inspection/subscription supplies execution state.

Explicit foreground-first parallel calls retain their existing lazy admission policy. Only a real Intercom group-detach handshake may skip slots that have not been admitted. Already-admitted queued tasks keep their IDs and remain queued; they cannot become `unstarted`. Ordinary independent launch never invokes that group-detach policy. This distinction preserves the D2 foreground-first example without dropping queued default-background work.

The SDK binds an owner before launch. It exposes `waitForTask`, `foregroundTask`, `cancelTask`, `readTaskOutput` and a subscription with `dispose()`. The UI command `/tasks` opens the shared task list; `/tasks <id>` selects a task; focused actions invoke the same SDK doors. These commands are proposed additions, not currently available CLI instructions.

N-API wire records are owned data. Rust `OwnerId`, `TaskId`, `AttemptId`, `OperationId` and generation newtypes convert to opaque strings; event `u64` sequences convert to decimal strings to avoid JS number precision loss. Rust enums convert to tagged objects through explicit DTO conversion. Generated napi-rs declarations remain the source of the low-level binding, with a typed TS facade above them. No bare numeric PID becomes a task capability.

```ts
type Cursor = {generation:Generation; sequence:Sequence};
type NativeTaskRef = {ownerId:OwnerId; taskId:TaskId; attemptId:AttemptId; generation:Generation};
type NativeEvent = {
  schemaVersion:1;
  cursor:Cursor;
  ownerId:OwnerId;
  taskId?:TaskId; // absent for owner-only events
  payload:TaskEvent;
};
type TaskSubscription = {
  lease:SubscriptionLease;
  snapshot:OwnerSnapshot;
  cursor:Cursor;
  events:AsyncIterable<NativeEvent>;
  dispose():void;
};
```

At the low-level N-API boundary, the same watch door takes an environment-local callback `(event:NativeEvent) => void` and returns a native subscription handle plus snapshot/cursor. The TS facade converts callback delivery into the bounded async iterable above. `dispose()` removes the native subscription and ends that iterable without closing the owner.

Native object handles retain the environment association; strings identify records but confer no authority alone. All calls check that association. The Rust actor owns `JoinHandle`s, process handles and bounded channels. Futures carry owned `Send + 'static` data. JavaScript `Env`, local references and callbacks never cross an await or worker-thread boundary as raw pointers.

A bounded nonblocking ThreadsafeFunction wakes a JS-side drain; it is not the sole durable event queue. `QueueFull` leaves a dirty cursor in the native store for the next drain/snapshot. `Closing` releases the subscription. No lock is held while calling JS, awaiting I/O or waiting for queue space. Do not use blocking TSFN calls on the JS thread or during shutdown. Callback exceptions become an explicit subscription failure and reconciliation request, not unchecked Rust panic. Restore task context explicitly around the JS callback; do not assume ambient async-local context survives native scheduling.

Native actor storage remains bounded even if the consumer does not drain: a queued wakeup covers later dirty revisions, and draining checks the current cursor again before sleeping. A failed wakeup with no queued callback arms one bounded host poll while the owner is live; reconciliation cannot depend on another task producing activity. Closed subscriptions retain no poll. This prevents the final settlement from becoming invisible when it is the last event after a full callback queue.

TS launches exactly one asynchronous `session.prompt` for a RunnerLease, stores that promise until settlement and feeds progress through reports. Yield only resolves an observation promise. Model I/O remains asynchronous on JS; synchronous extension/tool work can still block that event loop. Native process work uses asynchronous I/O or bounded blocking workers, not blocking calls in N-API entrypoints. Session AbortControllers bridge native cancellation requests into cooperative JS cancellation. A dropped JS Promise is not cancellation.

Environment shutdown first closes admission and cancels owners, awaits bounded resource cleanup, disconnects callbacks, then releases native objects. A native environment cleanup hook provides a no-JS fallback for process handles. Strong callback references must not accidentally keep the app alive forever; weak callbacks alone are not cleanup. Cross-environment use is refused. Test both Node and Bun host loading rather than assuming compatible teardown.

### 5.3 Data Model / Schema

```ts
type Execution =
  | {kind:"queued"}
  | {kind:"running"}
  | {kind:"cancelling"; cause:CancelCause}
  | {kind:"settled"; result:TaskResult};
type TaskResult =
  | {kind:"completed"; output:OutputRef; exitCode?:number}
  | {kind:"failed"; code:string; message:string; output?:OutputRef; exitCode?:number}
  | {kind:"cancelled"; cause:CancelCause; output?:OutputRef};
type Cleanup =
  | {kind:"active"}
  | {kind:"draining"}
  | {kind:"reaped"}
  | {kind:"failed"; resources:Array<ResourceFailure>};
type Attention =
  | {kind:"none"}
  | {kind:"input-needed"; requestId:string; prompt:string; route:PromptRoute}
  | {kind:"no-recent-activity"; lastActivityAt?:string};
type Presentation = {
  focus:{kind:"composer"} | {kind:"tasks"; selectedTaskId:TaskId} | {kind:"stdin"; taskId:TaskId};
  toolsExpanded:boolean;
  anchors:Array<{taskId:TaskId; activitySequence:Sequence; cellOffset:number; followBottom:boolean}>;
};
type TaskRecord = {
  ref:NativeTaskRef;
  launchOperationId:OperationId;
  parentTaskId?:TaskId;
  launchGroupId?:string;
  launchOrdinal:number;
  kind:"agent" | "command";
  title:string;
  agentName?:string; // resolved agent label; absent for commands
  execution:Execution;
  observation:HostObservation;
  attention:Attention;
  cleanup:Cleanup;
  currentAction?:{tool:string; text:string};
  metrics?:{elapsedMs?:number; toolCount?:number; tokenCount?:number};
  output:OutputRef;
};
type TaskEvent =
  | {kind:"task-admitted"; task:TaskRecord}
  | {kind:"task-started"; ref:NativeTaskRef}
  | {kind:"wait-yielded"; ref:NativeTaskRef; waitId:WaitId; reason:YieldReason}
  | {kind:"wait-started"; ref:NativeTaskRef; waitId:WaitId; observer:"sdk"|"host"}
  | {kind:"host-observation-changed"; ref:NativeTaskRef; observation:HostObservation}
  | {kind:"task-activity"; ref:NativeTaskRef; activity:ActivityReport}
  | {kind:"task-cancelling"; ref:NativeTaskRef; cause:CancelCause}
  | {kind:"task-settled"; ref:NativeTaskRef; result:TaskResult; completionId:string}
  | {kind:"cleanup-changed"; ref:NativeTaskRef; cleanup:Cleanup}
  | {kind:"owner-closing"}
  | {kind:"owner-closed"};
```

`OwnerSnapshot = {ownerId:OwnerId; scope:OwnerScope; generation:Generation; state:"open"|"closing"|"closed"; tasks:Array<TaskRecord>; cursor:Cursor}`. Snapshot records include the designated host observation at that cursor. `OutcomeReport = {reportId:string; result:TaskResult}`. Actor sequences, not wall time, order changes.

```ts
type HostObservation =
  | {kind:"foreground"; waitId:WaitId}
  | {kind:"background"; reason:YieldReason|"not-observed"|"observer-cancelled"}
  | {kind:"none"; reason:"task-settled"|"owner-closing"};
type PromptRoute = {sessionId:string; promptId:string; stageAttemptId?:string};
type ActivityReport = {reportId:string; change:
  | {kind:"action"; tool:string; text:string}
  | {kind:"metrics"; elapsedMs?:number; toolCount?:number; tokenCount?:number}
  | {kind:"output"; offset:string; bytesBase64:string}
  | {kind:"attention-set"; attention:Exclude<Attention,{kind:"none"}>}
  | {kind:"attention-clear"; requestId:string}};
```

HIL prompt admission reports attention-set with its exact requestId, raw prompt and actual PromptRoute. The task-activity event carries that same report; snapshot attention becomes input-needed. Prompt resolution/cancellation reports attention-clear for that requestId. It clears only a matching active HIL request, never a newer one; stale clears are accepted no-ops. Terminal/owner-close clears attention without inventing an answer. Inactivity attention is replaced by observed action. Metrics report fields patch only present values (zero preserved); output bytes decode without text normalization. Duplicate reportId with identical payload acknowledges once; conflicting payload returns ReportConflict. User-confirmed immediate HIL yielding is a separate yieldTaskWait action after attention-set.

Receipt DTOs are explicit: `ReportReceipt = {reportId:string; cursor:Cursor; disposition:"accepted"|"duplicate"}`; `SettlementReceipt = {taskId:TaskId; cursor:Cursor; result:TaskResult; completionId:string}`; `InputReceipt = {operationId:OperationId; acceptedBytes:number; kind:"bytes"|"eof"}`; `DeliveryReceipt = {completionId:string; admissionId:string}`. A partial or ambiguous stdin write produces `InputDeliveryUnknown` with its operation ID and known accepted-byte count, never a success receipt promising the full input. `OwnerCloseReceipt = {ownerId:OwnerId; state:"closed"; tasks:Array<CancelReceipt>}`. Error variants carry their named code plus the relevant task/resource identity; they do not replace the successful return type.


Exact retained-output DTO: `OutputRef = {ownerId:OwnerId; taskId:TaskId; artifactId:string; byteCount:string; omittedRanges:Array<{start:string; end:string}>}`. Decimal counts/offsets are nonnegative u64 strings. D2 uses `O = {ownerId:"S",taskId:"T1",artifactId:"out1",byteCount:"0",omittedRanges:[]}`. This is data, never native capability.
`OutputRef` identifies owner-scoped retained output, byte count and omitted ranges. `OutputPage` contains owned bytes, requested/returned offsets, `nextOffset?`, and `omittedRanges:Array<{start:string,end:string}>`. Offsets use decimal strings too. `OutputRange` has start offset and maximum bytes; an empty range is valid. Original bytes remain available within retention limits; terminal escape/control sanitization is a display-only transformation. Text, command whitespace, questions and attachment arrays are not normalized, reordered or deduplicated. Known zero is not unknown. Absent fields stay absent on the wire, not `null` or invented defaults. Omitted attachment lists remain distinct from `[]` in transport signatures.

Selected output limits apply to raw task output, separately from authoritative conversation/session history:

| Purpose | Limit in bytes | Behavior |
|---|---:|---|
| Command live head/tail preview | 1048576 | 1 MiB total, split between head and rolling tail |
| Foreground full-output spill threshold | 8388608 | 8 MiB; spill retained foreground bytes to the task file at the threshold |
| Per-task disk output cap | 5368709120 | 5 GiB actual file bytes. File-spool background commands are killed; drained pipe/PTY output is truncated |
| Shell-detail tail read | 8192 | 8 KiB per default tail read; older retained output is paged |

Background output spools immediately. Transitioning foreground output to background flushes the existing retained prefix once, preserving byte offsets. The live preview is separate from foreground full-output buffering; these values do not promise a 1 MiB total memory footprint. Reuse storage where possible and bound pending disk writes. These limits do not impose a new 32 MiB owner-wide output cap. Aggregate memory accounting and admission limits must include the foreground buffers and disk-write queues.

Command output uses two sinks. They share the 5 GiB cap and must not be collapsed into one overflow policy.

| Sink | When | At 5 GiB |
|---|---|---|
| File spool | Background command with stdout/stderr redirected to the task output file, no live drain | Poll the actual file size about every 5 s while backgrounded. If still backgrounded and size exceeds the cap, cancel with cause `output-limit`, SIGKILL the supervised process group, and settle `{kind:"failed", code:"OutputLimitExceeded", message:"Background command killed: output file exceeded 5 GiB"}`. Skip a poll on ENOENT. Do not start this watchdog during the initial foreground collection wait. |
| Drained pipe or PTY | Supervisor reads the stream | Stop growing the file. Keep the task running. Drain later bytes into the bounded live head/tail and record omitted ranges. Do not block the pipe or kill the process. Keep the truncation marker in metadata, not an extra write past the capped raw file. |

PTY commands always use the drained path. Background bash-like pipe commands default to file spool unless the tool requested a drained sink. Agent/session conversation records are not this command-file cap and are not killed or truncated by it. Disk-write errors still surface unavailable/truncated retention without inventing an output-limit kill. Do not accumulate an unbounded retry queue. Authoritative session/model persistence failures keep their separate delivery-pending semantics. First accepted terminal cause still wins: an already-settled task is not killed again; an in-flight user cancel is not rewritten into OutputLimitExceeded.

For OutputRef, byteCount is the total observed logical stream length, not the capped file size. Read output from the retained disk prefix and current live tail at their original offsets; ranges no longer available from either source are omitted. Each read snapshots the current retention map, so later tail eviction cannot change that response. On owner teardown, remaining transient tail bytes may be discarded; persist the updated omitted ranges with the historical task record. Session conversation records are not raw task output and keep their existing persistence policy.

Event journals use byte budgets and coalesce activity snapshots. Terminal facts remain in the task table after journal eviction. No queue silently discards cancellation, settlement or owner closure. Split output chunks at byte boundaries and carry incomplete UTF-8 code points during decoding. Input queues have byte credits and reject with InputBackpressure before admission, never halfway through an acknowledged write. Exact default limits and bounded-cap edge tests belong to S2; do not write a 5 GiB fixture just to test boundary arithmetic.

Snapshot subscription is atomic: actor installs the listener and returns snapshot at cursor C; deltas strictly after C drain next. Duplicate sequences are ignored. A gap stops incremental reduction and requests a fresh snapshot. A generation mismatch cannot reconnect into a different owner. Unsubscribe is idempotent and does not close the owner. Closed owners may be read as historical session records, but no live lease or runner is reconstructed from disk.

**Persistence and delivery.** Persist task launch anchors and terminal records as session task entries keyed by owner/task ID. Activity retention is bounded; persisted snapshots record truncation. They are history, not executable checkpoints. A completion envelope is `{completionId, ownerId, taskId, terminalSequence, result, display:false}`. The local completion outbox persists intent before admission, reuses the same ID on retry and records acknowledgement only after session/model persistence succeeds. This gives idempotent logical admission within existing session identity, not a claim of exactly-once network delivery after arbitrary storage loss.

The renderer applies the terminal task record to its existing anchor. The completion envelope is filtered as nonvisual **before** allocating a component, Spacer or Box. It may still trigger the required parent turn through existing admission. If the transcript anchor is not mounted, task lookup uses the store and history entry, not a new notification. Genuine Intercom messages retain their own visible entries. Historic `subagent-notify` entries remain readable; only new task-linked lifecycle completion takes the nonvisual route. Failure to persist model delivery is shown as `completion delivery pending` on the same task detail, separate from execution completion.

### 5.4 Algorithms and State Management

#### Execution, wait and owner transitions

| Current state | Input | Legal next state / invariant |
|---|---|---|
| owner open | start with authorized capability | queued task registered before dispatch |
| queued | runner/process admitted | running |
| queued/running | user cancel, owner close, execution deadline | cancelling; admission of new descendant effects fenced |
| running | explicit/timed/Intercom yield | running; only designated host wait yield changes badge to background; same task/attempt/promise |
| running background | foregroundTask | running; new wait ID; no new attempt |
| queued/running | accepted terminal report | settled completed/failed; task identity permanently terminal |
| cancelling | runner success arrives late | retain cancellation decision; finish cleanup, settle cancelled |
| cancelling | confirmed execution stop | settled cancelled; cleanup separately reaped/draining/failed |
| settled | same terminal report/cancel/yield replay | return recorded receipt; no new result or execution |
| settled | conflicting terminal/activity/start-attempt | refuse or acknowledge stale report as specified; never mutate terminal result |
| owner open | close | closing, atomically seal all admission and fence late model findings |
| owner closing | cleanup confirmed | closed; no live owned work |
| owner closing | cleanup fails | remain closing with CleanupFailed; never falsely report closed |
| owner closed | start/foreground/reopen | OwnerClosed/OwnerClosing refusal; new chat/stage requires new generation |
| any live owner | pane switch, Ctrl+O, task focus | no owner or execution transition |
| running, file-spool, backgrounded | actual output file exceeds 5 GiB | cancelling with cause output-limit, then failed OutputLimitExceeded after confirmed stop |
| running, drained pipe/PTY | disk output reaches cap | running; disk prefix stops growing, live tail keeps draining, omitted ranges advance |

Completion accepted before cancellation wins. Cancellation accepted first commits the cancellation decision, then rejects late success as terminal authority. Both routes must retain actual output and cleanup evidence. CancelReceipt includes `{taskId, decision:"already-settled"|"cancellation-requested", execution, cleanup}`; only `cleanup.kind === "reaped"` claims resource release. Natural command exit with lingering descendants requires cleanup too. OwnerCloseReceipt contains ordered task receipts; one failed resource prevents successful close.

Wait IDs separate concurrent observers. Repeated yield of the same wait returns its recorded outcome. A task's UI foreground badge describes the host's designated foreground observation, not every SDK waiter. SDK background waiters do not steal UI focus. When completion races a yield, the actor order produces either settled directly or yielded followed by task-settled. Neither produces two tasks or a second runner.

Observer disposal resolves only that pending wait with `WaitError: ObserverCancelled` (also a possible ForegroundError after registration); it does not call cancelTask. Add ObserverCancelled to those doors' named failure sets. Already recorded outcomes win a disposal race. Disposing a watch subscription is not disposing a wait. These are host lifecycle actions, not model JSON commands.

**Designation lifecycle (S1/S4 executable document trace D1).** Only a matching HostSession passed by the launching host adapter or foregroundTask may designate a wait. foregroundTask uses the bound host identity and atomically replaces any prior designation, leaving its SDK observation alive. Task admission starts background/not-observed. Designating W1 records wait-started then host-observation-changed in one actor transaction; the latter is the sole badge reducer input. Generic wait-started/yielded events never change the badge. Replacing designation does not cancel old waits. Designated yield clears its designation to background with its reason; non-designated yield does nothing to it. Disposing/cancelling the designated observer (not the task) emits background/observer-cancelled. Pane detach preserves designation and its timer; owner close emits none/owner-closing; settlement emits none/task-settled and resolves every pending wait. Terminal/cancelling execution labels outrank foreground/background badges. Replays cannot reclaim designation.

```text
D1 proposed trace (one task T, one attempt, one execution throughout)
1 admit T -> snapshot observation background/not-observed
2 host W1 start -> host-observation-changed foreground/W1
3 SDK W2 start -> no host-observation-changed -> foreground/W1
4 W2 elapsed yield -> no host-observation-changed -> foreground/W1
5 snapshot/reconnect -> foreground/W1 (W2 outcome remains yielded)
6 W1 Intercom yield -> host-observation-changed background/intercom-coordination
7 activity bash -> same T background; no terminal result
8 settle T -> host-observation-changed none/task-settled -> completed
branch at 6: dispose W1 -> background/observer-cancelled; execution still running
branch at 6: close owner -> none/owner-closing; cancel and reap owned work
```

**D2 proposed model/attention trace (S1/S3/S4).** This is an explicitly foreground-first parallel call, not default independent launch. Input slots 0 and 1 contain identical raw `task:" x "`; slot 2 awaits admission in the launch queue. At Intercom group detach the exact response is `{kind:"parallel",slots:[{ordinal:0,outcome:{kind:"admitted",observation:{kind:"yielded",taskId:"T0",waitId:"W0",reason:"intercom-coordination"}}},{ordinal:1,outcome:{kind:"admitted",observation:{kind:"settled",taskId:"T1",result:{kind:"completed",output:O}},artifacts:[]}},{ordinal:2,outcome:{kind:"unstarted",reason:{kind:"skipped",cause:"parallel-group-detach"}}}]}` where O is the OutputRef below, not a capability. Slot 0 artifacts is omitted, slot 1 is known empty; T0 and T1 are distinct. HIL report r1 attention-set(q8, raw prompt `""`, route session S/prompt q8) yields snapshot input-needed/q8; duplicate r1 produces no second event; r2 attention-clear(q7) leaves q8; r3 attention-clear(q8) yields none. Raw transport question absent versus `""`, attachments absent versus `[]`, and `[a,a,b]` versus `[b,a,a]` stay distinct through the existing retry signature, outside task DTOs.

#### Intercom transition

```text
inbound transport accepts/reserves message identity under existing policy
  exact foreground-detach probe / commit matches child + generation + message
    yieldTaskWait(existing wait, intercom-coordination)
      publish wait-yielded to owner task store
      resolve foreground observation; do not resolve execution promise
  deliver genuine inbound message through existing ordered admission
child activity continues
  reportTaskActivity -> task store -> same task row in either chat host
child settles while owner open
  reportTaskOutcome -> task-settled -> update same row
  deliverTaskCompletion -> persisted nonvisual model envelope
```

Keep current probe/commit matching, generation reset and terminal-ordering barrier. A probe without a matching commit changes nothing. Duplicate commits converge on the recorded wait outcome. A close between probe and commit prevents a new live transition. Accepted broker receipts remain accepted; receiver-side exact-stage filtering suppresses late findings without rewriting sender history. Transport disconnect retry retains its original message ID/token and raw payload. Fresh identical sends are still separate operations. Changing a task ID must never mint a substitute retry identity.

Explicit foreground-first parallel calls preserve Intercom group-detach semantics: active siblings release foreground waits, and slots still awaiting admission remain unstarted and visibly skipped. Do not relaunch those skipped slots as a background side effect. Already-admitted queued tasks keep their identity and scheduling. Default independent launches never skip queued work merely because their tool call returns. Each admitted child keeps its own task ID and terminal result. Group summaries include queued, running, completed, failed and not-started counts; tool return is not group completion.

Parent-directed `contact_supervisor` or claimed parent ask remains a terminal fresh-start handoff. It cancels the old execution and preserves raw omitted/empty question and ordered duplicate attachments. A new authorized launch gets new task/child/attempt IDs. It is not the peer-communication yield path. Nested display follows existing workflow/stage/subagent/tool relationships. A child agent's attempted child delegation remains refused by existing admission policy; native tree representation is not permission to deepen it.

#### Durable workflow boundary

```text
workflow stage logical operation
  ctx.tool(key, async () => {
    task = await startAgentTask(stageOwner, intent, stableLaunchOperation)
    expose task to live UI immediately
    result = await awaitTerminalTask(task)  // internal adapter, no yielded type
    return existing domain result or existing failure/cancel behavior
  })
    existing retry/cancellation boundary
    persist DurableToolCheckpoint only after logical terminal result
    publish node settlement -> dependencies may proceed
```
`awaitTerminalTask` is an SDK observation composition returning only TaskResult, never ModelSingleResponse or Yielded. Existing cancellation-before-persistence and persistence-start commit-wins fences remain authoritative. History cannot revive live tasks; durable retries admit fresh work under existing policy.

#### UI projection and keyboard behavior

Each launch creates one transcript anchor keyed by task identity, not repeated progress copies. Both hosts subscribe beyond tool/turn end using the shared reducer. The transcript, compact footer and focused inspector read that same task record; references in other views are not new task/result messages.

**Composition.** Lead with a recognizable agent label and short task description, then current activity. For commands, lead with bash and a readable command purpose or command preview. Resolve TaskRecord.title from the supplied nonempty description; otherwise use the first nonblank agent task line or the command text. Preserve the original string in intent/history and sanitize/truncate only for display. Do not use an LLM-generated title as identity. Empty task text falls back to the resolved agent label. Duplicate display labels get a short stable ID suffix; full IDs remain available in expanded metadata and focused detail. ID-first rows are not the default.

**Compact rows and groups.** A single title row and subordinate current-action/status line provide the normal collapsed shape. Show actual running/queued/completed/failed/cancelled/input-needed state, with foreground/background only while relevant. Known tool-use counts may follow the action; optional token/time/model metadata must not crowd out the title or state. A parallel group has one aggregate heading, dim tree connectors and one child per admitted or unstarted slot. Common agent type can move to the group heading. Count task execution states, never resolved launch-tool calls, when saying running or completed. Omit repeated nested expansion hints and diagnostic IDs. Show one configured Ctrl+O hint per group, plus a bounded hidden-task count when needed.

**Expanded transcript.** Ctrl+O retains the task title and adds subordinate metadata plus Prompt, Activity and Response sections as available. Reuse normal Atomic tool call/result and assistant-message rendering; do not replace it with an event-number table. Show bounded recent entries with access to earlier retained content. Tool name, arguments and real output remain correlated by original toolCallId. Display final response only when actually recorded. No synthesized assistant commentary, hidden reasoning disclosure or full system/developer prompt dump. A renderer returning null gets no fixed-height wrapper, spacer or bare connector; a real empty result still gets an honest completed/empty-result label. Count unique tool calls, not call/result/event records.

**Shared footer.** While background work is live or tasks need attention, one compact host statusline region shows counts and `/tasks`. Counts separate agents, shells and queued work, with input/failure attention taking priority under tight width. It remains discoverable when the original launch anchor scrolls off-screen, without moving that anchor or inserting progress into the transcript. Reuse the host's bounded footer/widget allocation, not an additional unbounded BACKGROUND panel. Hide it when no work or attention remains. Completion updates the existing row quietly; no success toast. Attention remains until handled under the existing prompt/error acknowledgement policy; a plain render does not acknowledge it.

**Focused inspector.** `/tasks` includes foreground, background and terminal tasks, not only active background work. Use fixed Agents and Shells sections when both are present, and no empty section headings. Within each section preserve admission order; state changes do not resort the list. A selected task opens detail with title, state, owner/ID, available elapsed/tool/token metrics, prompt, recent activity or shell output, then explicit actions. The latest activity uses a subdued marker distinct from the selection chevron. Prompt and final response can be read fully through retained transcript paging. Terminal tasks omit foreground/input/cancel actions; no implicit restart. Input-needed detail offers Open question through its exact PromptRoute. Empty state explains that launched agents/shells will appear here, without a spinner.

Rows keep transcript admission order and selection by task ID. Activity anchors use sequence plus cell offset; output cannot steal focus or reset a user's scroll. Follow-bottom stays on only if already enabled. Resize rewraps while retaining the logical anchor. Drop optional metrics before truncating the task title; state and overflow actions remain reachable. Above-fold transcript rows do not run elapsed-time animation. A visible focused detail or dock may have one bounded host clock, suspended when hidden. The working glyph remains literal one-cell `∀`; no-color states use text, and reduced motion remains static. Existing theme roles control bold title, muted connectors/metadata and selected-row emphasis, with no per-agent color badges or per-task bordered cards.

Viewport allocation reserves composer, mounted prompt and essential status first, then bounds visible rows/details. Remaining tasks stay accessible through `/tasks`. Never truncate the complete pure task/run projection to bound mounted height. A narrow terminal changes composition rather than shrinking text or hiding the only route to a task. The mockup dimensions are examples, not fixed breakpoints.

**Transcript data contract.** Compact native activity facts alone cannot reconstruct prompt, response or tool results. The TS owner store binds each task to its authorized child session and reads existing live/persisted message records through one shared adapter. Full transcript text does not travel through or accumulate in the native event journal. Proposed typed facade:

```ts
type TaskTranscriptItem = {
  id:string; // stable original message/content-block identity
  kind:"prompt"|"assistant"|"tool-call"|"tool-result"|"response";
  source:{sessionId:string; entryId:string; contentIndex?:number};
  toolCallId?:string;
};
type TaskTranscriptPage = {
  items:Array<TaskTranscriptItem>;
  nextCursor?:string;
  omittedEarlier:boolean;
};
readTaskTranscript(task:TaskLease, cursor?:string):
  Promise<Result<TaskTranscriptPage,TranscriptError>>;
type TranscriptError = "UnknownTask"|"ScopeMismatch"|"TranscriptUnavailable";
```

Page size and rendered content are bounded by the existing host history/viewport policy. The cursor is opaque and scoped to that task/session, not an array index or native lifecycle cursor. Page items reference original records for the existing message renderer; references are resolved only under owner-authorized access. The adapter deduplicates by item ID and correlates tool results without removing genuine repeated calls or messages. Live capture and persisted history reconcile once by those IDs. Lifecycle sequence still governs execution state; it is not reused as a fabricated message sequence. Read-only historical tasks use existing session-history authorization, not reconstructed live leases. If a task has no captured transcript, show Transcript unavailable with retained raw output where available; do not infer missing messages from metrics.

Source-backed composition findings and deliberate design differences are recorded in [the UI fidelity review](../research/2026-09-06-agent-task-ui-fidelity.md). These changes improve disclosure and recognition without changing the approved execution or ownership policies.

| Action | Default / route | Meaning and precedence |
|---|---|---|
| `app.tools.expand` | existing Ctrl+O | Global tool detail in both chats, never foreground/cancel |
| `app.tasks.open` | proposed `/tasks`; chord unresolved | Shared task list, no focus theft on activity |
| `app.tasks.inspect` | Enter in task list | Select same task detail; terminal tasks remain inspectable |
| `app.tasks.foreground` | labeled focused action | Call foregroundTask only for live tasks |
| `app.tasks.cancel` | labeled focused action with target confirmation | Cancel selected live task, not entire workflow implicitly |
| `app.tasks.input` | labeled focused action when stdin available | Focus explicit stdin target, preserve composer draft |
| Graph | existing F2 | Workflow graph remains graph; not reassigned here |
| Navigation | arrows, PageUp/PageDown, Home/End in task focus | No interception while editor/HIL owns those keys |
| Escape | exit stdin/task focus first | Does not silently terminate an owner |
| Ctrl+D / Ctrl+U | unchanged | No new paging/background binding |

Hints resolve configured action names and disappear if unbound. Mounted HIL prompt/editor input has priority; do not stack a task overlay above a prompt that owns input. Task attention is factual: a prompt ID means input is needed, inactivity only means no recent activity. Show a count plus task-local reason; do not auto-focus or fabricate stalled/completed status.

#### TUI preview: what to expect

These are static proposed layouts, not runtime screenshots. The [complete 30-frame mockup set](../research/2026-09-05-agent-task-mockups.md) includes PTY input, normal owner close, HIL, failures, short-screen overflow and empty state. This revision replaces ID-first rows and numbered activity logs with recognizable task titles, grouped progress and real prompt/activity/response disclosure. Counts below are fixture values; absent metrics stay absent. Host headings identify the scenario, not a required new main-chat banner.

**Default independent agents, 80×24.** A single group heading explains execution and background observation. Tree-connected children lead with their task, while queued work remains visibly queued.

```text
MAIN  inspect task contracts

∀ 3 agents · 2 running · 1 queued · background
  ├─ reader · Check owner rules
  │  Reading task contracts
  ├─ checker · Check type fixtures
  │  Bash · Compiler checking fixtures
  └─ ○ auditor · Check cleanup paths
     Queued · waiting for runner capacity
  Ctrl+O expand

Assistant  I can check the caller while these work.
────────────────────────────────────────────────────────────
>
Tasks  2 agents running · 1 queued · /tasks
```

**Explicit foreground, collapsed, 100×30.** The current action sits below a recognizable title. This is not the default agent-launch wait policy.

```text
MAIN  refactor task delivery

You  Trace where the child result reaches the chat.
∀ researcher · Trace result delivery
  ⎿ Running in foreground · Reading notify.ts · 3 tool uses
  Ctrl+O expand

────────────────────────────────────────────────────────────────────────────
> Keep the receipt identity unchanged
```

**Ctrl+O expansion, 100×30.** The same task reveals its prompt and recent native tool-message content. Task ID and elapsed time become secondary detail, not the collapsed headline.

```text
MAIN  refactor task delivery

You  Trace where the child result reaches the chat.
∀ researcher · Trace result delivery
  Running in foreground · 3 tool uses · 8s · t17
  Prompt
    Trace the child result path; preserve receipt identity.
  Activity
    Read(subagent-executor-status.ts)
      ⎿ Completion identity includes run and child index.
    Read(notify.ts)
      ⎿ Inspecting admission and display flags.
  1 earlier tool use · /tasks t17 inspect transcript
  Ctrl+O collapse

────────────────────────────────────────────────────────────────────────────
> Keep the receipt identity unchanged
```

**Intercom transition, 100×30.** t17 retains its title, task ID and execution. A real action appears after the wait releases. The compact footer keeps the background agent discoverable when this transcript anchor scrolls off-screen.

```text
MAIN  refactor task delivery

You  Trace where the child result reaches the chat.
∀ researcher · Trace result delivery
  Running in background · 4 tool uses · 12s · t17
  Prompt
    Trace the child result path; preserve receipt identity.
  Activity
    Read(notify.ts)
      ⎿ Inspecting admission and display flags.
    Bash(check notification fixture)
      ⎿ Checking delivery after the tool returned.
  Wait released for Intercom coordination; execution continues.
  2 earlier tool uses · /tasks t17 inspect transcript
  Ctrl+O collapse

Intercom  reviewer · m42
  I found the stage-close fence. Please preserve accepted receipts.

Assistant  I will check the live-task subscription.
────────────────────────────────────────────────────────────────────────────
> Keep the receipt identity unchanged
Tasks  1 agent running in background · /tasks
```

**Quiet completion, 100×30.** Prompt/history remains accessible, the response settles inside the same task entry and the genuine peer message remains. No extra completion card or blank block appears. The sole task is done, so its live footer disappears.

```text
MAIN  refactor task delivery

You  Trace where the child result reaches the chat.
✓ researcher · Trace result delivery
  Completed · 5 tool uses · 19s · t17
  Activity
    Read(interactive-agent-events.ts)
      ⎿ Pending-tool updates stop at tool end.
  Response
    Keep an owner-scoped subscription after the launching tool returns.
  4 earlier tool uses · /tasks t17 inspect transcript
  Ctrl+O collapse

Intercom  reviewer · m42
  I found the stage-close fence. Please preserve accepted receipts.

Assistant  The result confirms the separate task subscription.
────────────────────────────────────────────────────────────────────────────
> Keep the receipt identity unchanged
```

**Expanded workflow chat, 80×24.** The same title, metadata and message components sit inside workflow owner context. Yielding a task cannot complete the next dependency.

```text
WORKFLOW  task review / inspect · attempt 2

∀ reader · Check stage ownership
  Running in foreground · 2 tool uses · 7s · t31
  Prompt
    Check when the stage closes its child sessions.
  Activity
    Search(closeSignal)
      ⎿ Found the stage owner boundary.
    Read(workflow-stage-admission.ts)
      ⎿ Checking the late-delivery fence.
  Ctrl+O collapse · /tasks t31 inspect

Next: review · waiting for inspect result
────────────────────────────────────────────────────────────
>
F2 graph
```

**Shared task inspector, 48×16.** Fixed type groups and recognizable descriptions make work scannable. Selected task t63 remains stable during updates. Enter inspects, rather than automatically foregrounding.

```text
TASKS  inspect / attempt 2 · all 5
Agents
  ∀ Check owner rules         background
  ? Choose fixture           input needed
▸ ∀ Check type fixtures       background
  ✗ Check cleanup fixture    failed
Shells
  ∀ Build native module      background

checker · Check type fixtures · t63
↑↓ select · Enter inspect · Esc back
F2 graph
```

**Focused agent detail, 80×24.** Owner, ID, metrics and controls belong here. Latest activity › and selected action ▸ are distinct. No action is inferred from opening the view.

```text
TASKS  researcher · Trace result delivery
Running in background · 12s · 4 tool uses · 8.2k tokens
Task t17 · owner main session

Prompt
  Trace the child result path; preserve receipt identity.
Recent activity
  Read(subagent-executor-status.ts)
  Read(notify.ts)
› Bash(check notification fixture)

Actions
▸ Inspect transcript
  Foreground wait
  Cancel task…
↑↓ select action · Enter choose · Esc back
```

**Workflow skills, 80×24.** The fixture skill comes from the attached stage catalog, and its command expands once in that session. Mounted HIL prompts still own their input.

```text
WORKFLOW  review / inspect · attempt 2

∀ researcher · Trace result delivery
  ⎿ Running in background · Reading task contracts

────────────────────────────────────────────────────────────
> /skill:fi
  skill:fixture  Inspect the fixture contract  [project]
Enter submit · Ctrl+F follow-up · F2 graph
```

**Capped shell output, 80×24.** Background file-spool bash is killed at 5 GiB. This is not a user cancel and does not complete the workflow node as success.

```text
WORKFLOW  task review / verify · attempt 1

✗ bash · Process fixture records
  Failed · output file exceeded 5 GiB · t81
  Output · latest 8 KiB
    processed record 91204
    processed record 91205
  Background command killed: output file exceeded 5 GiB
  /tasks t81 inspect retained log
  Ctrl+O collapse

Next: review · waiting for verify result
────────────────────────────────────────────────────────────
>
Tasks  1 failed · /tasks · F2 graph
```

The excerpts above match their full mockup counterparts exactly. Keep them synchronized. Lifecycle changes are verified through task/message identities and render events, not through copied fixture strings alone.

#### Workflow-chat skill commands, user amendment

The attached stage's editable composer supports `/skill:<selector> [arguments]`, including qualified selectors and source-aware suggestions, using its own effective resource catalog and settings. Reuse existing discovery, resolution, expansion and argument handling. Session expansion supplies the skill location, candidate identity and base directory; do not expand in both UI and session. Skill-relative references retain that directory, while ordinary tools retain the stage working directory. Main-session resources cannot substitute for stage resources.

The shared command adapter classifies `/tasks` as a local view action and skill invocation as a stage-session user message. Delegate expansion exactly once to the existing session path. Enter preserves current steering/idle delivery; Ctrl+F preserves follow-up intent. Tool restrictions, workspace boundaries, stage admission and prompt ownership remain in force. Skills grant no permission to bypass those boundaries or automatically launch new workflows/subagents. This amendment does not expose every unrelated main-chat slash command in workflow chats.

Suggestions honor existing `enableSkillCommands` registration behavior, catalog precedence, qualified selectors and resource reload. Manually typed commands retain current session semantics, including argument trimming, unknown-selector pass-through and qualified-resolution/file-read diagnostics; a display setting is not a new authorization rule. Surface diagnostics in the attached chat. A host lacking stage command metadata must expose that limitation rather than borrow another owner's catalog.

Mounted HIL/custom prompts keep input ownership; slash-looking answers are literal answers, not commands. Blocked/read-only/replay stages cannot bypass admission. Existing explicit editable postmortem chat may use its own session's skill route without reviving a terminal workflow node. Pane switches and resource refresh cannot redirect a submitted command to another stage.

Source mapping and limitations are in the decision addendum. Session expansion already exists on several submission paths; S6 must test discovery and delivery before adding missing adapters. No blanket claim that skill execution is entirely absent is made.

#### Proposed wait and notification defaults

User confirmed independent agent launch by default, returning after setup without waiting for completion. Verified timing defaults are command foreground collection `10000` ms and explicit agent wait `30000` ms, configurable through `tasks.wait = {kind:"automatic", commandBudgetMs?:number, agentBudgetMs?:number}`. The agent budget applies only to requested waits, including explicit foreground-first launch or live foregrounding; it never delays a default independent launch. Timing values do not make mailbox activity a completed task result. Explicit background is immediate. `0` means immediate yield under Atomic's proposed wait API. Omitted budgets use owner settings. `tasks.wait = {kind:"until-settled"}` disables timed yielding for requested waits, not independent launch. Per-call budgets override settings; pane/cwd changes cannot reset a wait. Exact clamp/poll compatibility is distinct from defaults; see the decision addendum.

Execution timeout is separate and optional; wait budget expiry never kills. User confirmed HIL immediately raises attention and releases the foreground wait while the task stays live. Existing prompt routing and ownership remain authoritative; no answer is inferred and no child outlives its owner.

User confirmed quiet in-row success, persistent attention/error count, no automatic focus switch and necessary model completion wakeup. This changes completion presentation, not genuine messaging or model delivery. Repeated attention with the same identity does not spam rows. No additional success toast is included.

## 6. Alternatives Considered

| Option | Boundary, ownership and call path | Tradeoffs / decision |
|---|---|---|
| Extend N-API supervisor with separate start/wait doors | Existing native module owns resources; JS session stays in process; TS consumes ordered store | Recommended. Least distribution change, explicit callback/teardown work required. Cannot preempt hostile JS. |
| App-owned Rust sidecar with framed IPC | Host opens owner over IPC; sidecar owns commands, sends events; TS still runs model sessions | Better isolation from JS stalls for command supervision. More packaging, startup, disconnect and parent-death handling. Must not persist after app exit. Keep as fallback if native environment guarantees fail S1/S2. |
| TS-only registry wrapping current native helpers | TS owns state and timers; native only kills processes | Small UI change but cancellation/timing ordering depends on JS progress; does not satisfy selected Rust supervision boundary. Rejected. |
| Full Rust model runtime | Rust owns agent sessions and all tool loop logic | Exceeds explicit TypeScript sessions/tools/UI decision. Rejected. |
| One `runTask` result with async flags | One return type conflates yielded handle and terminal success | Easy to accidentally checkpoint a live handle; honest wait/result union is worth the extra door. Rejected. |
| Keep pending-tool UI plus final background notification | UI tied to invocation, separate result block | Cannot supply stable live UI after invocation lifetime or late attachment. Rejected. |
| Separate main/workflow background renderers | Each host interprets native events independently | Local convenience creates drift in expansion, race handling and messages. Shared projection and components selected. |

The first two alternatives preserve the same domain doors, so runtime topology can change without teaching the UI a different lifecycle. That does not make them interchangeable implementations; S1/S2 must prove the selected native lifetime contract.

## 7. Cross-Cutting Concerns

### 7.1 Security and Privacy

Owner capabilities come only from actual host session/stage identity. Model input cannot claim another owner's work. A native report must match environment, generation, task and attempt. Reconnected Intercom group membership does not grant workflow authority; existing immutable registration authority remains intact.

Starting agents/commands, writing stdin, cancellation, owner closure and model completion admission are the effect boundaries. Tool authorization stays at the existing tool edge. Cancellation cannot retract broker acceptance, remote API effects or file writes that already occurred. Display text is untrusted: sanitize terminal controls without changing raw artifacts or model/transport payloads. Avoid rendering credentials from environment maps in summaries. Output files use existing owner/session storage permissions and cleanup policy, not a new global public directory.

### 7.2 Native lifetime and cross-platform cleanup

Normal session/stage closure seals the owner before cancellation fanout. It stops future tool admission, aborts TS sessions, cancels native tasks, drains/reaps processes and then closes subscriptions. Main-session shutdown closes its stage owners too; a stage owner does not close sibling stages or unrelated sessions. Completed rows remain completed even while owner cleanup handles a lingering process resource.

macOS/Linux command supervision owns a process group and retained child handles. Spawn establishes containment before command execution. Close sends TERM, waits a bounded grace, sends KILL to remaining supervised group members, reaps the direct child and closes/drains PTY readers. A shell exiting early does not release the task's group ownership while descendants remain. Avoid delayed PID-only kills after handles are released; process-group reuse must be considered in native handle lifetime tests. Escaping process groups intentionally is outside ordinary cooperative command semantics and must be detected/refused where containment can establish it, not advertised as guaranteed containment.

Windows uses a native Job Object with kill-on-close, no breakaway permission and assignment before untrusted execution; suspended creation plus assignment is one suitable mechanism. ConPTY lifetime belongs to the same task. Assignment failure or nested-job restrictions fail launch with `ContainmentUnavailable`, cleaning the suspended process rather than running it unmanaged. Close terminates the job, waits on retained handles and disposes ConPTY readers/writers. `taskkill` and a child-only kill are not sufficient proof of this contract.

Cleanup grace is named supervisor configuration, measured in S2. Output limits are selected in §5.3, not pending a further product decision. Bounded cleanup returns CleanupFailed if confirmation is unavailable. It never reports reaped based solely on a cancellation flag. Logs retain owner/task IDs, first cancellation cause, cleanup failure resource and sequence, without raw secrets.

**In-process extension policy, confirmed by the user.** Preserve existing Node/Bun extension APIs and cooperative cancellation. Rust cannot forcibly stop arbitrary synchronous JavaScript on the host event loop. A hung callback can prevent host-side cancellation and diagnostic rendering until the loop responds; native shutdown paths remain available when invoked, but no instant UI or cleanup guarantee applies to that stall. Record closing/cleanup failure when possible, fence late admission/results, and never infer successful reaping from cancellation bookkeeping. This migration adds no isolated extension runtime or blanket refusal of existing extensions.

**Crash policy, confirmed by the user.** Normal session/stage/application shutdown cancels unfinished work and cleans up supervised resources. Forced host death receives best-effort platform safeguards only. SIGKILL executes no Rust Drop or JS hooks; Unix process groups alone cannot promise descendant cleanup. Linux parent-death signaling and Windows job cleanup can help where supported, but no universal guarantee is made for every backend or descendant. Document and test actual platform behavior without treating a known forced-crash limitation as failure of the normal-shutdown contract. No crash guardian or new containment service is required.

These confirmed policies replace the earlier isolate-or-refuse and universal crash-containment proposals. There is still no intentional ownership transfer, daemon, task survival service or terminal-child revival. A cleanup failure records a limitation, not permission to keep scheduling work after the owner closes. Existing stage cancellation/admission fences remain authoritative. History after restart is inspectable data, not a restored live task.

## Backwards Compatibility

Breaking changes are allowed. Replace conflated `continued`/detached result flags in new task-facing APIs with separate execution and observation unions. Regenerate native declarations rather than adding indefinite compatibility shims. Existing APIs are current state, not a mandate to preserve every signature.

Migration for eventual implementation:

1. Tool and SDK callers distinguish `yielded` from `settled`, retaining task handles only while the owner lives.
2. Durable workflow adapters await terminal domain results; they never checkpoint `WaitOutcome` directly.
3. Old child resume remains absent. Fresh `[TASK_CONTEXT]` launches remain the migration for terminal handoffs. Separate workflow resume semantics do not change.
4. Session history readers can display old `subagent-notify` entries but cannot restore live tasks. New task-linked completion envelopes are nonvisual and update keyed task history.
5. Migrate user configuration to documented wait policies and namespaced task actions. Keep Ctrl+O meaning and Ctrl+D/U unchanged. No compatibility aliases for unapproved key chords.
6. Preserve raw messages, omitted/empty parent questions, attachment ordering/duplicates, accepted receipts, retry tokens, exact-stage fences and workflow DAG/admission semantics.
7. Workflow-chat skill commands use the attached session's catalog, qualified selectors and existing expansion/delivery semantics. Document `/tasks` versus `/skill:<selector>`, discovery settings, HIL precedence and archive/postmortem boundaries without implying every parent command is available.

The future docs/changelog slice explains these changes only when they ship. No user-facing shipped documentation is changed by this RFC.

## 8. Test Plan

All commands in this section are **future implementation validation**, not tests executed for this design. Each slice must build and pass independently before later slices consume it. Root suites use Vitest with `node:assert/strict`, existing runtime helpers and existing timeout budgets. Structural heavy fixtures get named local budgets; no global timeout bump, serialization or removed assertions.

```text
S1 owner/task contract + supervisor
  S2 command supervision + input/cleanup
  S3 agent/Intercom + durable terminal adapter
  S4 shared compact projection + reconnect (uses S1; integration with S2/S3)
S2 + S3 + S4
  S5 expanded/navigation parity + complete terminal scenarios + migration docs
```

S6 workflow-chat skill discovery/submission is independent of the Rust supervisor. Verify against the existing stage session; coordinate shared command/input files with S5 rather than inventing an engine dependency.

S2 and S3 are independent consumers of S1. S4 can develop against S1 deterministic events before both producers are integrated. Shared-file changes remain single-writer at incorporation.

Post-review launch-policy gate for S1/S3: a default agent launch returns an admitted running handle after setup, before the fake runner is allowed to complete; no 30-second wait is introduced. Explicit wait times out without stopping that same task, explicit foreground-first still works, and a terminal-before-return race yields the terminal result once. Test default-background versus explicit yield reasons and wrong-owner task-ID refusal. Parallel default backgrounding must not masquerade as an Intercom group-detach event or skip queued siblings; normal concurrency scheduling continues while the owner remains live. The existing Intercom-specific queued-sibling rule applies only when that handshake actually occurs.

### S1: Admit, observe and stop owner-bound tasks

**Objective:** a native supervisor plus TS facade proves identity, state and owner rules without a model provider.

**Files:** S1 paths in §4.3; add `crates/atomic-natives/src/task_supervisor/tests.rs`, `test/unit/task-supervisor-contracts.test.ts`, `test/integration/task-supervisor-native.test.ts`.

**Red:** launch one fake runner, expire a wait, assert running state and unchanged identity; race close against admission and reject terminal restart. Test exact replay operation versus fresh duplicate intent; stale attempt/generation; zero budget; missing optional metrics; u64 sequence beyond JS safe integer. A negative TS construction fixture cannot pass `WaitOutcome` to a terminal result sink.

**Green:** smallest serialized owner/task registry, one runner lease, bounded wait and snapshot subscription through generated N-API bindings. No UI needed.

**Refactor:** share DTO conversion and remove competing lifecycle authority only after existing native terminal tests still pass.

**Acceptance gate:** same task ID/attempt after yield; exactly one fake execution; owner-close prevents future admission; duplicate terminal receipt unchanged; cancellation-first rejects success; full snapshot and later events have no gap; cross-environment handle refused. Native `Send + Sync` assertions cover actor-owned records, not JS handles.

```sh
cargo test -p atomic-natives task_supervisor
cargo test -p atomic-natives subagent_control
npm run build --workspace=@bastani/atomic-natives
npx --no-install vitest --run --project unit test/unit/task-supervisor-contracts.test.ts
npx --no-install vitest --run --project integration test/integration/task-supervisor-native.test.ts
npm run typecheck
```

### S2: Commands remain alive after yield, then stop with owner

**Objective:** route native pipe/PTY commands through the same supervisor without turning wait expiry into process timeout.

**Files:** S2 native/command paths in §4.3; add `test/fixtures/task-process-tree.mjs`, `test/unit/task-command-supervision.test.ts`, `test/integration/task-process-cleanup.test.ts`; extend existing `packages/coding-agent/test/bash-pty-native.test.ts`.

**Red:** real fixture writes parent/grandchild identities and incremental output; ordinary wait yields while both live. Owner close must confirm both exited. Separate execution timeout kills. Exercise shell exit before grandchild, spawn failure, stdin bytes/empty/EOF, input queue full, resize, cancellation/output/completion race and spool cap.

Assert default output values 1048576/8388608/5368709120/8192 bytes. Use a smaller injected cap for stream tests and arithmetic tests at the real 5 GiB boundary. File-spool background commands must be killed after a size poll, settle OutputLimitExceeded, and reap the process group; an ENOENT poll is skipped and a foreground collection wait must not start that watchdog. Drained pipe/PTY commands must stay running, keep the file within cap, continue draining, and record omitted ranges, including a multibyte character that spans the cap. Exercise background spill before the foreground threshold, disk-write failure, paged prefix/tail reads and cancellation/terminal delivery under sustained output. Keep session history outside raw-output cap handling. Do not kill an agent task or a drained PTY because a sibling file-spool command hit the cap.

**Green:** one process resource abstraction with explicit pipe/PTY variants, input lease and cleanup receipts. Windows containment failure refuses launch before command execution.

**Refactor:** consolidate native cleanup through the task resource owner; leave unrelated shell execution behavior untouched.

**Acceptance gate:** no child survives successful owner close on each actual supported OS; no falsely reaped receipt; zero/absent exit fields serialize correctly; output omissions observable; input ambiguous delivery never auto-retries; cancellation twice cannot kill a reused PID. Run Unix process-group and Windows job/ConPTY assertions on native hosts, not skipped tests or cross-compile-only proof.

Normal-shutdown cleanup tests remain authoritative. Forced-host-death probes record Linux/macOS/Windows safeguards and limitations separately; they do not require a universal descendant-kill result or a new guardian. Run hazardous crash/stall fixtures only in disposable child hosts with an external test watchdog and cleanup. For in-process JS stalls, verify the documented cooperative limit and unchanged extension compatibility; do not replace the runtime or label a stuck callback reaped.

```sh
cargo test -p atomic-natives task_supervisor
npm run build --workspace=@bastani/atomic-natives
npx --no-install vitest --run --project unit test/unit/task-command-supervision.test.ts
npx --no-install vitest --run --project integration test/integration/task-process-cleanup.test.ts
npm run test --workspace=@bastani/atomic -- test/bash-pty-native.test.ts
```

### S3: Agent and Intercom continuity without false workflow settlement

**Objective:** exact current running promise survives yield; task outcome and model delivery remain distinct.

**Files:** S3 adapters in §4.3; extend existing detach, cancellation, retry and handoff tests listed below; add `test/integration/task-durable-settlement.test.ts` and `test/integration/task-completion-delivery.test.ts`.

**Red:** fake model child emits read, receives a peer message, detaches, emits bash, then completes. Assert one start, stable IDs, no completion until terminal, genuine message preserved, same completion identity through lost acknowledgement. Repeat for parallel active siblings and skipped queued entries. Parent-directed ask instead terminally interrupts with raw empty/omitted question and ordered duplicate attachments; fresh launch uses new identity. Close stage at probe, commit, output, terminal and model-persistence boundaries. Check unrelated owners and accepted transport receipts remain unchanged.

**Green:** map handshake commit to yieldTaskWait; completion outbox uses existing admission/terminal barrier; durable adapter excludes yielded values.

**Refactor:** remove only new-task lifecycle visible notification insertion, not generic Intercom messages or historical renderers.

**Acceptance gate:** exact retry token/message ID preserved, terminal monotonicity, no completed DAG node while task live, existing persistence-start commit-wins behavior preserved, cancellation after detached tool return reaches original promise, no late finding rerouted to main chat after stage close.

```sh
npx --no-install vitest --run --project unit test/unit/subagents-foreground-intercom-detach.test.ts test/unit/subagents-parallel-intercom-detach.test.ts test/unit/intercom-foreground-detach-handoff.test.ts test/unit/workflow-stage-subagent-cancellation.test.ts test/unit/intercom-terminal-ordering-barrier.test.ts test/unit/intercom-retry-identity.test.ts test/unit/intercom-tool-retry-real-broker.test.ts
npx --no-install vitest --run --project integration test/integration/task-durable-settlement.test.ts test/integration/task-completion-delivery.test.ts test/integration/intercom-reconnect-recovery.test.ts test/integration/subagents-parent-ask-handoff.test.ts
npm run typecheck
```

### S4: One compact projection in both chat hosts

**Objective:** keep live task rows beyond launching tool/turn end, including reattachment.

**Files:** S4 paths in §4.3; add `test/unit/task-projection.test.ts`, `test/unit/task-row.test.ts`, `test/integration/task-chat-parity.test.ts`; extend `test/unit/stage-chat-view-mid-stream-attach.test.ts`.

**Red:** send the same event trace to main and workflow hosts: tool end, agent end, live background output, task settlement. Assert one task anchor, action updates before settlement, no new Spacer/Box for hidden completion, one genuine message. Disconnect after cursor C, overflow journal, reattach snapshot; assert same IDs and terminal fences. Render more than four runs through complete projection while mounting a bounded viewport.

**Green:** shared owner store, task-row renderer and keyed history updates. Add subscription disposal without owner closure.

**Refactor:** reuse common activity/formatting code; no broad theme or tool renderer rewrite.

UI fidelity gates: long/identical task descriptions, display-only truncation, title fallback and stable suffix disambiguation; mixed/same-type group headings and accurate task/tool-use counts; one expansion hint per group; main/workflow footer visible after the task anchor scrolls off-screen; bounded footer and prompt coexistence; no task footer for an empty session. Assert transcript and list orders separately: transcript launch order versus fixed type grouping with within-type admission order.

**Acceptance gate:** identical task content for both hosts at every sequence; exact absence of duplicate/empty completion component; unknown metrics omitted, zero shown; repeated labels do not merge tasks; resize/output retains selected task and anchor; `NO_COLOR` still identifies every state.

S5 also verifies the transcript adapter with original prompt, assistant text, tool calls/results and final response. No numeric event log may stand in for this content. Test paging, live/history deduplication, same tool-name repeated calls, null renderer with no allocated blank row, real empty output, unavailable transcript, hidden reasoning/system-prompt exclusion, terminal action removal, HIL prompt routing and latest-action marker distinct from keyboard selection. Add `test/unit/task-transcript-projection.test.ts` and `test/unit/task-detail.test.ts` to the future unit gates. Both hosts must render the same authorized message content for equivalent snapshots. Reference screenshots are not substitutes for native terminal tests.

```sh
npx --no-install vitest --run --project unit test/unit/task-projection.test.ts test/unit/task-row.test.ts test/unit/stage-chat-view-mid-stream-attach.test.ts
npx --no-install vitest --run --project integration test/integration/task-chat-parity.test.ts
npm run test --workspace=@bastani/atomic
npm run typecheck
```

### S5: Expanded detail, navigation and end-to-end task lifetime

**Objective:** verify all mockup flows through real terminal input with deterministic sessions, then document the shipped behavior.

**Files:** S5 UI/keybinding paths in §4.3; add `test/unit/task-navigation.test.ts`, `test/integration/task-terminal-scenarios.test.ts`, `test/fixtures/task-experience-session.ts`; future docs/changelog migration paths in §4.3. Fixture uses the actual ChatHost/renderers and native task facade with a fake model provider, not hard-coded mockup strings.

The TS transcript adapter in §5.4 and its `test/unit/task-transcript-projection.test.ts` / `test/unit/task-detail.test.ts` coverage belong to S5. They reuse existing session message/tool renderers, not a new child transcript engine.

**Red:** Ctrl+O toggles global expansion in both hosts; remapped/unbound action hints match. Task focus navigation does not intercept composer or HIL. Narrow/short screen keeps prompt and all-task route accessible. Exercise explicit, timed, Intercom, stdin, failure, cancellation, live foregrounding, owner close and reattach.

**Green:** focused task detail and shared input handler, plus test-only credential-free fixture with commands below.

**Refactor:** share navigation across hosts and preserve existing graph/editor bindings. Write migration docs and Unreleased shipped-behavior notes only after integration is proven.

**Acceptance gate:** screenshots/pane captures and machine event log agree on task identity/state; one visible task row throughout Intercom; actual process-tree close proof; no resurrected terminal child; no accidental key reassignment. Fixture commands are test-only and not registered in production.

Future fixture contract: run `bun test/fixtures/task-experience-session.ts --chat main|workflow --evidence-dir <dir>`. Its test composer accepts `/fixture foreground`, `/fixture explicit`, `/fixture timed`, `/fixture intercom`, `/fixture complete t17`, `/fixture shell`, `/fixture fail`, `/fixture close-owner`, `/fixture detach-view`, `/fixture attach-view`, `/fixture quit`. It writes `events.jsonl`, task/owner IDs and cleanup receipts. Intercom scenario reserves deterministic display alias t17 for one generated task ID; alias is never native identity. `/fixture intercom` emits a genuine peer message and additional post-yield activity under that ID. It must use the real local broker or a separately labeled deterministic transport adapter; real receipt-loss coverage stays in S3.

**D3 planned fixture barrier protocol.** Add planned `test/fixtures/task-experience-driver.mjs` (Node standard-library tmux driver/wait helper) in S5. Each run creates a fresh evidence directory and nonce runId; refuse reuse. Fixture appends complete JSONL records to planned `barriers.jsonl`: `{runId, barrier, commandId, revision, cursor, taskId?, evidence}`. revision is a decimal render revision, cursor is the native cursor; commandId is supplied by the driver as `/fixture <action> --command-id <id>`. Initial ready uses commandId `boot`. Never accept records from another run or partial JSON lines.

| Barrier | Required predicate / evidence |
|---|---|
| ready | Actual host mounted, owner open, input handlers installed; evidence contains host and ownerId. |
| intercom-live | Same admitted task/attempt/startCount=1; designated wait yielded; later bash activity cursor strictly greater than yield; real genuine message count=1; task still running. Fixture holds completion until commanded. |
| rendered | Actual renderer flush completed for commandId, revision strictly greater than previous capture, applied cursor at least requested cursor; evidence contains toolsExpanded, anchorCount=1, emptyCompletionComponents=0 and viewport dimensions. |
| terminal | task-settled for alias t17's original ID with completionId and terminalSequence. |
| model-persisted | Session/model storage reread confirms exactly one envelope with that completionId, display=false; workflow durable result persisted before dependency settlement. |
| shell-ready | Native fixture recorded retained parent/grandchild handles and birth identities, both live; output observed after yield. |
| cleanup | Owner closed only after every retained process identity exited, direct child reaped, descendants absent, PTY/readers closed; evidence lists each identity and native wait result, not merely a kill request. |
| stopped | Fixture shutdown finished; driver additionally awaits process exit and tmux session absence. |

Planned helper invocation: `node test/fixtures/task-experience-driver.mjs wait --dir <fresh-dir> --run-id <nonce> --barrier rendered --command-id expand --after-revision <previous> --timeout-ms 30000`. Named `FIXTURE_BARRIER_TIMEOUT_MS=30000` bounds each wait; `FIXTURE_EXIT_TIMEOUT_MS=10000` bounds exit. A missing barrier, predicate mismatch, fixture exit, invalid complete JSON record or deadline exits nonzero, saves diagnostics, prevents capture and closes the dedicated fixture/session in finally. Partial last lines are retried within the bound. Failure cleanup still checks native resource identities; a leak fails the scenario rather than passing because tmux died.

The planned `run` command implements this exact inspectable trace; `wait` is its helper, not a sleep:

```text
D3 planned run trace (each send has a unique commandId)
spawn dedicated tmux fixture -> wait ready(boot) -> wait rendered(boot)
send intercom(live) -> wait intercom-live(live) -> wait rendered(live) -> capture live.txt
send Ctrl+O -> fixture labels next input expand -> wait rendered(expand, expanded=true) -> capture expanded.txt
send complete t17(done) -> wait terminal(done) -> wait model-persisted(done)
  -> wait rendered(done, terminal cursor applied) -> capture settled.txt
resize 48x16(resize) -> wait rendered(resize, dimensions=48x16)
send shell(shell) -> wait shell-ready(shell) -> wait rendered(shell) -> capture shell.txt
send close-owner(close) -> wait cleanup(close) -> wait rendered(close) -> capture closed.txt
send quit(quit) -> wait stopped(quit) -> await process exit -> assert session absent
finally: stop dedicated fixture if still live; verify no retained process survives
```

The fixture assigns `expand` to the first Ctrl+O input and `resize` to the driver's first resize event; later repetitions use incremented suffixes agreed in its ready record. The driver requires a newer revision for every capture, task cursor predicates for lifecycle captures, and no user/provider timing dependence. It saves native events, render diagnostics and model-store reread evidence beside panes. Main and workflow host invocations are explicitly separate:

For the workflow fixture, the stage logical operation remains open on an explicit fixture release barrier after t17's durable result; the shell and close-owner steps occur in that same live stage. No automatic stage completion may race shell admission. The model-persisted oracle checks the task's durable callback result, not an assertion that the entire stage has completed. The close command cancels that still-open stage using the real lifetime boundary.

```sh
# PLANNED, unexecuted S5 transcript/detail gates; files are added by S5.
npx --no-install vitest --run --project unit test/unit/task-transcript-projection.test.ts test/unit/task-detail.test.ts test/unit/task-navigation.test.ts
```

```sh
# PLANNED, unexecuted: driver creates unique nonce directories beneath these roots.
node test/fixtures/task-experience-driver.mjs run --chat main --session atomic-task-main --evidence-root .ci-diagnostics/task-main --columns 100 --rows 30
node test/fixtures/task-experience-driver.mjs run --chat workflow --session atomic-task-workflow --evidence-root .ci-diagnostics/task-workflow --columns 100 --rows 30
# Each run launches: bun test/fixtures/task-experience-session.ts --chat <host> --evidence-dir <fresh-dir> --run-id <nonce>
npx --no-install vitest --run --project integration test/integration/task-terminal-scenarios.test.ts
npx --no-install vitest --run --project unit test/unit/task-navigation.test.ts
```

The scenario runner waits for event-log barriers before each capture; raw immediate `send-keys`/capture alone is not sufficient synchronization. It repeats both hosts at 100×30, 80×24 and 48×16, then remapped expansion, no-color and reduced-motion. It also drives `/tasks` focus and explicit stdin action in the shell fixture. Oracles compare task UUID in event logs, one row anchor in renderer diagnostics, stable display alias, genuine message count, no empty completion component and `cleanup:reaped` before successful close. On Windows use installed psmux with its actual help or native PTY automation; retain native job cleanup evidence. Tmux on macOS/Linux is not Windows proof.

### S6: Invoke skills from editable workflow chats

**Objective:** main-chat skill discovery/invocation semantics in workflow chat, using the exact attached session's resources and admission boundaries.

**Files:** S6 paths in §4.3; add `test/unit/stage-chat-skill-commands.test.ts` and `test/integration/stage-chat-skill-invocation.test.ts`. Update skills/workflow operations docs and applicable shipped-behavior changelogs only during implementation.

**Red:** distinct main/stage catalogs with a same-named skill and qualified alternatives. Submit `/skill:fixture args`; assert the stage skill body/base directory reaches only that session, expanded once. Test suggestions/source metadata, disabled registration, manually typed invocation parity, reload, unknown/ambiguous selectors and read errors. Repeat idle, streaming Enter, Ctrl+F and pane switching. Mounted prompt answers starting `/skill:` stay literal. Blocked/archive/replay cannot mutate; supported postmortem invocation cannot reopen workflow work. `/tasks` stays local and never enters model context.

**Green:** reuse catalog/session expansion; add only missing stage-bound completion metadata and submission wiring. No new interpreter or generic parent-command forwarding.

**Refactor:** share source-aware command classification without merging local UI actions and session delivery. Keep shared S5/S6 input files single-writer at integration.

**Acceptance gate:** equivalent catalogs resolve identically; different catalogs target correctly; one expansion and one admitted message; exact steer/followUp behavior; stage identity and HIL/replay fences hold. Extend a real stage-chat terminal fixture with credential-free selection/invocation evidence, not hard-coded transcript output.

```sh
# PLANNED, unexecuted. Test files are added by S6.
npx --no-install vitest --run --project unit test/unit/stage-chat-skill-commands.test.ts
npx --no-install vitest --run --project integration test/integration/stage-chat-skill-invocation.test.ts
npm run test --workspace=@bastani/atomic
npm run typecheck
```

S6 does not depend on S1–S4. Concurrent implementation needs its own worktree/root lifecycle; shared input/command adapter integration with S5 remains a coordination boundary. No implementation is launched by this amendment.

### Shared build, generated-contract and platform gates

After approved implementation setup:

```sh
npm ci --ignore-scripts
npm run build
cargo fmt --all -- --check
cargo clippy -p atomic-natives --all-targets -- -D warnings
cargo test -p atomic-natives
npm run build --workspace=@bastani/atomic-natives
npm run check
npm run test:unit
npm run test:integration
npm run test:ci-contracts
npm run test --workspace=@bastani/atomic
```

`Cargo.toml` declares one native crate; no speculative feature matrix is added. Test actual `cfg(unix)`/`cfg(windows)` paths, pipe/PTY, native module present/unsupported containment, Node/Bun host loading, generated optional fields and sequence strings. Native build generates declarations/loader; inspect their delta and typecheck both root and coding-agent configs. Never add a build step to raw-TypeScript workflows. Test source paths described as “add” above do not exist yet; their commands become gates in their owning slice.

Property tests permute duplicate reports, yield/terminal/cancel ordering, cursor gaps and owner closure using deterministic seeds. Invariant: no trace admits a new execution for a terminal ID, no closed owner has live supervised work, no yielded observation publishes logical workflow completion, and no task completion creates a second transcript anchor. Test each named door failure at its boundary rather than snapshots alone.

## 9. Confirmed decisions and remaining engineering work

The user has resolved the policy choices below. Human approval to implement is still separate from these decisions and from the earlier independent design review. Remaining work is implementation verification, not another interview about the same choices.

| Choice | Contrastive options | Recommendation and tradeoff |
|---|---|---|
| Agent launch composition | Resolved: independent launch by default; explicit result waits default to 30000 ms. Commands initially collect for 10000 ms. | User confirmed. Foreground-first agent launch remains an explicit option. Task-result and mailbox-activity semantics stay distinct. |
| HIL budget policy | Resolved: expose attention and yield immediately. | User confirmed. Keep task live within its owner and retain prompt routing. |
| Shared task overflow | Resolved: shared `/tasks` in both hosts, F2 unchanged graph. | User confirmed. Default shortcut remains unbound until collision review. |
| Completion attention | Resolved: quiet success in row, persistent error/HIL count, no focus theft. | User confirmed. No extra toast; model completion delivery remains required. |
| Output retention | Resolved: same four byte limits, with the split overflow convention. | File-spool background commands are killed at 5 GiB. Drained pipe/PTY output truncates and continues. Agent/session history is out of scope for this cap. |
| In-process JS extensions | Resolved: preserve existing runtime/API and cooperative cancellation. | Document hung synchronous callbacks; no isolated extension migration or blanket admission refusal. |
| Forced application death | Resolved: normal stop-with-owner cleanup; crash cleanup best effort. | Use supported platform safeguards and state limitations. No universal crash guarantee or guardian requirement. |
| Workflow-chat skills | Required: stage-local `/skill:<selector> [arguments]` discovery and invocation. | User amendment. Reuse catalog/session behavior; S6 covers routing and restrictions. Not permission to expose all parent slash commands. |

Engineering follow-ups are bounded queue sizing and aggregate-memory accounting, cleanup grace measurement, disk-log retention under existing session storage policy, and shortcut collision review. Keep `/tasks` command-accessible with no new default chord until that review. These details must not override the selected per-task limits or reintroduce resolved isolation/crash requirements.

Dependencies: UI research confirms #2700 remains open, not merged, with head `4914e13ea7f7d1addb03bab8dc7465770e2a1254`; #2824 and #2565 remain open. Reconcile their final widget/prompt identity changes before S4/S5 integration. Do not absorb their entire feature sets. Existing HIL routing stays authoritative; this draft shows attention and navigation rather than inventing parent-card or notification projects.

Source limits remain explicit in the research: indexed synthesis has no declared snapshot, some timeout constants and platform internals were not verified, and the reported newline behavior was not interactively reproduced. The draft's own proposed guarantees are tested by future slices, not asserted as current product behavior. [Design notes](../research/2026-09-05-agent-task-design-notes.md) record actual artifact checks separately.
