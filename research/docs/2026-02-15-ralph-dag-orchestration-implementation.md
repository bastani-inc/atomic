---
date: 2026-02-15 10:22:02 UTC
researcher: GitHub Copilot
git_commit: 991f96c07c87a448301979f4b3e6174c68fa7973
branch: lavaman131/hotfix/sub-agents-ui
repository: atomic
topic: "Ralph DAG-Based Orchestration: Implementation Research for blockedBy Enforcement and Parallel Worker Dispatch"
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
        concurrency,
        worker-agent,
    ]
status: complete
last_updated: 2026-02-15
last_updated_by: GitHub Copilot
---

# Research: Ralph DAG-Based Orchestration — Implementation Path for blockedBy Enforcement and Parallel Worker Dispatch

## Research Question

How to modify the current ralph implementation so that `blockedBy` is properly enforced during task execution (not just UI display), worker sub-agents can mark tasks as complete with immediate UI reflection (no delay waiting for the main agent), and multiple workers are dispatched in parallel using a DAG-based topological traversal with round-robin execution. Specifically: how to replace the serial worker loop with a DAG orchestrator that computes a "ready set" and dispatches workers concurrently, how to handle concurrent `tasks.json` writes, dynamic DAG mutations, and deadlock detection.

## Summary

The `blockedBy` dependency field exists across the full data model (TodoWrite schema, normalization pipeline, topological sort in `task-order.ts`, UI rendering in `TaskListIndicator`) but is **never enforced during task execution**. The worker loop in `workflow-commands.ts` is sequential: it spawns one worker at a time via `context.spawnSubagent()`, which blocks on a single `streamCompletionResolverRef` slot in `chat.tsx`. Workers select tasks by "highest priority" heuristic without checking `blockedBy`. The infrastructure for parallel sub-agent execution exists (`SubagentGraphBridge.spawnParallel()` using `Promise.allSettled()`) but is unused by ralph. The UI already updates reactively via `fs.watch` on `tasks.json`, so workers writing to `tasks.json` (via TodoWrite interception) trigger immediate UI updates. This document details every component involved and what changes would be required for DAG-based orchestration.

---

## Detailed Findings

### 1. Current Worker Loop: Sequential and Dependency-Unaware

The ralph worker loop exists in two places (fresh start and resume), both following the same serial pattern.

#### 1.1 Fresh-Start Worker Loop

**File**: [`src/ui/commands/workflow-commands.ts:796-809`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L796-L809)

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

**Key observations**:

1. **No `blockedBy` check**: Only filters by `status !== "completed"` (line 801). Tasks with unsatisfied dependencies are included in `pending`.
2. **Serial execution**: `context.spawnSubagent()` blocks until the worker stream completes, so only one worker runs at a time.
3. **Worker self-selection**: The full task list (including blocked tasks) is sent to the worker via `buildTaskListPreamble()`. The worker picks "highest priority" without dependency checking.
4. **Safety limit**: `maxIterations = tasks.length * 2` prevents infinite loops.

#### 1.2 Resume Worker Loop

**File**: [`src/ui/commands/workflow-commands.ts:748-757`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L748-L757)

Identical structure with one difference: optional `additionalPrompt` appended if user provided extra instructions with `--resume`.

#### 1.3 Full Ralph Command Flow

1. User invokes `/ralph "<prompt>"`
2. Session UUID generated, directory created at `~/.atomic/workflows/sessions/{uuid}/` via `initWorkflowSession()` ([`src/workflows/session.ts:51-77`](https://github.com/bastani/atomic/blob/991f96c/src/workflows/session.ts#L51-L77))
3. Task decomposition: `buildSpecToTasksPrompt(parsed.prompt)` → `context.streamAndWait(..., { hideContent: true })` → LLM generates JSON task array with `blockedBy` fields
4. Tasks parsed via `parseTasks()` ([`workflow-commands.ts:650-667`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L650-L667)) — attempts direct JSON parse with regex fallback
5. Tasks normalized via `normalizeTodoItems()` and written to `tasks.json` via `saveTasksToActiveSession()`
6. Task panel activated: `context.setRalphSessionDir(sessionDir)` + `context.setRalphSessionId(sessionId)`
7. Serial worker loop iterates until all tasks complete or max iterations reached

---

### 2. The `spawnSubagent` Single-Slot Blocking Mechanism

This is the **fundamental architectural barrier** to parallel worker dispatch.

#### 2.1 Single-Slot Resolver

**File**: [`src/ui/chat.tsx:1765`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L1765)

```typescript
const streamCompletionResolverRef = useRef<
    ((result: StreamResult) => void) | null
>(null);
```

The ref holds exactly ONE resolver function. Only one `spawnSubagent()` call can be in-flight at a time.

#### 2.2 spawnSubagent Implementation

**File**: [`src/ui/chat.tsx:3254-3269`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L3254-L3269)

```typescript
spawnSubagent: async (options) => {
  const agentName = options.name ?? options.model ?? "general-purpose";
  const task = options.message;
  const instruction = `Use the ${agentName} sub-agent to handle this task: ${task}`;
  const result = await new Promise<StreamResult>((resolve) => {
    streamCompletionResolverRef.current = resolve;
    context.sendSilentMessage(instruction);
  });
  return {
    success: !result.wasInterrupted,
    output: result.content,
  };
},
```

**Why only one at a time**: Each call overwrites `streamCompletionResolverRef.current`. A second concurrent call would orphan the first promise (never resolved).

#### 2.3 Stream Completion Resolution

**File**: [`src/ui/chat.tsx:3224-3236`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L3224-L3236)

```typescript
const resolver = streamCompletionResolverRef.current;
if (resolver) {
    streamCompletionResolverRef.current = null;
    resolver({
        content: lastStreamingContentRef.current,
        wasInterrupted: false,
    });
    return;
}
```

#### 2.4 CommandContext Interface

**File**: [`src/ui/commands/registry.ts:65-139`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/registry.ts#L65-L139)

Key methods: `addMessage`, `sendMessage`, `sendSilentMessage`, `spawnSubagent`, `streamAndWait`, `clearContext`, `setTodoItems`, `setRalphSessionDir`, `setRalphSessionId`, `updateWorkflowState`.

#### 2.5 SpawnSubagentResult Interface

**File**: [`src/ui/commands/registry.ts:52-59`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/registry.ts#L52-L59)

```typescript
export interface SpawnSubagentResult {
    success: boolean;
    output: string;
    error?: string;
}
```

---

### 3. Existing Parallel Sub-Agent Infrastructure (Unused by Ralph)

The codebase has production-ready parallel execution infrastructure that ralph does not use.

#### 3.1 SubagentGraphBridge.spawnParallel()

**File**: [`src/graph/subagent-bridge.ts:184-208`](https://github.com/bastani/atomic/blob/991f96c/src/graph/subagent-bridge.ts#L184-L208)

```typescript
async spawnParallel(agents: SubagentSpawnOptions[]): Promise<SubagentResult[]> {
  const results = await Promise.allSettled(
    agents.map((agent) => this.spawn(agent))
  );
  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const agent = agents[i];
    return {
      agentId: agent?.agentId ?? `unknown-${i}`,
      success: false,
      output: "",
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      toolUses: 0,
      durationMs: 0,
    };
  });
}
```

**Key properties**:

- Uses `Promise.allSettled()` — one agent's failure doesn't cancel others
- Each sub-agent gets its own independent SDK session via `this.spawn()` → `this.createSession()`
- Output truncated to 4000 chars (`MAX_SUMMARY_LENGTH`)
- Results persisted to `~/.atomic/workflows/sessions/{sessionId}/agents/{agentId}.json`

#### 3.2 SubagentGraphBridge.spawn() — Single Agent

**File**: [`src/graph/subagent-bridge.ts:106-178`](https://github.com/bastani/atomic/blob/991f96c/src/graph/subagent-bridge.ts#L106-L178)

Creates an independent SDK session, streams the agent's response, accumulates output, records tool uses and duration, persists results, and destroys the session in a `finally` block.

#### 3.3 SubagentSpawnOptions Interface

**File**: [`src/graph/subagent-bridge.ts:28-41`](https://github.com/bastani/atomic/blob/991f96c/src/graph/subagent-bridge.ts#L28-L41)

```typescript
interface SubagentSpawnOptions {
    agentId: string;
    agentName: string;
    task: string;
    systemPrompt?: string;
    model?: string;
    tools?: string[];
}
```

#### 3.4 Graph Node Parallel Primitives

**File**: [`src/graph/nodes.ts`](https://github.com/bastani/atomic/blob/991f96c/src/graph/nodes.ts)

- `parallelNode()` (line 988): Creates fan-out/fan-in structure in graph, but branches execute sequentially through the BFS queue
- `parallelSubagentNode()` (line 1802): **True parallel execution** — calls `bridge.spawnParallel()` with `Promise.allSettled()`. Takes a `merge` function to aggregate results into state update.

#### 3.5 Global Bridge Registration

**File**: [`src/graph/subagent-bridge.ts:217-221`](https://github.com/bastani/atomic/blob/991f96c/src/graph/subagent-bridge.ts#L217-L221)

```typescript
export function setSubagentBridge(bridge: SubagentGraphBridge): void { ... }
export function getSubagentBridge(): SubagentGraphBridge | undefined { ... }
```

The bridge is initialized with a `CreateSessionFn` factory provided by SDK client implementations, enabling SDK-agnostic session creation.

---

### 4. The `blockedBy` Data Model: Complete but Unenforced

The `blockedBy` field flows through the entire system but is only used for display:

| Layer                | File                                                                                                                                              | Line(s) | Usage                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| **Schema**           | [`src/sdk/tools/todo-write.ts`](https://github.com/bastani/atomic/blob/991f96c/src/sdk/tools/todo-write.ts#L40-L44)                               | 40-44   | `blockedBy` field in TodoWrite JSON schema                   |
| **Type**             | [`src/sdk/tools/todo-write.ts`](https://github.com/bastani/atomic/blob/991f96c/src/sdk/tools/todo-write.ts#L58)                                   | 58      | `blockedBy?: string[]` on `TodoItem`                         |
| **Normalization**    | [`src/ui/utils/task-status.ts`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/task-status.ts#L69-L80)                               | 69-80   | `normalizeBlockedBy()` filters/stringifies array             |
| **Prompt**           | [`src/graph/nodes/ralph.ts`](https://github.com/bastani/atomic/blob/991f96c/src/graph/nodes/ralph.ts#L39-L51)                                     | 39-51   | LLM instructed to generate `blockedBy` arrays                |
| **Topological sort** | [`src/ui/components/task-order.ts`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-order.ts#L19-L122)                      | 19-122  | `sortTasksTopologically()` using Kahn's algorithm            |
| **UI rendering**     | [`src/ui/components/task-list-indicator.tsx`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-list-indicator.tsx#L117-L119) | 117-119 | Renders `› blocked by #1, #2` annotations                    |
| **Worker prompt**    | [`.claude/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.claude/agents/worker.md#L84-L96)                                     | 84-96   | Bug handling instructs writing `blockedBy` on affected tasks |
| **State snapshots**  | [`src/ui/utils/ralph-task-state.ts`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/ralph-task-state.ts#L34-L38)                     | 34-38   | `snapshotTaskItems()` preserves `blockedBy`                  |
| **Worker loop**      | [`workflow-commands.ts`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L801)                                | 801     | **NOT USED** — only checks `status !== "completed"`          |

---

### 5. Topological Sort: Reusable for Execution Scheduling

#### 5.1 Kahn's Algorithm Implementation

**File**: [`src/ui/components/task-order.ts:19-122`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-order.ts#L19-L122)

The algorithm follows these steps:

1. **ID Normalization** (lines 22-27): Strips leading `#` chars, re-adds single `#`, detects duplicates via `normalizeTaskId()`
2. **Unresolved marking** (lines 29-36): Tasks with missing/duplicate IDs marked as `unresolved`
3. **ID-to-index lookup** (lines 38-44): Reverse mapping for O(1) blocker resolution
4. **Blocker validation** (lines 46-67): Normalizes `blockedBy` arrays, deduplicates via `Set`, marks tasks with unknown blockers as unresolved
5. **Adjacency list + in-degree** (lines 76-94): `edges` maps blocker→dependents, `indegree` counts dependencies per task
6. **BFS traversal** (lines 96-112): Processes zero-in-degree tasks, decrements dependents' in-degree, adds newly-zero tasks to queue
7. **Tail appendage** (lines 114-121): Unresolved/cyclic tasks appended in original order after sorted tasks

#### 5.2 Adapting for "Ready Set" Computation

The topological sort can be adapted for execution scheduling by extracting the "ready set" — tasks that are:

- Status is `"pending"` (not `"completed"` or `"in_progress"`)
- All tasks in `blockedBy` have `status === "completed"`

**Pseudocode**:

```typescript
function getReadyTasks(tasks: TaskItem[]): TaskItem[] {
    // Reuse same normalization/validation from sortTasksTopologically
    // but filter to only tasks where:
    //   1. status === "pending"
    //   2. all blockedBy items have status === "completed"
    // Returns subset of dispatchable tasks
}
```

This function would be called by the orchestrator after each task completion to compute the next dispatch batch.

#### 5.3 Cycle/Deadlock Detection

If the ready set is empty but uncompleted tasks remain, the system is deadlocked. Kahn's algorithm inherently detects this: tasks left in the queue with non-zero in-degree after BFS are in cycles.

#### 5.4 Test Coverage

**File**: [`src/ui/components/task-order.test.ts`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-order.test.ts)

Tests cover: linear chains, fan-out dependencies, cycles, missing IDs, duplicate IDs, empty input, single tasks, and unknown blockers.

---

### 6. TodoWrite Interception and File-Watcher UI Pipeline

This pipeline is how task state changes propagate to the UI and is **already compatible** with parallel workers.

#### 6.1 TodoWrite Tool Definition

**File**: [`src/sdk/tools/todo-write.ts:67-92`](https://github.com/bastani/atomic/blob/991f96c/src/sdk/tools/todo-write.ts#L67-L92)

The handler stores todos in memory, returns `{ oldTodos, newTodos, summary }`. The TUI intercepts the tool input before the handler runs to persist to disk.

#### 6.2 TodoWrite Interception in chat.tsx

Two interception points in the streaming pipeline:

**handleToolExecute** — [`src/ui/chat.tsx:2026-2046`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L2026-L2046)

When a tool call is detected as "TodoWrite", the TUI extracts todos from the input and:

1. Updates in-memory `todoItemsRef` for the summary panel
2. If ralph is active (`ralphSessionIdRef.current` is set), persists to `tasks.json`:

```typescript
if (ralphSessionIdRef.current) {
    void saveTasksToActiveSession(todos, ralphSessionIdRef.current);
}
```

**handleToolComplete** — [`src/ui/chat.tsx:2141-2152`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L2141-L2152)

Same logic for late/deferred tool inputs.

#### 6.3 File Watcher Mechanism

**File**: [`src/ui/commands/workflow-commands.ts:818-837`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L818-L837)

```typescript
export function watchTasksJson(
    sessionDir: string,
    onUpdate: (items: NormalizedTodoItem[]) => void,
): () => void {
    const tasksPath = join(sessionDir, "tasks.json");
    const watcher = watch(sessionDir, async (eventType, filename) => {
        if (filename !== "tasks.json") return;
        try {
            const content = await readFile(tasksPath, "utf-8");
            const tasks = normalizeTodoItems(JSON.parse(content));
            onUpdate(tasks);
        } catch {
            /* ignore mid-write/missing file */
        }
    });
    return () => watcher.close();
}
```

Watches the **directory** (not the file) so it catches file creation even if `tasks.json` doesn't exist at mount time.

#### 6.4 TaskListPanel Consumption

**File**: [`src/ui/components/task-list-panel.tsx:48-64`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-list-panel.tsx#L48-L64)

Two-phase loading:

1. **Sync initial load**: `readFileSync(tasksPath)` on mount (prevents flash)
2. **Async live updates**: `watchTasksJson(sessionDir, (items) => setTasks(sortTasksTopologically(items)))` for reactive re-renders

#### 6.5 TaskListIndicator Rendering

**File**: [`src/ui/components/task-list-indicator.tsx:85-134`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-list-indicator.tsx#L85-L134)

Renders each task with:

- Status icons: `○` pending, `●` in_progress (blinking blue), `●` completed (green), `✕` error (red)
- Content text truncated to `MAX_CONTENT_LENGTH`
- `blockedBy` annotation: `› blocked by #1, #2` in muted color (lines 117-119)

#### 6.6 Complete Data Flow

```
Worker calls TodoWrite → SDK event → chat.tsx handleToolExecute (line 2026) →
  saveTasksToActiveSession() → Bun.write(tasks.json) → fs.watch triggers →
  TaskListPanel.onUpdate → setTasks(sortTasksTopologically(items)) → re-render
```

**Workers already trigger immediate UI updates** via this pipeline. The delay comes from the serial worker loop in the orchestrator waiting for one worker to finish before spawning the next, not from the UI update mechanism itself.

---

### 7. Worker Agent Configuration

#### 7.1 Worker Agent Definition

**Files**: [`.claude/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.claude/agents/worker.md), [`.github/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.github/agents/worker.md), [`.opencode/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.opencode/agents/worker.md)

All three versions are nearly identical. Key instructions:

- **Task selection** (line 9): "Only work on the SINGLE highest priority task that is not yet marked as complete" — does NOT mention checking `blockedBy`
- **Bug handling** (lines 84-96): Worker knows how to INSERT bug-fix tasks and UPDATE `blockedBy` on affected downstream tasks
- **Path reference** (line 13): `~/.atomic/workflows/{session_id}` — missing `sessions/` segment (should be `~/.atomic/workflows/sessions/{session_id}`)

#### 7.2 How Workers Complete Tasks

Workers call the **TodoWrite tool** with the updated task list where the target task has `status: "completed"`. The TUI intercepts this call (see §6.2), persists to `tasks.json`, and the file watcher triggers a UI re-render.

The worker does NOT write directly to `tasks.json` via file tools. It uses TodoWrite, which the TUI pipeline handles.

#### 7.3 Worker Name Resolution

- `.claude/agents/worker.md` → name derived from filename ("worker")
- `.github/agents/worker.md` → name from frontmatter (`name: worker`)
- `.opencode/agents/worker.md` → name derived from filename ("worker")

When `context.spawnSubagent({ name: "worker" })` is called, it sends: `"Use the worker sub-agent to handle this task: <preamble>"`. The SDK resolves "worker" to the agent definition file.

---

### 8. Ralph State Management in chat.tsx

**File**: [`src/ui/chat.tsx:1773-1776`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L1773-L1776)

```typescript
const [ralphSessionDir, setRalphSessionDir] = useState<string | null>(null);
const ralphSessionDirRef = useRef<string | null>(null);
const [ralphSessionId, setRalphSessionId] = useState<string | null>(null);
const ralphSessionIdRef = useRef<string | null>(null);
```

Both `useState` (for rendering) and `useRef` (for callback closures) track the active ralph session. The refs are updated via `context.setRalphSessionDir()` / `context.setRalphSessionId()` which are exposed on CommandContext:

- **setRalphSessionDir** ([`chat.tsx:3301-3303`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L3301-L3303)): Sets both state and ref
- **setRalphSessionId** ([`chat.tsx:3305-3307`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L3305-L3307)): Sets both state and ref

The `ralphSessionIdRef.current` is checked during TodoWrite interception to determine whether to persist to `tasks.json`.

---

### 9. File Persistence: No Atomicity or Locking

#### 9.1 saveTasksToActiveSession()

**File**: [`src/ui/commands/workflow-commands.ts:141-163`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L141-L163)

```typescript
export async function saveTasksToActiveSession(
    tasks: Array<{
        id?: string;
        content: string;
        status: string;
        activeForm: string;
        blockedBy?: string[];
    }>,
    sessionId?: string,
): Promise<void> {
    // ... resolve sessionDir ...
    const tasksPath = join(sessionDir, "tasks.json");
    try {
        await Bun.write(
            tasksPath,
            JSON.stringify(
                tasks.map((task) => normalizeTodoItem(task)),
                null,
                2,
            ),
        );
    } catch (error) {
        console.error("[ralph] Failed to write tasks.json:", error);
    }
}
```

**No atomicity**: Uses `Bun.write()` which is a direct `O_CREAT | O_WRONLY` write. Not atomic for multi-process access.

#### 9.2 Bun.write() Atomicity Analysis

Based on Bun source code analysis:

- **General `Bun.write()`: NOT atomic** — uses direct write + truncate, not write-to-temp-then-rename
- **POSIX `write()` guarantees**: Only atomic for writes ≤ `PIPE_BUF` (4KB-64KB). `tasks.json` can exceed this.
- **Race condition risk**: Multiple concurrent TodoWrite calls could create corrupted/mixed file content
- **No file locking API** exposed to JavaScript in Bun

**References**:

- [Bun File I/O Docs](https://bun.sh/docs/api/file-io)
- [Bun Issue #12917: Parallel install race conditions](https://github.com/oven-sh/bun/issues/12917)
- [Bun Issue #24822: Feature request for native locks](https://github.com/oven-sh/bun/issues/24822)

#### 9.3 Session Directory Structure

**File**: [`src/workflows/session.ts:32-49`](https://github.com/bastani/atomic/blob/991f96c/src/workflows/session.ts#L32-L49)

```
~/.atomic/workflows/sessions/{sessionId}/
├── session.json          ← WorkflowSession metadata
├── tasks.json            ← Shared task state (the contention point)
├── progress.txt          ← Append-only worker log
├── checkpoints/          ← Graph state checkpoints
├── agents/               ← Sub-agent output files
└── logs/                 ← Session logs
```

---

### 10. Concurrency Patterns for Parallel Workers

#### 10.1 Centralized Coordinator Pattern (Recommended)

The orchestrator (ralph command handler) acts as the sole writer to `tasks.json`. Workers report completions back via a callback/event mechanism, and the orchestrator serializes all mutations.

```
┌──────────────────────────────────────┐
│     Ralph Orchestrator (Main)        │
│  - Maintains in-memory task DAG      │
│  - Computes ready set                │
│  - Dispatches workers via bridge     │
│  - SOLE writer to tasks.json         │
│  - Receives completion events        │
└──────────────────┬───────────────────┘
                   │ SubagentGraphBridge.spawnParallel()
       ┌───────────┼───────────┐
       │           │           │
┌──────▼─────┐ ┌──▼────────┐ ┌▼───────────┐
│  Worker 1  │ │  Worker 2  │ │  Worker 3  │
│ (assigned  │ │ (assigned  │ │ (assigned  │
│  task #1)  │ │  task #2)  │ │  task #5)  │
└────────────┘ └────────────┘ └────────────┘
```

**Benefits**: No write conflicts, no file locking, no race conditions. Workers only need to report success/failure.

#### 10.2 File Locking Alternative (If Workers Must Write)

If workers must write `tasks.json` directly, use `proper-lockfile` (pure JS, Bun-compatible, ~2.5M weekly npm downloads):

```javascript
import lockfile from "proper-lockfile";
const release = await lockfile.lock("tasks.json", {
    stale: 10000,
    retries: { retries: 10 },
});
try {
    // read-modify-write tasks.json
} finally {
    await release();
}
```

**References**: [proper-lockfile GitHub](https://github.com/moxystudio/node-proper-lockfile)

#### 10.3 Atomic Write Pattern

Use write-to-temp-then-rename for crash-safe writes:

```typescript
import { randomBytes } from "crypto";
const tmp = `${tasksPath}.tmp.${randomBytes(6).toString("hex")}`;
await Bun.write(tmp, JSON.stringify(tasks, null, 2));
await fs.promises.rename(tmp, tasksPath); // Atomic on POSIX
```

#### 10.4 DAG Scheduling Libraries

| Library                                                            | DAG Support  | Parallel Execution          | Bun Ready |
| ------------------------------------------------------------------ | ------------ | --------------------------- | --------- |
| [`@microsoft/p-graph`](https://github.com/microsoft/p-graph)       | ✅ Native    | ✅ Configurable concurrency | ✅        |
| [`async.auto()`](https://github.com/caolan/async)                  | ✅ Native    | ✅ Configurable concurrency | ✅        |
| [`graph-run`](https://github.com/isaacs/graph-run)                 | ✅ Native    | ✅ Maximal parallelism      | ✅        |
| [`dependency-graph`](https://github.com/jriecken/dependency-graph) | ✅ Data only | ❌ No execution engine      | ✅        |

---

### 11. Ralph Task State Helpers

#### 11.1 RalphTaskStateItem Interface

**File**: [`src/ui/utils/ralph-task-state.ts:5-12`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/ralph-task-state.ts#L5-L12)

```typescript
export type RalphTaskStatus = "pending" | "in_progress" | "completed" | "error";

export interface RalphTaskStateItem {
    id?: string;
    content: string;
    status: RalphTaskStatus;
    blockedBy?: string[];
}
```

#### 11.2 normalizeInterruptedTasks()

**File**: [`src/ui/utils/ralph-task-state.ts:17-25`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/ralph-task-state.ts#L17-L25)

Resets `in_progress` → `pending` when a workflow is interrupted. Used on resume to ensure crashed workers don't leave tasks stuck.

#### 11.3 snapshotTaskItems()

**File**: [`src/ui/utils/ralph-task-state.ts:30-40`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/ralph-task-state.ts#L30-L40)

Creates clean snapshots for message persistence, explicitly mapping only `id`, `content`, `status`, `blockedBy` fields.

---

### 12. Task Status Normalization Pipeline

**File**: [`src/ui/utils/task-status.ts`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/task-status.ts)

The normalization pipeline handles arbitrary/malformed task data:

| Function                | Line(s) | Purpose                                                   |
| ----------------------- | ------- | --------------------------------------------------------- |
| `normalizeId()`         | 61-67   | Converts to string, returns `undefined` if empty          |
| `normalizeBlockedBy()`  | 69-80   | Validates array, filters null/empty, stringifies items    |
| `normalizeTaskStatus()` | 90-97   | Maps aliases (`todo`→`pending`, `done`→`completed`, etc.) |
| `normalizeTaskItem()`   | 99-107  | Combines all normalizers for base task                    |
| `normalizeTodoItem()`   | 109-117 | Extends base with `activeForm` field                      |
| `normalizeTodoItems()`  | 127-133 | Maps normalizer over array                                |

Status alias map (lines 17-35) supports: `pending`/`todo`/`open`/`not_started` → `"pending"`, `in_progress`/`inprogress`/`doing`/`running`/`active` → `"in_progress"`, `completed`/`complete`/`done`/`success`/`succeeded` → `"completed"`, `error`/`failed`/`failure` → `"error"`.

---

## Architecture Gaps Summary

| Gap                        | Current State                                                           | Location                      |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| **Dependency enforcement** | `blockedBy` exists but worker loop only checks `status !== "completed"` | `workflow-commands.ts:801`    |
| **Parallel dispatch**      | Serial `for` loop with single `streamCompletionResolverRef`             | `chat.tsx:1765, 3254-3269`    |
| **Worker task selection**  | Worker picks "highest priority" without checking blockers               | `.claude/agents/worker.md:9`  |
| **File concurrency**       | No locking; `Bun.write()` full overwrite                                | `workflow-commands.ts:159`    |
| **Deadlock detection**     | Not implemented                                                         | N/A                           |
| **Worker path**            | References `~/.atomic/workflows/{session_id}` (missing `sessions/`)     | `.claude/agents/worker.md:13` |

---

## Code References

| Component                           | File:Line                                                                                                                                 | Description                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Worker loop (fresh)                 | [`workflow-commands.ts:796-809`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L796-L809)           | Serial `for` loop spawning one worker at a time          |
| Worker loop (resume)                | [`workflow-commands.ts:748-757`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L748-L757)           | Same pattern for resume path                             |
| `spawnSubagent` impl                | [`chat.tsx:3254-3269`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L3254-L3269)                                        | Single-slot resolver blocking                            |
| `streamCompletionResolverRef`       | [`chat.tsx:1765`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L1765)                                                   | `useRef` single resolver — prevents parallelism          |
| `saveTasksToActiveSession`          | [`workflow-commands.ts:141-163`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L141-L163)           | Writes tasks to `tasks.json` via `Bun.write()`           |
| `readTasksFromDisk`                 | [`workflow-commands.ts:166-176`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L166-L176)           | Reads/normalizes tasks from disk                         |
| `watchTasksJson`                    | [`workflow-commands.ts:818-837`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L818-L837)           | File watcher for live UI updates                         |
| `buildSpecToTasksPrompt`            | [`ralph.ts:19-58`](https://github.com/bastani/atomic/blob/991f96c/src/graph/nodes/ralph.ts#L19-L58)                                       | Prompt instructing LLM to generate `blockedBy`           |
| `buildTaskListPreamble`             | [`ralph.ts:66-81`](https://github.com/bastani/atomic/blob/991f96c/src/graph/nodes/ralph.ts#L66-L81)                                       | Serializes full task list for worker context             |
| `sortTasksTopologically`            | [`task-order.ts:19-122`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-order.ts#L19-L122)                         | Kahn's algorithm (display only, reusable for scheduling) |
| `normalizeBlockedBy`                | [`task-status.ts:69-80`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/task-status.ts#L69-L80)                              | Normalizes `blockedBy` arrays                            |
| `TaskListPanel`                     | [`task-list-panel.tsx:39-94`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-list-panel.tsx#L39-L94)               | Persistent file-driven task list UI                      |
| `TaskListIndicator`                 | [`task-list-indicator.tsx:85-134`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/task-list-indicator.tsx#L85-L134)     | Renders tasks with blocked-by annotations                |
| `SubagentGraphBridge.spawn`         | [`subagent-bridge.ts:106-178`](https://github.com/bastani/atomic/blob/991f96c/src/graph/subagent-bridge.ts#L106-L178)                     | Single sub-agent session lifecycle                       |
| `SubagentGraphBridge.spawnParallel` | [`subagent-bridge.ts:184-208`](https://github.com/bastani/atomic/blob/991f96c/src/graph/subagent-bridge.ts#L184-L208)                     | Parallel execution via `Promise.allSettled()`            |
| `parallelSubagentNode`              | [`nodes.ts:1802-1838`](https://github.com/bastani/atomic/blob/991f96c/src/graph/nodes.ts#L1802-L1838)                                     | Graph node for concurrent sub-agent spawning             |
| Worker agent def (Claude)           | [`.claude/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.claude/agents/worker.md)                                     | Worker prompt — no `blockedBy` check for task selection  |
| Worker agent def (Copilot)          | [`.github/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.github/agents/worker.md)                                     | Worker prompt (Copilot version)                          |
| Worker agent def (OpenCode)         | [`.opencode/agents/worker.md`](https://github.com/bastani/atomic/blob/991f96c/.opencode/agents/worker.md)                                 | Worker prompt (OpenCode version)                         |
| TodoWrite tool                      | [`todo-write.ts:53-92`](https://github.com/bastani/atomic/blob/991f96c/src/sdk/tools/todo-write.ts#L53-L92)                               | TodoItem interface and handler                           |
| TodoWrite interception              | [`chat.tsx:2026-2046`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L2026-L2046)                                        | Persists to `tasks.json` when ralph is active            |
| Ralph session state                 | [`chat.tsx:1773-1776`](https://github.com/bastani/atomic/blob/991f96c/src/ui/chat.tsx#L1773-L1776)                                        | `ralphSessionDir`/`ralphSessionId` React state           |
| Session directory                   | [`session.ts:32-49`](https://github.com/bastani/atomic/blob/991f96c/src/workflows/session.ts#L32-L49)                                     | `~/.atomic/workflows/sessions/{sessionId}/`              |
| Ralph task state helpers            | [`ralph-task-state.ts:5-40`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/ralph-task-state.ts#L5-L40)                      | State types, interrupt normalization, snapshots          |
| Task status normalization           | [`task-status.ts:1-133`](https://github.com/bastani/atomic/blob/991f96c/src/ui/utils/task-status.ts#L1-L133)                              | Full normalization pipeline                              |
| `parseTasks`                        | [`workflow-commands.ts:650-667`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L650-L667)           | JSON extraction from LLM output                          |
| `parseRalphArgs`                    | [`workflow-commands.ts:50-69`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L50-L69)               | Command argument parsing                                 |
| Workflow definition                 | [`workflow-commands.ts:540-573`](https://github.com/bastani/atomic/blob/991f96c/src/ui/commands/workflow-commands.ts#L540-L573)           | Ralph workflow metadata registration                     |
| `ParallelAgentsTree`                | [`src/ui/components/parallel-agents-tree.tsx`](https://github.com/bastani/atomic/blob/991f96c/src/ui/components/parallel-agents-tree.tsx) | UI component for visualizing parallel agent execution    |

## Historical Context (from research/)

- [`research/docs/2026-02-09-163-ralph-loop-enhancements.md`](https://github.com/bastani/atomic/blob/991f96c/research/docs/2026-02-09-163-ralph-loop-enhancements.md) — Original ralph loop enhancement research (Issue #163)
- [`research/docs/2026-02-13-ralph-task-list-ui.md`](https://github.com/bastani/atomic/blob/991f96c/research/docs/2026-02-13-ralph-task-list-ui.md) — Persistent task list UI implementation research
- [`research/docs/2026-02-15-ralph-dag-orchestration-blockedby.md`](https://github.com/bastani/atomic/blob/991f96c/research/docs/2026-02-15-ralph-dag-orchestration-blockedby.md) — Prior research on DAG orchestration (same topic, earlier iteration)
- [`research/docs/qa-ralph-task-list-ui.md`](https://github.com/bastani/atomic/blob/991f96c/research/docs/qa-ralph-task-list-ui.md) — QA findings for task list UI
- [`specs/2026-02-09-ralph-loop-enhancements.md`](https://github.com/bastani/atomic/blob/991f96c/specs/2026-02-09-ralph-loop-enhancements.md) — Detailed design spec including dependency resolution (Section 5.1.3) and dynamic DAG mutations (Section 5.1.4)
- [`specs/2026-02-14-ralph-task-list-ui.md`](https://github.com/bastani/atomic/blob/991f96c/specs/2026-02-14-ralph-task-list-ui.md) — Task list UI spec with file-driven reactive pattern

## Related Research

- [`specs/2026-01-25-ralph-setup-refactor.md`](https://github.com/bastani/atomic/blob/991f96c/specs/2026-01-25-ralph-setup-refactor.md) — Ralph setup refactor spec

## Open Questions

1. **Worker assignment model**: Should the orchestrator assign a specific task to each worker (orchestrator-controlled), or should workers self-select from the ready set (worker-controlled)? Orchestrator-controlled is simpler for concurrency but requires changing how `buildTaskListPreamble()` works.

2. **Concurrency limit**: How many parallel workers should run simultaneously? The `SubagentGraphBridge` has no built-in concurrency limit — all agents in `spawnParallel()` start simultaneously. A configurable concurrency cap (e.g., 2-4 workers) may be needed to avoid API rate limits and context confusion.

3. **Worker-to-orchestrator communication**: With `SubagentGraphBridge.spawnParallel()`, the orchestrator only learns results after ALL parallel workers complete. For true DAG traversal (dispatch next wave immediately when a worker finishes), a different mechanism is needed — possibly launching workers individually with `spawn()` and managing promises manually, or using an event-driven coordinator.

4. **TodoWrite vs direct file writes**: With centralized coordinator, should workers call TodoWrite (which goes through the TUI interception pipeline) or should the orchestrator be the sole writer? If using `SubagentGraphBridge`, workers run in independent SDK sessions and their TodoWrite calls may not be intercepted by the TUI. This needs investigation.

5. **Dynamic DAG mutation timing**: When a worker inserts a bug-fix task, when does the orchestrator detect and incorporate it? If using file watching, the orchestrator can react to `tasks.json` changes. If using centralized coordinator, the worker needs an IPC mechanism to notify the coordinator.

6. **Resume semantics**: How should resume work with parallel workers? Currently, interrupted `in_progress` tasks are reset to `pending`. With multiple workers, multiple tasks could be `in_progress` simultaneously, all of which need reset.
