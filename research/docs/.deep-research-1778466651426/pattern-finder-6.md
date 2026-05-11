# Partition 6: Research Documentation Patterns
## Pattern Mapping for Atomic → Pi-Coding-Agent Rewrite

**Partition**: 6 of 12 (research/)  
**Scope**: `research/docs/` (2,307 LOC of markdown)  
**Research Question**: Map the entire Atomic CLI codebase for a planned full rewrite onto pi-coding-agent. Remove ALL dependencies on tmux, Claude Code/Claude Agent SDK, GitHub Copilot CLI/SDK, and OpenCode/OpenCode SDK.

---

## Patterns Found

#### Pattern 1: Unified SDK Abstraction Architecture
**Where:** `research/docs/2026-01-31-sdk-migration-and-graph-execution.md:544-576`  
**What:** Documents the current three-SDK abstraction pattern and recommends a single unified interface.

```typescript
interface CodingAgentClient {
  // Session management
  createSession(config: SessionConfig): Promise<Session>
  resumeSession(id: string): Promise<Session>
  
  // Messaging
  send(message: string): Promise<void>
  stream(): AsyncGenerator<AgentMessage>
  
  // Events
  on(event: string, handler: EventHandler): Unsubscribe
  
  // Tools
  registerTool(tool: ToolDefinition): void
  
  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
}

// Implementations
class OpenCodeClient implements CodingAgentClient { ... }
class ClaudeAgentClient implements CodingAgentClient { ... }
class CopilotClient implements CodingAgentClient { ... }
```

**Variations / call-sites:**  
- `research/docs/2026-01-31-opencode-sdk-research.md:114-145` — OpenCode SDK migration path
- `research/docs/2026-01-31-claude-agent-sdk-research.md:147-196` — Claude Agent SDK v2 API patterns
- `research/docs/2026-01-31-github-copilot-sdk-research.md:198-255` — GitHub Copilot SDK architecture

---

#### Pattern 2: Graph-Based Workflow Execution with Fluent API
**Where:** `research/docs/2026-01-31-sdk-migration-and-graph-execution.md:429-461`  
**What:** Declarative workflow pattern with chaining, conditionals, loops, and parallel execution.

```typescript
const workflow = graph<AtomicWorkflowState>()
  .start("research")
  .then(researchCodebase)
  .then(createSpec)
  .then(reviewSpec)
  .if(ctx => ctx.state.specApproved === true)
    .then(createFeatureList)
    .loop(implementFeature, {
      until: ctx => ctx.state.allFeaturesPassing === true,
      maxIterations: 100
    })
    .then(createPR)
  .else()
    .then(notifyUser)
    .wait("Waiting for spec revision")
  .endif()
  .end("create_pr", "notify")
  .compile({
    checkpointer: new ResearchDirSaver()
  })

const result = await workflow.invoke(initialState, config)

for await (const state of workflow.stream(initialState, config)) {
  console.log(`Iteration: ${state.iteration}`)
}
```

**Variations / call-sites:**
- `research/docs/2026-01-31-graph-execution-pattern-design.md:432-540` — Node factory functions, error handling, state persistence
- `research/docs/2026-01-31-atomic-current-workflow-architecture.md:147-161` — Current graph engine entry point and exports

---

#### Pattern 3: SDK Event Normalization for Multi-Agent Support
**Where:** `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md:202-226`  
**What:** Maps SDK-specific events from three agents (Claude, OpenCode, Copilot) to unified UI events.

```typescript
// Each SDK produces different event structures:

// **Claude Agent SDK** (QueryAsyncIterable)
for await (const message of query(...)) {
  if (message.type === 'tool_use') {
    // Handle tool start
  }
  if (message.type === 'tool_result') {
    // Handle tool complete
  }
}

// **OpenCode SDK** (SSE-based)
for await (const event of events.stream()) {
  if (event.type === 'message.part.updated') {
    const partType = event.data.part.type; // 'text' | 'tool' | 'reasoning'
    // Handle by part type
  }
}

// **Copilot SDK** (31 event types)
session.on((event) => {
  if (event.type === 'assistant.message') { /* ... */ }
  if (event.type === 'tool.execution_start') { /* ... */ }
})

// Unified event pipeline in adapter
interface NormalizedEvent {
  type: 'chunk' | 'tool_start' | 'tool_complete' | 'agent_start' | 'agent_complete'
  timestamp: number
  // ... payload varies by type
}
```

**Variations / call-sites:**
- `research/docs/2026-02-12-tui-layout-streaming-content-ordering.md:258` — SDK UI standardization reference
- `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` — Claude Code CLI patterns for TUI
- `research/docs/2026-02-16-opencode-deepwiki-research.md:103-160` — OpenCode message streaming and sub-agent lifecycle

---

#### Pattern 4: Chat System Architecture with Content Segments
**Where:** `research/docs/2026-02-16-atomic-chat-architecture-current.md:23-100`  
**What:** Offset-based chronological rendering of interleaved message content, tools, agents, and tasks.

```typescript
function buildContentSegments(
  content: string,
  toolCalls: MessageToolCall[],
  agents?: ParallelAgent[] | null,
  agentsOffset?: number,
  taskItems?: TaskItem[] | null,
  tasksOffset?: number,
  tasksExpanded?: boolean,
): ContentSegment[]

// Segment types:
type ContentSegment = 
  | { type: 'text'; content: string }
  | { type: 'tool'; toolCall: MessageToolCall }
  | { type: 'hitl'; question: CompletedQuestion }
  | { type: 'agents'; agents: ParallelAgent[] }
  | { type: 'tasks'; items: TaskItem[] }

// Offset-based insertion: Each segment has a character offset in content
// where it should appear chronologically. Segments sorted by:
// 1. offset (chronological)
// 2. priority (text=0, tool=0, hitl=1, agents=2, tasks=3)
// 3. sequence (insertion order)
```

**Variations / call-sites:**
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:1287-1483` — `buildContentSegments()` full implementation
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:1502-1757` — `MessageBubble` rendering with segments

---

#### Pattern 5: Deferred Completion with Parallel Agent Coordination
**Where:** `research/docs/2026-02-16-atomic-chat-architecture-current.md:319-343`  
**What:** Pattern for handling asynchronous sub-agents while preventing premature message completion.

```typescript
// Handler delays completion if sub-agents or tools still running
if (hasActiveAgents || hasRunningToolRef.current) {
  pendingCompleteRef.current = handleComplete;
  return; // Exit early, defer execution
}

// Effect monitors completion state
useEffect(() => {
  if (!hasActive && !hasRunningToolRef.current && pendingCompleteRef.current) {
    const complete = pendingCompleteRef.current;
    pendingCompleteRef.current = null;
    complete(); // Now finalize
  }
}, [parallelAgents, toolCompletionVersion])

// Stale callback guard with generation counter
const currentGeneration = streamGenerationRef.current;
return () => {
  if (streamGenerationRef.current !== currentGeneration) return;
  // Safe to proceed
};
```

**Variations / call-sites:**
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:3384-3393` — Deferred completion check in `handleComplete`
- `research/docs/2026-02-16-atomic-chat-architecture-current.md:2707-2782` — Agent-only stream finalization
- `research/docs/2026-02-15-subagent-premature-completion-SUMMARY.md` — Comprehensive fix notes

---

#### Pattern 6: tmux-Free Architecture Transition
**Where:** `research/docs/2026-02-06-at-mention-dropdown-research.md:55-85` (Claude Code tmux usage), `2026-02-06-at-mention-dropdown-research.md:175-200` (OpenCode SolidJS native UI)  
**What:** Documents shift from tmux-based Claude Code to native terminal UI (OpenCode/OpenTUI approach).

```typescript
// OLD PATTERN (Claude Code + tmux):
// 1. Claude Code CLI runs in tmux pane
// 2. Sub-agent invocation via `@mention` triggers tmux send-keys
// 3. External process coordination via file I/O and tmux escape sequences

// NEW PATTERN (OpenCode + OpenTUI):
// 1. Single-process TUI using OpenTUI primitives
// 2. Sub-agents managed natively within event loop
// 3. No tmux dependency, no external process coordination

// OpenTUI primitives (SolidJS-based):
import { Textarea, Box, ScrollBox, Text, SelectRenderable } from "@opentui/core"

// All UI components manage state directly
function ChatApp() {
  const [messages, setMessages] = createSignal([])
  const [inputValue, setInputValue] = createSignal("")
  
  return (
    <Box flexDirection="column" flexGrow={1}>
      <ScrollBox flexGrow={1} stickyScroll>
        {messages.map(msg => <MessageComponent msg={msg} />)}
      </ScrollBox>
      <Textarea 
        value={inputValue()}
        onInput={e => setInputValue(e)}
        onSubmit={handleMessage}
      />
    </Box>
  )
}
```

**Variations / call-sites:**
- `research/docs/2026-02-06-at-mention-dropdown-research.md:537-574` — Comparison table (Claude Code vs OpenCode primitives)
- `research/docs/2026-02-01-claude-code-ui-patterns-for-atomic.md` — Claude Code UI patterns study

---

#### Pattern 7: SDK Auto-Compaction and Context Management
**Where:** `research/docs/2026-03-01-opencode-auto-compaction.md:111-167`  
**What:** Unified context overflow handling across three SDKs with different mechanisms.

```typescript
// COPILOT SDK: Native auto-compact with event
session.on('session.compaction', (event) => {
  if (event.data.phase === 'start') {
    showCompactionSpinner();
  }
  if (event.data.phase === 'complete') {
    hideCompactionSpinner();
    showCompactionSummary(event.data.summary);
  }
});

// CLAUDE AGENT SDK: Auto-compact on ContextOverflowError
try {
  for await (const msg of query(...)) {
    // process message
  }
} catch (error) {
  if (error instanceof ContextOverflowError) {
    // SDK handles auto-compaction internally
    // Resume streaming
  }
}

// OPENCODE SDK: Manual trigger via summarize()
if (contextUsage > 0.45) { // 45% threshold
  await session.summarize();
  // UI shows compaction spinner
}

// Unified adapter pattern:
interface CompactionEvent {
  phase: 'start' | 'complete';
  summary?: string;
  timestamp: number;
}
```

**Variations / call-sites:**
- `research/docs/2026-03-01-opencode-auto-compaction.md:185-203` — Feature comparison table
- `research/docs/2026-03-01-opencode-auto-compaction.md:204-428` — Upstream OpenCode native auto-compaction system

---

## Summary

The research partition documents **seven distinct patterns** critical for the Atomic → Pi-Coding-Agent rewrite:

1. **Unified SDK Abstraction** (`CodingAgentClient` interface): Abstracts three SDKs (Claude, OpenCode, Copilot) behind a single interface with `createSession()`, `stream()`, `on()`, `registerTool()` methods.

2. **Graph-Based Workflows**: Fluent API for declarative workflow orchestration with `.then()`, `.if()`/`.else()`, `.loop()`, and `.parallel()` combinators, supporting Ralph-loop patterns.

3. **Event Normalization**: Adapters map SDK-specific events (Claude's `QueryAsyncIterable`, OpenCode's SSE, Copilot's 31+ event types) to unified pipeline.

4. **Content Segment Architecture**: Offset-based chronological rendering interleaves text, tool calls, HITL questions, parallel agents, and task items at their exact character positions.

5. **Deferred Completion Pattern**: Prevents premature message finalization when sub-agents are running by storing callbacks in refs and executing when all operations complete.

6. **tmux Removal**: Shift from external process coordination (Claude Code + tmux) to native single-process TUI (OpenTUI + SolidJS).

7. **Context Management**: Unified auto-compaction handling across Copilot (native events), Claude (exceptions), and OpenCode (manual triggers).

All patterns exist in current codebase as of research documents dated 2026-01-31 through 2026-03-02. Each includes concrete type definitions, implementation strategies, and variation examples across the three current coding agent SDKs.
