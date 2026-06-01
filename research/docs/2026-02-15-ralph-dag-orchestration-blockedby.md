---
date: 2026-02-15 00:00:00 UTC
researcher: Claude Opus 4.6
git_commit: d5c8a4e3ee33dbfae60da8e6df15af549403fb9f
branch: main
repository: atomic
topic: "Ralph DAG-Based Orchestration with blockedBy Dependency Enforcement"
tags:
    [
        research,
        codebase,
        ralph,
        dag,
        orchestration,
        blockedBy,
        parallel-workers,
        topological-sort,
        task-management,
        workflow,
    ]
status: complete
last_updated: 2026-02-15
last_updated_by: Claude Opus 4.6
---

# Research: Ralph DAG-Based Orchestration with blockedBy Dependency Enforcement

## Research Question

How to modify the current ralph implementation so that `blockedBy` is properly enforced during task execution (not just UI display), worker sub-agents can mark tasks as complete with immediate UI reflection, and multiple workers are dispatched in parallel using a DAG-based topological traversal with round-robin execution.

## Summary

The `blockedBy` dependency system exists across the entire data model (TodoWrite schema, normalization pipeline, topological sort, UI rendering) but is **never enforced during task execution**. The worker loop in `workflow-commands.ts` is sequential: it spawns one worker at a time via `context.spawnSubagent()`, which blocks on a single `streamCompletionResolverRef` slot in `chat.tsx`. Workers select tasks by "highest priority" heuristic without checking `blockedBy`. The infrastructure for parallel sub-agent execution exists (`SubagentGraphBridge.spawnParallel()` using `Promise.allSettled()`) but is unused by ralph. The UI already updates reactively via `fs.watch` on `tasks.json`, so workers writing directly to `tasks.json` would immediately update the persistent `TaskListPanel`. Key gaps to address: (1) dependency-aware task selection, (2) parallel worker dispatch replacing the serial loop, (3) dynamic DAG mutation when workers insert bug-fix tasks, (4) file locking for concurrent `tasks.json` writes, and (5) deadlock detection.

## Detailed Findings

### 1. Current Worker Loop: Sequential and Dependency-Unaware

The ralph worker loop exists in two places (fresh start and resume), both following the same pattern:

**File**: [`src/ui/commands/workflow-commands.ts:796-807`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/commands/workflow-commands.ts#L796-L807)

```typescript
// Worker loop: spawn worker sub-agent per iteration until all tasks are done
const maxIterations = tasks.length * 2; // safety limit
for (let i = 0; i < maxIterations; i++) {
    // Read current task state from disk
    const currentTasks = await readTasksFromDisk(sessionDir);
    const pending = currentTasks.filter((t) => t.status !== "completed");
    if (pending.length === 0) break;

    const message = buildTaskListPreamble(currentTasks);
    const result = await context.spawnSubagent({ name: "worker", message });
    if (!result.success) break;
}
```

**Resume path** (identical pattern): [`workflow-commands.ts:748-757`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/commands/workflow-commands.ts#L748-L757)

**Key problems**:

1. **No `blockedBy` check**: The loop filters only on `status !== "completed"` (line 801). Tasks with unsatisfied dependencies are included in `pending` and presented to the worker.
2. **Serial execution**: `context.spawnSubagent()` blocks until the worker stream completes, so only one worker runs at a time.
3. **Worker self-selection**: The full task list (including blocked tasks) is sent to the worker via `buildTaskListPreamble()`. The worker picks "highest priority" without dependency checking.

### 2. Why `spawnSubagent` Is Serial (Single-Slot Blocking)

**File**: [`src/ui/chat.tsx:3359-3374`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/chat.tsx#L3359-L3374)

```typescript
spawnSubagent: async (options) => {
  const agentName = options.name ?? options.model ?? "general-purpose";
  const task = options.message;
  const instruction = `Use the ${agentName} sub-agent to handle this task: ${task}`;
  const result = await new Promise<StreamResult>((resolve) => {
    streamCompletionResolverRef.current = resolve;
    context.sendSilentMessage(instruction);
  });
  return { success: !result.wasInterrupted, output: result.content };
},
```

The `streamCompletionResolverRef` (declared at [`chat.tsx:1897`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/chat.tsx#L1897)) is a `useRef` holding a single resolver function. Each call to `spawnSubagent` overwrites it. This means calling `spawnSubagent` a second time before the first resolves would **silently drop** the first stream's result. This is the fundamental architectural barrier to parallel worker dispatch via the current `CommandContext` interface.

### 3. The blockedBy Data Model: Complete but Unenforced

The `blockedBy` field flows through the entire system but is only used for **display purposes**:

| Layer                 | File                                                                                                                                                      | Usage                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Schema**            | [`src/sdk/tools/todo-write.ts:40-44`](https://github.com/bastani/atomic/blob/d5c8a4e/src/sdk/tools/todo-write.ts#L40-L44)                                 | `blockedBy` field in TodoWrite JSON schema                   |
| **Type**              | [`src/sdk/tools/todo-write.ts:58`](https://github.com/bastani/atomic/blob/d5c8a4e/src/sdk/tools/todo-write.ts#L58)                                        | `blockedBy?: string[]` on `TodoItem` interface               |
| **Normalization**     | [`src/ui/utils/task-status.ts:69-80`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/utils/task-status.ts#L69-L80)                                 | `normalizeBlockedBy()` filters/stringifies array             |
| **Prompt generation** | [`src/graph/nodes/ralph.ts:50`](https://github.com/bastani/atomic/blob/d5c8a4e/src/graph/nodes/ralph.ts#L50)                                              | LLM instructed to generate `blockedBy` arrays                |
| **Topological sort**  | [`src/ui/components/task-order.ts:19-122`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/components/task-order.ts#L19-L122)                       | `sortTasksTopologically()` using Kahn's algorithm            |
| **UI rendering**      | [`src/ui/components/task-list-indicator.tsx:117-119`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/components/task-list-indicator.tsx#L117-L119) | Renders `> blocked by #1, #2` annotations                    |
| **Worker agent**      | [`.claude/agents/worker.md:84-96`](https://github.com/bastani/atomic/blob/d5c8a4e/.claude/agents/worker.md#L84-L96)                                       | Bug handling instructs writing `blockedBy` on affected tasks |
| **State snapshots**   | [`src/ui/utils/ralph-task-state.ts:34-38`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/utils/ralph-task-state.ts#L34-L38)                       | `snapshotTaskItems()` preserves `blockedBy`                  |
| **Worker loop**       | [`workflow-commands.ts:801`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/commands/workflow-commands.ts#L801)                                    | **NOT USED** - only checks `status !== "completed"`          |

The topological sort in `task-order.ts` implements Kahn's algorithm (BFS) with cycle detection, but it is only consumed by `TaskListPanel` for **display ordering**, not by the worker loop for **execution scheduling**.

### 4. Existing Parallel Execution Infrastructure

**File**: [`src/graph/subagent-bridge.ts:184-208`](https://github.com/bastani/atomic/blob/d5c8a4e/src/graph/subagent-bridge.ts#L184-L208)

```typescript
async spawnParallel(
  agents: SubagentSpawnOptions[],
): Promise<SubagentResult[]> {
  const results = await Promise.allSettled(
    agents.map((agent) => this.spawn(agent))
  );
  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    // ... error handling for rejected promises
  });
}
```

This uses `Promise.allSettled()` so one agent's failure doesn't cancel others. Each sub-agent in `spawnParallel` gets its own independent session via `SubagentGraphBridge.spawn()`. This infrastructure **already supports true parallel sub-agent execution** and could replace the serial `context.spawnSubagent()` loop.

Additional parallel primitives exist in [`src/graph/nodes.ts`](https://github.com/bastani/atomic/blob/d5c8a4e/src/graph/nodes.ts):

- `parallelNode()` (line 988): Graph node with parallel branches, strategy, and merge function
- `parallelSubagentNode()` (line 1802): Spawns multiple sub-agents concurrently within graph execution

### 5. Task List UI: Already Reactive via File Watcher

The UI update pipeline is already file-driven and would work with parallel workers:

1. **Worker writes `tasks.json`** via `saveTasksToActiveSession()` ([`workflow-commands.ts:141-163`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/commands/workflow-commands.ts#L141-L163)) which uses `Bun.write()`
2. **File watcher detects change** via `watchTasksJson()` ([`workflow-commands.ts:818-837`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/commands/workflow-commands.ts#L818-L837)) using Node's `fs.watch` on the session directory
3. **TaskListPanel re-renders** ([`task-list-panel.tsx:48-64`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/components/task-list-panel.tsx#L48-L64)) with topologically sorted tasks

Three write paths exist for `tasks.json`:

- **Orchestrator** writes after task decomposition ([`workflow-commands.ts:789`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/commands/workflow-commands.ts#L789))
- **TodoWrite interception** in chat.tsx persists when ralph is active ([`chat.tsx:2145-2146`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/chat.tsx#L2145-L2146) and [`chat.tsx:2254-2255`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/chat.tsx#L2254-L2255))
- **Worker agent** writes directly to `tasks.json` at `~/.atomic/workflows/{session_id}/tasks.json` (per worker.md instructions)

Since the `TaskListPanel` uses `watchTasksJson()` to react to file changes, workers that write directly to `tasks.json` already trigger immediate UI updates. No delay until the main agent is involved.

### 6. Session and File Concurrency Concerns

**File**: [`src/workflows/session.ts:32-49`](https://github.com/bastani/atomic/blob/d5c8a4e/src/workflows/session.ts#L32-L49)

```
~/.atomic/workflows/sessions/{sessionId}/
  ├── tasks.json          ← shared state file
  ├── progress.txt        ← append-only log
  ├── session.json        ← session metadata
  └── subagent-outputs/   ← individual agent output files
```

**No file locking mechanism exists.** The current `saveTasksToActiveSession()` uses `Bun.write()` which is a full file overwrite. With parallel workers, two workers could:

1. Both read `tasks.json` at the same time
2. Each modify their respective task status
3. The second write overwrites the first, losing its status update

This is a classic read-modify-write race condition. A solution requires either:

- **Centralized coordinator** that serializes all `tasks.json` mutations (recommended)
- **File locking** via `flock` or advisory locks
- **Atomic compare-and-swap** using versioned writes

### 7. Worker Agent: Missing Dependency Awareness

**File**: [`.claude/agents/worker.md`](https://github.com/bastani/atomic/blob/d5c8a4e/.claude/agents/worker.md)

The worker agent prompt instructs (line 9):

> "Only work on the SINGLE highest priority task that is not yet marked as complete."

It does **not** instruct the worker to:

- Check `blockedBy` before selecting a task
- Skip tasks whose `blockedBy` contains incomplete task IDs
- Verify dependency completion before starting work

The worker **does** understand `blockedBy` for bug handling (lines 84-96): when a bug is found, it adds the bug-fix task and updates downstream `blockedBy` arrays. But this is write-only — the worker never reads `blockedBy` for task selection.

Additionally, the worker references the wrong path format: `~/.atomic/workflows/{session_id}` (line 13) vs the actual path `~/.atomic/workflows/sessions/{session_id}` ([`session.ts:32-35`](https://github.com/bastani/atomic/blob/d5c8a4e/src/workflows/session.ts#L32-L35)).

### 8. Topological Sort Implementation (Reusable for Execution Scheduling)

**File**: [`src/ui/components/task-order.ts:19-122`](https://github.com/bastani/atomic/blob/d5c8a4e/src/ui/components/task-order.ts#L19-L122)

`sortTasksTopologically()` implements Kahn's algorithm:

1. Normalize task IDs (strip leading `#`, handle duplicates)
2. Build adjacency list from `blockedBy` → dependents edges
3. Compute in-degree for each task
4. BFS from zero-in-degree tasks (no dependencies)
5. Append tasks with unresolvable metadata (missing IDs, unknown blockers, cycles) to tail

This function could be adapted for **execution scheduling** (not just display ordering) by:

- Extracting the "ready set" (zero in-degree, status = pending) as tasks to dispatch
- After a task completes, decrementing in-degree of dependents and checking for newly-ready tasks
- Detecting deadlock when no tasks are ready but uncompleted tasks remain

### 9. Dynamic DAG Mutation (Bug-Fix Insertion)

Per [`specs/2026-02-09-ralph-loop-enhancements.md`](https://github.com/bastani/atomic/blob/d5c8a4e/specs/2026-02-09-ralph-loop-enhancements.md) (Section 5.1.4), workers can dynamically mutate the task DAG by:

1. Inserting a new bug-fix task (e.g., `#0`) at the top
2. Adding `#0` to the `blockedBy` array of affected downstream tasks
3. Writing the modified `tasks.json` to disk

A DAG orchestrator must handle this by:

- Re-reading `tasks.json` after each worker completes (or on file change)
- Rebuilding the dependency graph to detect new edges
- Pausing dispatch of tasks that now have new blockers

## Architecture Gaps Summary

| Gap                        | Current State                                                           | Required Change                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Dependency enforcement** | `blockedBy` exists but worker loop only checks `status !== "completed"` | Orchestrator must compute "ready set" (pending + all blockers completed) before dispatch                        |
| **Parallel dispatch**      | Serial `for` loop with single `streamCompletionResolverRef`             | Use `SubagentGraphBridge.spawnParallel()` or equivalent concurrent dispatch                                     |
| **Worker task selection**  | Worker picks "highest priority" without checking blockers               | Either (a) orchestrator assigns specific task to each worker, or (b) worker prompt updated to check `blockedBy` |
| **File concurrency**       | No locking; `Bun.write()` full overwrite                                | Centralized coordinator serializes `tasks.json` mutations                                                       |
| **Deadlock detection**     | Not implemented                                                         | Detect when remaining tasks all have unsatisfied `blockedBy` and no worker is running                           |
| **Worker path**            | Worker.md references `~/.atomic/workflows/{session_id}`                 | Should be `~/.atomic/workflows/sessions/{session_id}`                                                           |

## Key Code References

| Component                           | File:Line                                          | Description                                              |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Worker loop (fresh)                 | `src/ui/commands/workflow-commands.ts:796-807`     | Serial `for` loop spawning one worker at a time          |
| Worker loop (resume)                | `src/ui/commands/workflow-commands.ts:748-757`     | Same pattern for resume path                             |
| `spawnSubagent` impl                | `src/ui/chat.tsx:3359-3374`                        | Single-slot `streamCompletionResolverRef` blocking       |
| `streamCompletionResolverRef`       | `src/ui/chat.tsx:1897`                             | `useRef` holding single resolver — prevents parallelism  |
| `saveTasksToActiveSession`          | `src/ui/commands/workflow-commands.ts:141-163`     | Writes tasks to `tasks.json` via `Bun.write()`           |
| `readTasksFromDisk`                 | `src/ui/commands/workflow-commands.ts:166-176`     | Reads/normalizes tasks from disk                         |
| `watchTasksJson`                    | `src/ui/commands/workflow-commands.ts:818-837`     | File watcher for live UI updates                         |
| `buildSpecToTasksPrompt`            | `src/graph/nodes/ralph.ts:19-58`                   | Prompt instructing LLM to generate `blockedBy`           |
| `buildTaskListPreamble`             | `src/graph/nodes/ralph.ts:66-81`                   | Serializes full task list for worker context             |
| `sortTasksTopologically`            | `src/ui/components/task-order.ts:19-122`           | Kahn's algorithm (display only, reusable for scheduling) |
| `normalizeBlockedBy`                | `src/ui/utils/task-status.ts:69-80`                | Normalizes `blockedBy` arrays                            |
| `TaskListPanel`                     | `src/ui/components/task-list-panel.tsx:39-94`      | Persistent file-driven task list UI                      |
| `TaskListIndicator`                 | `src/ui/components/task-list-indicator.tsx:85-134` | Renders task items with blocked-by annotations           |
| `SubagentGraphBridge.spawnParallel` | `src/graph/subagent-bridge.ts:184-208`             | Parallel sub-agent execution via `Promise.allSettled()`  |
| `parallelSubagentNode`              | `src/graph/nodes.ts:1802-1838`                     | Graph node for concurrent sub-agent spawning             |
| Worker agent definition             | `.claude/agents/worker.md`                         | Worker prompt — no `blockedBy` check for task selection  |
| TodoWrite tool                      | `src/sdk/tools/todo-write.ts:53-59`                | TodoItem interface with `blockedBy` field                |
| TodoWrite interception              | `src/ui/chat.tsx:2145-2146, 2254-2255`             | Persists to `tasks.json` when ralph is active            |
| Ralph session state                 | `src/ui/chat.tsx:1904-1907`                        | `ralphSessionDir`/`ralphSessionId` React state           |
| Session directory                   | `src/workflows/session.ts:32-49`                   | `~/.atomic/workflows/sessions/{sessionId}/`              |
| Ralph task state helpers            | `src/ui/utils/ralph-task-state.ts:17-25`           | `normalizeInterruptedTasks()` preserves `blockedBy`      |

## Related Research Documents

- [`research/docs/2026-02-09-163-ralph-loop-enhancements.md`](https://github.com/bastani/atomic/blob/d5c8a4e/research/docs/2026-02-09-163-ralph-loop-enhancements.md) - Original ralph loop enhancement research (Issue #163)
- [`research/docs/2026-02-13-ralph-task-list-ui.md`](https://github.com/bastani/atomic/blob/d5c8a4e/research/docs/2026-02-13-ralph-task-list-ui.md) - Persistent task list UI implementation research
- [`specs/2026-02-09-ralph-loop-enhancements.md`](https://github.com/bastani/atomic/blob/d5c8a4e/specs/2026-02-09-ralph-loop-enhancements.md) - Detailed design spec including dependency resolution (Section 5.1.3) and dynamic DAG mutations (Section 5.1.4)
- [`specs/2026-02-14-ralph-task-list-ui.md`](https://github.com/bastani/atomic/blob/d5c8a4e/specs/2026-02-14-ralph-task-list-ui.md) - Task list UI spec with file-driven reactive pattern
