---
date: 2026-02-11 00:36:57 UTC
researcher: Copilot CLI
git_commit: be48427c29302f27573c917102c626d1f10cc15d
branch: lavaman131/feature/tui
repository: atomic
topic: "Workflow SDK Implementation: Custom Tools, Sub-Agents, and Graph Execution"
tags:
    [
        research,
        codebase,
        workflow-sdk,
        graph-engine,
        custom-tools,
        sub-agents,
        tui,
    ]
status: complete
last_updated: 2026-02-11
last_updated_by: Copilot CLI
---

# Research: Workflow SDK Implementation

## Research Question

Research the current implementation of the atomic workflow SDK (e.g. `~/.atomic/workflows/*.ts` and `.atomic/workflows/*.ts`). Understand how the current workflow SDK works by thoroughly reviewing the TUI component of the codebase and enhance the workflow SDK to be able to use custom tools that are already defined in the SDK as TypeScript modules (e.g. `~/.atomic/tools/*.ts` and `.atomic/tools/*.ts`). The workflow SDK should also be capable of manipulating existing sub-agents in nodes to execute deterministic workflows using sub-agents that are auto-discovered and built-in sub-agents.

## Summary

The Atomic CLI implements a graph-based workflow execution engine in `src/graph/` with a fluent builder API, typed state management via annotations, and multiple node types (agent, tool, decision, wait, ask_user, subgraph, parallel, context monitor). Workflows are defined as TypeScript files and can be loaded from three sources: built-in (`src/workflows/`), project-local (`.atomic/workflows/`), and user-global (`~/.atomic/workflows/`). Custom tools follow a parallel discovery pattern from `.atomic/tools/` and `~/.atomic/tools/` with a Zod-based `tool()` helper. Sub-agent management is handled by `SubagentSessionManager` in the TUI layer. Currently, only one built-in workflow exists ("Ralph"), and custom tools are registered at the SDK client level but not yet directly composable within workflow graph nodes. The sub-agent system operates through the TUI session manager independently of the graph execution engine.

---

## Detailed Findings

### 1. Graph Execution Engine (`src/graph/`)

The graph engine is the core of the workflow system. It provides a declarative, type-safe way to define and execute multi-step workflows.

#### 1.1 Core Types (`src/graph/types.ts`)

- **`BaseState`**: Foundation state interface with `executionId`, `lastUpdated`, `outputs` (Record<NodeId, unknown>)
- **`NodeType`**: Union of `"agent" | "tool" | "decision" | "wait" | "ask_user" | "subgraph" | "parallel"`
- **`NodeDefinition<TState>`**: Shape of a graph node — `id`, `type`, `name`, `description`, `retry?`, `execute(ctx) => Promise<NodeResult<TState>>`
- **`NodeResult<TState>`**: Execution result — `stateUpdate?`, `signals?`, `goto?` (for routing)
- **`ExecutionContext<TState>`**: Context passed to node execute — `state`, `config`, `model`, `emit?`, `contextWindowUsage?`, `contextWindowThreshold?`
- **`CompiledGraph<TState>`**: The compiled, executable graph — `nodes` Map, `edges` array, `startNode`, `endNodes` Set, `config`
- **`GraphConfig`**: Execution configuration — `maxSteps`, `contextWindowThreshold`, `defaultModel`, `checkpointer?`, `telemetryProvider?`
- **`SignalData`**: Signal types including `context_window_warning`, `human_input_required`
- **`RetryConfig`**: `maxAttempts`, `backoffMs`, `backoffMultiplier`
- **Constants**: `BACKGROUND_COMPACTION_THRESHOLD = 0.45`, `BUFFER_EXHAUSTION_THRESHOLD = 0.6`

#### 1.2 Graph Builder (`src/graph/builder.ts`)

Fluent API for constructing graphs:

```typescript
const workflow = graph<MyState>()
    .start(startNode)
    .then(nodeA)
    .if(condition)
    .then(nodeB)
    .else()
    .then(nodeC)
    .endif()
    .loop([nodeD, nodeE], { until: (state) => state.done, maxIterations: 100 })
    .parallel([branchA, branchB], { strategy: "all" })
    .wait({ prompt: "Continue?" })
    .catch(errorHandler)
    .end()
    .compile(config);
```

Key methods:

- `start(node)` — Set the entry node
- `then(node)` — Append a sequential node
- `if(condition)/else()/endif()` — Conditional branching
- `loop(nodes, config)` — Loop with `until` condition and `maxIterations`
- `parallel(nodes, config)` — Concurrent branch execution
- `wait(config)` — Pause for human input
- `catch(handler)` — Error handling node
- `end()` — Mark terminal nodes
- `compile(config)` — Produce a `CompiledGraph`

Factory function: `graph<TState>()` at `src/graph/builder.ts:694`

#### 1.3 Graph Executor (`src/graph/compiled.ts`)

`GraphExecutor<TState>` handles the actual execution:

- **`execute(state)`** (`compiled.ts:232`): Entry point, returns final state
- **`stream(state)`** (`compiled.ts:266`): Async generator yielding `StepResult` per node
- **BFS traversal**: Follows edges from start node, evaluates `goto` for routing
- **Model resolution** (`compiled.ts:510`): `node.model → parentContext.model → config.defaultModel → undefined`
- **Retry logic** (`compiled.ts:547`): Configurable per-node with exponential backoff
- **Checkpointing**: Saves state after each node via `Checkpointer` interface
- **Signal handling**: Processes `context_window_warning` and `human_input_required` signals
- **Telemetry**: Tracks node execution timing and outcomes

Checkpointer implementations: `MemorySaver`, `FileSaver`, `ResearchDirSaver`, `SessionDirSaver`

#### 1.4 State Annotation System (`src/graph/annotation.ts`)

Type-safe state management inspired by LangGraph:

- **`annotation<T>(default, reducer?)`**: Define a state field with default value and optional merge strategy
- **`Reducers`**: Built-in reducers — `replace`, `concat`, `merge`, `mergeById(field)`, `max`, `min`, `sum`, `or`, `and`, `ifDefined`
- **`initializeState(schema)`**: Create state from annotation definitions
- **`applyStateUpdate(schema, current, update)`**: Apply partial updates with reducers

Two annotation schemas exist:

1. **`AtomicStateAnnotation`** — For general Atomic workflows (researchDoc, specDoc, featureList, etc.)
2. **`RalphStateAnnotation`** — Extended for Ralph sessions (adds `ralphSessionId`, `yolo`, `maxIterations`, `shouldContinue`, etc.)

Corresponding state types:

- `AtomicWorkflowState = StateFromAnnotation<typeof AtomicStateAnnotation>`
- `RalphWorkflowState` — Manually defined interface at `src/graph/annotation.ts:463`

---

### 2. Node Factory Functions (`src/graph/nodes.ts`)

The file exports factory functions for all node types. Each returns a `NodeDefinition<TState>`.

#### 2.1 Agent Node (`agentNode()`, line 163)

Creates a node that executes an AI agent session:

```typescript
agentNode<MyState>({
    id: "research",
    agentType: "claude", // "claude" | "opencode" | "copilot"
    systemPrompt: "...",
    tools: ["tool1", "tool2"],
    buildMessage: (state) => `Research: ${state.topic}`,
    outputMapper: (messages, state) => ({ result: messages }),
    sessionConfig: { model: "sonnet" },
    retry: { maxAttempts: 3 },
});
```

**Key mechanics:**

- Uses `globalClientProvider` (set via `setClientProvider()`) to get a `CodingAgentClient` for the agent type
- Creates an SDK session via `client.createSession()`
- Sends a message built from state, streams the response
- Tracks context window usage and emits signals
- Always destroys the session in a `finally` block

**`ClientProvider` type** (`nodes.ts:100`): `(agentType: AgentNodeAgentType) => CodingAgentClient | null`

#### 2.2 Tool Node (`toolNode()`, line 362)

Executes a specific tool function:

```typescript
toolNode<MyState, { url: string }, Response>({
    id: "fetch-data",
    toolName: "http_fetch",
    execute: async (args) => fetch(args.url),
    args: (state) => ({ url: state.targetUrl }),
    outputMapper: (result, state) => ({ fetchedData: result }),
    timeout: 30000,
});
```

- Supports static or dynamic args (function of state)
- Has timeout support via AbortController
- Result stored in `outputs[nodeId]` by default or via `outputMapper`

#### 2.3 Clear Context Node (`clearContextNode()`, line 487)

Emits a `context_window_warning` signal with `action: "summarize"` to trigger context compaction between workflow phases.

#### 2.4 Decision Node (`decisionNode()`, line 586)

Routes based on state conditions:

```typescript
decisionNode<MyState>({
    id: "router",
    routes: [
        { condition: (s) => s.score >= 90, target: "fast-track" },
        { condition: (s) => s.score >= 70, target: "standard" },
    ],
    fallback: "manual-review",
});
```

Evaluates routes in order; first match wins. Falls back if none match.

#### 2.5 Wait Node (`waitNode()`, line 676)

Pauses for human input via `human_input_required` signal. Supports `autoApprove` for testing.

#### 2.6 Ask User Node (`askUserNode()`, line 833)

Primary node type for explicit human input in workflows:

```typescript
askUserNode<MyState>({
    id: "confirm",
    options: {
        question: "Continue?",
        header: "Confirmation",
        options: [
            { label: "Yes", description: "Proceed" },
            { label: "No", description: "Cancel" },
        ],
    },
});
```

- Generates a unique `requestId` via `crypto.randomUUID()`
- Emits `human_input_required` signal via both `ctx.emit` and `signals`
- Sets state flags: `__waitingForInput`, `__waitNodeId`, `__askUserRequestId`
- `AskUserWaitState` interface for the state extension

#### 2.7 Parallel Node (`parallelNode()`, line 981)

Executes branches concurrently:

```typescript
parallelNode<MyState>({
    id: "gather",
    branches: ["fetch-1", "fetch-2", "fetch-3"],
    strategy: "all", // "all" | "race" | "any"
    merge: (results, state) => ({ allData: Array.from(results.values()) }),
});
```

Returns `goto: branches` for the execution engine to handle actual parallelism.

#### 2.8 Subgraph Node (`subgraphNode()`, line 1159)

Executes a nested graph:

```typescript
// Direct compiled graph
subgraphNode<MainState, SubState>({
    id: "analysis",
    subgraph: compiledGraph,
    inputMapper: (state) => ({ doc: state.document }),
    outputMapper: (subState, state) => ({ results: subState.results }),
});

// Workflow name string (resolved at runtime)
subgraphNode<MainState, SubState>({
    id: "research",
    subgraph: "research-codebase",
});
```

**Workflow resolution:**

- String refs resolved via `globalWorkflowResolver` (set by `setWorkflowResolver()`)
- Circular dependency detection via `resolutionStack` Set
- Resolver is initialized in `workflow-commands.ts` via `initializeWorkflowResolver()`

#### 2.9 Context Monitor Node (`contextMonitorNode()`, line 1367)

Monitors context window usage and takes action when threshold is exceeded:

- `"summarize"` — Calls `session.summarize()` (OpenCode)
- `"recreate"` — Signals session recreation (Claude)
- `"warn"` — Emits warning only (Copilot)
- Default action auto-detected from `agentType`

---

### 3. Workflow System (`src/workflows/` + `src/ui/commands/workflow-commands.ts`)

#### 3.1 Built-in Workflow: Ralph

The only currently implemented workflow. Defined in `src/workflows/ralph/`:

**Files:**

- `src/workflows/ralph/workflow.ts` — Graph definition via `createRalphWorkflow()`
- `src/workflows/ralph/executor.ts` — `RalphExecutor` class for interrupt handling and session persistence
- `src/workflows/ralph/session.ts` — Session CRUD operations, session stored at `.ralph/sessions/{sessionId}/session.json`
- `src/graph/nodes/ralph-nodes.ts` — Ralph-specific node factories

**Ralph Workflow Structure** (`workflow.ts:169`):

```typescript
export function createRalphWorkflow(config?: CreateRalphWorkflowConfig) {
    return graph<RalphWorkflowState>()
        .start(initSessionNode)
        .loop([clearContextNode, implementFeatureNode], {
            until: (state) => !state.shouldContinue,
            maxIterations: config?.maxIterations ?? 100,
        })
        .then(checkCompletionNode)
        .end()
        .compile({ checkpointing: config?.checkpointing ?? true });
}
```

**Ralph Node IDs** (`workflow.ts:40`): `RALPH_NODE_IDS` constant with `initSession`, `clearContext`, `implementFeature`, `checkCompletion`

**Ralph-specific nodes** (`ralph-nodes.ts`):

- `initRalphSessionNode` — Initialize or resume a session, create directory structure
- `implementFeatureNode` — Pick next available task, delegate to agent
- `checkCompletionNode` — Deterministic termination check: any available (non-blocked) tasks remaining?
- `createPRNode` — Create pull request with session metadata

**RalphWorkflowState** (`ralph-nodes.ts:202`): Extends `BaseState` with `ralphSessionId`, `ralphSessionDir`, `tasks: TodoItem[]`, `currentFeatureIndex`, `completedFeatures`, `iteration`, `sessionStatus`, `shouldContinue`, `prUrl`, `prBranch`, `contextWindowUsage`, `debugReports`

**Ralph Executor** (`executor.ts`):

- Manages SIGINT/Esc interrupt handling
- Session state persistence to `.ralph/sessions/{sessionId}/`
- `run()` method at line 236 returns placeholder result — actual execution integration is TODO

#### 3.2 Workflow Discovery and Registration (`workflow-commands.ts`)

**Search paths** (line 219):

```typescript
export const CUSTOM_WORKFLOW_SEARCH_PATHS = [
    ".atomic/workflows", // Project-local (highest priority)
    "~/.atomic/workflows", // Global user workflows
];
```

**Discovery flow:**

1. `discoverWorkflowFiles()` — Scans paths for `.ts` files
2. `loadWorkflowsFromDisk()` — Dynamic `import()` of discovered files
3. Each file expected to export:
    - `default` — Function `(config?) => CompiledGraph` (required)
    - `name` — Workflow name (optional, defaults to filename)
    - `description` — Human-readable description (optional)
    - `aliases` — Alternative command names (optional)

**Example custom workflow file:**

```typescript
// .atomic/workflows/my-workflow.ts
import { graph, agentNode } from "@bastani/atomic/graph";

export const name = "my-workflow";
export const description = "My custom workflow";
export const aliases = ["mw"];

export default function createWorkflow(config?: Record<string, unknown>) {
    return graph<MyState>()
        .start(researchNode)
        .then(implementNode)
        .end()
        .compile();
}
```

**Priority**: Local `.atomic/workflows/` overrides global `~/.atomic/workflows/` overrides built-in

**Workflow Registry** (line 410):

- `workflowRegistry: Map<string, WorkflowMetadata>` — Maps lowercase name/alias to metadata
- `getWorkflowFromRegistry(name)` — Lookup by name or alias
- `resolveWorkflowRef(name)` — Resolve name to compiled graph (with circular dependency detection)
- `refreshWorkflowRegistry()` — Clear and reinitialize after loading new workflows

**Registration** (line 825):

- `registerWorkflowCommands()` — Creates command definitions and registers with `globalRegistry`
- Also calls `initializeWorkflowResolver()` to enable `subgraphNode()` string workflow references
- Each workflow gets a `/` slash command in the TUI

**WorkflowMetadata** (line 94):

```typescript
interface WorkflowMetadata<TState extends BaseState> {
    name: string;
    description: string;
    aliases?: string[];
    createWorkflow: (config?) => CompiledGraph<TState>;
    defaultConfig?: Record<string, unknown>;
    source?: "builtin" | "global" | "local";
    argumentHint?: string;
}
```

**Workflow Session Tracking** (line 114):

- `WorkflowSession` — Tracks sessionId, agentType, currentStep, paths, timestamps
- `WorkflowStep` union: `"research" | "research_complete" | "create_spec" | ... | "complete"`
- Active sessions stored in-memory `Map<string, WorkflowSession>`

---

### 4. Custom Tools System (`src/sdk/tools/`)

#### 4.1 Tool Plugin API (`src/sdk/tools/plugin.ts`)

```typescript
import { tool } from "@atomic/plugin";

export default tool({
    description: "Run the project linter",
    args: {
        filePath: tool.schema.string().describe("Path to lint"),
    },
    async execute(args, context) {
        const proc = Bun.spawn(["bun", "lint", args.filePath], {
            cwd: context.directory,
        });
        return await new Response(proc.stdout).text();
    },
});
```

- **`tool<Args>(input: ToolInput<Args>): ToolInput<Args>`** — Identity function for type safety
- **`ToolInput<Args>`**: `description`, `args` (Zod schema), `execute(args, context)`
- **`ToolContext`**: `sessionID`, `messageID`, `agent`, `directory`, `abort` (AbortSignal)
- **`tool.schema`** — Re-exports Zod (`z`) for schema definitions

#### 4.2 Tool Discovery (`src/sdk/tools/discovery.ts`)

**Search paths** (line 45):

```typescript
export const TOOL_SEARCH_PATHS = [
    ".atomic/tools", // Project-local (highest priority)
    join(HOME, ".atomic", "tools"), // Global user tools (~/.atomic/tools)
];
```

**Discovery flow:**

1. `discoverToolFiles()` — Scans paths for `.ts` and `.js` files
2. `loadToolsFromDisk()` — Dynamic import with `@atomic/plugin` import rewriting
3. `registerCustomTools(client)` — Registers all discovered tools with SDK client

**Naming convention:**

- Default export → tool name = filename (e.g., `lint.ts` → `lint`)
- Named exports → `<filename>_<exportName>` (e.g., `weather.ts:getTemp` → `weather_getTemp`)

**Import resolution:**

- `@atomic/plugin` imports rewritten to absolute path to `plugin.ts`
- Necessary because Bun can't resolve `@`-scoped packages at runtime for dynamic imports
- Temporary rewritten files stored in `~/.atomic/.tmp/tools/` and cleaned up on exit

**Conversion** (`discovery.ts:183`):

- `convertToToolDefinition()` — Converts `ToolInput` (Zod) to `ToolDefinition` (JSON Schema)
- Uses `zodToJsonSchema()` from `schema-utils.ts`
- Handler wraps execute with Zod validation and output truncation

**Registration** (`discovery.ts:260`):

```typescript
export async function registerCustomTools(
    client: CodingAgentClient,
): Promise<number> {
    discoveredCustomTools = await loadToolsFromDisk();
    for (const { definition } of discoveredCustomTools) {
        client.registerTool(definition);
    }
    return discoveredCustomTools.length;
}
```

Called from `src/commands/chat.ts` after client creation, before `client.start()`.

#### 4.3 Schema Utilities (`src/sdk/tools/schema-utils.ts`)

`zodToJsonSchema()` converts Zod schemas to JSON Schema format for SDK registration.

#### 4.4 Output Truncation (`src/sdk/tools/truncate.ts`)

`truncateToolOutput()` limits tool output length for context window efficiency.

---

### 5. Sub-Agent Management

#### 5.1 SubagentSessionManager (`src/ui/subagent-session-manager.ts`)

Manages independent sub-agent sessions in the TUI layer:

```typescript
interface SubagentSpawnOptions {
    agentId: string;
    agentName: string;
    task: string;
    systemPrompt?: string;
    model?: string;
    tools?: string[];
}

interface SubagentResult {
    agentId: string;
    success: boolean;
    output: string;
    error?: string;
    toolUses: number;
    durationMs: number;
}
```

**Key features:**

- **Independent sessions**: Each sub-agent gets its own isolated SDK session via `createSession()`
- **Concurrency limiting**: Configurable `maxConcurrent` (default 5) with request queuing
- **Real-time updates**: Status callback updates `ParallelAgentsTree` component
- **Lifecycle tracking**: Running count, session Map, destroyed flag
- **Parallel spawning**: `spawnParallel(agents[])` uses `Promise.allSettled()`
- **Cancellation**: `cancel(agentId)` and `cancelAll()` destroy sessions
- **Cleanup**: Always destroys session in `finally` block

**Session flow** (`executeSpawn()`, line 283):

1. Create independent session via `createSession(config)`
2. Store session in tracking Map
3. Emit "running" status
4. Stream response, tracking tool uses and text
5. Build truncated summary (max 2000 chars)
6. Emit "completed" status
7. Destroy session in `finally`
8. Process next queued request

**Factory pattern**: Uses `CreateSessionFn = (config?) => Promise<Session>` for decoupling from `CodingAgentClient`

#### 5.2 Sub-Agent Events (`src/sdk/types.ts`)

```typescript
type EventType = ... | "subagent.start" | "subagent.complete";

interface SubagentStartEventData {
  subagentId: string;
  subagentType?: string;
  task?: string;
}

interface SubagentCompleteEventData {
  subagentId: string;
  result?: unknown;
  success: boolean;
}
```

#### 5.3 Agent Commands (`src/ui/commands/agent-commands.ts`)

TUI commands for managing sub-agents (referenced in grep results but not fully read — likely handles `/agent` command dispatch).

---

### 6. TUI Integration

#### 6.1 Chat Interface (`src/ui/chat.tsx`)

The main TUI component integrates:

- Sub-agent session management via `SubagentSessionManager`
- Tool registration via `registerCustomTools(client)` (from `src/commands/chat.ts`)
- Workflow command dispatch
- Real-time parallel agent tree visualization

#### 6.2 Command Registry

Commands are registered in a global registry (`src/ui/commands/registry.ts`):

- Workflow commands registered via `registerWorkflowCommands()`
- Each workflow becomes a `/` slash command
- Agent commands handle sub-agent operations

#### 6.3 Workflow Session State in UI

The TUI tracks workflow sessions with:

- `WorkflowSession` — Session metadata (step, paths, timestamps)
- Active sessions Map for multi-session support
- Step progression: research → create_spec → spec_review → implement → complete

---

### 7. SDK Client Interface (`src/sdk/types.ts`)

```typescript
interface CodingAgentClient {
    readonly agentType: AgentType;
    createSession(config?: SessionConfig): Promise<Session>;
    resumeSession(sessionId: string): Promise<Session | null>;
    on<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void;
    registerTool(tool: ToolDefinition): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    getModelDisplayInfo(modelHint?: string): Promise<ModelDisplayInfo>;
}

interface Session {
    readonly id: string;
    send(message: string): Promise<AgentMessage>;
    stream(message: string): AsyncIterable<AgentMessage>;
    summarize(): Promise<void>;
    getContextUsage(): Promise<ContextUsage>;
    getSystemToolsTokens(): number;
    destroy(): Promise<void>;
}

interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (
        input,
        context: ToolContext,
    ) => ToolHandlerResult | Promise<ToolHandlerResult>;
}
```

Three implementations exist: `src/sdk/claude-client.ts`, `src/sdk/opencode-client.ts`, `src/sdk/copilot-client.ts`

---

## Code References

### Graph Engine

- `src/graph/types.ts` — All core type definitions (BaseState, NodeDefinition, CompiledGraph, GraphConfig)
- `src/graph/builder.ts:694` — `graph<TState>()` factory function
- `src/graph/compiled.ts:232` — `GraphExecutor.execute()` entry point
- `src/graph/compiled.ts:266` — `GraphExecutor.stream()` async generator
- `src/graph/compiled.ts:510` — Model resolution chain
- `src/graph/compiled.ts:547` — Retry logic with exponential backoff
- `src/graph/annotation.ts:68` — `Reducers` built-in reducer functions
- `src/graph/annotation.ts:309` — `AtomicStateAnnotation` schema
- `src/graph/annotation.ts:549` — `RalphStateAnnotation` schema
- `src/graph/annotation.ts:463` — `RalphWorkflowState` interface
- `src/graph/index.ts` — Re-exports entire graph API surface

### Node Factories

- `src/graph/nodes.ts:100` — `ClientProvider` type
- `src/graph/nodes.ts:113` — `setClientProvider(provider)`
- `src/graph/nodes.ts:163` — `agentNode<TState>(config)` factory
- `src/graph/nodes.ts:362` — `toolNode<TState>(config)` factory
- `src/graph/nodes.ts:487` — `clearContextNode<TState>(config)` factory
- `src/graph/nodes.ts:586` — `decisionNode<TState>(config)` factory
- `src/graph/nodes.ts:676` — `waitNode<TState>(config)` factory
- `src/graph/nodes.ts:833` — `askUserNode<TState>(config)` factory
- `src/graph/nodes.ts:981` — `parallelNode<TState>(config)` factory
- `src/graph/nodes.ts:1032` — `CompiledSubgraph<TSubState>` interface
- `src/graph/nodes.ts:1097` — `WorkflowResolver` type
- `src/graph/nodes.ts:1111` — `setWorkflowResolver(resolver)`
- `src/graph/nodes.ts:1159` — `subgraphNode<TState>(config)` factory
- `src/graph/nodes.ts:1367` — `contextMonitorNode<TState>(config)` factory

### Ralph Workflow

- `src/workflows/index.ts:1-51` — Module exports
- `src/workflows/ralph/workflow.ts:40` — `RALPH_NODE_IDS` constant
- `src/workflows/ralph/workflow.ts:169` — `createRalphWorkflow()` factory
- `src/workflows/ralph/executor.ts:236` — `RalphExecutor.run()` (partially implemented)
- `src/workflows/ralph/session.ts:50` — `RalphSession` interface
- `src/graph/nodes/ralph-nodes.ts:96` — `checkCompletionNode()` factory
- `src/graph/nodes/ralph-nodes.ts:202` — `RalphWorkflowState` interface
- `src/graph/nodes/ralph-nodes.ts:324` — `createRalphWorkflowState()` factory
- `src/graph/nodes/ralph-nodes.ts:429` — `workflowStateToSession(state)`
- `src/graph/nodes/ralph-nodes.ts:505` — `buildSpecToTasksPrompt(spec)`

### Custom Tools

- `src/sdk/tools/plugin.ts:10` — `ToolInput<Args>` interface
- `src/sdk/tools/plugin.ts:40` — `tool()` helper function
- `src/sdk/tools/discovery.ts:45` — `TOOL_SEARCH_PATHS` constant
- `src/sdk/tools/discovery.ts:127` — `discoverToolFiles()` function
- `src/sdk/tools/discovery.ts:219` — `loadToolsFromDisk()` function
- `src/sdk/tools/discovery.ts:260` — `registerCustomTools(client)` function
- `src/sdk/tools/discovery.ts:183` — `convertToToolDefinition()` Zod→JSON Schema conversion

### Workflow Commands

- `src/ui/commands/workflow-commands.ts:51` — `parseRalphArgs(args)` parser
- `src/ui/commands/workflow-commands.ts:94` — `WorkflowMetadata` interface
- `src/ui/commands/workflow-commands.ts:219` — `CUSTOM_WORKFLOW_SEARCH_PATHS`
- `src/ui/commands/workflow-commands.ts:254` — `discoverWorkflowFiles()`
- `src/ui/commands/workflow-commands.ts:313` — `loadWorkflowsFromDisk()`
- `src/ui/commands/workflow-commands.ts:369` — `getAllWorkflows()`
- `src/ui/commands/workflow-commands.ts:485` — `resolveWorkflowRef(name)` with circular dep detection
- `src/ui/commands/workflow-commands.ts:556` — `BUILTIN_WORKFLOW_DEFINITIONS`
- `src/ui/commands/workflow-commands.ts:802` — `initializeWorkflowResolver()`
- `src/ui/commands/workflow-commands.ts:825` — `registerWorkflowCommands()`

### Sub-Agent Management

- `src/ui/subagent-session-manager.ts:23` — `SubagentSpawnOptions` interface
- `src/ui/subagent-session-manager.ts:41` — `SubagentResult` interface
- `src/ui/subagent-session-manager.ts:106` — `SubagentSessionManager` class
- `src/ui/subagent-session-manager.ts:145` — `spawn(options)` method
- `src/ui/subagent-session-manager.ts:173` — `spawnParallel(agents[])` method
- `src/ui/subagent-session-manager.ts:283` — `executeSpawn(options)` private method

### SDK Types

- `src/sdk/types.ts:114` — `SessionConfig` interface
- `src/sdk/types.ts:201` — `Session` interface
- `src/sdk/types.ts:481` — `ToolContext` interface
- `src/sdk/types.ts:500` — `ToolDefinition` interface
- `src/sdk/types.ts:526` — `CodingAgentClient` interface
- `src/sdk/types.ts:556` — `registerTool(tool)` method

---

## Architecture Documentation

### Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TUI Layer (src/ui/)                       │
│  ┌──────────────┐ ┌────────────────┐ ┌───────────────────┐  │
│  │ chat.tsx      │ │ workflow-cmds  │ │ agent-commands    │  │
│  │ (main render) │ │ (slash cmds)   │ │ (sub-agent mgmt) │  │
│  └──────────────┘ └────────────────┘ └───────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ SubagentSessionManager (independent session lifecycle)│  │
│  └────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                  Workflow Layer (src/workflows/)             │
│  ┌──────────────┐ ┌────────────────┐                        │
│  │ Ralph        │ │ Custom         │ (.atomic/workflows/)   │
│  │ workflow.ts  │ │ workflows      │ (~/.atomic/workflows/) │
│  │ executor.ts  │ │ (dynamically   │                        │
│  │ session.ts   │ │  loaded)       │                        │
│  └──────────────┘ └────────────────┘                        │
├─────────────────────────────────────────────────────────────┤
│                  Graph Engine (src/graph/)                   │
│  ┌──────────────┐ ┌────────────────┐ ┌───────────────────┐  │
│  │ builder.ts   │ │ compiled.ts    │ │ nodes.ts          │  │
│  │ (fluent API) │ │ (executor)     │ │ (node factories)  │  │
│  └──────────────┘ └────────────────┘ └───────────────────┘  │
│  ┌──────────────┐ ┌────────────────┐                        │
│  │ types.ts     │ │ annotation.ts  │                        │
│  │ (core types) │ │ (state mgmt)   │                        │
│  └──────────────┘ └────────────────┘                        │
├─────────────────────────────────────────────────────────────┤
│                  SDK Layer (src/sdk/)                        │
│  ┌──────────────┐ ┌────────────────┐ ┌───────────────────┐  │
│  │ types.ts     │ │ claude-client  │ │ copilot-client    │  │
│  │ (interfaces) │ │ opencode-client│ │ (implementations) │  │
│  └──────────────┘ └────────────────┘ └───────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐│
│  │ tools/ (discovery.ts, plugin.ts, schema-utils.ts)       ││
│  │ Custom tool loading from .atomic/tools/ & ~/.atomic/    ││
│  └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Data Flow: Workflow Execution

```
User types /ralph "prompt"
    │
    ▼
workflow-commands.ts: parseRalphArgs() → createWorkflowCommand()
    │
    ▼
createRalphWorkflow() → graph<RalphWorkflowState>()
    │                     .start(initSession)
    │                     .loop([clearCtx, implement], {until})
    │                     .then(checkCompletion)
    │                     .end()
    │                     .compile(config)
    ▼
GraphExecutor.execute(initialState)
    │
    ▼
For each node:
    │ resolve model → execute(ctx) → process signals → checkpoint state
    │
    ├── agentNode: clientProvider(type) → client.createSession() → stream() → destroy()
    ├── toolNode: execute(args) → outputMapper(result, state)
    ├── decisionNode: evaluate routes → goto target
    ├── subgraphNode: resolve workflow name → execute nested graph
    └── askUserNode: emit human_input_required → wait for response
```

### Data Flow: Custom Tool Registration

```
Application startup (src/commands/chat.ts)
    │
    ▼
registerCustomTools(client)
    │
    ▼
discoverToolFiles()
    │ scan .atomic/tools/ and ~/.atomic/tools/
    │ collect .ts/.js files
    ▼
loadToolsFromDisk()
    │ for each file:
    │   prepareToolFileForImport() — rewrite @atomic/plugin imports
    │   dynamic import()
    │   extract default + named exports
    │   isToolExport() type guard
    │   convertToToolDefinition() — Zod → JSON Schema
    ▼
client.registerTool(definition)
    │ for each loaded tool
    ▼
Tools available to AI agent during sessions
```

### Data Flow: Sub-Agent Lifecycle

```
TUI triggers sub-agent spawn
    │
    ▼
SubagentSessionManager.spawn(options)
    │
    ├── Check concurrency limit (default 5)
    │   ├── Under limit → executeSpawn()
    │   └── At limit → queue in pendingQueue
    ▼
executeSpawn():
    1. createSession(config) — independent session
    2. sessions.set(agentId, session)
    3. onStatusUpdate("running")
    4. for await (msg of session.stream(task)):
    │     ├── tool_use → increment toolUses, update status
    │     └── text → accumulate summary
    5. truncate summary (max 2000 chars)
    6. onStatusUpdate("completed")
    7. finally: session.destroy(), sessions.delete(), runningCount--
    8. processQueue() — start next pending if any
```

### Dependency Injection Patterns

The codebase uses global setter/getter patterns for loose coupling:

1. **`setClientProvider(provider)`** (`nodes.ts:113`) — Injects the SDK client factory into graph agent nodes
2. **`setWorkflowResolver(resolver)`** (`nodes.ts:1111`) — Injects workflow name resolution into subgraph nodes
3. **`CreateSessionFn`** (`subagent-session-manager.ts:69`) — Factory function decouples session creation from client

---

## Historical Context (from research/)

### Relevant Previous Research

- `research/docs/2026-01-31-atomic-current-workflow-architecture.md` — Prior documentation of workflow architecture
- `research/docs/2026-01-31-graph-execution-pattern-design.md` — Design patterns for the graph execution engine
- `research/docs/2026-01-31-sdk-migration-and-graph-execution.md` — SDK migration notes related to graph execution
- `research/docs/2026-01-31-workflow-config-semantics.md` — Workflow configuration semantics
- `research/docs/2026-02-02-atomic-builtin-workflows-research.md` — Built-in workflow research
- `research/docs/2026-02-03-custom-workflow-file-format.md` — Custom workflow file format design
- `research/docs/2026-02-03-workflow-composition-patterns.md` — Workflow composition patterns including subgraph
- `research/docs/2026-02-03-model-params-workflow-nodes-message-queuing.md` — Model params and message queuing in nodes
- `research/docs/2026-02-05-pluggable-workflows-sdk-design.md` — Pluggable workflow SDK design
- `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md` — Sub-agent UI with independent context
- `research/docs/2026-02-09-163-ralph-loop-enhancements.md` — Ralph loop enhancement research
- `research/docs/2026-02-09-165-custom-tools-directory.md` — Custom tools directory research
- `research/docs/2026-02-09-166-context-command-session-usage.md` — Context command session usage

### Supplementary Agent Documentation

During this research, three detailed reference documents were generated by sub-agents:

- `docs/graph-execution-engine.md` (37KB) — Comprehensive graph engine reference
- `docs/sdk-tools-system.md` (30KB) — SDK tools system reference
- `docs/tui-layer.md` (39KB) — TUI layer reference

---

## Open Questions

1. **Custom tools in workflow nodes**: Currently, custom tools are registered at the SDK client level via `registerCustomTools(client)`. Graph `toolNode()` uses its own `execute` function. How should custom tools from `.atomic/tools/` be made available as first-class graph nodes? One approach: a `customToolNode()` factory that wraps a discovered tool's handler, or bridging through `agentNode()` where the agent has access to registered tools.

2. **Sub-agent orchestration in graphs**: The `SubagentSessionManager` operates in the TUI layer independently of the graph engine. Graph `parallelNode()` defines branches by node IDs, not by sub-agent sessions. How should the graph engine natively support sub-agent spawning within nodes? Options include: extending `agentNode()` to support concurrent sub-agents, creating a new `subagentNode()` factory, or bridging `SubagentSessionManager` into graph execution context.

3. **Tool availability in agent nodes**: `agentNode()` accepts a `tools` config (string array of tool names), which is passed to `SessionConfig.tools`. This relies on the SDK client having tools registered. The custom tools from `.atomic/tools/` are registered with the client before session start, so they should already be available to agent nodes — but this flow is implicit rather than declarative in the graph definition.

4. **Workflow-to-tool bridging**: There is no current mechanism for a workflow to directly invoke a custom tool defined in `.atomic/tools/` without going through an agent session. The `toolNode()` factory requires an explicit `execute` function, not a tool name reference. A bridge function could load a tool by name from the discovered tools and return its handler.

5. **Sub-agent auto-discovery**: The TUI has built-in sub-agent types (explore, task, general-purpose, code-review from the agent commands), but these are not formalized as a discoverable registry. Making sub-agents discoverable (similar to tools and workflows) would enable workflow graphs to reference sub-agents by name.

6. **RalphExecutor integration**: The `RalphExecutor.run()` method currently returns a placeholder result. The actual integration between `RalphExecutor` and `GraphExecutor` is not yet complete.
