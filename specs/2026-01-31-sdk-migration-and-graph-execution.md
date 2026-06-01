# SDK Migration and Graph Execution Pattern Technical Design Document

| Document Metadata      | Details            |
| ---------------------- | ------------------ |
| Author(s)              | lavaman131         |
| Status                 | Draft (WIP)        |
| Team / Owner           | bastani-inc/atomic |
| Created / Last Updated | 2026-01-31         |

## 1. Executive Summary

This RFC proposes a comprehensive architectural upgrade for the Atomic CLI, introducing two interconnected systems: (1) **Thin SDK Adapters** that expose native SDK functionality with minimal abstraction, and (2) a **Graph Execution Engine** implementing a Pregel-based StateGraph pattern with a fluent API for orchestrating agentic workflows.

**Core Design Principle: Use SDK Features, Don't Reimplement**

Rather than building a heavy abstraction layer, we leverage each SDK's native capabilities:

- **Claude V2 SDK:** Use `send()`/`stream()` directly, auto-compaction via `PreCompact` hook
- **OpenCode SDK:** Use native `session.summarize()`, event subscription, plugin system
- **Copilot SDK:** Use native 31 event types, built-in `/compact` command

**Key changes:**

- Create thin `CodingAgentClient` adapters that delegate to native SDKs (no message transformation)
- Expose native SDK sessions via `native` accessor for advanced features
- Use SDK's built-in context compaction (not reimplemented)
- Forward native SDK events to graph engine (passthrough, not mapping)
- Implement type-safe graph execution with 6 node types (agent, tool, decision, wait, subgraph, parallel)
- Enable declarative workflow definition via fluent API chaining (`.start()`, `.then()`, `.loop()`, etc.)
- Build OpenTUI-based terminal chat interface with streaming, syntax highlighting, and sticky scroll
- Subscribe to native SDK events for telemetry (no wrapper pattern)
- Support checkpointing for workflow resumption and progress tracking
- Replace current hook-based Ralph implementation with graph-based orchestration

**Impact:** This enables Atomic to orchestrate complex, multi-step AI workflows leveraging the full power of each SDK, reducing code duplication by ~60% while preserving SDK-specific features. The thin adapter pattern ensures we benefit from SDK improvements automatically.

**Research References:**

- [research/docs/2026-01-31-claude-agent-sdk-research.md](../research/docs/2026-01-31-claude-agent-sdk-research.md)
- [research/docs/2026-01-31-github-copilot-sdk-research.md](../research/docs/2026-01-31-github-copilot-sdk-research.md)
- [research/docs/2026-01-31-opencode-sdk-research.md](../research/docs/2026-01-31-opencode-sdk-research.md)
- [research/docs/2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md)
- [research/docs/2026-01-31-sdk-migration-and-graph-execution.md](../research/docs/2026-01-31-sdk-migration-and-graph-execution.md)
- [research/docs/2026-01-31-opentui-library-research.md](../research/docs/2026-01-31-opentui-library-research.md)

## 2. Context and Motivation

### 2.1 Current State

The Atomic CLI currently supports three AI coding agents through separate, incompatible implementations:

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CURRENT IMPLEMENTATION                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ .claude/        │  │ .github/        │  │ .opencode/      │     │
│  │                 │  │                 │  │                 │     │
│  │ settings.json   │  │ hooks.json      │  │ opencode.json   │     │
│  │ SessionEnd hook │  │ 3 hook events   │  │ Plugin SDK      │     │
│  │ Marketplace     │  │ Hook scripts    │  │ Full client API │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
│           │                    │                    │               │
│           ▼                    ▼                    ▼               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              NO UNIFIED ABSTRACTION                          │   │
│  │                                                              │   │
│  │  • Duplicate telemetry implementations                       │   │
│  │  • Different Ralph loop implementations per agent            │   │
│  │  • No shared workflow orchestration                          │   │
│  │  • Hook-based control flow (limited)                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Current Implementation Details:**

| Directory    | Agent          | Hook System                                                           | Ralph Implementation                    | Context Compaction    |
| ------------ | -------------- | --------------------------------------------------------------------- | --------------------------------------- | --------------------- |
| `.claude/`   | Claude Code    | `SessionEnd` only                                                     | Marketplace plugin                      | Not available         |
| `.github/`   | GitHub Copilot | `sessionStart`, `userPromptSubmitted`, `sessionEnd`                   | Hook scripts + external orchestrator    | Not available         |
| `.opencode/` | OpenCode       | `session.created`, `session.status`, `session.deleted` + plugin hooks | SDK plugin with in-session continuation | `session.summarize()` |

**Research Reference:** [2026-01-31-claude-implementation-analysis.md](../research/docs/2026-01-31-claude-implementation-analysis.md), [2026-01-31-github-implementation-analysis.md](../research/docs/2026-01-31-github-implementation-analysis.md), [2026-01-31-opencode-implementation-analysis.md](../research/docs/2026-01-31-opencode-implementation-analysis.md)

### 2.2 The Problem

**Technical Debt:**

1. **Code Duplication:** Ralph loop logic implemented 3 times (~1,200+ lines total) with slight variations
2. **Inconsistent Capabilities:** Only OpenCode supports context compaction; Claude lacks session start hooks
3. **Limited Orchestration:** Hook-based approach cannot express complex workflows (parallel execution, conditional branching)
4. **No Type Safety:** Each agent uses different configuration schemas with no compile-time validation

**User Impact:**

- Ralph loops on Claude/Copilot risk context overflow without compaction
- Adding new workflow patterns requires modifying all three implementations
- Testing workflow behavior requires testing against each agent separately

**Business Impact:**

- New agent integrations require ~400+ lines of boilerplate
- Feature parity across agents is difficult to maintain
- Advanced workflows (e.g., parallel research + implementation) are impossible with current architecture

## 3. Goals and Non-Goals

### 3.1 Functional Goals

**SDK Abstraction Layer (Thin Adapters):**

- [ ] Create `CodingAgentClient` interface as thin adapter (delegates to native SDK)
- [ ] Implement `ClaudeAgentClient` using V2 SDK directly (`send()`/`stream()` pattern)
- [ ] Implement `OpenCodeClient` using native SDK with built-in `session.summarize()`
- [ ] Implement `CopilotClient` using native 31 event types (no event mapping)
- [ ] Expose native SDK sessions via `native` accessor for advanced use cases

**Native SDK Integration (No Reimplementation):**

- [ ] Use Claude V2's built-in context management (auto-compaction via `PreCompact` hook)
- [ ] Use OpenCode's built-in `session.summarize()` for context compaction
- [ ] Use Copilot's built-in `/compact` command for context management
- [ ] Use native SDK hooks directly (no unified hook abstraction)
- [ ] Use native SDK event streams (passthrough, not mapping)

**Graph Execution Engine:**

- [ ] Implement `GraphBuilder<TState>` with fluent API for workflow definition
- [ ] Support 6 node types: `agent`, `tool`, `decision`, `wait`, `subgraph`, `parallel`
- [ ] Implement checkpointing via `Checkpointer` interface with `MemorySaver`, `FileSaver`, `ResearchDirSaver`
- [ ] Support streaming execution via `AsyncGenerator<TState>`
- [ ] Implement retry logic with exponential backoff for node execution

**OpenTUI Chat Interface:**

- [ ] Implement terminal chat UI using `@opentui/core` and `@opentui/react`
- [ ] Support streaming message display with `MarkdownRenderable` and `streaming: true`
- [ ] Implement sticky scroll chat history with `ScrollBoxRenderable`
- [ ] Add syntax-highlighted code blocks via `CodeRenderable`
- [ ] Support keyboard navigation and input handling
- [ ] Implement theme support (dark/light modes)

**Telemetry Integration:**

- [ ] Create unified `TelemetryCollector` interface for cross-SDK event tracking
- [ ] Track workflow execution events (node start/complete, errors, checkpoints)
- [ ] Track SDK session events (create, resume, destroy, message counts)
- [ ] Implement consent-based collection with `DO_NOT_TRACK` support
- [ ] Support JSONL event logging for local analysis
- [ ] Integrate with existing Azure Application Insights backend

**Atomic Workflow Migration:**

- [ ] Migrate Ralph loop to graph-based execution
- [ ] Implement context window monitoring with configurable thresholds
- [ ] Support human-in-the-loop approval for spec review

### 3.2 Non-Goals (Out of Scope)

- [ ] We will NOT implement real-time collaboration features
- [ ] We will NOT build a web-based UI (terminal only)
- [ ] We will NOT support non-TypeScript plugin implementations

## 4. Proposed Solution (High-Level Design)

### 4.1 System Architecture Diagram

```mermaid
%%{init: {'theme':'base', 'themeVariables': { 'primaryColor':'#f8f9fa','primaryTextColor':'#2c3e50','primaryBorderColor':'#4a5568','lineColor':'#4a90e2','secondaryColor':'#ffffff','tertiaryColor':'#e9ecef','background':'#f5f7fa','mainBkg':'#f8f9fa','nodeBorder':'#4a5568','clusterBkg':'#ffffff','clusterBorder':'#cbd5e0','edgeLabelBackground':'#ffffff'}}}%%

flowchart TB
    classDef entrypoint fill:#5a67d8,stroke:#4c51bf,stroke-width:3px,color:#ffffff,font-weight:600
    classDef abstraction fill:#4a90e2,stroke:#357abd,stroke-width:2.5px,color:#ffffff,font-weight:600
    classDef client fill:#667eea,stroke:#5a67d8,stroke-width:2.5px,color:#ffffff,font-weight:600
    classDef graph fill:#48bb78,stroke:#38a169,stroke-width:2.5px,color:#ffffff,font-weight:600
    classDef ui fill:#ed8936,stroke:#dd6b20,stroke-width:2.5px,color:#ffffff,font-weight:600
    classDef telemetry fill:#9f7aea,stroke:#805ad5,stroke-width:2.5px,color:#ffffff,font-weight:600
    classDef external fill:#718096,stroke:#4a5568,stroke-width:2.5px,color:#ffffff,font-weight:600,stroke-dasharray:6 3

    User(("User")):::entrypoint

    subgraph AtomicCore["Atomic Core"]
        direction TB

        subgraph UILayer["Terminal UI Layer"]
            direction LR
            ChatUI["ChatInterface<br><i>@opentui/react</i>"]:::ui
            MessageList["ScrollBoxRenderable<br><i>Sticky Scroll</i>"]:::ui
            InputArea["InputRenderable<br><i>User Input</i>"]:::ui
            CodeBlock["CodeRenderable<br><i>Syntax Highlight</i>"]:::ui
        end

        CLI["atomic CLI<br><i>Commander.js</i>"]:::entrypoint

        subgraph SDKLayer["SDK Abstraction Layer"]
            direction LR
            Interface["CodingAgentClient<br><i>Interface</i>"]:::abstraction
            ClaudeClient["ClaudeAgentClient<br><i>@anthropic-ai/claude-agent-sdk</i>"]:::client
            OpenCodeClient["OpenCodeClient<br><i>@opencode-ai/sdk</i>"]:::client
            CopilotClient["CopilotClient<br><i>@github/copilot-sdk</i>"]:::client
        end

        subgraph GraphEngine["Graph Execution Engine"]
            direction TB
            Builder["GraphBuilder<br><i>Fluent API</i>"]:::graph
            Compiled["CompiledGraph<br><i>Executable</i>"]:::graph
            Nodes["Node Types<br>agent, tool, decision<br>wait, subgraph, parallel"]:::graph
            Checkpointer["Checkpointer<br>Memory, File, ResearchDir"]:::graph
        end

        subgraph TelemetryLayer["Telemetry Layer"]
            direction LR
            Collector["TelemetryCollector<br><i>Unified Events</i>"]:::telemetry
            LocalLog["JSONL Logger<br><i>Local Storage</i>"]:::telemetry
            AppInsights["Azure App Insights<br><i>Remote Upload</i>"]:::telemetry
        end
    end

    subgraph ExternalAPIs["External APIs"]
        direction LR
        Claude["Anthropic API<br><i>claude-sonnet/opus</i>"]:::external
        OpenCode["OpenCode Server<br><i>HTTP/SSE</i>"]:::external
        Copilot["Copilot CLI<br><i>JSON-RPC</i>"]:::external
    end

    User -->|"atomic run/ralph"| ChatUI
    ChatUI --> CLI
    CLI --> Interface
    Interface --> ClaudeClient
    Interface --> OpenCodeClient
    Interface --> CopilotClient

    ClaudeClient --> Claude
    OpenCodeClient --> OpenCode
    CopilotClient --> Copilot

    CLI --> Builder
    Builder -->|".compile()"| Compiled
    Compiled --> Nodes
    Compiled --> Checkpointer

    Compiled -->|"execute()"| Interface

    Interface -->|"events"| Collector
    Compiled -->|"events"| Collector
    Collector --> LocalLog
    Collector --> AppInsights

    ChatUI --> MessageList
    ChatUI --> InputArea
    MessageList --> CodeBlock

    style UILayer fill:#fff7ed,stroke:#ed8936,stroke-width:2px
    style SDKLayer fill:#f0f4ff,stroke:#4a90e2,stroke-width:2px
    style GraphEngine fill:#f0fff4,stroke:#48bb78,stroke-width:2px
    style TelemetryLayer fill:#faf5ff,stroke:#9f7aea,stroke-width:2px
    style ExternalAPIs fill:#f5f5f5,stroke:#718096,stroke-width:2px,stroke-dasharray:8 4
```

### 4.2 Architectural Pattern

**Two-Layer Architecture:**

1. **SDK Abstraction Layer:** Adapter pattern wrapping each vendor SDK behind a unified `CodingAgentClient` interface. Enables swapping backends without workflow changes.

2. **Graph Execution Engine:** Pregel-based StateGraph pattern (inspired by LangGraph.js) with fluent API for declarative workflow definition. Provides type-safe state management, checkpointing, and streaming execution.

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) Section 4.1

### 4.3 Key Components

| Component            | Responsibility                            | Technology Stack                        | Justification                                                                 |
| -------------------- | ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `CodingAgentClient`  | Thin adapter interface for AI agents      | TypeScript interface                    | **Minimal abstraction** - delegates to native SDK methods                     |
| `ClaudeAgentClient`  | Thin wrapper over Claude V2 SDK           | `@anthropic-ai/claude-agent-sdk`        | **Uses V2 `send()`/`stream()` directly** - V1 only for advanced features      |
| `OpenCodeClient`     | Thin wrapper over OpenCode SDK            | `@opencode-ai/sdk/v2/client`            | **Uses native `session.summarize()`**, event subscriptions, and plugin system |
| `CopilotClient`      | Thin wrapper over Copilot SDK             | `@github/copilot-sdk`                   | **Uses native event system** with 31 event types - no custom event mapping    |
| `EventBridge`        | Unified event forwarding (not mapping)    | TypeScript passthrough                  | **Forwards native SDK events** to graph engine - no transformation            |
| `GraphBuilder<T>`    | Fluent API for workflow definition        | TypeScript generics + method chaining   | Type-safe, declarative workflow construction                                  |
| `CompiledGraph<T>`   | Executable graph with state management    | BFS traversal + immutable state         | Deterministic execution with streaming support                                |
| `Checkpointer`       | State persistence for workflow resumption | Interface with Memory/File/ResearchDir  | Enables long-running workflows and failure recovery                           |
| `Annotation<T>`      | Type-safe state with custom reducers      | TypeScript + reducer functions          | Enables complex state merging (arrays concatenate, maps merge by key)         |
| `ChatInterface`      | Terminal chat UI with streaming           | `@opentui/react` + `@opentui/core`      | Native terminal rendering, flexbox layout, streaming support                  |
| `TelemetryCollector` | Listens to native SDK events              | TypeScript + JSONL + Azure App Insights | **Subscribes to SDK event streams** - no wrapper needed                       |

**Design Principle: Thin Adapters, Not Wrappers**

The SDK clients are intentionally thin adapters that:

1. **Expose native SDK types directly** where possible (no type re-mapping)
2. **Forward to native SDK methods** without adding logic
3. **Use SDK's built-in features** (context compaction, streaming, hooks)
4. **Only abstract where truly necessary** (unified session lifecycle for graph nodes)

### 4.4 SDK Features to Use (Not Reimplement)

| Feature                 | Claude SDK                             | OpenCode SDK            | Copilot SDK               | Don't Build                |
| ----------------------- | -------------------------------------- | ----------------------- | ------------------------- | -------------------------- |
| **Context compaction**  | Auto via `PreCompact` hook             | `session.summarize()`   | `/compact` command        | ❌ Custom compaction       |
| **Streaming**           | `session.stream()` yields `SDKMessage` | `event.subscribe()` SSE | `session.on()` callbacks  | ❌ Message transformation  |
| **Tool execution**      | MCP servers via `options.mcpServers`   | Plugin tools            | `defineTool()`            | ❌ Custom tool system      |
| **Hooks/Events**        | `options.hooks` (12 event types)       | Plugin hooks            | `session.on()` (31 types) | ❌ Unified event mapping   |
| **Session persistence** | `sessionId` from messages              | Session CRUD API        | `resumeSession()`         | ❌ Custom persistence      |
| **Permissions**         | `permissionMode` + `canUseTool`        | Plugin `permission.ask` | `onPermissionRequest`     | ❌ Custom permission layer |
| **Subagents**           | `agents` option                        | Built-in agent system   | Custom agents             | ❌ Agent orchestration     |

**What We DO Build (SDK Doesn't Provide):**

| Feature                | Justification                                  |
| ---------------------- | ---------------------------------------------- |
| Graph Execution Engine | Workflow orchestration across SDK boundaries   |
| Fluent API Builder     | Declarative workflow definition                |
| Checkpointing          | Cross-SDK state persistence for long workflows |
| OpenTUI Chat Interface | Unified terminal UI (SDKs are headless)        |
| Telemetry Aggregation  | Cross-SDK analytics (each SDK has its own)     |

## 5. Detailed Design

### 5.1 SDK Abstraction Layer

#### 5.1.1 CodingAgentClient Interface (Thin Adapter Pattern)

The interface is intentionally minimal - it exposes native SDK sessions and only abstracts what's necessary for graph orchestration.

```typescript
// src/sdk/types.ts

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Client as OpenCodeClient } from "@opencode-ai/sdk/v2/client";

/**
 * Minimal session interface - delegates to native SDK sessions
 * Each SDK client returns its native session type wrapped in this interface
 */
export interface CodingAgentSession {
    /** Session identifier */
    readonly id: string;

    /**
     * Send a message - delegates to native SDK
     * Claude: session.send()
     * OpenCode: session.prompt()
     * Copilot: session.send()
     */
    send(message: string): Promise<void>;

    /**
     * Stream responses - returns native SDK message types
     * No transformation - graph nodes handle SDK-specific types
     */
    stream(): AsyncGenerator<unknown>; // Native SDK message type

    /**
     * Context compaction - uses native SDK implementation
     * Claude: session recreation (SDK handles internally)
     * OpenCode: session.summarize() (built-in)
     * Copilot: /compact command (SDK handles internally)
     */
    compact?(): Promise<void>;

    /** Close session - delegates to native SDK */
    close(): Promise<void>;

    /** Access to underlying native session for advanced use cases */
    readonly native: unknown;
}

/**
 * Thin adapter interface - no custom event system
 * SDKs provide their own event subscriptions
 */
export interface CodingAgentClient<TSession = CodingAgentSession> {
    /** Create session using native SDK - returns wrapped native session */
    createSession(config: CodingAgentSessionConfig): Promise<TSession>;

    /** Resume session using native SDK */
    resumeSession(sessionId: string): Promise<TSession>;

    /**
     * Subscribe to native SDK events (passthrough, not transformation)
     * Returns native SDK event stream
     */
    events(): AsyncGenerator<unknown>;

    /** Lifecycle methods */
    start(): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Session config - passes through to native SDK options
 * Each client maps to its SDK's native config format
 */
export interface CodingAgentSessionConfig {
    model: string;
    sessionId?: string;
    systemPrompt?: string | { type: "preset"; preset: "claude_code" };
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    maxTurns?: number;
    // SDK-specific options passed through
    nativeOptions?: Record<string, unknown>;
}
```

**Design Rationale:**

- **No custom `AgentMessage` type** - use native SDK message types directly
- **No unified event mapping** - subscribe to native SDK event streams
- **`native` accessor** - allows advanced use cases to access full SDK features
- **`compact()`** - uses SDK's built-in context management (not reimplemented)

**Research Reference:** [2026-01-31-sdk-migration-and-graph-execution.md](../research/docs/2026-01-31-sdk-migration-and-graph-execution.md) "Unified SDK Abstraction Layer" section

#### 5.1.2 ClaudeAgentClient Implementation (V2-First, Thin Adapter)

**Design Principle:** Use Claude V2 SDK directly - no session wrapping, no message transformation, native hooks.

```typescript
// src/sdk/claude-client.ts

import {
    unstable_v2_createSession,
    unstable_v2_resumeSession,
    type Session as ClaudeV2Session,
    type SDKMessage,
    type Options,
} from "@anthropic-ai/claude-agent-sdk";
import type {
    CodingAgentClient,
    CodingAgentSession,
    CodingAgentSessionConfig,
} from "./types";

/**
 * Thin adapter over Claude Agent SDK V2
 * - Exposes native V2 session directly
 * - No message transformation
 * - Hooks passed through to SDK
 */
export class ClaudeAgentClient implements CodingAgentClient<ClaudeSession> {
    private sessions = new Map<string, ClaudeV2Session>();

    constructor(private defaultOptions?: Partial<Options>) {}

    /**
     * Create session - delegates to V2 SDK, returns thin wrapper
     */
    async createSession(
        config: CodingAgentSessionConfig,
    ): Promise<ClaudeSession> {
        const session = unstable_v2_createSession({
            model: config.model,
            systemPrompt: config.systemPrompt,
            permissionMode: config.permissionMode ?? "default",
            maxTurns: config.maxTurns,
            // Pass through any SDK-specific options
            ...config.nativeOptions,
            ...this.defaultOptions,
        });

        const sessionId = config.sessionId ?? crypto.randomUUID();
        this.sessions.set(sessionId, session);

        return new ClaudeSession(sessionId, session);
    }

    async resumeSession(sessionId: string): Promise<ClaudeSession> {
        const session = unstable_v2_resumeSession(sessionId, {
            model: this.defaultOptions?.model ?? "claude-sonnet-4-5-20250929",
        });
        this.sessions.set(sessionId, session);
        return new ClaudeSession(sessionId, session);
    }

    /**
     * Events are accessed via native session.stream()
     * No separate event subscription - messages include all events
     */
    async *events(): AsyncGenerator<SDKMessage> {
        // Claude V2 streams events through session.stream()
        // Graph nodes subscribe per-session, not globally
        throw new Error("Use session.stream() for Claude events");
    }

    async start(): Promise<void> {
        // V2 SDK handles connection automatically
    }

    async stop(): Promise<void> {
        for (const session of this.sessions.values()) {
            session.close();
        }
        this.sessions.clear();
    }
}

/**
 * Thin wrapper - exposes native session with minimal abstraction
 */
export class ClaudeSession implements CodingAgentSession {
    constructor(
        public readonly id: string,
        private readonly session: ClaudeV2Session,
    ) {}

    /** Delegates directly to V2 SDK */
    async send(message: string): Promise<void> {
        await this.session.send(message);
    }

    /**
     * Returns native SDKMessage stream - no transformation
     * Graph nodes handle SDK-specific message types
     */
    async *stream(): AsyncGenerator<SDKMessage> {
        yield* this.session.stream();
    }

    /**
     * V2 SDK handles context management internally via auto-compaction
     * No manual compaction needed - SDK triggers PreCompact hook
     */
    async compact(): Promise<void> {
        // V2 SDK handles this automatically when approaching context limit
        // Manual compaction not exposed in V2 - use V1 query() if needed
    }

    async close(): Promise<void> {
        this.session.close();
    }

    /** Access native session for advanced features (hooks, forking via V1) */
    get native(): ClaudeV2Session {
        return this.session;
    }
}
```

**What We DON'T Implement (SDK Provides):**

| Feature             | SDK Provides                           | Our Implementation               |
| ------------------- | -------------------------------------- | -------------------------------- |
| Message streaming   | `session.stream()` yields `SDKMessage` | Pass through directly            |
| Context compaction  | Auto-compaction via `PreCompact` hook  | No wrapper needed                |
| Tool execution      | SDK calls tools via MCP servers        | Configure MCP servers in options |
| Hooks               | `options.hooks` with all event types   | Pass hooks in config             |
| Session persistence | SDK manages session state              | Use `sessionId` from messages    |

**When to Use V1 API:**

For advanced features not in V2, use `query()` directly:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Session forking (not in V2)
const q = query({ prompt, options });
const forked = q.fork();

// Async input stream (not in V2)
const q = query({
    prompt: asyncInputGenerator,
    options,
});
```

**Research Reference:** [2026-01-31-claude-agent-sdk-research.md](../research/docs/2026-01-31-claude-agent-sdk-research.md) "V1 API" and "V2 API" sections

#### 5.1.3 OpenCodeClient Implementation (Native SDK, Built-in Compaction)

**Design Principle:** OpenCode SDK provides the richest feature set - use it directly with no abstraction.

```typescript
// src/sdk/opencode-client.ts

import { createOpencodeClient, type Client } from "@opencode-ai/sdk/v2/client";
import type {
    CodingAgentClient,
    CodingAgentSession,
    CodingAgentSessionConfig,
} from "./types";

/**
 * Thin adapter over OpenCode SDK
 * - Uses native event subscription (SSE)
 * - Uses built-in session.summarize() for context compaction
 * - No message transformation
 */
export class OpenCodeClient implements CodingAgentClient<OpenCodeSession> {
    private client: Client;
    private eventStream?: AsyncGenerator<unknown>;

    constructor(private config: { baseUrl: string; directory: string }) {
        this.client = createOpencodeClient({
            baseUrl: config.baseUrl,
            directory: config.directory,
        });
    }

    async createSession(
        config: CodingAgentSessionConfig,
    ): Promise<OpenCodeSession> {
        const response = await this.client.session.create({
            body: {
                title: config.sessionId ?? `session-${Date.now()}`,
                directory: this.config.directory,
                permission:
                    config.permissionMode === "bypassPermissions"
                        ? "allow"
                        : "ask",
            },
        });

        return new OpenCodeSession(response.id, this.client);
    }

    async resumeSession(sessionId: string): Promise<OpenCodeSession> {
        // Verify session exists
        await this.client.session.get({ path: { sessionID: sessionId } });
        return new OpenCodeSession(sessionId, this.client);
    }

    /**
     * Native SSE event stream - no transformation
     * Yields events like: session.idle, message.part.updated, tool.execute.before/after
     */
    async *events(): AsyncGenerator<unknown> {
        const events = await this.client.event.subscribe();
        yield* events.stream;
    }

    async start(): Promise<void> {
        // SDK handles connection on first API call
    }

    async stop(): Promise<void> {
        // Cleanup handled by event stream
    }

    /** Access native client for advanced operations */
    get native(): Client {
        return this.client;
    }
}

/**
 * Thin wrapper - uses SDK methods directly
 */
export class OpenCodeSession implements CodingAgentSession {
    constructor(
        public readonly id: string,
        private readonly client: Client,
    ) {}

    /** Delegates to SDK session.prompt() */
    async send(message: string): Promise<void> {
        await this.client.session.prompt({
            path: { id: this.id },
            body: { parts: [{ type: "text", text: message }] },
        });
    }

    /**
     * Filter event stream for this session's messages
     * Returns native event objects - no transformation
     */
    async *stream(): AsyncGenerator<unknown> {
        const events = await this.client.event.subscribe();
        for await (const event of events.stream) {
            const props = (event as any).properties;
            if (props?.sessionID !== this.id) continue;
            yield event;
            // Break on session idle
            if (
                (event as any).type === "session.status" &&
                props.status === "idle"
            ) {
                break;
            }
        }
    }

    /**
     * Uses SDK's built-in context compaction - no reimplementation
     * SDK handles: token counting, overflow detection, summary generation
     */
    async compact(): Promise<void> {
        await this.client.session.summarize({ path: { id: this.id } });
    }

    async close(): Promise<void> {
        await this.client.session.delete({ path: { sessionID: this.id } });
    }

    get native(): Client {
        return this.client;
    }
}
```

**SDK Features We Use Directly (No Reimplementation):**

| Feature             | SDK Method                        | Notes                             |
| ------------------- | --------------------------------- | --------------------------------- |
| Context compaction  | `session.summarize()`             | Built-in token counting + summary |
| Auto-compaction     | `compaction.auto` config          | SDK triggers at 95% context       |
| Tool output pruning | `compaction.prune` config         | SDK prunes old outputs            |
| Event subscription  | `event.subscribe()`               | SSE stream with all event types   |
| Session forking     | `session.create({ parentID })`    | Native session hierarchy          |
| Shell execution     | `session.shell()`                 | Execute commands in session       |
| History revert      | `session.revert()` / `unrevert()` | Built-in undo/redo                |

**Plugin Hooks (Use SDK's Plugin System):**

Tools and hooks are configured via `.opencode/plugins/` or `opencode.json`:

```typescript
// .opencode/plugins/telemetry.ts
import type { Plugin } from "@opencode-ai/plugin";

export default {
    event: async ({ event }) => {
        // SDK passes all events - no need for custom event system
        if (event.type === "session.idle") {
            await recordTelemetry(event);
        }
    },
    "tool.execute.before": async ({ tool, args }) => {
        // SDK's native hook - no wrapper needed
    },
} satisfies Plugin;
```

**Research Reference:** [2026-01-31-opencode-sdk-research.md](../research/docs/2026-01-31-opencode-sdk-research.md) "SDK Client API" section

#### 5.1.4 CopilotClient Implementation (Native SDK Events)

**Design Principle:** Copilot SDK has 31 native event types - use them directly, no event mapping.

```typescript
// src/sdk/copilot-client.ts

import {
    CopilotClient as GHCopilotClient,
    defineTool,
} from "@github/copilot-sdk";
import type {
    CodingAgentClient,
    CodingAgentSession,
    CodingAgentSessionConfig,
} from "./types";

/**
 * Thin adapter over GitHub Copilot SDK
 * - Uses native 31 event types directly
 * - No event mapping or transformation
 * - Delegates to SDK's built-in /compact command
 */
export class CopilotClient implements CodingAgentClient<CopilotSession> {
    private client: GHCopilotClient;
    private sessions = new Map<string, any>();

    constructor(
        config: { useStdio?: boolean; port?: number; cliUrl?: string } = {},
    ) {
        if (config.cliUrl) {
            this.client = new GHCopilotClient({ cliUrl: config.cliUrl });
        } else if (config.port) {
            this.client = new GHCopilotClient({ port: config.port });
        } else {
            this.client = new GHCopilotClient({ useStdio: true });
        }
    }

    async createSession(
        config: CodingAgentSessionConfig,
    ): Promise<CopilotSession> {
        const session = await this.client.createSession({
            sessionId: config.sessionId,
            model: config.model ?? "gpt-5",
            systemMessages: config.systemPrompt
                ? [config.systemPrompt as string]
                : undefined,
            // Pass through SDK-specific options
            ...config.nativeOptions,
        });

        this.sessions.set(session.id, session);
        return new CopilotSession(session.id, session);
    }

    async resumeSession(sessionId: string): Promise<CopilotSession> {
        const session = await this.client.resumeSession(sessionId);
        this.sessions.set(sessionId, session);
        return new CopilotSession(sessionId, session);
    }

    /**
     * Subscribe to native Copilot events (31 event types)
     * No mapping - returns SDK event types directly
     */
    async *events(): AsyncGenerator<unknown> {
        // Copilot events come via session.on() callback
        // This provides a unified async generator interface
        const eventQueue: unknown[] = [];
        let resolveNext: ((event: unknown) => void) | null = null;

        // Subscribe to all sessions' events
        for (const session of this.sessions.values()) {
            session.on((event: unknown) => {
                if (resolveNext) {
                    resolveNext(event);
                    resolveNext = null;
                } else {
                    eventQueue.push(event);
                }
            });
        }

        while (true) {
            if (eventQueue.length > 0) {
                yield eventQueue.shift()!;
            } else {
                yield await new Promise((resolve) => {
                    resolveNext = resolve;
                });
            }
        }
    }

    async start(): Promise<void> {
        await this.client.start();
    }

    async stop(): Promise<void> {
        await this.client.stop();
        this.sessions.clear();
    }

    get native(): GHCopilotClient {
        return this.client;
    }
}

/**
 * Thin wrapper - exposes native session with minimal abstraction
 */
export class CopilotSession implements CodingAgentSession {
    constructor(
        public readonly id: string,
        private readonly session: any,
    ) {}

    async send(message: string): Promise<void> {
        await this.session.send({ prompt: message });
    }

    /**
     * Stream events for this session - returns native event objects
     */
    async *stream(): AsyncGenerator<unknown> {
        const eventQueue: unknown[] = [];
        let resolveNext: ((event: unknown) => void) | null = null;
        let isDone = false;

        this.session.on((event: any) => {
            if (resolveNext) {
                resolveNext(event);
                resolveNext = null;
            } else {
                eventQueue.push(event);
            }
            // Session idle signals end of response
            if (event.type === "session.idle") {
                isDone = true;
            }
        });

        while (!isDone) {
            if (eventQueue.length > 0) {
                yield eventQueue.shift()!;
            } else {
                yield await new Promise((resolve) => {
                    resolveNext = resolve;
                });
            }
        }
    }

    /**
     * Uses Copilot's built-in /compact command
     * SDK handles context compression at 95% threshold automatically
     */
    async compact(): Promise<void> {
        // Send /compact command - SDK handles internally
        await this.session.send({ prompt: "/compact" });
    }

    async close(): Promise<void> {
        await this.session.destroy();
    }

    get native(): any {
        return this.session;
    }
}
```

**SDK Features We Use Directly (No Reimplementation):**

| Feature             | SDK Provides                        | Notes                          |
| ------------------- | ----------------------------------- | ------------------------------ |
| 31 event types      | `session.on(callback)`              | All events passthrough         |
| Auto-compaction     | Automatic at 95% context            | No manual trigger needed       |
| Manual compact      | `/compact` slash command            | Via `send()`                   |
| Permission handling | `onPermissionRequest` callback      | SDK's native permission system |
| Custom agents       | Agent profiles in `.github/agents/` | SDK loads automatically        |
| MCP servers         | `mcp-config.json`                   | SDK manages connections        |
| Skills              | Skill definitions                   | SDK's skills system            |

**Native Event Types (Use Directly, No Mapping):**

```typescript
// These are SDK event types - use directly in graph nodes
type CopilotEvent =
    | "session.start"
    | "session.idle"
    | "session.error"
    | "assistant.message"
    | "assistant.message_delta"
    | "tool.execution_start"
    | "tool.execution_complete"
    | "subagent.started"
    | "subagent.completed"
    | "file.edit"
    | "file.create"
    | "file.delete"
    | "permission.requested"
    | "permission.granted"
    | "permission.denied";
// ... and 16 more
```

**Research Reference:** [2026-01-31-github-copilot-sdk-research.md](../research/docs/2026-01-31-github-copilot-sdk-research.md) "Session Lifecycle" and "31 Event Types" sections

#### 5.1.5 Event Bridge (Passthrough, Not Mapping)

**Design Principle:** Don't map events between SDKs - forward native events to graph engine. Each SDK has its own event semantics that should be preserved.

```typescript
// src/sdk/event-bridge.ts

import type { CodingAgentClient, CodingAgentSession } from "./types";

/**
 * EventBridge forwards native SDK events to graph execution
 * - No event mapping or transformation
 * - Graph nodes handle SDK-specific event types
 * - Preserves native event semantics
 */
export class EventBridge {
    private listeners = new Set<(event: NativeEvent) => void>();

    /**
     * Subscribe to all events from all SDKs (passthrough)
     */
    subscribe(handler: (event: NativeEvent) => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    /**
     * Connect a client's event stream to the bridge
     * Events are forwarded as-is with source tag
     */
    async connect(
        client: CodingAgentClient,
        source: "claude" | "copilot" | "opencode",
    ): Promise<void> {
        // Stream native events and tag with source
        for await (const event of client.events()) {
            this.forward({ source, event });
        }
    }

    private forward(nativeEvent: NativeEvent): void {
        for (const listener of this.listeners) {
            listener(nativeEvent);
        }
    }
}

/** Native event with source tag - no transformation */
export interface NativeEvent {
    source: "claude" | "copilot" | "opencode";
    event: unknown; // Native SDK event type
}
```

**Why No Unified Event Mapping:**

1. **SDKs have different semantics** - Claude's `SessionEnd` vs Copilot's `session.idle` mean different things
2. **Information loss** - Mapping loses SDK-specific metadata
3. **Maintenance burden** - SDK updates require mapping updates
4. **Graph nodes are SDK-aware** - They already handle SDK-specific types

**Recommended Pattern: SDK-Aware Graph Nodes**

Instead of unified events, graph nodes handle SDK-specific types:

```typescript
// Graph node that handles all SDK event types
const sessionMonitorNode = agentNode<AtomicState>("monitor", {
    execute: async (ctx) => {
        const session = ctx.state.session;

        // Handle events based on SDK type
        for await (const event of session.stream()) {
            // Claude events
            if (isClaudeMessage(event)) {
                if (event.type === "result" && event.subtype === "success") {
                    return { stateUpdate: { completed: true } };
                }
            }

            // OpenCode events
            if (isOpenCodeEvent(event)) {
                if (
                    event.type === "session.status" &&
                    event.properties.status === "idle"
                ) {
                    return { stateUpdate: { completed: true } };
                }
            }

            // Copilot events
            if (isCopilotEvent(event)) {
                if (event.type === "session.idle") {
                    return { stateUpdate: { completed: true } };
                }
            }
        }
    },
});
```

**Migration from Config-Based Hooks:**

Config-based hooks (`.claude/settings.json`, `.github/hooks/hooks.json`) should be migrated to **native SDK hooks**, not a unified abstraction:

```typescript
// Claude: Use options.hooks directly
const session = unstable_v2_createSession({
    model: "claude-sonnet-4-5-20250929",
    hooks: {
        SessionEnd: [(params) => collectTelemetry(params)],
        PreToolUse: [(params) => validateToolUse(params)],
    },
});

// OpenCode: Use plugin system directly
// .opencode/plugins/telemetry.ts
export default {
    event: async ({ event }) => {
        if (event.type === "session.idle") {
            await collectTelemetry(event);
        }
    },
} satisfies Plugin;

// Copilot: Use session.on() directly
const session = await client.createSession(config);
session.on((event) => {
    if (event.type === "session.idle") {
        collectTelemetry(event);
    }
});
```

**Research Reference:** [2026-01-31-claude-implementation-analysis.md](../research/docs/2026-01-31-claude-implementation-analysis.md), [2026-01-31-github-implementation-analysis.md](../research/docs/2026-01-31-github-implementation-analysis.md), [2026-01-31-opencode-implementation-analysis.md](../research/docs/2026-01-31-opencode-implementation-analysis.md)

### 5.2 Graph Execution Engine

#### 5.2.1 Core Types

```typescript
// src/graph/types.ts

/** Base state that all workflow states must extend */
export interface BaseState {
    executionId: string;
    lastUpdated: Date;
    outputs: Record<string, unknown>;
}

/** Execution context passed to all nodes */
export interface ExecutionContext<TState extends BaseState> {
    state: Readonly<TState>;
    config: GraphConfig;
    errors: ExecutionError[];
    abortSignal?: AbortSignal;
    contextWindowUsage?: number;
}

/** Result returned by node execution */
export interface NodeResult<TState extends BaseState> {
    /** Partial state update to merge */
    stateUpdate?: Partial<TState>;
    /** Override next node(s) instead of following edges */
    goto?: NodeId | NodeId[];
    /** Signals for external handling */
    signals?: Signal[];
}

/** Node identifier */
export type NodeId = string;

/** Node types supported by the engine */
export type NodeType =
    | "agent"
    | "tool"
    | "decision"
    | "wait"
    | "subgraph"
    | "parallel";

/** Base node definition */
export interface NodeDefinition<TState extends BaseState> {
    id: NodeId;
    type: NodeType;
    execute: (ctx: ExecutionContext<TState>) => Promise<NodeResult<TState>>;
    retry?: RetryConfig;
}

/** Retry configuration for node execution */
export interface RetryConfig {
    maxAttempts: number;
    backoffMs: number;
    backoffMultiplier?: number;
    retryOn?: (error: ExecutionError) => boolean;
}

/** Graph configuration */
export interface GraphConfig {
    checkpointer?: Checkpointer;
    maxConcurrency?: number;
    timeout?: number;
    onProgress?: (state: BaseState) => void;
}

/** Signal types for external handling */
export type Signal =
    | { type: "context_window_warning"; usage: number }
    | { type: "checkpoint"; label: string }
    | { type: "human_input_required"; prompt: string }
    | { type: "debug_report_generated"; report: DebugReport };

/** Execution error with context */
export interface ExecutionError {
    nodeId: NodeId;
    error: Error;
    timestamp: Date;
    attempt: number;
}

/** Debug report for error analysis */
export interface DebugReport {
    errorSummary: string;
    stackTrace: string;
    relevantFiles: string[];
    suggestedFixes: string[];
}
```

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "Core Types Hierarchy" section

#### 5.2.2 State Annotation System

```typescript
// src/graph/annotation.ts

/** Annotation for type-safe state with custom reducers */
export interface Annotation<T> {
    default: T;
    reducer?: (current: T, update: T) => T;
}

/** Create a typed annotation */
export function annotation<T>(config: Annotation<T>): Annotation<T> {
    return config;
}

/** Root annotation combining multiple annotations */
export type AnnotationRoot<T extends Record<string, Annotation<any>>> = {
    [K in keyof T]: T[K] extends Annotation<infer U> ? U : never;
};

/** Default reducers for common types */
export const Reducers = {
    /** Replace current value with new value */
    replace: <T>(current: T, update: T): T => update,

    /** Concatenate arrays */
    concat: <T>(current: T[], update: T[]): T[] => [...current, ...update],

    /** Merge objects */
    merge: <T extends object>(current: T, update: Partial<T>): T => ({
        ...current,
        ...update,
    }),

    /** Merge arrays by ID field */
    mergeById: <T extends { id: string }>(current: T[], update: T[]): T[] => {
        const map = new Map(current.map((item) => [item.id, item]));
        for (const item of update) {
            map.set(item.id, item);
        }
        return Array.from(map.values());
    },
};

/** Example: Atomic workflow state annotation */
export const AtomicStateAnnotation = {
    executionId: annotation({ default: "" }),
    lastUpdated: annotation({ default: new Date() }),
    outputs: annotation({ default: {}, reducer: Reducers.merge }),

    researchDoc: annotation({ default: undefined as string | undefined }),
    specDoc: annotation({ default: undefined as string | undefined }),
    specApproved: annotation({ default: false }),

    featureList: annotation({
        default: [] as FeatureItem[],
        reducer: Reducers.mergeById,
    }),
    currentFeature: annotation({
        default: undefined as FeatureItem | undefined,
    }),
    allFeaturesPassing: annotation({ default: false }),

    debugReports: annotation({
        default: [] as DebugReport[],
        reducer: Reducers.concat,
    }),

    prUrl: annotation({ default: undefined as string | undefined }),
    contextWindowUsage: annotation({ default: 0 }),
    iteration: annotation({ default: 0 }),
};

export type AtomicWorkflowState = AnnotationRoot<typeof AtomicStateAnnotation>;
```

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "State Annotation System" section

#### 5.2.3 Node Factory Functions

```typescript
// src/graph/nodes.ts

import type {
    NodeDefinition,
    ExecutionContext,
    NodeResult,
    BaseState,
} from "./types";
import type { CodingAgentClient, SessionConfig } from "../sdk/types";

/** Agent node configuration */
export interface AgentNodeConfig<TState extends BaseState> {
    /** Agent type identifier */
    agentType: string;
    /** System prompt for the agent */
    systemPrompt: string;
    /** Available tools */
    tools?: string[];
    /** Map agent output to state update */
    outputMapper: (
        output: string,
        ctx: ExecutionContext<TState>,
    ) => Partial<TState>;
    /** Session configuration overrides */
    sessionConfig?: Partial<SessionConfig>;
}

/** Create an agent node */
export function agentNode<TState extends BaseState>(
    id: string,
    config: AgentNodeConfig<TState>,
    client: CodingAgentClient,
): NodeDefinition<TState> {
    return {
        id,
        type: "agent",
        async execute(ctx) {
            const session = await client.createSession({
                model: "claude-sonnet-4-5-20250929",
                systemPrompt: config.systemPrompt,
                ...config.sessionConfig,
            });

            try {
                await session.send(JSON.stringify(ctx.state));

                let fullOutput = "";
                for await (const msg of session.stream()) {
                    if (msg.type === "text") {
                        fullOutput += msg.content;
                    }
                }

                return {
                    stateUpdate: config.outputMapper(fullOutput, ctx),
                };
            } finally {
                await session.destroy();
            }
        },
        retry: {
            maxAttempts: 3,
            backoffMs: 1000,
            backoffMultiplier: 2,
        },
    };
}

/** Tool node configuration */
export interface ToolNodeConfig<TState extends BaseState> {
    /** Tool name to execute */
    toolName: string;
    /** Arguments builder */
    args: (ctx: ExecutionContext<TState>) => Record<string, unknown>;
    /** Map tool output to state update */
    outputMapper: (
        output: unknown,
        ctx: ExecutionContext<TState>,
    ) => Partial<TState>;
    /** Execution timeout */
    timeout?: number;
}

/** Create a tool node */
export function toolNode<TState extends BaseState>(
    id: string,
    config: ToolNodeConfig<TState>,
): NodeDefinition<TState> {
    return {
        id,
        type: "tool",
        async execute(ctx) {
            // Execute tool via shell or MCP
            const args = config.args(ctx);
            const result = await executeTool(
                config.toolName,
                args,
                config.timeout,
            );
            return {
                stateUpdate: config.outputMapper(result, ctx),
            };
        },
    };
}

/** Decision node configuration */
export interface DecisionNodeConfig<TState extends BaseState> {
    /** Condition to evaluate */
    condition: (ctx: ExecutionContext<TState>) => NodeId | NodeId[];
    /** Fallback node if condition returns undefined */
    fallback?: NodeId;
}

/** Create a decision node */
export function decisionNode<TState extends BaseState>(
    id: string,
    config: DecisionNodeConfig<TState>,
): NodeDefinition<TState> {
    return {
        id,
        type: "decision",
        async execute(ctx) {
            const nextNode = config.condition(ctx);
            return {
                goto: nextNode ?? config.fallback,
            };
        },
    };
}

/** Wait node configuration (human-in-the-loop) */
export interface WaitNodeConfig<TState extends BaseState> {
    /** Prompt to display for human input */
    prompt: string | ((ctx: ExecutionContext<TState>) => string);
    /** Auto-approve after timeout (optional) */
    autoApprove?: { after: number };
    /** Map human input to state update */
    inputMapper?: (
        input: string,
        ctx: ExecutionContext<TState>,
    ) => Partial<TState>;
}

/** Create a wait node */
export function waitNode<TState extends BaseState>(
    id: string,
    config: WaitNodeConfig<TState>,
): NodeDefinition<TState> {
    return {
        id,
        type: "wait",
        async execute(ctx) {
            const prompt =
                typeof config.prompt === "function"
                    ? config.prompt(ctx)
                    : config.prompt;

            return {
                signals: [{ type: "human_input_required", prompt }],
            };
        },
    };
}

/** Parallel node configuration */
export interface ParallelNodeConfig<TState extends BaseState> {
    /** Branches to execute in parallel */
    branches: NodeDefinition<TState>[];
    /** How to merge branch results */
    mergeStrategy: "all" | "first" | "any";
    /** Custom merge function */
    merge?: (results: Partial<TState>[]) => Partial<TState>;
}

/** Create a parallel node */
export function parallelNode<TState extends BaseState>(
    id: string,
    config: ParallelNodeConfig<TState>,
): NodeDefinition<TState> {
    return {
        id,
        type: "parallel",
        async execute(ctx) {
            const promises = config.branches.map((branch) =>
                branch.execute(ctx),
            );

            let results: NodeResult<TState>[];
            switch (config.mergeStrategy) {
                case "first":
                    results = [await Promise.race(promises)];
                    break;
                case "any":
                    results = [await Promise.any(promises)];
                    break;
                case "all":
                default:
                    results = await Promise.all(promises);
            }

            const stateUpdates = results.map((r) => r.stateUpdate ?? {});
            const mergedState = config.merge
                ? config.merge(stateUpdates)
                : Object.assign({}, ...stateUpdates);

            return { stateUpdate: mergedState };
        },
    };
}
```

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "Node Factory Functions" section

#### 5.2.4 GraphBuilder Fluent API

```typescript
// src/graph/builder.ts

import type { NodeDefinition, NodeId, BaseState, GraphConfig } from "./types";
import { CompiledGraph } from "./compiled";

/** Edge in the graph */
interface Edge {
    from: NodeId;
    to: NodeId;
    condition?: (ctx: ExecutionContext<any>) => boolean;
}

/** Loop configuration */
interface LoopConfig<TState> {
    until: (ctx: ExecutionContext<TState>) => boolean;
    maxIterations?: number;
}

/** Graph builder for fluent API */
export class GraphBuilder<TState extends BaseState> {
    private nodes = new Map<NodeId, NodeDefinition<TState>>();
    private edges: Edge[] = [];
    private startNode?: NodeId;
    private endNodes = new Set<NodeId>();
    private currentNode?: NodeId;
    private conditionalStack: { ifNode: NodeId; elseNode?: NodeId }[] = [];

    /** Set the starting node */
    start(nodeId: NodeId): this {
        this.startNode = nodeId;
        this.currentNode = nodeId;
        return this;
    }

    /** Add a node and connect from current */
    then(node: NodeDefinition<TState>): this {
        this.nodes.set(node.id, node);
        if (this.currentNode && this.currentNode !== node.id) {
            this.edges.push({ from: this.currentNode, to: node.id });
        }
        this.currentNode = node.id;
        return this;
    }

    /** Begin a conditional branch */
    if(condition: (ctx: ExecutionContext<TState>) => boolean): this {
        const decisionNodeId = `decision_${this.nodes.size}`;
        this.conditionalStack.push({ ifNode: decisionNodeId });
        // Actual decision node will be created on .else() or .endif()
        return this;
    }

    /** Alternative branch */
    else(): this {
        const current = this.conditionalStack[this.conditionalStack.length - 1];
        if (current) {
            current.elseNode = this.currentNode;
        }
        return this;
    }

    /** Close conditional block */
    endif(): this {
        this.conditionalStack.pop();
        return this;
    }

    /** Execute nodes in parallel */
    parallel(
        nodes: NodeDefinition<TState>[],
        config?: { merge?: (results: Partial<TState>[]) => Partial<TState> },
    ): this {
        const parallelId = `parallel_${this.nodes.size}`;
        const parallelNode: NodeDefinition<TState> = {
            id: parallelId,
            type: "parallel",
            async execute(ctx) {
                const results = await Promise.all(
                    nodes.map((n) => n.execute(ctx)),
                );
                const stateUpdates = results.map((r) => r.stateUpdate ?? {});
                const merged = config?.merge
                    ? config.merge(stateUpdates)
                    : Object.assign({}, ...stateUpdates);
                return { stateUpdate: merged };
            },
        };
        return this.then(parallelNode);
    }

    /** Create a loop */
    loop(node: NodeDefinition<TState>, config: LoopConfig<TState>): this {
        const loopId = `loop_${node.id}`;
        const loopNode: NodeDefinition<TState> = {
            id: loopId,
            type: "subgraph", // Loops are implemented as subgraphs
            async execute(ctx) {
                let iteration = 0;
                let currentState = ctx.state;

                while (!config.until({ ...ctx, state: currentState })) {
                    if (
                        config.maxIterations &&
                        iteration >= config.maxIterations
                    ) {
                        break;
                    }

                    const result = await node.execute({
                        ...ctx,
                        state: currentState,
                    });
                    currentState = {
                        ...currentState,
                        ...result.stateUpdate,
                        iteration: iteration + 1,
                    } as TState;
                    iteration++;

                    // Check for signals that should break the loop
                    if (
                        result.signals?.some(
                            (s) => s.type === "human_input_required",
                        )
                    ) {
                        return result;
                    }
                }

                return { stateUpdate: currentState };
            },
        };
        return this.then(loopNode);
    }

    /** Add a human-in-the-loop wait point */
    wait(prompt: string, config?: { autoApprove?: { after: number } }): this {
        const waitId = `wait_${this.nodes.size}`;
        const waitNode: NodeDefinition<TState> = {
            id: waitId,
            type: "wait",
            async execute() {
                return {
                    signals: [{ type: "human_input_required", prompt }],
                };
            },
        };
        return this.then(waitNode);
    }

    /** Add error recovery handler */
    catch(
        handler: (
            error: Error,
            ctx: ExecutionContext<TState>,
        ) => Promise<NodeResult<TState>>,
    ): this {
        // Error handling is applied to the previous node
        if (this.currentNode) {
            const node = this.nodes.get(this.currentNode);
            if (node) {
                const originalExecute = node.execute;
                node.execute = async (ctx) => {
                    try {
                        return await originalExecute(ctx);
                    } catch (error) {
                        return handler(error as Error, ctx);
                    }
                };
            }
        }
        return this;
    }

    /** Mark node(s) as terminal */
    end(...nodeIds: NodeId[]): this {
        for (const id of nodeIds) {
            this.endNodes.add(id);
        }
        return this;
    }

    /** Compile the graph for execution */
    compile(config?: GraphConfig): CompiledGraph<TState> {
        if (!this.startNode) {
            throw new Error("Graph must have a start node");
        }
        return new CompiledGraph(
            this.nodes,
            this.edges,
            this.startNode,
            this.endNodes,
            config,
        );
    }
}

/** Create a new graph builder */
export function graph<TState extends BaseState>(): GraphBuilder<TState> {
    return new GraphBuilder<TState>();
}
```

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "Fluent API Chain Methods" section

#### 5.2.5 CompiledGraph Execution

```typescript
// src/graph/compiled.ts

import type {
    NodeDefinition,
    NodeId,
    Edge,
    BaseState,
    GraphConfig,
    ExecutionContext,
    ExecutionError,
} from "./types";
import type { Checkpointer } from "./checkpointer";

export class CompiledGraph<TState extends BaseState> {
    constructor(
        private nodes: Map<NodeId, NodeDefinition<TState>>,
        private edges: Edge[],
        private startNode: NodeId,
        private endNodes: Set<NodeId>,
        private config?: GraphConfig,
    ) {}

    /** Execute the graph with initial state */
    async execute(initialState: Partial<TState>): Promise<TState> {
        const state = this.initializeState(initialState);

        for await (const currentState of this.stream(state)) {
            // Streaming execution
        }

        return this.getCheckpointedState() ?? state;
    }

    /** Stream execution for incremental state updates */
    async *stream(initialState: TState): AsyncGenerator<TState> {
        let state = initialState;
        const visited = new Set<NodeId>();
        const queue: NodeId[] = [this.startNode];
        const errors: ExecutionError[] = [];

        while (queue.length > 0) {
            const currentId = queue.shift()!;

            if (visited.has(currentId) && !this.isLoopNode(currentId)) {
                continue;
            }
            visited.add(currentId);

            const node = this.nodes.get(currentId);
            if (!node) {
                throw new Error(`Node ${currentId} not found`);
            }

            const ctx: ExecutionContext<TState> = {
                state,
                config: this.config ?? {},
                errors,
                abortSignal: undefined,
            };

            try {
                const result = await this.executeWithRetry(node, ctx);

                // Update state
                if (result.stateUpdate) {
                    state = this.mergeState(state, result.stateUpdate);
                    state.lastUpdated = new Date();
                }

                // Checkpoint
                if (this.config?.checkpointer) {
                    await this.config.checkpointer.save(state);
                }

                // Yield current state
                yield state;

                // Handle signals
                if (result.signals) {
                    for (const signal of result.signals) {
                        if (signal.type === "human_input_required") {
                            // Pause execution - caller must resume with human input
                            return;
                        }
                    }
                }

                // Determine next nodes
                if (result.goto) {
                    const nextNodes = Array.isArray(result.goto)
                        ? result.goto
                        : [result.goto];
                    queue.push(...nextNodes);
                } else if (!this.endNodes.has(currentId)) {
                    const outgoingEdges = this.edges.filter(
                        (e) => e.from === currentId,
                    );
                    for (const edge of outgoingEdges) {
                        if (!edge.condition || edge.condition(ctx)) {
                            queue.push(edge.to);
                        }
                    }
                }
            } catch (error) {
                errors.push({
                    nodeId: currentId,
                    error: error as Error,
                    timestamp: new Date(),
                    attempt: 1,
                });
                throw error;
            }
        }
    }

    private async executeWithRetry(
        node: NodeDefinition<TState>,
        ctx: ExecutionContext<TState>,
    ): Promise<NodeResult<TState>> {
        const retryConfig = node.retry ?? { maxAttempts: 1, backoffMs: 0 };
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
            try {
                return await node.execute(ctx);
            } catch (error) {
                lastError = error as Error;

                if (
                    retryConfig.retryOn &&
                    !retryConfig.retryOn({
                        nodeId: node.id,
                        error: lastError,
                        timestamp: new Date(),
                        attempt,
                    })
                ) {
                    throw lastError;
                }

                if (attempt < retryConfig.maxAttempts) {
                    const delay =
                        retryConfig.backoffMs *
                        Math.pow(
                            retryConfig.backoffMultiplier ?? 1,
                            attempt - 1,
                        );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    private initializeState(partial: Partial<TState>): TState {
        return {
            executionId: crypto.randomUUID(),
            lastUpdated: new Date(),
            outputs: {},
            ...partial,
        } as TState;
    }

    private mergeState(current: TState, update: Partial<TState>): TState {
        // Use immutable merge - would use annotation reducers in full implementation
        return { ...current, ...update };
    }

    private isLoopNode(nodeId: NodeId): boolean {
        return nodeId.startsWith("loop_");
    }

    private getCheckpointedState(): TState | undefined {
        // Would retrieve from checkpointer
        return undefined;
    }
}
```

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "Graph Execution Model" section

#### 5.2.6 Checkpointer Implementations

````typescript
// src/graph/checkpointer.ts

import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import type { BaseState } from "./types";

export interface Checkpointer<TState extends BaseState = BaseState> {
    /** Save state checkpoint */
    save(state: TState): Promise<void>;
    /** Load latest checkpoint */
    load(executionId: string): Promise<TState | undefined>;
    /** List all checkpoints */
    list(): Promise<string[]>;
    /** Delete checkpoint */
    delete(executionId: string): Promise<void>;
}

/** In-memory checkpointer for testing */
export class MemorySaver<
    TState extends BaseState,
> implements Checkpointer<TState> {
    private checkpoints = new Map<string, TState>();

    async save(state: TState): Promise<void> {
        this.checkpoints.set(state.executionId, structuredClone(state));
    }

    async load(executionId: string): Promise<TState | undefined> {
        const state = this.checkpoints.get(executionId);
        return state ? structuredClone(state) : undefined;
    }

    async list(): Promise<string[]> {
        return Array.from(this.checkpoints.keys());
    }

    async delete(executionId: string): Promise<void> {
        this.checkpoints.delete(executionId);
    }
}

/** File-based checkpointer */
export class FileSaver<
    TState extends BaseState,
> implements Checkpointer<TState> {
    constructor(private directory: string) {}

    async save(state: TState): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        const path = join(this.directory, `${state.executionId}.json`);
        await writeFile(path, JSON.stringify(state, null, 2));
    }

    async load(executionId: string): Promise<TState | undefined> {
        try {
            const path = join(this.directory, `${executionId}.json`);
            const content = await readFile(path, "utf-8");
            return JSON.parse(content);
        } catch {
            return undefined;
        }
    }

    async list(): Promise<string[]> {
        // Would use readdir and filter .json files
        return [];
    }

    async delete(executionId: string): Promise<void> {
        // Would use unlink
    }
}

/** Research directory checkpointer (Atomic-specific) */
export class ResearchDirSaver<
    TState extends BaseState,
> implements Checkpointer<TState> {
    constructor(private projectRoot: string = process.cwd()) {}

    private get checkpointDir(): string {
        return join(this.projectRoot, "research", "checkpoints");
    }

    async save(state: TState): Promise<void> {
        await mkdir(this.checkpointDir, { recursive: true });

        // Save as YAML frontmatter + JSON for human readability
        const path = join(this.checkpointDir, `${state.executionId}.md`);
        const content = `---
executionId: ${state.executionId}
lastUpdated: ${state.lastUpdated.toISOString()}
---

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
`;
        await writeFile(path, content);
    }

    async load(executionId: string): Promise<TState | undefined> {
        try {
            const path = join(this.checkpointDir, `${executionId}.md`);
            const content = await readFile(path, "utf-8");

            // Extract JSON from code block
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }
            return undefined;
        } catch {
            return undefined;
        }
    }

    async list(): Promise<string[]> {
        // Would use readdir and extract execution IDs
        return [];
    }

    async delete(executionId: string): Promise<void> {
        // Would use unlink
    }
}
````

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "Checkpointing Strategy" section

### 5.3 Atomic Workflow Graph

```typescript
// src/workflows/atomic.ts

import { graph, agentNode, toolNode, decisionNode, waitNode } from "../graph";
import type { AtomicWorkflowState } from "../graph/annotation";
import type { CodingAgentClient } from "../sdk/types";

export function createAtomicWorkflow(client: CodingAgentClient) {
    // Node definitions
    const research = agentNode<AtomicWorkflowState>(
        "research",
        {
            agentType: "codebase-research-analyzer",
            systemPrompt:
                "Analyze the codebase and existing research documents...",
            outputMapper: (output) => ({ researchDoc: output }),
        },
        client,
    );

    const createSpec = agentNode<AtomicWorkflowState>(
        "createSpec",
        {
            agentType: "general",
            systemPrompt:
                "Create a technical specification based on research...",
            outputMapper: (output) => ({ specDoc: output }),
        },
        client,
    );

    const reviewSpec = decisionNode<AtomicWorkflowState>("reviewSpec", {
        condition: (ctx) =>
            ctx.state.specApproved ? "createFeatureList" : "waitForApproval",
        fallback: "waitForApproval",
    });

    const waitForApproval = waitNode<AtomicWorkflowState>("waitForApproval", {
        prompt: (ctx) =>
            `Please review the spec:\n\n${ctx.state.specDoc}\n\nApprove? (yes/no)`,
    });

    const createFeatureList = agentNode<AtomicWorkflowState>(
        "createFeatureList",
        {
            agentType: "codebase-analyzer",
            systemPrompt: "Create a feature list from the spec...",
            outputMapper: (output) => {
                const features = JSON.parse(output);
                return { featureList: features, allFeaturesPassing: false };
            },
        },
        client,
    );

    const selectFeature = decisionNode<AtomicWorkflowState>("selectFeature", {
        condition: (ctx) => {
            const pending = ctx.state.featureList?.find((f) => !f.passes);
            if (pending) {
                return "implementFeature";
            }
            return "createPR";
        },
    });

    const implementFeature = agentNode<AtomicWorkflowState>(
        "implementFeature",
        {
            agentType: "general",
            systemPrompt: "Implement the current feature...",
            outputMapper: (output, ctx) => {
                const currentFeature = ctx.state.currentFeature;
                if (currentFeature) {
                    return {
                        featureList: [{ ...currentFeature, passes: true }],
                        iteration: ctx.state.iteration + 1,
                    };
                }
                return {};
            },
        },
        client,
    );

    const createPR = toolNode<AtomicWorkflowState>("createPR", {
        toolName: "gh",
        args: (ctx) => ({
            command: "pr",
            subcommand: "create",
            title: "Implement features from spec",
            body: ctx.state.specDoc ?? "",
        }),
        outputMapper: (output) => ({ prUrl: String(output) }),
    });

    // Build the graph
    return graph<AtomicWorkflowState>()
        .start("research")
        .then(research)
        .then(createSpec)
        .then(reviewSpec)
        .then(waitForApproval)
        .then(createFeatureList)
        .loop(implementFeature, {
            until: (ctx) => ctx.state.allFeaturesPassing === true,
            maxIterations: 100,
        })
        .then(createPR)
        .end("createPR")
        .compile({
            checkpointer: new ResearchDirSaver(),
        });
}
```

**Research Reference:** [2026-01-31-graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md) "Ralph Loop Pattern" section

### 5.4 OpenTUI Chat Interface

#### 5.4.1 Core Chat Application

```typescript
// src/ui/chat.tsx

import { render, useKeyboard, useTerminalDimensions } from '@opentui/react';
import { createCliRenderer, BoxRenderable, ScrollBoxRenderable, InputRenderable, MarkdownRenderable, CodeRenderable } from '@opentui/core';
import { useState, useCallback } from 'react';
import type { AgentMessage } from '../sdk/types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

interface ChatAppProps {
  onSendMessage: (message: string) => Promise<void>;
  onStreamMessage: () => AsyncGenerator<AgentMessage>;
  onExit: () => void;
}

export function ChatApp({ onSendMessage, onStreamMessage, onExit }: ChatAppProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const { width, height } = useTerminalDimensions();

  useKeyboard((event) => {
    if (event.name === 'escape') {
      onExit();
    }
    if (event.ctrl && event.name === 'c') {
      onExit();
    }
  });

  const handleSubmit = useCallback(async (input: string) => {
    if (!input.trim() || isStreaming) return;

    // Add user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // Create placeholder for assistant response
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), streaming: true },
    ]);

    setIsStreaming(true);

    try {
      await onSendMessage(input);

      // Stream response
      for await (const chunk of onStreamMessage()) {
        if (chunk.type === 'text') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk.content } : m
            )
          );
        }
      }
    } finally {
      setIsStreaming(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m))
      );
    }
  }, [isStreaming, onSendMessage, onStreamMessage]);

  return (
    <box flexDirection="column" flexGrow={1} width={width} height={height}>
      {/* Header */}
      <box border padding={1} title="Atomic Chat">
        <text fg="#4a90e2">Press ESC to exit | Ctrl+C to cancel</text>
      </box>

      {/* Message History with Sticky Scroll */}
      <scrollbox
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        flexGrow={1}
        border
        title="Messages"
      >
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </scrollbox>

      {/* Input Area */}
      <box border padding={1}>
        <input
          placeholder={isStreaming ? 'Waiting for response...' : 'Type your message...'}
          onSubmit={handleSubmit}
          disabled={isStreaming}
        />
      </box>
    </box>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <box
      flexDirection="column"
      padding={1}
      marginBottom={1}
      backgroundColor={isUser ? '#2d3748' : '#1a365d'}
    >
      <text fg={isUser ? '#a0aec0' : '#63b3ed'} bold>
        {isUser ? 'You' : 'Assistant'}
        {message.streaming && ' (typing...)'}
      </text>

      {/* Render markdown with streaming support */}
      <markdown content={message.content} streaming={message.streaming} />
    </box>
  );
}
```

**Research Reference:** [2026-01-31-opentui-library-research.md](../research/docs/2026-01-31-opentui-library-research.md) "Chat Interface Pattern" section

#### 5.4.2 Streaming Code Blocks

````typescript
// src/ui/code-block.tsx

import { CodeRenderable } from '@opentui/core';

interface CodeBlockProps {
  content: string;
  language: string;
  streaming?: boolean;
}

export function CodeBlock({ content, language, streaming = false }: CodeBlockProps) {
  return (
    <code
      content={content}
      filetype={language}
      syntaxStyle="monokai"
      streaming={streaming}
      border
      padding={1}
    />
  );
}

/**
 * Extract and render code blocks from markdown content
 */
export function extractCodeBlocks(content: string): Array<{ language: string; code: string }> {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const blocks: Array<{ language: string; code: string }> = [];

  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    blocks.push({
      language: match[1] || 'text',
      code: match[2].trim(),
    });
  }

  return blocks;
}
````

#### 5.4.3 Theme System

```typescript
// src/ui/theme.ts

export interface Theme {
  name: string;
  colors: {
    background: string;
    foreground: string;
    accent: string;
    border: string;
    userMessage: string;
    assistantMessage: string;
    error: string;
    success: string;
    warning: string;
  };
}

export const darkTheme: Theme = {
  name: 'dark',
  colors: {
    background: '#1a1a2e',
    foreground: '#edf2f7',
    accent: '#4a90e2',
    border: '#4a5568',
    userMessage: '#2d3748',
    assistantMessage: '#1a365d',
    error: '#fc8181',
    success: '#68d391',
    warning: '#f6e05e',
  },
};

export const lightTheme: Theme = {
  name: 'light',
  colors: {
    background: '#ffffff',
    foreground: '#1a202c',
    accent: '#3182ce',
    border: '#e2e8f0',
    userMessage: '#edf2f7',
    assistantMessage: '#ebf8ff',
    error: '#c53030',
    success: '#276749',
    warning: '#c05621',
  },
};

// Theme context for OpenTUI
import { createContext, useContext } from 'react';

const ThemeContext = createContext<Theme>(darkTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function ThemeProvider({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
```

#### 5.4.4 CLI Integration

```typescript
// src/ui/index.ts

import { render } from '@opentui/react';
import { createCliRenderer } from '@opentui/core';
import { ChatApp } from './chat';
import type { CodingAgentClient, Session } from '../sdk/types';

export async function startChatUI(client: CodingAgentClient, sessionConfig: SessionConfig): Promise<void> {
  const renderer = await createCliRenderer();
  let session: Session | undefined;
  let currentStream: AsyncGenerator<AgentMessage> | undefined;

  const handleSendMessage = async (message: string) => {
    if (!session) {
      session = await client.createSession(sessionConfig);
    }
    await session.send(message);
  };

  const handleStreamMessage = async function* () {
    if (session) {
      currentStream = session.stream();
      yield* currentStream;
    }
  };

  const handleExit = async () => {
    if (session) {
      await session.destroy();
    }
    // IMPORTANT: Unmount before destroying renderer to avoid Yoga crash
    root.unmount();
    await renderer.destroy();
    process.exit(0);
  };

  const root = render(
    <ChatApp
      onSendMessage={handleSendMessage}
      onStreamMessage={handleStreamMessage}
      onExit={handleExit}
    />,
    renderer
  );

  // Handle process signals
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}
```

**Research Reference:** [2026-01-31-opentui-library-research.md](../research/docs/2026-01-31-opentui-library-research.md) "CLI Integration" and "Known Issues" sections

### 5.5 Telemetry Integration

#### 5.5.1 Telemetry Types and Collector

```typescript
// src/telemetry/types.ts

export interface TelemetryEvent {
    eventId: string;
    timestamp: Date;
    eventType: TelemetryEventType;
    sessionId?: string;
    executionId?: string;
    properties: Record<string, unknown>;
}

export type TelemetryEventType =
    // SDK Events
    | "sdk.session.created"
    | "sdk.session.resumed"
    | "sdk.session.destroyed"
    | "sdk.message.sent"
    | "sdk.message.received"
    | "sdk.tool.executed"
    | "sdk.error"
    // Graph Events
    | "graph.execution.started"
    | "graph.execution.completed"
    | "graph.execution.failed"
    | "graph.node.started"
    | "graph.node.completed"
    | "graph.node.failed"
    | "graph.checkpoint.saved"
    | "graph.checkpoint.loaded"
    // Workflow Events
    | "workflow.ralph.started"
    | "workflow.ralph.iteration"
    | "workflow.ralph.completed"
    | "workflow.feature.started"
    | "workflow.feature.completed"
    // UI Events
    | "ui.chat.opened"
    | "ui.chat.closed"
    | "ui.message.submitted";

export interface TelemetryCollector {
    /** Track an event */
    track(event: Omit<TelemetryEvent, "eventId" | "timestamp">): void;
    /** Flush pending events */
    flush(): Promise<void>;
    /** Check if telemetry is enabled */
    isEnabled(): boolean;
    /** Shutdown collector */
    shutdown(): Promise<void>;
}

// src/telemetry/collector.ts

import { writeFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import type {
    TelemetryEvent,
    TelemetryCollector,
    TelemetryEventType,
} from "./types";

export class UnifiedTelemetryCollector implements TelemetryCollector {
    private events: TelemetryEvent[] = [];
    private anonymousId: string;
    private flushInterval: NodeJS.Timeout | undefined;
    private readonly batchSize = 100;
    private readonly flushIntervalMs = 30000; // 30 seconds

    constructor(
        private config: {
            enabled: boolean;
            localLogPath?: string;
            appInsightsKey?: string;
            anonymousId?: string;
        },
    ) {
        this.anonymousId = config.anonymousId ?? this.generateAnonymousId();

        if (config.enabled) {
            this.flushInterval = setInterval(
                () => this.flush(),
                this.flushIntervalMs,
            );
        }
    }

    private generateAnonymousId(): string {
        // Generate stable anonymous ID from machine characteristics
        const os = require("os");
        const crypto = require("crypto");
        const machineId = `${os.hostname()}-${os.userInfo().username}-${os.platform()}`;
        return crypto
            .createHash("sha256")
            .update(machineId)
            .digest("hex")
            .substring(0, 16);
    }

    isEnabled(): boolean {
        // Respect DO_NOT_TRACK environment variable
        if (process.env.DO_NOT_TRACK === "1") return false;
        if (process.env.ATOMIC_TELEMETRY === "0") return false;
        return this.config.enabled;
    }

    track(event: Omit<TelemetryEvent, "eventId" | "timestamp">): void {
        if (!this.isEnabled()) return;

        const fullEvent: TelemetryEvent = {
            ...event,
            eventId: crypto.randomUUID(),
            timestamp: new Date(),
            properties: {
                ...event.properties,
                anonymousId: this.anonymousId,
                platform: process.platform,
                nodeVersion: process.version,
            },
        };

        this.events.push(fullEvent);

        // Auto-flush if batch size reached
        if (this.events.length >= this.batchSize) {
            this.flush();
        }
    }

    async flush(): Promise<void> {
        if (this.events.length === 0) return;

        const eventsToFlush = [...this.events];
        this.events = [];

        // Write to local JSONL log
        if (this.config.localLogPath) {
            await this.writeToLocalLog(eventsToFlush);
        }

        // Send to Azure Application Insights
        if (this.config.appInsightsKey) {
            await this.sendToAppInsights(eventsToFlush);
        }
    }

    private async writeToLocalLog(events: TelemetryEvent[]): Promise<void> {
        const logDir = this.config.localLogPath!;
        await mkdir(logDir, { recursive: true });

        const logFile = join(
            logDir,
            `telemetry-${new Date().toISOString().split("T")[0]}.jsonl`,
        );
        const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";

        await appendFile(logFile, lines);
    }

    private async sendToAppInsights(events: TelemetryEvent[]): Promise<void> {
        // Azure Application Insights ingestion
        const endpoint = "https://dc.services.visualstudio.com/v2/track";

        const telemetryItems = events.map((event) => ({
            name: "Microsoft.ApplicationInsights.Event",
            time: event.timestamp.toISOString(),
            iKey: this.config.appInsightsKey,
            data: {
                baseType: "EventData",
                baseData: {
                    ver: 2,
                    name: event.eventType,
                    properties: {
                        eventId: event.eventId,
                        sessionId: event.sessionId,
                        executionId: event.executionId,
                        ...event.properties,
                    },
                },
            },
        }));

        try {
            await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(telemetryItems),
            });
        } catch (error) {
            // Fail silently - telemetry should not break the application
            console.debug("Telemetry upload failed:", error);
        }
    }

    async shutdown(): Promise<void> {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
        await this.flush();
    }
}
```

#### 5.5.2 SDK Telemetry Integration (Native Event Subscription)

**Design Principle:** Subscribe to native SDK event streams - no wrapper pattern needed.

```typescript
// src/telemetry/sdk-integration.ts

import type { TelemetryCollector } from "./types";
import type { EventBridge, NativeEvent } from "../sdk/event-bridge";

/**
 * Subscribe to EventBridge for cross-SDK telemetry
 * No wrapper pattern - just event subscription
 */
export function connectTelemetry(
    bridge: EventBridge,
    collector: TelemetryCollector,
): () => void {
    return bridge.subscribe((nativeEvent: NativeEvent) => {
        // Track native events directly - no transformation
        collector.track({
            eventType: inferEventType(nativeEvent),
            sessionId: extractSessionId(nativeEvent),
            properties: {
                source: nativeEvent.source,
                nativeType: getNativeType(nativeEvent.event),
                // Include native event for analysis (anonymized)
                eventData: sanitizeForTelemetry(nativeEvent.event),
            },
        });
    });
}

/**
 * Infer telemetry event type from native event
 * Preserves SDK-specific event types in properties
 */
function inferEventType(event: NativeEvent): TelemetryEventType {
    const nativeType = getNativeType(event.event);

    // Session lifecycle
    if (nativeType.includes("session.") || nativeType.includes("Session")) {
        if (
            nativeType.includes("start") ||
            nativeType.includes("created") ||
            nativeType.includes("Start")
        ) {
            return "sdk.session.created";
        }
        if (
            nativeType.includes("idle") ||
            nativeType.includes("End") ||
            nativeType.includes("deleted")
        ) {
            return "sdk.session.destroyed";
        }
        if (nativeType.includes("error")) {
            return "sdk.error";
        }
    }

    // Tool execution
    if (nativeType.includes("tool") || nativeType.includes("Tool")) {
        return "sdk.tool.executed";
    }

    // Messages
    if (nativeType.includes("message") || nativeType.includes("assistant")) {
        return "sdk.message.received";
    }

    return "sdk.message.received";
}

function getNativeType(event: unknown): string {
    return (event as any)?.type ?? (event as any)?.hook_event_name ?? "unknown";
}

function extractSessionId(event: NativeEvent): string {
    const e = event.event as any;
    return e?.session_id ?? e?.sessionId ?? e?.properties?.sessionID ?? "";
}

function sanitizeForTelemetry(event: unknown): Record<string, unknown> {
    // Remove sensitive fields, keep structure for analysis
    const e = event as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    // Safe fields to include
    const safeFields = ["type", "subtype", "hook_event_name", "status"];
    for (const field of safeFields) {
        if (e[field] !== undefined) {
            sanitized[field] = e[field];
        }
    }

    return sanitized;
}
```

**Alternative: Direct SDK Hook Integration**

For SDK-specific telemetry, use native hooks directly:

```typescript
// Claude: Use options.hooks
const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929',
  hooks: {
    SessionStart: [(params) => collector.track({ eventType: 'sdk.session.created', ... })],
    SessionEnd: [(params) => collector.track({ eventType: 'sdk.session.destroyed', ... })],
    PostToolUse: [(params) => collector.track({ eventType: 'sdk.tool.executed', ... })],
  },
});

// OpenCode: Use plugin system
// .opencode/plugins/telemetry.ts
export default {
  event: async ({ event }) => {
    collector.track({ eventType: inferEventType(event), ... });
  },
} satisfies Plugin;

// Copilot: Use session.on()
session.on((event) => {
  collector.track({ eventType: inferEventType(event), ... });
});
```

#### 5.5.3 Graph Telemetry Integration

```typescript
// src/telemetry/graph-integration.ts

import type { GraphConfig, BaseState } from "../graph/types";
import type { TelemetryCollector } from "./types";

/**
 * Create graph config with telemetry hooks
 */
export function withGraphTelemetry<TState extends BaseState>(
    config: GraphConfig,
    collector: TelemetryCollector,
): GraphConfig {
    return {
        ...config,

        onProgress: (state) => {
            collector.track({
                eventType: "graph.node.completed",
                executionId: state.executionId,
                properties: {
                    nodeId: state.outputs.lastNodeId,
                    iteration: (state as any).iteration,
                },
            });

            // Call original handler if exists
            config.onProgress?.(state);
        },
    };
}

/**
 * Track graph execution lifecycle
 */
export function trackGraphExecution<TState extends BaseState>(
    collector: TelemetryCollector,
    executionId: string,
) {
    return {
        started: () => {
            collector.track({
                eventType: "graph.execution.started",
                executionId,
                properties: {},
            });
        },

        completed: (state: TState) => {
            collector.track({
                eventType: "graph.execution.completed",
                executionId,
                properties: {
                    totalIterations: (state as any).iteration ?? 0,
                    featureCount: (state as any).featureList?.length ?? 0,
                },
            });
        },

        failed: (error: Error, nodeId: string) => {
            collector.track({
                eventType: "graph.execution.failed",
                executionId,
                properties: {
                    nodeId,
                    errorMessage: error.message,
                    errorName: error.name,
                },
            });
        },

        checkpointSaved: (label: string) => {
            collector.track({
                eventType: "graph.checkpoint.saved",
                executionId,
                properties: { label },
            });
        },
    };
}
```

#### 5.5.4 Telemetry Configuration

```typescript
// src/telemetry/config.ts

import { join } from "path";
import { homedir } from "os";

export interface TelemetryConfig {
    enabled: boolean;
    localLogPath: string;
    appInsightsKey?: string;
}

export function loadTelemetryConfig(): TelemetryConfig {
    // Check environment variables
    const doNotTrack = process.env.DO_NOT_TRACK === "1";
    const telemetryDisabled = process.env.ATOMIC_TELEMETRY === "0";

    // Default paths
    const dataDir =
        process.platform === "win32"
            ? join(process.env.LOCALAPPDATA ?? homedir(), "atomic")
            : join(
                  process.env.XDG_DATA_HOME ??
                      join(homedir(), ".local", "share"),
                  "atomic",
              );

    return {
        enabled: !doNotTrack && !telemetryDisabled,
        localLogPath: join(dataDir, "telemetry"),
        appInsightsKey: process.env.ATOMIC_APP_INSIGHTS_KEY,
    };
}
```

**Research Reference:** [2026-01-31-claude-implementation-analysis.md](../research/docs/2026-01-31-claude-implementation-analysis.md) "Telemetry Event Structure" section, [2026-01-31-azure-app-insights-backend-integration.md](../research/docs/2026-01-22-azure-app-insights-backend-integration.md)

## 6. Alternatives Considered

| Option                                | Pros                                             | Cons                                                     | Reason for Rejection                                       |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| **A: Keep current hook-based**        | No migration effort, already working             | No unified abstraction, limited workflow patterns        | Cannot express complex workflows                           |
| **B: LangGraph.js directly**          | Battle-tested, good documentation                | Heavy dependency (~500KB), opinionated patterns          | Too heavyweight for CLI tool                               |
| **C: Temporal.io workflows**          | Production-grade, built-in durability            | Requires server infrastructure, complex setup            | Overkill for local CLI workflows                           |
| **D: Custom graph engine (Selected)** | Lightweight, tailored to Atomic needs, type-safe | Implementation effort, less battle-tested                | **Selected:** Best balance of features and simplicity      |
| **E: State machine library (XState)** | Well-documented, visual debugging                | State machines less flexible than graphs, learning curve | Graphs better model agentic workflows with dynamic routing |

**Research Reference:** [2026-01-31-sdk-migration-and-graph-execution.md](../research/docs/2026-01-31-sdk-migration-and-graph-execution.md) "Comparative Analysis" section

## 7. Cross-Cutting Concerns

### 7.1 Security and Privacy

- **Authentication:** Each SDK uses its own authentication:
    - Claude: `ANTHROPIC_API_KEY` environment variable
    - OpenCode: Local server connection (no auth for localhost)
    - Copilot: GitHub OAuth via `gh auth login` or `GITHUB_TOKEN` environment variable
- **Permission Modes:** All clients support `permissionMode` configuration to control tool access
- **Telemetry Privacy:**
    - Consent-based collection with `DO_NOT_TRACK` and `ATOMIC_TELEMETRY=0` opt-out
    - Anonymous ID generated from machine hash (no PII)
    - Local JSONL logs stored in user data directory
    - Remote upload to Azure App Insights only with explicit configuration
- **Data Protection:** Checkpoints stored locally in `research/checkpoints/`, never transmitted

### 7.2 Observability Strategy

- **Metrics:**
    - `graph_execution_duration` (Histogram) - Total workflow execution time
    - `node_execution_count` (Counter) - Executions per node type
    - `checkpoint_save_count` (Counter) - Checkpoint saves
    - `context_window_usage` (Gauge) - Current context usage 0-1
- **Tracing:** Execution ID propagated through all nodes for correlation
- **Alerting:** Context window warning signal at 60% usage threshold

### 7.3 Scalability and Capacity Planning

- **Concurrency:** `maxConcurrency` config limits parallel node execution
- **Memory:** Checkpoints stored on disk, not in memory
- **Context Window:** Automatic compaction via `session.summarize()` (OpenCode) or session recreation (Claude)

### 7.4 Error Handling

```typescript
// Error handling patterns

// 1. Node-level retry with exponential backoff
const nodeWithRetry: NodeDefinition<State> = {
    id: "resilient",
    type: "agent",
    execute: async (ctx) => {
        /* ... */
    },
    retry: {
        maxAttempts: 3,
        backoffMs: 1000,
        backoffMultiplier: 2,
        retryOn: (error) => error.error.message.includes("rate limit"),
    },
};

// 2. Graph-level catch handler
graph<State>()
    .then(riskyNode)
    .catch(async (error, ctx) => {
        // Log error, update state, choose recovery path
        return {
            stateUpdate: { error: error.message },
            goto: "errorRecovery",
        };
    });

// 3. Debug report generation
const debugNode = agentNode<AtomicWorkflowState>(
    "debug",
    {
        agentType: "debugger",
        systemPrompt: "Analyze the error and suggest fixes...",
        outputMapper: (output) => ({
            debugReports: [JSON.parse(output)],
        }),
    },
    client,
);
```

## 8. Migration, Rollout, and Testing

### 8.1 Deployment Strategy

| Phase | Duration | Activities                                               |
| ----- | -------- | -------------------------------------------------------- |
| 1     | Week 1   | Core types, interfaces, and `MemorySaver` checkpointer   |
| 2     | Week 2   | `GraphBuilder` class with fluent API methods             |
| 3     | Week 3   | `CompiledGraph` execution engine with streaming          |
| 4     | Week 4   | SDK client implementations (Claude, OpenCode, Copilot)   |
| 5     | Week 5   | OpenTUI chat interface with streaming and themes         |
| 6     | Week 6   | Telemetry integration (local JSONL + Azure App Insights) |
| 7     | Week 7   | Atomic workflow migration and CLI integration            |
| 8     | Week 8   | Testing, documentation, and rollout                      |

### 8.2 Test Plan

**Unit Tests:**

```typescript
// tests/graph/builder.test.ts
describe("GraphBuilder", () => {
    test("builds linear graph", () => {
        const compiled = graph<TestState>()
            .start("a")
            .then(nodeA)
            .then(nodeB)
            .compile();
        expect(compiled.nodes.size).toBe(2);
    });

    test("loop exits on condition", async () => {
        let iterations = 0;
        const loopNode = {
            id: "counter",
            execute: async () => ({ stateUpdate: { count: ++iterations } }),
        };
        const compiled = graph<{ count: number }>()
            .start("loop")
            .loop(loopNode, { until: (ctx) => ctx.state.count >= 5 })
            .compile();
        const result = await compiled.execute({ count: 0 });
        expect(result.count).toBe(5);
    });
});
```

**Integration Tests:**

```typescript
// tests/sdk/claude-client.test.ts
describe("ClaudeAgentClient", () => {
    test("creates session and streams response", async () => {
        const client = new ClaudeAgentClient();
        const session = await client.createSession({
            model: "claude-sonnet-4-5-20250929",
        });
        await session.send("Hello");
        const messages = [];
        for await (const msg of session.stream()) {
            messages.push(msg);
        }
        expect(messages.length).toBeGreaterThan(0);
    });
});
```

**End-to-End Tests:**
| Test Case | Command | Expected |
| -------------------- | ------------------------------------- | ----------------------------------------- |
| Graph execution | `bun test:e2e:graph` | Workflow completes with checkpoints |
| Ralph loop migration | `atomic ralph setup -a claude "test"` | Uses graph engine, creates checkpoints |
| Context compaction | Long-running workflow | Summarize called at 60% context usage |
| Error recovery | Inject failure mid-workflow | Retries, then falls back to error handler |

### 8.3 Rollback Plan

1. Graph engine is additive - existing hook-based implementations continue to work
2. Feature flag `ATOMIC_USE_GRAPH_ENGINE=1` controls opt-in during rollout
3. If issues arise, disable flag and fall back to hook-based execution

## 9. Open Questions / Unresolved Issues

- [ ] **Claude V2 Stability:** When will `unstable_v2_*` APIs be promoted to stable?
    - _Impact:_ May require API changes when V2 stabilizes
    - _Mitigation:_ Abstract behind `ClaudeAgentClient` interface

- [ ] **Context Window Estimation:** How to estimate context usage for Claude SDK (no API exposed)?
    - _Options:_ Token counting locally, fixed buffer approach
    - _Recommendation:_ Use conservative 60% threshold with session recreation

- [ ] **Parallel Execution Limits:** What is the optimal `maxConcurrency` for parallel nodes?
    - _Impact:_ Rate limiting, resource consumption
    - _Recommendation:_ Default to 3, configurable per graph

- [ ] **OpenTUI Multi-width Characters:** Known issue with Chinese/CJK character highlighting
    - _Impact:_ Visual offset issues with non-ASCII text
    - _Mitigation:_ Consider ASCII-only for critical UI elements, or await upstream fix

- [ ] **Telemetry Consent Flow:** How to prompt for initial consent on first run?
    - _Options:_ Interactive prompt, config file, environment variable only
    - _Recommendation:_ Default to enabled with clear opt-out documentation

## 10. Implementation Checklist

### Phase 1: Core Types (Week 1)

- [ ] Create `src/graph/types.ts` with all type definitions
- [ ] Create `src/graph/annotation.ts` with state annotation system
- [ ] Create `src/graph/checkpointer.ts` with `MemorySaver`
- [ ] Add unit tests for types and annotations

### Phase 2: GraphBuilder (Week 2)

- [ ] Create `src/graph/builder.ts` with fluent API
- [ ] Implement `.start()`, `.then()`, `.end()`
- [ ] Implement `.if()`, `.else()`, `.endif()` conditional logic
- [ ] Implement `.loop()` with exit conditions
- [ ] Implement `.parallel()` with merge strategies
- [ ] Implement `.wait()` for human-in-the-loop
- [ ] Implement `.catch()` for error handling
- [ ] Add unit tests for all builder methods

### Phase 3: CompiledGraph (Week 3)

- [ ] Create `src/graph/compiled.ts` with execution engine
- [ ] Implement BFS traversal with visited tracking
- [ ] Implement state merging with annotation reducers
- [ ] Implement streaming via `AsyncGenerator`
- [ ] Implement retry logic with exponential backoff
- [ ] Implement signal handling (context warning, human input)
- [ ] Add integration tests for execution

### Phase 4: SDK Clients (Week 4) - Thin Adapters

- [ ] Create `src/sdk/types.ts` with thin adapter interface (delegates to native SDKs)
- [ ] Create `src/sdk/claude-client.ts` as thin wrapper over V2 SDK
    - Uses `unstable_v2_createSession()` / `unstable_v2_resumeSession()` directly
    - Returns native `SDKMessage` from `stream()` - no transformation
    - Exposes `native` accessor for V1 features when needed
- [ ] Create `src/sdk/opencode-client.ts` as thin wrapper
    - Uses native `session.summarize()` for compaction
    - Uses native event subscription via `event.subscribe()`
    - No custom event mapping
- [ ] Create `src/sdk/copilot-client.ts` as thin wrapper
    - Uses native 31 event types - no mapping
    - Uses `/compact` command for context management
- [ ] Create `src/sdk/event-bridge.ts` for event passthrough (not mapping)
- [ ] Document which SDK features to use for each capability:
    - Context compaction: SDK built-in (not reimplemented)
    - Event subscription: Native SDK streams (not unified)
    - Session forking: Claude V1 `query().fork()` when needed
- [ ] Add unit tests with mocked SDKs
- [ ] Add integration tests with real SDKs (optional, requires API keys)

### Phase 5: OpenTUI Chat Interface (Week 5)

- [ ] Install `@opentui/core` and `@opentui/react` dependencies
- [ ] Create `src/ui/chat.tsx` with main ChatApp component
- [ ] Implement `MessageBubble` with markdown rendering
- [ ] Create `src/ui/code-block.tsx` with syntax highlighting
- [ ] Create `src/ui/theme.ts` with dark/light themes
- [ ] Create `src/ui/index.ts` with CLI integration
- [ ] Handle renderer lifecycle (unmount before destroy)
- [ ] Add unit tests for UI components
- [ ] Add integration tests for chat flow

### Phase 6: Telemetry Integration (Week 6)

- [ ] Create `src/telemetry/types.ts` with event types
- [ ] Create `src/telemetry/collector.ts` with `UnifiedTelemetryCollector`
- [ ] Implement local JSONL logging
- [ ] Implement Azure Application Insights upload
- [ ] Create `src/telemetry/sdk-integration.ts` with `withTelemetry` wrapper
- [ ] Create `src/telemetry/graph-integration.ts` with graph hooks
- [ ] Create `src/telemetry/config.ts` with configuration loader
- [ ] Implement consent-based collection with opt-out
- [ ] Add unit tests for telemetry collector
- [ ] Add integration tests for event tracking

### Phase 7: Atomic Integration (Week 7)

- [ ] Create `src/workflows/atomic.ts` with workflow definition
- [ ] Create `src/graph/checkpointer.ts` `ResearchDirSaver`
- [ ] Update `atomic ralph setup` to use graph engine
- [ ] Add feature flag `ATOMIC_USE_GRAPH_ENGINE`
- [ ] Integrate OpenTUI chat interface with workflows
- [ ] Update CLI to display graph execution progress
- [ ] Wire up telemetry for workflow events
- [ ] Add end-to-end tests for Ralph workflow

### Phase 8: Rollout (Week 8)

- [ ] Update README with graph engine documentation
- [ ] Document OpenTUI chat interface usage
- [ ] Document telemetry collection and opt-out
- [ ] Create migration guide for existing Ralph users
- [ ] Enable graph engine by default
- [ ] Monitor for issues during rollout
- [ ] Address any reported issues

## 11. File Structure (Post-Implementation)

```
src/
├── sdk/
│   ├── types.ts                  # Thin adapter interface (delegates to native SDKs)
│   ├── claude-client.ts          # Thin wrapper over Claude V2 SDK (no transformation)
│   ├── opencode-client.ts        # Thin wrapper using native summarize(), events
│   ├── copilot-client.ts         # Thin wrapper using native 31 event types
│   ├── event-bridge.ts           # Event passthrough to graph engine (no mapping)
│   └── index.ts                  # Re-exports
├── graph/
│   ├── types.ts                  # Graph type definitions
│   ├── annotation.ts             # State annotation system
│   ├── nodes.ts                  # Node factory functions
│   ├── builder.ts                # GraphBuilder fluent API
│   ├── compiled.ts               # CompiledGraph execution
│   ├── checkpointer.ts           # Checkpointer implementations
│   └── index.ts                  # Re-exports
├── ui/
│   ├── chat.tsx                  # Main ChatApp component
│   ├── code-block.tsx            # Syntax-highlighted code blocks
│   ├── theme.ts                  # Dark/light theme definitions
│   └── index.ts                  # CLI integration and exports
├── telemetry/
│   ├── types.ts                  # TelemetryEvent types
│   ├── collector.ts              # UnifiedTelemetryCollector
│   ├── sdk-integration.ts        # withTelemetry wrapper
│   ├── graph-integration.ts      # Graph execution tracking
│   ├── config.ts                 # Telemetry configuration
│   └── index.ts                  # Re-exports
├── workflows/
│   ├── atomic.ts                 # Atomic workflow definition
│   └── index.ts                  # Re-exports
└── ...

tests/
├── sdk/
│   ├── claude-client.test.ts     # Test V2 SDK delegation
│   ├── opencode-client.test.ts   # Test native summarize(), events
│   ├── copilot-client.test.ts    # Test native event passthrough
│   └── event-bridge.test.ts      # Test event forwarding
├── graph/
│   ├── builder.test.ts
│   ├── compiled.test.ts
│   └── checkpointer.test.ts
├── ui/
│   ├── chat.test.tsx
│   └── theme.test.ts
├── telemetry/
│   ├── collector.test.ts
│   └── integration.test.ts
└── workflows/
    └── atomic.test.ts

research/
├── checkpoints/                  # Workflow checkpoints (gitignored)
│   └── {executionId}.md
└── docs/
    └── 2026-01-31-*.md           # Research documents
```

## 12. Appendix: Research Document Summary

| Document                                                                                                 | Key Findings                                                                     | Relevance             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------- |
| [claude-agent-sdk-research.md](../research/docs/2026-01-31-claude-agent-sdk-research.md)                 | V2 API with `send()`/`stream()` pattern, hooks system, MCP integration           | High - Primary SDK    |
| [github-copilot-sdk-research.md](../research/docs/2026-01-31-github-copilot-sdk-research.md)             | 31 event types, thin client architecture, skills system, permission handling     | High - Primary SDK    |
| [opencode-sdk-research.md](../research/docs/2026-01-31-opencode-sdk-research.md)                         | Production-ready V2, hierarchical sessions, plugin system                        | High - Primary SDK    |
| [claude-implementation-analysis.md](../research/docs/2026-01-31-claude-implementation-analysis.md)       | SessionEnd hook only, YAML frontmatter agents, marketplace plugins               | High - Current state  |
| [github-implementation-analysis.md](../research/docs/2026-01-31-github-implementation-analysis.md)       | 3 hook events, cross-platform commands, external orchestrator for Ralph          | High - Reference      |
| [opencode-implementation-analysis.md](../research/docs/2026-01-31-opencode-implementation-analysis.md)   | Full plugin SDK, in-session continuation, `session.summarize()`                  | High - Best practices |
| [graph-execution-pattern-design.md](../research/docs/2026-01-31-graph-execution-pattern-design.md)       | Pregel-based StateGraph, fluent API, 6 node types, checkpointing                 | High - Core design    |
| [sdk-migration-and-graph-execution.md](../research/docs/2026-01-31-sdk-migration-and-graph-execution.md) | Unified abstraction layer, migration paths, synthesis                            | High - Strategy       |
| [opentui-library-research.md](../research/docs/2026-01-31-opentui-library-research.md)                   | TypeScript/Zig architecture, flexbox layout, streaming support, React reconciler | High - UI Layer       |
