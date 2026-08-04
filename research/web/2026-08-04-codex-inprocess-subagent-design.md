# OpenAI Codex (`codex-rs`) in-process subagent design

**Repository snapshot.** `openai/codex`, `codex-rs`, commit [`9873cba8ce6d14e650e12cdc0dddd159ae6613d7`](https://github.com/openai/codex/commit/9873cba8ce6d14e650e12cdc0dddd159ae6613d7) (`2026-08-04`, “Consolidate thread spawning behind a request object”, commit time `2026-08-04T08:46:21Z`). All source links below are pinned to that full SHA.

## Summary

Codex has two materially different collaboration protocols:

- **MultiAgent V1 (legacy):** namespaced `multi_agent_v1` tools (`spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`) address children by UUID-like thread ID. A child completion watcher sends a model-visible notification to the parent. `wait_agent` can also return the final status and completed assistant message. Completed children remain open and consume the V1 child-thread limit until `close_agent` is called.
- **MultiAgent V2 (current path):** plain or configured-namespace tools (`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`) address children by canonical task path. Messages are mailbox communications. A terminal child sends a completion envelope to its direct parent (the formatter explicitly bounds error text; successful final text is passed through); `wait_agent` waits for mailbox activity and deliberately does not return the child’s content. There is no V2 `close_agent`; terminal runtimes are unloaded by an LRU residency policy and can be lazily reloaded from persisted history.

A child is **not a separate Codex process**. The parent and child are `Arc`-owned `CodexThread`/`Session` instances registered in one `ThreadManagerState`; their session loops and turn tasks run on the same Tokio runtime. They share the root’s cloned `AgentControl`, auth manager, model manager, thread/environment/MCP/plugin stores, and (when compatible) execution-policy manager. Each child still constructs its own `ModelClient` with its own thread ID and provider snapshot.

The important capacity distinction is:

- **V1:** default legacy spawned-agent cap is `6` child threads per root control session (the TOML `agents.max_threads` alias is normalized to `max_concurrent_threads_per_session`); root is not counted. Default V1 nesting depth is `1`, so root children may spawn but grandchildren are blocked. V1 has no active-turn execution limiter.
- **V2:** default `max_concurrent_threads_per_session` is `4` including the conceptual root slot. The runtime derives a **child capacity of `3`** (`max_concurrent_threads_per_session - 1`) for loaded residency and active child turns. V2’s identity reservation is intentionally unbounded (`reserve_spawn_slot(None)`); the loaded-runtime and active-turn limits are the bounds. V2 has no depth check.

Status is a watch channel derived from lifecycle events (`PendingInit`, `Running`, `Interrupted`, `Completed(final_message)`, `Errored`, `Shutdown`, `NotFound`). Parent tools, `list_agents`, structured turn items, and completion messages expose it. Interrupt is cooperative first (cancellation token), waits **100 ms**, then aborts the task and emits `TurnAborted(Interrupted)`. Shutdown closes the runtime and waits for the session loop. Wait timeouts are tool-call deadlines, not child execution deadlines; there is no wall-clock idle timeout for children in this code.

The narrowest useful Atomic analogue is therefore: an in-process child session with an explicit identity/control handle, shared auth/model-manager dependencies but a per-child model client, RAII spawn reservations, separate loaded-residency and active-execution budgets, a depth policy, a small status/result envelope, and a restricted direct-tool surface for collaboration calls.

## 1. Collaboration tool surface

### 1.1 V1: UUID-addressed tools

The V1 tool specification registers the tools in the `multi_agent_v1` namespace. The spawn output is deliberately only identity metadata:

> `name: "spawn_agent"` … `Returns the spawned agent id plus the user-facing nickname when available.`

Source: [`multi_agents_spec.rs#L67-L99`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L67-L99). The output schema is `{agent_id: string, nickname: string|null}` ([`#L391-L407`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L391-L407)).

| Tool | Parameters | Return/semantics |
|---|---|---|
| `multi_agent_v1.spawn_agent` | `message` **or** structured `items`; optional `agent_type`, `model`, `reasoning_effort`, `service_tier`, and `fork_context` | `{agent_id, nickname}`. `fork_context=true` forks current history; otherwise the child starts with the prompt. [`multi_agents_spec.rs#L586-L628`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L586-L628) |
| `multi_agent_v1.send_input` | required `target`; `message` **or** `items`; optional `interrupt` | `{submission_id}`. `interrupt=true` first interrupts the current child turn, then submits the message; otherwise it queues it. [`multi_agents_spec.rs#L148-L183`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L148-L183), [`send_input.rs#L41-L89`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs#L41-L89) |
| `multi_agent_v1.wait_agent` | required `targets: string[]`; optional `timeout_ms` | `{status: {target: AgentStatus}, timed_out}`. It waits for whichever target reaches a final status first, and the completed status may contain the final assistant message. [`multi_agents_spec.rs#L269-L281`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L269-L281), [`wait.rs#L156-L221`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L156-L221) |
| `multi_agent_v1.close_agent` | required `target` | `{previous_status}`; marks the persisted spawn edge closed and shuts down the target plus live descendants. [`multi_agents_spec.rs#L318-L337`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L318-L337), [`close_agent.rs#L29-L128`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs#L29-L128) |
| `multi_agent_v1.resume_agent` | required `id` | `{status}`; recreates a previously closed/cold agent from its rollout so it can receive input/wait calls. [`multi_agents_spec.rs#L247-L265`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L247-L265), [`resume_agent.rs#L82-L151`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs#L82-L151) |

The spawn handler validates the one-level V1 depth policy before doing any work, emits an in-progress `CollabAgentToolCall`, builds the child config, invokes `AgentControl::spawn_agent_with_metadata`, then emits a completed tool item and returns the ID/nickname:

```rust
let child_depth = next_thread_spawn_depth(&session_source);
let max_depth = turn.config.agent_max_depth;
if exceeds_thread_spawn_depth_limit(child_depth, max_depth) { /* ... */ }
// ...
let result = Box::pin(session.services.agent_control.spawn_agent_with_metadata(/* ... */))
    .await
    .map_err(collab_spawn_error);
// ...
Ok(SpawnAgentResult { agent_id: new_thread_id.to_string(), nickname })
```

Source: [`multi_agents/spawn.rs#L44-L68`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L44-L68) and [`#L117-L136`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L117-L136), [`#L187-L218`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs#L187-L218).

`wait_agent` subscribes to each child’s `watch::Receiver<AgentStatus>`, returns immediately for an already-final target, otherwise waits until a final status or deadline. The final status map is keyed by the target’s canonical path when available (or ID), and `Completed(Option<String>)` carries the final assistant message:

```rust
let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
// clamp to MIN_WAIT_TIMEOUT_MS..=MAX_WAIT_TIMEOUT_MS
let status = rx.borrow().clone();
if is_final(&status) { initial_final_statuses.push((*id, status)); }
```

Source: [`multi_agents/wait.rs#L89-L127`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L89-L127), [`#L156-L200`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L156-L200).

### 1.2 V2: canonical task paths and mailbox tools

V2 requires `task_name` and creates a canonical child path under the caller, e.g. `/root/research/task_3`. The model-facing description explicitly says the child has the same tools as its parent and that its final answer is delivered to the parent:

> “The spawned agent will have the same tools as you and the ability to spawn its own subagents.”
>
> “It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.”

Source: [`multi_agents_spec.rs#L749-L768`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L749-L768).

| Tool | Parameters | Return/semantics |
|---|---|---|
| `spawn_agent` (plain or configured namespace, default `collaboration`) | required `task_name`, `message`; optional `agent_type`, `model`, `reasoning_effort`, `service_tier`, `fork_turns` (`none`, `all`, or positive integer string). `fork_context` is rejected in V2. | `{task_name, nickname?}` (nickname can be hidden by config). Spawn submits a trigger-turn inter-agent communication to the child. [`multi_agents_spec.rs#L102-L145`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L102-L145), [`multi_agents_v2/spawn.rs#L39-L135`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L39-L135) |
| `send_message` | required `target` (relative/canonical path) and `message` | Queues a message but does not trigger a turn; returns empty success. [`multi_agents_spec.rs#L186-L215`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L186-L215), [`multi_agents_v2/message_tool.rs#L51-L129`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L51-L129) |
| `followup_task` | required `target` (not root) and `message` | Queues a follow-up and triggers a turn if idle; if already running it is delivered at a message boundary/after a pending tool call. [`multi_agents_spec.rs#L218-L244`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L218-L244), [`followup_task.rs#L24-L39`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs#L24-L39) |
| `wait_agent` | optional `timeout_ms` | Waits for mailbox activity (queued message or final-status notification), or parent-turn steering; returns `{message, timed_out}` and **not** child content. [`multi_agents_spec.rs#L285-L294`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L285-L294), [`multi_agents_v2/wait.rs#L37-L117`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L37-L117) |
| `interrupt_agent` | required `target` | `{previous_status}`; interrupts the current turn but leaves the child available for messages/follow-ups. Root and self are rejected. [`multi_agents_spec.rs#L340-L357`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L340-L357), [`interrupt_agent.rs#L26-L95`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs#L26-L95) |
| `list_agents` | optional `path_prefix` | `{agents: [{agent_name, agent_status}]}` for the current root tree. [`multi_agents_spec.rs#L297-L315`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L297-L315), [`agent/control.rs#L383-L452`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control.rs#L383-L452) |

The V2 spawn handler converts `fork_turns`, builds a child `SessionSource::SubAgent(ThreadSpawn { ... agent_path ... })`, and sends a `trigger_turn: true` communication:

```rust
let spawn_source = thread_spawn_source(/* parent */, /* depth */, role_name,
                                       Some(args.task_name.clone()))?;
let communication = communication_from_tool_message(
    author, new_agent_path.clone(), message, &source, /*trigger_turn*/ true,
);
let spawned_agent = agent_control.spawn_agent_with_communication(
    config, communication, context, Some(spawn_source), options,
).await?;
```

Source: [`multi_agents_v2/spawn.rs#L61-L135`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L61-L135).

The V2 wait call waits on the parent session’s input-queue activity receiver, not on a list of child status receivers:

```rust
let (mut activity_rx, pending_activity) = session
    .input_queue
    .subscribe_activity(turn_state.as_deref())
    .await;
let outcome = wait_for_activity(&mut activity_rx, pending_activity, deadline).await;
```

Source: [`multi_agents_v2/wait.rs#L68-L117`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L68-L117), [`#L178-L195`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L178-L195).

### 1.3 What a child returns to its parent

There are three separate return channels; spawn itself is not the final-result channel:

1. **Spawn acknowledgement:** V1 returns `agent_id`/nickname; V2 returns canonical `task_name`/optional nickname.
2. **Submission acknowledgement:** V1 `send_input` returns a `submission_id`; V2 send/follow-up tools return an empty successful tool result.
3. **Completion result:** V1 can return `AgentStatus::Completed(Some(final_message))` via `wait_agent`; V2 serializes terminal completion into an inter-agent mailbox message sent to the direct parent. The V2 `wait_agent` result only says that mailbox activity occurred.

The terminal envelope is structured, but only the error path is explicitly bounded in this formatter. `format_inter_agent_completion_message` uses the final assistant text for `Completed` without an explicit truncation call, emits a readable/truncated error for `Errored`, and returns no message for non-final statuses. The error path is sized for a 1,000-token budget (with 100 tokens reserved for the envelope):

```rust
const COMPLETION_MESSAGE_MAX_TOKENS: usize = 1_000;
const COMPLETION_MESSAGE_ENVELOPE_TOKEN_RESERVE: usize = 100;
// ...
AgentStatus::Completed(Some(message)) => message.clone(),
AgentStatus::Errored(error) => truncate_text(error, TruncationPolicy::Tokens(ERROR_MAX_TOKENS)),
AgentStatus::PendingInit | AgentStatus::Running | AgentStatus::Interrupted => return None,
```

Source: [`session_prefix.rs#L10-L43`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session_prefix.rs#L10-L43).

## 2. In-process thread/session construction

### 2.1 One control plane per root tree

`AgentControl` is cloned into every descendant and intentionally holds a weak manager reference plus root-tree-scoped shared state:

```rust
/// `AgentControl` is held by each session ...
/// That same `AgentControl` is then shared with every sub-agent spawned from that root,
/// which keeps the registry scoped to that root thread rather than the entire `ThreadManager`.
pub(crate) struct AgentControl {
    session_id: SessionId,
    manager: Weak<ThreadManagerState>,
    state: Arc<AgentRegistry>,
    v2_residency: Arc<V2Residency>,
    agent_execution_limiter: Arc<AgentExecutionLimiter>,
    rollout_budget: Arc<RolloutBudget>,
}
```

Source: [`agent/control.rs#L90-L109`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control.rs#L90-L109). `with_session_id` sets the shared session identity and initializes the shared execution limit ([`agent/control.rs#L128-L132`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control.rs#L128-L132)). This is a useful ownership shape for Atomic: the child handle should not own a second global manager or duplicate the root’s quota state.

### 2.2 Spawn path

`spawn_agent_internal` is the central path for both V1 user-input spawns and V2 inter-agent-communication spawns. It:

1. resolves the effective multi-agent version;
2. checks active-turn execution capacity;
3. reserves V2 residency if applicable;
4. reserves an identity/count slot and reserves the child path/nickname before startup;
5. calls `ThreadManagerState::spawn_new_thread_with_source` or the fork path, passing the **same** `AgentControl` clone and parent metadata;
6. commits reservations only after the new thread exists;
7. broadcasts thread creation and persists the parent-child graph edge;
8. submits the initial user input or communication; and
9. returns `LiveAgent {thread_id, metadata, status}`.

The source shows the reservation and same-control handoff:

```rust
let mut reservation = self.state.reserve_spawn_slot(reservation_max_threads)?;
// ...
let new_thread = state.spawn_new_thread_with_source(
    config.clone(), self.clone(), session_source, /* ... */
).await?;
agent_metadata.agent_id = Some(new_thread.thread_id);
reservation.commit(agent_metadata.clone());
```

Source: [`agent/control/spawn.rs#L365-L481`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L365-L481). Initial input is submitted after the reservation is committed ([`#L521-L567`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L521-L567)).

`ThreadSpawnRequest` centralizes startup dependencies (config, auth manager, control handle, parent/fork IDs, inherited environment and exec policy):

```rust
struct ThreadSpawnRequest {
    options: StartThreadOptions,
    auth_manager: Arc<AuthManager>,
    agent_control: AgentControl,
    parent_thread_id: Option<ThreadId>,
    forked_from_thread_id: Option<ThreadId>,
    inherited_environments: Option<TurnEnvironmentSnapshot>,
    inherited_exec_policy: Option<Arc<ExecPolicyManager>>,
}
```

Source: [`thread_manager.rs#L235-L264`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/thread_manager.rs#L235-L264).

The manager’s `spawn_thread` passes shared managers and stores the resulting `CodexThread` in the same in-memory map. It passes the child config, the same `auth_manager`, `models_manager`, environment/MCP/plugin/extension services, thread store, inherited policy, and the cloned `AgentControl` to `Session::spawn`:

```rust
let (session, io) = Session::spawn(SessionSpawnArgs {
    config,
    auth_manager,
    models_manager: Arc::clone(&self.models_manager),
    environment_manager: Arc::clone(&self.environment_manager),
    // ...
    agent_control,
    inherited_environments,
    inherited_exec_policy,
    // ...
}).await?;
```

Source: [`thread_manager.rs#L1586-L1727`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/thread_manager.rs#L1586-L1727). `finalize_thread_spawn` inserts the new `Arc<CodexThread>` into `ThreadManagerState.threads` ([`thread_manager.rs#L1730-L1777`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/thread_manager.rs#L1730-L1777)).

### 2.3 Session loops and same-process execution

`Session::spawn` creates bounded submission and unbounded event channels, initializes the child `Session`, and starts its submission loop with `tokio::spawn`:

```rust
let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY);
let (tx_event, rx_event) = async_channel::unbounded();
// ...
let session_loop_handle = tokio::spawn(async move {
    submission_loop(session_for_loop, config, rx_sub).await;
});
```

Source: [`session/mod.rs#L552-L554`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L552-L554), [`#L762-L776`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L762-L776). This is an in-process asynchronous session, although normal child tools can of course launch external shell/MCP processes as part of their work.

### 2.4 Config, auth, model manager, and model client inheritance

The tool handler starts from the parent’s effective turn config rather than stale persisted settings. `build_agent_shared_config` clones the parent config, sets the current model/provider/reasoning/developer instructions, then applies live runtime fields:

```rust
let base_config = turn.config.clone();
let mut config = (*base_config).clone();
config.model = Some(turn.model_info.slug.clone());
config.model_provider = turn.provider.info().clone();
config.model_reasoning_effort = /* current turn effort */;
// ...
apply_spawn_agent_runtime_overrides(&mut config, turn)?;
```

Source: [`multi_agents_common.rs#L170-L215`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L170-L215). Runtime overrides explicitly copy approval policy, approvals reviewer, cwd, and permission profile ([`#L229-L254`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L229-L254)). A requested role is layered afterward; role loading preserves caller provider/service-tier choices unless the role explicitly sets them ([`role.rs#L31-L63`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/role.rs#L31-L63)).

For a thread-spawn child, environment selection is snapshotted from the parent and the parent execution-policy manager is reused only when `child_uses_parent_exec_policy` says it is compatible:

```rust
Some(parent_thread.session.services.turn_environments.snapshot().await)
// ...
if !child_uses_parent_exec_policy(&parent_config, child_config) { return None; }
Some(Arc::clone(&parent_thread.session.services.exec_policy))
```

Source: [`agent/control.rs#L611-L654`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control.rs#L611-L654).

Auth and model **managers** are shared, but the model client is session-scoped. `Session::new` builds `SessionServices` with the shared `Arc<AuthManager>` and `SharedModelsManager`, then constructs a new `ModelClient` with the child thread ID and child provider/source:

```rust
model_client: ModelClient::new(
    Some(Arc::clone(&auth_manager)),
    /* auth policy */,
    thread_id,
    session_configuration.provider.clone(),
    session_configuration.session_source.clone(),
    // ...
)
```

Source: [`session/session.rs#L1092-L1162`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/session.rs#L1092-L1162). Thus Atomic should share credential/client-factory infrastructure safely, while keeping per-child request/session identity, provider snapshot, prompt cache identity, and cancellation state separate.

For full-history forks, Codex flushes the parent rollout, loads its model context, supports `all`/last-N turns, and removes tool calls/reasoning/inter-agent messages and V2 usage hints from the fork. The fork path also replaces parent developer instructions with the child’s instructions. Source: [`agent/control/spawn.rs#L630-L758`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L630-L758) and [`#L779-L827`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L779-L827). This is context inheritance, not shared mutable conversation state.

## 3. Capacity bounds and exact mechanisms

### 3.1 V1 identity/spawn reservation

`AgentRegistry` is shared by all controls in one root tree. Its comments describe the V1 bound as total spawned sub-agents per user session. `reserve_spawn_slot(Some(max))` uses an atomic compare-and-exchange loop; failure returns `AgentLimitReached`. `SpawnReservation` is RAII: a failed spawn decrements the count and releases a reserved path; `commit` registers metadata and transfers ownership of the slot:

```rust
if let Some(max_threads) = max_threads {
    if !self.try_increment_spawned(max_threads) {
        return Err(CodexErr::new(AgentLimitReached { max_threads }));
    }
}
// ...
impl Drop for SpawnReservation {
    fn drop(&mut self) {
        if self.active {
            // release path
            self.state.total_count.fetch_sub(1, Ordering::AcqRel);
        }
    }
}
```

Source: [`registry.rs#L17-L27`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/registry.rs#L17-L27), [`#L80-L118`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/registry.rs#L80-L118), [`#L297-L343`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/registry.rs#L297-L343).

The root is registered by path but is not counted as a spawned child: release decrements `total_count` only when metadata is not the root path ([`registry.rs#L102-L118`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/registry.rs#L102-L118)). V1 uses `config.agent_max_threads.or(DEFAULT_AGENT_MAX_THREADS)`, and `DEFAULT_AGENT_MAX_THREADS` is `Some(6)` ([`config/mod.rs#L203-L211`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L203-L211), [`#L1546-L1559`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L1546-L1559)). The practical default is therefore six live V1 child identities, excluding root, until close/death releases them. The legacy `agents.max_threads` spelling is an alias for the canonical config key, as covered by [`config_tests.rs#L8666-L8684`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/config_tests.rs#L8666-L8684).

On a failed request to an already-created thread, `AgentControl` removes the dead runtime, forgets V2 residency, and releases its registry slot:

```rust
if matches!(err.details(), CodexErrorDetails::InternalAgentDied) {
    let _ = state.remove_thread(&agent_id).await;
    self.forget_v2_residency(agent_id);
    self.state.release_spawned_thread(agent_id);
}
```

Source: [`agent/control.rs#L259-L273`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control.rs#L259-L273).

### 3.2 Depth limit

Depth is stored in `SubAgentSource::ThreadSpawn.depth`; `next_thread_spawn_depth` saturating-adds one and `exceeds_thread_spawn_depth_limit` is simply `depth > max_depth` ([`registry.rs#L64-L78`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/registry.rs#L64-L78)). The config default is `DEFAULT_AGENT_MAX_DEPTH: i32 = 1`, and the loader defaults `agents.max_depth` to it ([`config/mod.rs#L266-L270`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L266-L270), [`#L3712-L3716`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L3712-L3716)).

The V1 tool gate applies this check before exposing collaboration tools; V2 always enables the collaboration surface:

```rust
MultiAgentVersion::V1 => !exceeds_thread_spawn_depth_limit(
    next_thread_spawn_depth(&turn_context.session_source),
    turn_context.config.agent_max_depth,
),
MultiAgentVersion::V2 => true,
```

Source: [`tools/spec_plan.rs#L474-L487`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/spec_plan.rs#L474-L487). V2 still records depth for paths/metadata, but this source snapshot has no V2 maximum-depth rejection.

### 3.3 V2 loaded-runtime residency

V2 converts the configured total-thread value into a child capacity by subtracting one:

```rust
MultiAgentVersion::V2 => Some(
    self.multi_agent_v2
        .max_concurrent_threads_per_session
        .saturating_sub(1),
),
```

Source: [`config/mod.rs#L1546-L1559`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L1546-L1559). The V2 default total is `4` ([`config/mod.rs#L207-L211`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L207-L211)). When the older `[agents] max_concurrent_threads_per_session` setting is used, config resolution adds one before storing it as the V2 total, preserving the old child-count meaning ([`config/mod.rs#L2652-L2665`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L2652-L2665)).

`V2Residency` tracks a deque of resident child IDs and pending reservations. A reservation succeeds if `residents + pending_slots < capacity`; otherwise it repeatedly tries the least-recently-used resident. A candidate is unloadable only when it is `Completed`, `Errored`, or `Interrupted`, has no active turn, and has no pending mailbox item. Codex materializes its rollout, shuts down the runtime, removes it from the manager, and then retries:

```rust
if state.residents.len().saturating_add(state.pending_slots) >= capacity {
    return false;
}
// ...
if !is_unloadable(candidate_thread.as_ref()) { self.touch(candidate_thread_id); continue; }
candidate_thread.ensure_rollout_materialized().await;
candidate_thread.shutdown_and_wait().await?;
let _ = manager.remove_thread(&candidate_thread_id).await;
```

Source: [`residency.rs#L80-L151`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/residency.rs#L80-L151), [`#L217-L232`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/residency.rs#L217-L232). Pending slots are RAII too: commit moves the new child to the MRU end; drop releases a not-yet-committed pending slot ([`residency.rs#L28-L45`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/residency.rs#L28-L45), [`#L194-L215`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/residency.rs#L194-L215)).

V2 deliberately bypasses the bounded V1 registry count when reserving a spawn:

```rust
let reservation_max_threads = if spawn_uses_v2_residency {
    None
} else {
    agent_max_threads
};
let mut reservation = self.state.reserve_spawn_slot(reservation_max_threads)?;
```

Source: [`agent/control/spawn.rs#L385-L403`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L385-L403). Thus V2 bounds **resident runtimes**, not the total number of persisted task identities created over the session.

When a cold V2 child is messaged, `ensure_v2_agent_loaded` reads its stored metadata/history, restores the role/runtime policy, reserves a residency slot (protecting the target from eviction), and calls `resume_thread_with_history_with_source` with the same `AgentControl`:

```rust
let residency_slot = self.reserve_v2_residency_slot(&state, &config, Some(thread_id)).await?;
// ...
state.resume_thread_with_history_with_source(ResumeThreadWithHistoryOptions {
    config,
    initial_history,
    agent_control: self.clone(),
    // ...
}).await?;
```

Source: [`agent/control/spawn.rs#L250-L363`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L250-L363).

### 3.4 V2 active execution limit

The same derived child capacity initializes one shared `AgentExecutionLimiter` per root control tree. It has an atomic active count and a `OnceLock` maximum. It limits only V2 non-root subagent turns; root and V1 turns return no guard:

```rust
fn is_execution_limited(version: MultiAgentVersion, source: &SessionSource) -> bool {
    version == MultiAgentVersion::V2
        && matches!(source, SessionSource::SubAgent(_))
}

fn guard(self: Arc<Self>) -> AgentExecutionGuard {
    self.active.fetch_add(1, Ordering::AcqRel);
    AgentExecutionGuard { limiter: self }
}
```

Source: [`agent/control/execution.rs#L14-L27`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/execution.rs#L14-L27), [`#L60-L118`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/execution.rs#L60-L118). Capacity is checked when a new turn-starting operation is submitted (`UserInput` or trigger-turn inter-agent communication); an already-active turn in that same thread is allowed to receive input. [`execution.rs#L31-L58`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/execution.rs#L31-L58), [`#L107-L110`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/execution.rs#L107-L110).

The guard is held by `RunningTask`, so dropping a turn releases the active execution slot:

```rust
let agent_execution_guard = self.services.agent_control.execution_guard(
    turn_context.multi_agent_version,
    &turn_context.session_source,
);
// ...
_agent_execution_guard: agent_execution_guard,
```

Source: [`tasks/mod.rs#L337-L415`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tasks/mod.rs#L337-L415). The limiter is initialized with `effective_agent_max_threads(V2)` in `Session::new` ([`session/session.rs#L577-L590`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/session.rs#L577-L590)).

This is a capacity check plus an RAII guard, not a queueing semaphore: if there is no capacity the operation fails with `AgentLimitReached`; callers can retry after a child completes/unloads.

## 4. Status, progress, and user surfacing

### 4.1 Status model

The protocol status enum is explicit and serializable:

```rust
PendingInit,
Running,
Interrupted,
Completed(Option<String>),
Errored(String),
Shutdown,
NotFound,
```

Source: [`protocol.rs#L1732-L1752`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/protocol/src/protocol.rs#L1732-L1752). Status is reduced from events: `TurnStarted` -> `Running`, `TurnComplete` -> `Completed(last_agent_message)`, interrupted/budget-limited abort -> `Interrupted`, errors -> `Errored`, shutdown complete -> `Shutdown`. `is_final` treats everything except `PendingInit`, `Running`, and `Interrupted` as final ([`agent/status.rs#L4-L28`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/status.rs#L4-L28)).

Each session starts a `watch` channel at `PendingInit`, and every delivered protocol event updates the latest status:

```rust
let (agent_status_tx, agent_status_rx) = watch::channel(AgentStatus::PendingInit);
// ...
if let Some(status) = agent_status_from_event(&event.msg) {
    self.agent_status.send_replace(status);
}
```

Source: [`session/mod.rs#L711-L774`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L711-L774), [`#L2062-L2069`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L2062-L2069). `CodexThread::agent_status` reads it and `subscribe_status` clones the receiver ([`codex_thread.rs#L476-L494`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/codex_thread.rs#L476-L494)).

### 4.2 Structured progress/UI events

V1 handlers emit `TurnItem::CollabAgentToolCall` started/completed items containing sender ID, receiver IDs, receiver metadata, prompt/model metadata, and `agents_states`. For example, V1 `send_input` emits in-progress before submission and a completed item with the current receiver status afterward ([`send_input.rs#L69-L115`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs#L69-L115)). V1 `wait_agent` emits the same structured item with final statuses or timeout ([`wait.rs#L99-L115`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L99-L115), [`#L203-L221`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/wait.rs#L203-L221)).

V2 additionally emits `SubAgentActivityItem {agent_thread_id, agent_path, kind}` for `Started`, `Interacted`, and `Interrupted`. The helper emits both item-started and item-completed lifecycle events:

```rust
let item = TurnItem::SubAgentActivity(item);
session.emit_turn_item_started(turn, &item).await;
session.emit_turn_item_completed(turn, item).await;
```

Source: [`multi_agents_v2.rs#L47-L55`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L47-L55), with spawn’s `Started` event at [`multi_agents_v2/spawn.rs#L146-L156`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L146-L156) and interrupt’s `Interrupted` event at [`interrupt_agent.rs#L81-L95`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs#L81-L95).

### 4.3 Parent completion notifications

Legacy V1 starts a detached watcher for each `ThreadSpawn` child. It waits on the status watch channel until final, then either sends a V2-style inter-agent communication (when the child has a V2 path) or injects a user-role notification into the parent without creating a turn:

```rust
while !is_final(&status) {
    status_rx.changed().await?;
    status = status_rx.borrow().clone();
}
// V1 fallback:
parent_thread.inject_user_message_without_turn(message).await;
```

Source: [`agent/control.rs#L455-L546`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control.rs#L455-L546). The watcher is started for non-V2 children in the spawn path ([`agent/control/spawn.rs#L549-L561`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/spawn.rs#L549-L561)).

For V2, `Session::send_event` intercepts child `TurnComplete`/`TurnAborted`, reduces the terminal status, and sends a non-triggering `InterAgentCommunication` of kind `Result` to the direct parent. It does not forward every child token/event into the parent model:

```rust
if turn_context.multi_agent_version != MultiAgentVersion::V2 { return; }
if !matches!(msg, EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)) { return; }
// ...
self.services.agent_control.send_inter_agent_communication(
    parent_thread_id, communication, context, /*parent_turn_id*/ None,
).await;
```

Source: [`session/mod.rs#L1861-L1907`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L1861-L1907), [`#L1910-L1975`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L1910-L1975). This gives Atomic a good default: stream structured lifecycle/progress separately, but return only a terminal envelope to the parent’s context; enforce a success-text bound separately if Atomic needs one.

## 5. Cancellation, interruption, and shutdown

### 5.1 Interrupting a child turn

At the control plane, `interrupt_agent` submits `Op::Interrupt` to the target. V1’s `send_input(interrupt=true)` uses the same method before sending the new input ([`multi_agents/send_input.rs#L59-L89`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs#L59-L89)). V2 exposes it as a separate tool, rejects root/self targets, captures the previous status, and explicitly leaves the child usable ([`multi_agents_v2/interrupt_agent.rs#L39-L66`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs#L39-L66)).

The session loop dispatches `Op::Interrupt` to `Session::interrupt_task`:

```rust
Op::Interrupt => {
    interrupt(&sess).await;
    false
}
```

Source: [`session/handlers.rs#L703-L718`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/handlers.rs#L703-L718). `interrupt_task` aborts the active turn and cancels MCP startup when there was no active turn ([`session/mod.rs#L4024-L4031`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L4024-L4031)).

`abort_all_tasks` takes the active task; `handle_task_abort` cancels its token, waits only `GRACEFULL_INTERRUPTION_TIMEOUT_MS = 100`, then forcibly aborts the task and emits a terminal `TurnAborted(Interrupted)` event:

```rust
const GRACEFULL_INTERRUPTION_TIMEOUT_MS: u64 = 100;
// ...
task.cancellation_token.cancel();
select! {
    _ = task.done.notified() => {},
    _ = sleep(Duration::from_millis(GRACEFULL_INTERRUPTION_TIMEOUT_MS)) => {},
}
task.handle.abort();
```

Source: [`tasks/mod.rs#L64-L67`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tasks/mod.rs#L64-L67) and [`#L850-L920`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tasks/mod.rs#L850-L920).

### 5.2 Closing/shutting down a child

V1 `close_agent` first marks its persisted graph edge `Closed`, then calls `shutdown_agent_tree`. The latter gathers live descendants and shuts down the target and each descendant, tolerating already-missing/dead children:

```rust
let descendant_ids = self.live_thread_spawn_descendants(agent_id).await?;
let result = self.shutdown_live_agent(agent_id).await;
for descendant_id in descendant_ids {
    self.shutdown_live_agent(descendant_id).await?;
}
```

Source: [`agent/control/legacy.rs#L32-L101`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/legacy.rs#L32-L101). `shutdown_live_agent` flushes the rollout, submits `Op::Shutdown`, waits for termination, removes the thread, forgets V2 residency, and releases the registry identity ([`legacy.rs#L4-L29`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/legacy.rs#L4-L29)).

The low-level `SessionIo::shutdown_and_wait` submits `Op::Shutdown` and awaits the shared session-loop termination future ([`session/mod.rs#L836-L845`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/mod.rs#L836-L845)). The shutdown handler aborts tasks, terminates unified exec processes, shuts down code mode/MCP/guardian resources, flushes persistence, and emits `ShutdownComplete` ([`session/handlers.rs#L589-L667`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/handlers.rs#L589-L667)).

V2 does not expose close; an interrupted/terminal child remains a persisted identity and can be lazily loaded for a message/follow-up while its runtime is eligible for residency eviction.

## 6. Idle and timeout handling

There are two separate concepts:

1. **Wait-tool timeout:** V1 waits on status changes; V2 waits on mailbox/steering activity. Defaults are 30,000 ms, minimum 10,000 ms, maximum 3,600,000 ms in the default configuration:

   ```rust
   DEFAULT_MULTI_AGENT_V2_MIN_WAIT_TIMEOUT_MS: i64 = 10_000;
   DEFAULT_MULTI_AGENT_V2_MAX_WAIT_TIMEOUT_MS: i64 = 3600 * 1000;
   DEFAULT_MULTI_AGENT_V2_DEFAULT_WAIT_TIMEOUT_MS: i64 = 30_000;
   ```

   Source: [`config/mod.rs#L207-L211`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L207-L211). V1 constants use the same minimum/maximum and a 30-second default ([`multi_agents_common.rs#L29-L33`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L29-L33)); V2 validates a requested value against the configured min/max ([`multi_agents_v2/wait.rs#L49-L66`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L49-L66)). A timeout returns control to the parent; it does not interrupt or destroy the child.
2. **Runtime idleness/residency:** V2 has no wall-clock idle timer in this path. It unloads only when another spawn/load needs a slot and the LRU candidate is terminal, has no active turn, and has no pending mailbox items ([`residency.rs#L117-L151`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/residency.rs#L117-L151), [`#L226-L232`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/agent/control/residency.rs#L226-L232)). V1 has no automatic idle reclamation: its tool description says completed agents continue counting until explicitly closed ([`multi_agents_spec.rs#L318-L336`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L318-L336)).

Codex does have an idle lifecycle callback for extensions, but it is not a timer or child eviction mechanism. It runs only when there is no active turn and no trigger-turn mailbox work:

```rust
if self.active_turn.lock().await.is_some()
    || self.input_queue.has_trigger_turn_mailbox_items().await { return; }
// invoke extension on_thread_idle
```

Source: [`tasks/lifecycle.rs#L42-L56`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tasks/lifecycle.rs#L42-L56).

## 7. Tool narrowing and child authority

### 7.1 Collaboration exposure

The tool planner gates collaboration by multi-agent version and depth, then chooses exposure:

- V2 defaults to `ToolExposure::DirectModelOnly` when `multi_agent_v2.non_code_mode_only=true`; this keeps collaboration calls out of code-mode/`functions.exec` tool namespaces.
- V2 registers spawn, send, follow-up, optional wait, interrupt, and list tools; the namespace is configurable and defaults to `collaboration`.
- V1 registers spawn, send-input, resume, wait, and close; when tool search is enabled, V1 can be deferred instead of directly exposed.

Source: [`tools/spec_plan.rs#L981-L1067`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/spec_plan.rs#L981-L1067). The default V2 config sets namespace `collaboration`, hides spawn metadata, enables wait, and sets `non_code_mode_only=true` ([`config/mod.rs#L1241-L1282`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L1241-L1282)). The usage hint explicitly says collaboration tools are absent from `functions.exec` and must be called directly, while agents share the same directory/current working directory ([`config/mod.rs#L251-L263`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/config/mod.rs#L251-L263)).

### 7.2 Is the child’s ordinary tool set narrowed?

This source snapshot does **not** implement a general per-child allowlist of ordinary tools. The V2 model-facing contract instead says the spawned agent has the same tools as the parent ([`multi_agents_spec.rs#L757-L768`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L757-L768)). A role can layer a different config/model/instructions, and a fork scrubs inherited conversation tool-call artifacts, but those are not an ordinary-tool capability filter. The practical narrowing is:

- collaboration APIs are explicit, direct-model-only by default;
- child task prompts/roles/fork mode are controlled through a small schema;
- runtime approval, permission profile, cwd, environment, and exec-policy state are inherited intentionally rather than silently reset;
- V2 child result delivery is mailbox-based; the source explicitly bounds error text, but does not explicitly truncate a successful final message.
- full-history fork context is sanitized before the child samples.

For an Atomic runner that wants stronger isolation than Codex currently exposes, add a child-specific tool allowlist at the tool-plan boundary; do not infer that Codex’s `non_code_mode_only` setting is such an allowlist—it only controls where collaboration tools can be invoked.

## Conflicts, gaps, and version boundaries

- **V1 versus V2 is not cosmetic.** V1’s `wait_agent` is status-centric and returns final content; V2’s `wait_agent` is mailbox-centric and returns only an activity summary. V1 has explicit close/resume and a hard child identity count; V2 has interrupt/list and lazy residency but no close tool.
- **“Four concurrent threads” means three child slots in this implementation.** `MultiAgentV2Config.max_concurrent_threads_per_session` defaults to 4, but `effective_agent_max_threads(V2)` subtracts one. Usage hints describe the four slots as including the root. A deployment should expose the same terminology consistently to avoid an off-by-one surprise.
- **V2 identity count is not bounded by `max_concurrent_threads_per_session`.** V2 passes `None` to `AgentRegistry::reserve_spawn_slot`; residency and active execution are bounded, persisted task identities are not. If Atomic needs a lifetime/total-spawn cap, add one separately.
- **No child wall-clock execution timeout was found.** Wait deadlines only bound the parent’s wait call; V2 residency eviction is demand-driven and requires terminal idle state. The 100-ms value is only the graceful-interrupt grace period.
- **No general child ordinary-tool allowlist was found.** Codex’s own prompt says children have the same tools. The collaboration surface is narrowed by exposure and schema, not by per-child tool permissions.

## Transferable design ideas

1. **Child session in the same runtime:** create a child session/thread object with its own event/input channels, active turn, cancellation token, status watch, and model client, but inject shared auth/model-manager/store dependencies and a root-tree control handle.
2. **One root-scoped control plane:** share registry, canonical path mapping, status subscriptions, communication routing, and quotas through a cloneable control object; hold only a weak manager reference to avoid ownership cycles.
3. **RAII spawn reservation:** reserve identity/path/nickname before startup; commit only after the child runtime is registered; automatically release count/path on every failed startup path.
4. **Separate bounds:** distinguish total identities, resident loaded runtimes, active executing turns, and nesting depth. Codex’s V2 shows why resident and active limits can be the same derived child capacity while identity persistence remains independent.
5. **Demand-driven residency:** when capacity is full, evict only an LRU child that is terminal, not executing, and has no queued work; persist its rollout first; reload it on demand under a protected target slot.
6. **Bounded parent result:** return an immediate child identity from spawn, a submission acknowledgement from messaging, and a separate terminal result to the parent. Codex bounds the error branch to a 1,000-token envelope, but passes successful final text through; Atomic should enforce a bound for both branches if context safety requires it.
7. **Two status channels:** expose structured lifecycle/progress events to the UI, but send only terminal summaries into parent model context. A status watch makes `wait` inexpensive and avoids streaming every child token into the parent.
8. **Explicit cancellation semantics:** interruption should cancel cooperatively, wait a short grace interval, force-abort if necessary, emit a terminal interrupted status, and leave the child reusable unless the caller explicitly closes it.
9. **Narrow collaboration entry points:** expose spawn/send/wait/interrupt/list as direct model tools, keep them out of shell/code-mode tool namespaces by default, and make child ordinary-tool narrowing an explicit policy rather than an accidental consequence of process reuse.
10. **Version the protocol:** if Atomic changes from status-centric waits to mailbox-centric waits, keep the distinction in the tool schema and result type. Do not overload one `wait` contract to mean both “final answer” and “some activity happened.”
