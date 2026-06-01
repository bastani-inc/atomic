---
date: 2026-02-03T16:50:07Z
researcher: Claude Opus 4.5
git_commit: 3ac4293f210df8b4639da065d31591986e54b18a
branch: lavaman131/feature/tui
repository: atomic
topic: "Model Parameters for Workflow Nodes, Custom Workflows, Model Command, Message Queuing, and Multi-Agent Configuration Parsing"
tags:
    [
        research,
        codebase,
        workflow,
        model-config,
        message-queue,
        tui,
        sdk,
        configuration,
        claude-code,
        opencode,
        copilot,
    ]
status: complete
last_updated: 2026-02-03T21:00:00Z
last_updated_by: Claude Opus 4.5
revision: 5
revision_notes: |
    Revision 5: SDK-First Architecture with No Permission Prompts.
    - Use SDK model aliases (opus, sonnet, haiku) directly instead of manual mappings for auto-model updates
    - Claude SDK: settingSources for config loading, supportedModels() for discovery
    - OpenCode SDK: Config.get() for config, Provider.parseModel() for models
    - Copilot SDK: ListModels() for discovery, skillDirectories for skills
    - PERMISSIONS: Use bypassPermissions/auto-approve mode. No permission prompts.
    - AskUserQuestion is HIL (human-in-the-loop) interaction, NOT a permission check.
    - Removed manual normalization where SDKs handle it natively
---

# Research: Model Parameters, Custom Workflows, /model Command, and Message Queuing

## Research Question

Research the codebase to understand how to:

1. Add a model parameter to each node for the coding agent in the workflow
2. Create a basic workflow in `.atomic/workflows` to test defining custom workflows
3. Parse and register configurations from `.claude/`, `.opencode/`, `.github/` directories so models defined in sub-agents, skills, slash commands respect model settings (Atomic does NOT define its own custom format - only `.atomic/workflows/` is Atomic-specific)
4. Create a `/model` built-in command for model selection
5. Allow queuing messages in workflows and chats (study Claude Code's approach)

## Summary

This research covers six major areas for enhancing the Atomic CLI with an **SDK-First approach** - delegating to SDK abstractions wherever possible to minimize manual logic and support auto-model updates:

1. **Per-node model configuration** - Extend `NodeDefinition` with SDK-native aliases (`'opus' | 'sonnet' | 'haiku' | 'inherit'`). SDKs resolve aliases to versioned model IDs automatically.
2. **Custom workflows** - Loaded from `.atomic/workflows/*.ts` files that export a factory function. This is the ONLY Atomic-specific config format.
3. **Multi-agent configuration loading** - **SDK-First**: Claude SDK auto-loads via `settingSources: ['project']`, OpenCode SDK auto-loads via `Config.get()`. Only Copilot agents/instructions require manual parsing.
4. **`/model` command** - Uses SDK discovery (`supportedModels()`, `ListModels()`) instead of hardcoded mappings. Pass aliases directly to `setModel()` - SDK handles resolution.
5. **Message queuing** - Infrastructure exists (`useMessageQueue` hook) but lacks UI integration. Implement Claude Code's "Boundary-aware Queuing" UX pattern.
6. **Permissions** - **None**: Atomic auto-approves all tool executions (no permission prompts). `AskUserQuestion` is HIL for gathering input, not a permission mechanism.

---

## SDK Abstraction Reference (Key Findings)

This section summarizes what each SDK provides that eliminates the need for manual implementation.

### Claude Agent SDK Abstractions

| Feature              | SDK Method/Option                                   | Description                                                     |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Model aliases        | `model: 'opus' \| 'sonnet' \| 'haiku' \| 'inherit'` | SDK resolves to latest versioned model ID                       |
| Model discovery      | `query.supportedModels()`                           | Returns `ModelInfo[]` with id, displayName, description         |
| Runtime model switch | `query.setModel('opus')`                            | Change model mid-session                                        |
| Config loading       | `settingSources: ['project']`                       | Auto-loads `.claude/settings.json`, agents/, skills/, CLAUDE.md |
| **No permissions**   | `permissionMode: 'bypassPermissions'`               | **Atomic uses bypass mode - no permission prompts**             |
| Hooks                | `hooks: { PreToolUse: [...] }`                      | SDK executes hooks, handles responses                           |

### OpenCode SDK Abstractions

| Feature            | SDK Method/Option                                  | Description                                         |
| ------------------ | -------------------------------------------------- | --------------------------------------------------- |
| Config loading     | `Config.get()`                                     | Auto-loads all `.opencode/` configs with precedence |
| Model parsing      | `Provider.parseModel('anthropic/claude-opus-4-5')` | Extracts providerID, modelID                        |
| Model resolution   | `Provider.getModel(providerID, modelID)`           | Returns full model with metadata                    |
| Model state        | `local.model.current()`, `.set()`, `.list()`       | Full model lifecycle management                     |
| **No permissions** | `permission: { "*": "allow" }`                     | **Atomic auto-allows all tools**                    |

### Copilot SDK Abstractions

| Feature            | SDK Method/Option                                   | Description                                      |
| ------------------ | --------------------------------------------------- | ------------------------------------------------ |
| Model discovery    | `client.ListModels()`                               | Returns `ModelInfo[]` with capabilities, billing |
| Model selection    | `SessionConfig.model`                               | Pass model ID directly                           |
| Skill loading      | `skillDirectories: [...]`                           | SDK scans for SKILL.md files                     |
| Tool filtering     | `AvailableTools`, `ExcludedTools`                   | Whitelist/blacklist arrays                       |
| **No permissions** | `OnPermissionRequest: () => ({ kind: 'approved' })` | **Atomic auto-approves all requests**            |

### Permission Philosophy

**Atomic uses NO permission prompts.** All tool executions are auto-approved.

- **AskUserQuestion** is a **Human-in-the-Loop (HIL)** tool for gathering user input, NOT a permission check
- HIL is for clarifying requirements, not for approving tool usage
- This simplifies UX and matches agentic coding patterns

### What Atomic Must Implement (SDK Gaps)

| Component                                 | Reason                                     |
| ----------------------------------------- | ------------------------------------------ |
| `.atomic/workflows/*.ts`                  | Atomic-specific workflow format            |
| `.github/agents/*.md` parsing             | Copilot SDK doesn't auto-load agents       |
| `.github/copilot-instructions.md` parsing | Copilot SDK doesn't auto-load instructions |
| Cross-SDK agent merging                   | Unified @ autocomplete across all SDKs     |

---

## Detailed Findings

### 1. Model Parameter for Workflow Nodes

#### Current Architecture

The workflow graph system uses `NodeDefinition` objects that execute via `ExecutionContext`:

**NodeDefinition** (`src/graph/types.ts:277-295`):

```typescript
export interface NodeDefinition<TState extends BaseState = BaseState> {
    id: NodeId;
    type: NodeType;
    execute: NodeExecuteFn<TState>;
    retry?: RetryConfig;
    name?: string;
    description?: string;
    // NOTE: No model field exists currently
}
```

**ExecutionContext** (`src/graph/types.ts:231-259`):

```typescript
export interface ExecutionContext<TState extends BaseState = BaseState> {
    state: TState;
    config: GraphConfig;
    errors: ExecutionError[];
    abortSignal?: AbortSignal;
    contextWindowUsage?: ContextWindowUsage;
    emit?: (signal: SignalData) => void;
    getNodeOutput?: (nodeId: NodeId) => unknown;
    // NOTE: No model field exists currently
}
```

#### Agent Node Pattern

Agent nodes currently accept model configuration through `AgentNodeConfig.sessionConfig`:

**AgentNodeConfig** (`src/graph/nodes.ts:57-94`):

```typescript
export interface AgentNodeConfig<TState extends BaseState = BaseState> {
    id: NodeId;
    agentType: AgentNodeAgentType;
    systemPrompt?: string;
    tools?: string[];
    outputMapper?: OutputMapper<TState>;
    sessionConfig?: Partial<SessionConfig>; // Contains model field
    retry?: RetryConfig;
    name?: string;
    description?: string;
    buildMessage?: (state: TState) => string;
}
```

**SessionConfig** (`src/sdk/types.ts:114-133`):

```typescript
export interface SessionConfig {
    model?: string; // Model identifier
    sessionId?: string;
    systemPrompt?: string;
    tools?: string[];
    mcpServers?: McpServerConfig[];
    permissionMode?: PermissionMode;
    maxBudgetUsd?: number;
    maxTurns?: number;
    agentMode?: OpenCodeAgentMode;
}
```

#### Proposed Extension

To support per-node model configuration:

1. **Add to NodeDefinition**:

```typescript
export interface NodeDefinition<TState extends BaseState = BaseState> {
    // ...existing fields
    model?: string | "inherit"; // Model ID or 'inherit' from parent
}
```

2. **Add to ExecutionContext**:

```typescript
export interface ExecutionContext<TState extends BaseState = BaseState> {
    // ...existing fields
    model?: string; // Current model for this execution context
}
```

3. **Add to GraphConfig** (for default):

```typescript
export interface GraphConfig<TState extends BaseState = BaseState> {
    // ...existing fields
    defaultModel?: string; // Graph-wide default model
}
```

4. **Update GraphExecutor** (`src/graph/compiled.ts:519-531`):

```typescript
const context: ExecutionContext<TState> = {
    state,
    config: this.config,
    errors,
    abortSignal,
    // Add model resolution: node.model > parent model > config.defaultModel
    model: resolveModel(node, parentContext, this.config),
    emit: (_signal) => {},
    getNodeOutput: (nodeId) => state.outputs[nodeId],
};
```

#### SDK Model Configuration Patterns (SDK-First Approach)

**IMPORTANT**: Use SDK-native model aliases and discovery instead of manual mappings. This ensures auto-model updates are supported without code changes.

**Claude Agent SDK** (use aliases directly - SDK resolves to latest versions):

```typescript
// Subagent definitions - use aliases directly
const agentDef: AgentDefinition = {
    model: "sonnet", // or 'opus', 'haiku', 'inherit'
    // SDK auto-resolves to latest: claude-sonnet-4-5-YYYYMMDD
};

// Runtime model discovery (for /model list)
const models = await query.supportedModels();
// Returns: [{ value: 'claude-opus-4-5-...', displayName: 'Claude Opus 4.5', ... }]

// Runtime model switching
await query.setModel("opus"); // SDK resolves alias
```

**OpenCode SDK** (SDK handles resolution via Provider):

```typescript
// SDK handles model parsing and resolution
const { providerID, modelID } = Provider.parseModel(
    "anthropic/claude-sonnet-4",
);
const model = Provider.getModel(providerID, modelID);

// Use local.model context for state management
local.model.set("anthropic/claude-sonnet-4");
local.model.current(); // Get current model
local.model.list(); // List available models
```

**Copilot SDK** (SDK provides model discovery):

```typescript
// List available models (for /model list)
const models = await client.ListModels();
// Returns: [{ id: 'claude-sonnet-4.5', name: '...', capabilities: {...} }]

// Pass model ID directly - no mapping needed
const session = await client.createSession({ model: "claude-sonnet-4.5" });
```

---

### 2. Custom Workflow Definition Format

#### Current Mechanism

Custom workflows are loaded from `.atomic/workflows/` and `~/.atomic/workflows/` directories.

**Discovery** (`src/ui/commands/workflow-commands.ts:369-392`):

```typescript
export function discoverWorkflowFiles(): {
    path: string;
    source: "local" | "global";
}[] {
    // Searches .atomic/workflows (local) and ~/.atomic/workflows (global)
    // Returns .ts files found
}
```

**Loading** (`src/ui/commands/workflow-commands.ts:428-478`):

```typescript
export async function loadWorkflowsFromDisk(): Promise<WorkflowMetadata[]> {
    const discovered = discoverWorkflowFiles();
    for (const { path, source } of discovered) {
        const module = await import(path);
        // Extract name, description, aliases from module exports
        // Validate default export is a function
        const metadata: WorkflowMetadata = {
            name: module.name ?? filename,
            description: module.description ?? `Custom workflow: ${name}`,
            aliases: module.aliases,
            createWorkflow: module.default,
            defaultConfig: module.defaultConfig,
            source,
        };
    }
}
```

#### Required Exports

A custom workflow file must export:

| Export          | Required | Type                         | Description                          |
| --------------- | -------- | ---------------------------- | ------------------------------------ |
| `default`       | Yes      | `(config?) => CompiledGraph` | Factory function                     |
| `name`          | No       | `string`                     | Workflow name (defaults to filename) |
| `description`   | No       | `string`                     | Human-readable description           |
| `aliases`       | No       | `string[]`                   | Alternative command names            |
| `defaultConfig` | No       | `Record<string, unknown>`    | Default configuration                |

#### Example Workflow File (Using SDK Aliases)

**`.atomic/workflows/test-workflow.ts`**:

```typescript
import { graph, agentNode, toolNode } from "@bastani/atomic/graph";

export const name = "test-workflow";
export const description =
    "A basic test workflow for custom workflow validation";
export const aliases = ["test", "tw"];
export const defaultConfig = {
    maxIterations: 5,
    model: "sonnet", // Use SDK alias - SDK resolves to latest version
};

interface TestWorkflowState extends BaseState {
    message: string;
    result?: string;
}

export default function createTestWorkflow(
    config: Record<string, unknown> = {},
): CompiledGraph<TestWorkflowState> {
    // Use SDK alias directly - no need to map to full model ID
    const model = (config.model as string) ?? defaultConfig.model;

    const greetNode = toolNode<TestWorkflowState, void, string>({
        id: "greet",
        toolName: "greet",
        execute: async () => "Hello from test workflow!",
        outputMapper: (state, result) => ({ result }),
        name: "Greeting",
        description: "Emit a greeting message",
    });

    const agentProcessNode = agentNode<TestWorkflowState>({
        id: "process",
        agentType: "claude",
        // Pass SDK alias directly - SDK handles resolution
        sessionConfig: { model }, // 'sonnet' → claude-sonnet-4-5-YYYYMMDD
        buildMessage: (state) => `Process this: ${state.message}`,
        name: "Process with Agent",
        description: "Use agent to process the message",
    });

    return graph<TestWorkflowState>()
        .start(greetNode)
        .then(agentProcessNode)
        .end()
        .compile();
}
```

---

### 3. Configuration Loading (SDK-First Approach)

**Key Principle**: Delegate configuration loading to SDK abstractions wherever possible. Only implement custom parsing for Atomic-specific features (`.atomic/workflows/`).

#### SDK Configuration Loading Capabilities

| SDK          | Config Loading                | What It Handles                                                          |
| ------------ | ----------------------------- | ------------------------------------------------------------------------ |
| **Claude**   | `settingSources: ['project']` | `.claude/settings.json`, `.claude/agents/`, `.claude/skills/`, CLAUDE.md |
| **OpenCode** | `Config.get()`                | Full `.opencode/` directory, opencode.json, agents, commands, plugins    |
| **Copilot**  | `skillDirectories` option     | Skill loading from specified directories                                 |

#### Claude SDK Configuration Loading

```typescript
// SDK loads all .claude/ configs automatically
const result = query({
    prompt: "...",
    options: {
        settingSources: ["project"], // Loads .claude/settings.json, CLAUDE.md
        systemPrompt: { type: "preset", preset: "claude_code" }, // Required for CLAUDE.md
        // Agents from .claude/agents/ are auto-registered
        // Model from frontmatter (opus, sonnet, haiku) is resolved by SDK
    },
});
```

**Settings precedence** (SDK handles this):

1. Local settings (`.claude/settings.local.json`) - highest
2. Project settings (`.claude/settings.json`)
3. User settings (`~/.claude/settings.json`) - lowest

#### OpenCode SDK Configuration Loading

```typescript
// SDK handles ALL configuration loading
const config = await Config.get(); // Merges all sources automatically

// Config precedence (SDK handles):
// 1. OPENCODE_CONFIG_CONTENT env var (highest)
// 2. .opencode directories
// 3. Project opencode.json
// 4. OPENCODE_CONFIG path
// 5. Global ~/.config/opencode/opencode.json
// 6. Remote .well-known/opencode (lowest)
```

#### Copilot SDK Configuration Loading

```typescript
// Specify skill directories - SDK scans for SKILL.md files
const session = await client.createSession({
    skillDirectories: ["./.github/skills", "./skills"],
    // SDK parses SKILL.md frontmatter automatically
});
```

**Note**: Copilot SDK does NOT auto-load `.github/copilot-instructions.md`. This requires manual parsing if needed.

#### What Atomic Needs to Handle Manually

Only these items require custom implementation:

| Config                   | Reason                                               |
| ------------------------ | ---------------------------------------------------- |
| `.atomic/workflows/*.ts` | Atomic-specific format                               |
| Cross-SDK agent merging  | Combining agents from .claude/, .opencode/, .github/ |
| Copilot instructions     | `.github/copilot-instructions.md` not auto-loaded    |

#### Model Handling in Frontmatter

**Use SDK aliases directly** - no normalization needed:

```yaml
# Claude format - SDK resolves alias to latest version
model: opus

# OpenCode format - SDK parses provider/model
model: anthropic/claude-opus-4-5

# Both work because SDKs handle resolution internally
```

**Recommendation**: Pass frontmatter `model` directly to SDK without transformation. The SDK handles alias resolution and version management.

---

### 4. `/model` Command Implementation

#### Built-in Command Pattern

**Location**: `src/ui/commands/builtin-commands.ts`

Built-in commands follow this pattern:

```typescript
export const modelCommand: CommandDefinition = {
    name: "model",
    description: "Switch or view the current model",
    category: "builtin",
    aliases: ["m"],
    execute: (args: string, context: CommandContext): CommandResult => {
        // Implementation
    },
};
```

#### Proposed `/model` Command (SDK-First)

**Key Principle**: Use SDK model discovery and aliases instead of hardcoded mappings. This ensures auto-model updates work without code changes.

```typescript
/**
 * /model - Switch or display the current model.
 *
 * Usage:
 *   /model                    - Show current model
 *   /model <alias>            - Switch to model by alias (opus, sonnet, haiku)
 *   /model <full-name>        - Switch to specific model
 *   /model list               - List available models (from SDK)
 */
export const modelCommand: CommandDefinition = {
    name: "model",
    description: "Switch or view the current model",
    category: "builtin",
    aliases: ["m"],
    execute: async (
        args: string,
        context: CommandContext,
    ): Promise<CommandResult> => {
        const trimmed = args.trim().toLowerCase();

        // Show current model - delegate to SDK
        if (!trimmed) {
            // SDK provides display info
            const currentModel =
                context.session?.getModelDisplayInfo?.() ?? "No model set";
            return {
                success: true,
                message: `Current model: **${currentModel}**`,
            };
        }

        // List available models - use SDK discovery
        if (trimmed === "list") {
            // Claude SDK: query.supportedModels()
            // OpenCode SDK: local.model.list()
            // Copilot SDK: client.ListModels()
            const models = await context.sdk.listAvailableModels();
            const lines = models.map(
                (m) => `  ${m.alias ?? m.id} - ${m.displayName}`,
            );
            return {
                success: true,
                message: `**Available Models**\n\n${lines.join("\n")}`,
            };
        }

        // Switch model - pass alias directly to SDK (no manual mapping!)
        // SDK resolves: 'opus' → 'claude-opus-4-5-YYYYMMDD'
        // SDK resolves: 'sonnet' → 'claude-sonnet-4-5-YYYYMMDD'
        // SDK resolves: 'haiku' → 'claude-haiku-3-5-YYYYMMDD'
        await context.sdk.setModel(trimmed);

        return {
            success: true,
            message: `Model switched to **${trimmed}**`,
            stateUpdate: {
                model: trimmed, // Store alias, SDK resolves at runtime
            },
        };
    },
};
```

#### Registration

Add to `builtinCommands` array in `builtin-commands.ts`:

```typescript
export const builtinCommands: CommandDefinition[] = [
    helpCommand,
    themeCommand,
    clearCommand,
    compactCommand,
    modelCommand, // Add here
];
```

#### Claude Code Model Selection Reference

Claude Code provides:

- `/model <alias|name>` - switch mid-session
- `Opt+P` / `Alt+P` - keyboard shortcut for model switching
- Model aliases: `sonnet`, `opus`, `haiku`, `default`, `sonnet[1m]`, `opusplan`

---

### 5. Message Queuing Implementation

#### Current Implementation Status

**useMessageQueue hook** (`src/ui/hooks/use-message-queue.ts:89-136`):

- Fully implemented with `enqueue`, `dequeue`, `clear` operations
- Uses FIFO queue with `QueuedMessage` objects

**ChatApp integration** (`src/ui/chat.tsx`):

- Hook instantiated at line 784
- Messages queued during streaming at line 1693
- Queue processed on stream completion at lines 1633-1638
- 50ms delay between queue processing

**QueueIndicator component** (`src/ui/components/queue-indicator.tsx`):

- Fully implemented with compact and expanded modes
- Exported but **NOT rendered in ChatApp**

#### Gap: Missing UI Integration

The `QueueIndicator` component exists but is not rendered. To add it:

**In ChatApp (`src/ui/chat.tsx`)**, add to render section:

```tsx
{
    /* Message queue indicator - show when streaming with queued messages */
}
{
    isStreaming && messageQueue.count > 0 && (
        <QueueIndicator
            count={messageQueue.count}
            queue={messageQueue.queue}
            compact={true}
        />
    );
}
```

#### Claude Code's Approach: Boundary-Aware Queuing

**CORRECTION**: Claude Code DOES use message queuing, not just interrupts. Based on direct observation via tmux-cli:

**Observed Behavior**:

1. **Input placeholder changes**: When messages are queued, input shows "Press up to edit queued messages"
2. **Queue display**: Queued messages appear above the input box with `❯ ` prefix
3. **Queue editing**: Users can press up-arrow to navigate and edit queued messages before they're processed
4. **Sequential processing**: Messages are processed in order after the current response completes

**Key UX Pattern - "Boundary-Aware Queuing"**:

- Messages typed during streaming are queued (not lost)
- User gets visual feedback that messages are queued
- User can edit/reorder queued messages before processing
- Processing happens at response boundaries (after stream completes)

**This differs from pure interrupt model**:

- Interrupts (`Esc`) abort current stream immediately
- Queuing preserves input for sequential processing
- Both patterns coexist in Claude Code

#### Implementation Recommendations for Atomic

1. **Primary: Adopt Claude Code's queuing UX**:
    - Show "Press up to edit queued messages" placeholder when queue is non-empty
    - Display queued messages with `❯ ` prefix above input
    - Allow up-arrow navigation to edit queued messages
    - Process queue sequentially at stream completion

2. **Secondary: Support interrupts alongside queuing**:
    - `Esc` to abort current stream (already exists)
    - Queued messages remain after interrupt
    - User can choose to process queue or clear it

3. **Render QueueIndicator**:
    ```tsx
    {messageQueue.count > 0 && (
      <QueueIndicator
        count={messageQueue.count}
        queue={messageQueue.queue}
        editable={!isStreaming}
        onEdit={(index) => /* edit queued message */}
      />
    )}
    ```

---

### 6. Configuration Schemas (Parsed by Atomic)

**IMPORTANT**: Atomic does NOT define its own custom format for agents, skills, commands, or MCP configuration. Instead, Atomic **parses and registers** configurations from existing `.claude`, `.opencode`, and `.github` directories. The only Atomic-specific configuration is `.atomic/workflows/` for custom workflow definitions.

This approach provides:

- Compatibility with existing coding agent setups
- No migration required for users of Claude Code, OpenCode, or Copilot CLI
- Unified interface across all three agent ecosystems

---

#### 6.1 Claude Code Configuration (`.claude/`)

**Source**: https://code.claude.com/docs/en/features-overview

**Directory Structure**:

```
project-root/
├── .claude/
│   ├── settings.json              # Project-shared settings (committed)
│   ├── settings.local.json        # Personal overrides (gitignored)
│   ├── CLAUDE.md                  # Project memory file
│   ├── CLAUDE.local.md            # Personal memory (gitignored)
│   ├── agents/                    # Subagent definitions
│   │   └── <agent-name>.md
│   ├── commands/                  # Custom slash commands (legacy, still supported)
│   │   └── <command-name>.md
│   ├── skills/                    # Skill definitions
│   │   └── <skill-name>/
│   │       └── SKILL.md
│   └── rules/                     # Modular project rules
│       └── *.md
├── .mcp.json                      # MCP server configuration
├── CLAUDE.md                      # Alternative project memory location
└── CLAUDE.local.md                # Personal project memory (gitignored)
```

**User-Level Structure**:

```
~/.claude/
├── settings.json                  # User-wide settings
├── CLAUDE.md                      # User memory file
├── .claude.json                   # User preferences/OAuth/MCP servers
├── agents/                        # User subagents
├── skills/                        # User skills
└── rules/                         # User-level rules
```

**settings.json Complete Schema**:

```json
{
    "$schema": "https://json.schemastore.org/claude-code-settings.json",

    // Model Configuration
    "model": "sonnet|opus|haiku|sonnet[1m]|opusplan",
    "alwaysThinkingEnabled": false,

    // Permissions (Atomic uses bypassPermissions - NO PROMPTS)
    "permissions": {
        "defaultMode": "bypassPermissions" // Atomic: always bypass
        // Other modes available: "acceptEdits", "askForAll", "default"
    },

    // MCP Configuration
    "enableAllProjectMcpServers": false,
    "enabledMcpjsonServers": ["serverName"],
    "disabledMcpjsonServers": ["serverName"],
    "allowedMcpServers": [{ "serverName": "github" }],
    "deniedMcpServers": [{ "serverName": "dangerous" }],

    // Hooks
    "hooks": {
        /* see hooks section */
    },
    "disableAllHooks": false,

    // Sandbox
    "sandbox": {
        "enabled": false,
        "autoAllowBashIfSandboxed": true,
        "excludedCommands": ["rm"],
        "network": {
            "allowedDomains": ["*.github.com"],
            "allowLocalBinding": false
        }
    },

    // UI & Display
    "language": "english|japanese|spanish|french",
    "showTurnDuration": true,
    "spinnerTipsEnabled": true,
    "terminalProgressBarEnabled": true,

    // Environment
    "env": { "KEY": "value" },

    // Plugins
    "enabledPlugins": { "plugin-name@marketplace": true }
}
```

**Agent Frontmatter (`.claude/agents/*.md`)**:

```yaml
---
name: agent-name # Required: Unique identifier
description: When to delegate # Required: Delegation criteria
tools: Read, Grep, Glob, Bash # Optional: Comma-separated allowlist
disallowedTools: Write, Edit # Optional: Tool denylist
model: sonnet|opus|haiku|inherit # Optional: Model override (default: inherit)
permissionMode: bypassPermissions # Atomic default: NO PROMPTS
skills: # Optional: Skills to preload
    - skill-name-1
hooks: # Optional: Agent-scoped hooks
    PreToolUse:
        - matcher: "Bash"
          hooks:
              - type: command
                command: "./validate.sh"
---
System prompt content goes here...
```

**Skill Manifest (`.claude/skills/<name>/SKILL.md`)**:

```yaml
---
name: skill-name                    # Optional: Display name (defaults to dir name)
description: What this skill does   # Recommended: Used for auto-invocation
argument-hint: "[issue-number]"     # Optional: Hint for autocomplete
disable-model-invocation: false     # Optional: Only user can invoke via /name
user-invocable: true                # Optional: Show in / menu
allowed-tools: Read, Grep           # Optional: Auto-approved tools
model: sonnet                       # Optional: Model override
context: fork                       # Optional: Run in forked subagent
agent: Explore|Plan|general-purpose # Optional: Subagent type when context: fork
---

Skill instructions with $ARGUMENTS placeholder...
Dynamic context: !`shell command`
```

**MCP Configuration (`.mcp.json`)**:

```json
{
    "mcpServers": {
        "server-name": {
            "type": "stdio|http|sse",
            "command": "/path/to/executable",
            "args": ["--flag", "value"],
            "env": {
                "API_KEY": "${API_KEY}",
                "PATH": "${PATH:-/usr/bin}"
            },
            "cwd": "/working/directory",
            "url": "https://api.example.com/mcp",
            "headers": { "Authorization": "Bearer ${TOKEN}" }
        }
    }
}
```

**Hook Events**:
| Event | Matcher Input | Description |
|-------|---------------|-------------|
| `SessionStart` | `startup\|resume\|clear\|compact` | Session begins |
| `UserPromptSubmit` | N/A | User submits prompt |
| `PreToolUse` | Tool name | Before tool execution |
| `PostToolUse` | Tool name | After tool success |
| `PostToolUseFailure` | Tool name | After tool failure |
| `Stop` | N/A | Claude finishes responding |
| `SubagentStart` | Agent type | Subagent spawned |
| `SubagentStop` | Agent type | Subagent finishes |
| `PreCompact` | `manual\|auto` | Before context compaction |
| `SessionEnd` | Exit reason | Session terminates |

**Model Aliases** (SDK-Native - Pass directly, SDK resolves to latest versions):
| Alias | Description | SDK Resolution |
|-------|-------------|----------------|
| `sonnet` | Claude Sonnet 4.5 (latest) | → `claude-sonnet-4-5-YYYYMMDD` |
| `opus` | Claude Opus 4.5 | → `claude-opus-4-5-YYYYMMDD` |
| `haiku` | Claude Haiku (fast) | → `claude-haiku-3-5-YYYYMMDD` |
| `sonnet[1m]` | Sonnet with 1M context window | → Extended context variant |
| `opusplan` | Opus for planning, Sonnet for execution | → Multi-model orchestration |
| `inherit` | Use parent conversation's model | → Parent's resolved model |

**Key Point**: Use aliases directly in code. The SDK handles resolution to versioned model IDs, ensuring auto-updates work without code changes.

---

#### 6.2 OpenCode Configuration (`.opencode/`)

**Source**: `anomalyco/opencode` repository (DeepWiki)

**Directory Structure**:

```
.opencode/
├── opencode.json              # Main configuration
├── agents/ or agent/          # Agent definitions
│   └── *.md
├── command/ or commands/      # Command definitions
│   └── *.md
├── skills/                    # Skill definitions
│   └── <skill-name>/
│       └── SKILL.md
└── *.local.md                 # Runtime state (gitignored)
```

**Config Precedence** (later overrides earlier):

1. Remote config
2. Global config (`~/.config/opencode/opencode.json`)
3. Custom config (`OPENCODE_CONFIG` env var)
4. Project config (`opencode.json`)
5. `.opencode` directories
6. Inline config (`OPENCODE_CONFIG_CONTENT` env var)

**opencode.json Complete Schema**:

```json
{
    "$schema": "https://opencode.ai/config.json",

    // Model Configuration
    "model": "provider_id/model_id",
    "small_model": "provider_id/model_id",
    "default_agent": "build",

    // Provider Configuration
    "provider": {
        "anthropic": {
            "name": "Anthropic",
            "api": "https://api.anthropic.com",
            "env": ["ANTHROPIC_API_KEY"],
            "options": {
                "apiKey": "string",
                "baseURL": "string",
                "timeout": 300000
            },
            "models": {
                "claude-sonnet-4-5": {
                    "name": "Claude Sonnet 4.5",
                    "cost": { "input": 0.003, "output": 0.015 },
                    "limit": { "context": 200000, "output": 8192 },
                    "tool_call": true,
                    "attachment": true
                }
            }
        }
    },

    // MCP Server Configuration
    "mcp": {
        "server-name": {
            "type": "local|remote",
            "command": ["npx", "-y", "mcp-command"],
            "environment": { "VAR": "value" },
            "url": "https://mcp-server.com",
            "headers": { "Authorization": "Bearer KEY" },
            "oauth": { "clientId": "...", "scope": "..." },
            "enabled": true,
            "timeout": 5000
        }
    },

    // Permission Configuration (Atomic uses allow-all - NO PROMPTS)
    "permission": {
        "*": "allow" // Atomic: auto-allow all tools
        // Other actions available: "ask", "deny"
    },

    // Agent Configuration
    "agent": {
        "build": {
            /* AgentConfig */
        },
        "plan": {
            /* AgentConfig */
        },
        "general": {
            /* AgentConfig */
        },
        "explore": {
            /* AgentConfig */
        }
    },

    // UI Configuration
    "theme": "string",
    "tui": {
        "scroll_speed": 3,
        "diff_style": "auto|stacked"
    },
    "keybinds": {
        "leader": "ctrl+x",
        "app_exit": "ctrl+c,ctrl+d",
        "model_list": "<leader>m"
    },

    // Additional Configuration
    "skills": { "paths": ["./custom-skills"] },
    "watcher": { "ignore": ["node_modules/**"] },
    "formatter": {
        "prettier": { "command": ["npx", "prettier", "--write", "$FILE"] }
    },
    "lsp": {
        "typescript": { "command": ["typescript-language-server", "--stdio"] }
    },
    "compaction": { "auto": true, "prune": true },
    "share": "manual|auto|disabled",
    "autoupdate": true
}
```

**Agent Frontmatter (`.opencode/agents/*.md`)**:

```yaml
---
model: anthropic/claude-opus-4-5 # Optional: Model override
variant: string # Optional: Model variant
temperature: 0.7 # Optional: 0.0-2.0
top_p: 0.9 # Optional: 0.0-1.0
prompt: path/to/prompt.md # Optional: External prompt file
description: Agent description # Optional: Shown in UI
mode: subagent|primary|all # Optional: Agent mode
hidden: false # Optional: Hide from @ autocomplete
disable: false # Optional: Disable agent
color: "#FF5733" # Optional: UI color
steps: 50 # Optional: Max iterations
permission: # Atomic: auto-allow all
    "*": "allow"
---
System prompt content...
```

**Command Frontmatter (`.opencode/command/*.md`)**:

```yaml
---
description: Command description     # Optional: Shown in UI
agent: build                         # Optional: Agent to execute
model: anthropic/claude-sonnet-4     # Optional: Model override
subtask: false                       # Optional: Force subagent invocation
---

Command template with $ARGUMENTS or $1, $2 placeholders...
Shell output: `!npm test`
File reference: @filename
```

**Skill Manifest (`.opencode/skills/<name>/SKILL.md`)**:

```yaml
---
name: skill-name # Required: 1-64 chars, lowercase with hyphens
description: Skill description # Required: 1-1024 chars
license: MIT # Optional
---
Skill content in Markdown...
```

**Model Format**: `provider_id/model_id` (e.g., `anthropic/claude-opus-4-5`, `openai/gpt-5`)

**Permission Actions**: `"allow"` (Atomic default), `"ask"`, `"deny"` - **Atomic uses `"allow"` for all**

**Available Tools**:
| Tool | Description |
|------|-------------|
| `read` | Reading files |
| `edit` | File modifications |
| `glob` | File globbing |
| `grep` | Content search |
| `list` | Directory listing |
| `bash` | Shell commands |
| `task` | Launching subagents |
| `skill` | Loading skills |
| `webfetch` | Fetching URLs |
| `websearch` | Web search |

---

#### 6.3 GitHub Copilot Configuration (`.github/`)

**Source**: GitHub Docs (Copilot CLI, Hooks, Agent Skills)

**Directory Structure**:

```
.github/
├── copilot-instructions.md          # Repository-wide instructions
├── instructions/                     # Path-specific instructions
│   └── *.instructions.md
├── hooks/                            # Hook configuration
│   └── *.json
├── agents/                           # Custom agent profiles
│   └── CUSTOM-AGENT-NAME.md
└── skills/                           # Agent skills
    └── <skill-name>/
        ├── SKILL.md
        └── [optional resources]
```

**User-Level Configuration**:

```
~/.copilot/
├── config                            # General CLI configuration
├── mcp-config.json                   # MCP server definitions
├── agents/                           # User-level custom agents
└── skills/                           # Personal skills
```

**Note**: `.github/workflows/` and `.github/dependabot.yml` are NOT Copilot config files.

**Agent Frontmatter (`.github/agents/AGENT-NAME.md`)**:

```yaml
---
name: agent-name                      # Optional: Display name
description: Agent purpose            # Required: When to use
target: vscode|github-copilot         # Optional: Environment
tools: ["*"]|["read", "edit"]|[]      # Optional: Tool access
infer: true                           # Optional: Auto-selection
mcp-servers:                          # Optional: MCP config (org/enterprise only)
  server-name:
    type: local
    command: some-command
    tools: ["*"]
    env:
      VAR: $COPILOT_MCP_VAR
metadata:                             # Optional: Custom annotations
  key: value
---

System prompt content (max 30,000 chars)...
```

**Tool Aliases** (case-insensitive):
| Alias | Description |
|-------|-------------|
| `execute` | Shell commands (bash/powershell) |
| `read` | File viewing |
| `edit` | File modifications |
| `search` | File/text searching |
| `agent` | Invoke other custom agents |
| `web` | URL fetching/web search |
| `todo` | Task list creation |
| `server-name/*` | All tools from MCP server |

**Skill Manifest (`.github/skills/<name>/SKILL.md`)**:

```yaml
---
name: skill-name # Required: Unique identifier
description: Skill description # Required: Function and triggers
license: MIT # Optional
---
Skill instructions in Markdown...
```

**Hooks Configuration (`.github/hooks/*.json`)**:

```json
{
    "version": 1,
    "hooks": {
        "sessionStart": [],
        "sessionEnd": [],
        "userPromptSubmitted": [],
        "preToolUse": [
            {
                "type": "command",
                "bash": "./scripts/validate.sh",
                "powershell": "./scripts/validate.ps1",
                "cwd": "scripts",
                "timeoutSec": 30,
                "env": { "KEY": "value" },
                "comment": "Security validation"
            }
        ],
        "postToolUse": [],
        "errorOccurred": []
    }
}
```

**Hook Events**:
| Event | Input Fields | Output Fields |
|-------|--------------|---------------|
| `sessionStart` | `timestamp`, `cwd`, `source`, `initialPrompt` | - |
| `sessionEnd` | `timestamp`, `cwd`, `reason` | - |
| `userPromptSubmitted` | `timestamp`, `cwd`, `prompt` | - |
| `preToolUse` | `timestamp`, `cwd`, `toolName`, `toolArgs` | (Atomic: not used for permissions - auto-approve) |
| `postToolUse` | `timestamp`, `cwd`, `toolName`, `toolArgs`, `toolResult` | - |
| `errorOccurred` | `timestamp`, `cwd`, `error` | - |

**MCP Configuration (`~/.copilot/mcp-config.json`)**:

```json
{
    "mcpServers": {
        "server-name": {
            "command": "string",
            "args": ["string"],
            "env": { "KEY": "${VAR_NAME}" },
            "cwd": "string"
        }
    }
}
```

**Model Selection**:

- Interactive: `/model` or `/model claude-sonnet-4`
- Command-line: `copilot --model "claude-sonnet-4"`
- Available models: Claude Sonnet 4.5, Claude Sonnet 4, Claude Haiku 4.5, GPT-5, GPT-5 mini, GPT-4.1

---

#### 6.4 Atomic Configuration (`.atomic/`)

**IMPORTANT**: Atomic only defines `.atomic/workflows/` for custom workflow definitions. All other configurations (agents, skills, commands, MCP) are loaded from the existing `.claude/`, `.opencode/`, and `.github/` directories.

**Directory Structure**:

```
.atomic/
└── workflows/                        # Custom workflow definitions (ONLY Atomic-specific)
    └── *.ts                          # TypeScript workflow files
```

**Workflow File Exports**:

```typescript
export const name: string; // Command name
export const description: string; // Description
export const aliases: string[]; // Alternative names
export const defaultConfig: Record<string, unknown>; // Defaults
export default function (config?): CompiledGraph; // Factory function
```

**Configuration Loading Strategy**:
Atomic loads and registers configurations from all three agent directories:

| Config Type | Source Directories                                                                 |
| ----------- | ---------------------------------------------------------------------------------- |
| Agents      | `.claude/agents/`, `.opencode/agents/`, `.github/agents/`                          |
| Commands    | `.claude/commands/`, `.opencode/command/`                                          |
| Skills      | `.claude/skills/`, `.opencode/skills/`, `.github/skills/`                          |
| MCP Servers | `.mcp.json`, `.opencode/opencode.json` (mcp section), `~/.copilot/mcp-config.json` |
| Settings    | `.claude/settings.json`, `.opencode/opencode.json`                                 |
| Hooks       | `.claude/settings.json` (hooks), `.github/hooks/*.json`                            |
| Workflows   | `.atomic/workflows/` (Atomic-only)                                                 |

---

#### 6.5 Configuration Normalization (SDK-First)

**Key Principle**: Let SDKs handle normalization internally. Only normalize when bridging between SDKs.

**Model Format**: NO MANUAL NORMALIZATION NEEDED

- Pass aliases (`opus`, `sonnet`, `haiku`) directly to Claude SDK
- Pass `provider/model` format directly to OpenCode SDK
- Pass model IDs directly to Copilot SDK
- Each SDK handles its own resolution to versioned model IDs

**Tool Format**: MINIMAL NORMALIZATION

- Claude SDK accepts comma-separated strings or arrays
- OpenCode SDK has `fromConfig()` to normalize permission config
- Copilot SDK accepts arrays directly

```typescript
// Only normalize OpenCode's object format to array if needed
export function normalizeTools(
    tools: string[] | Record<string, boolean> | undefined,
): string[] | undefined {
    if (!tools) return undefined;
    if (Array.isArray(tools)) return tools; // Already array - pass through
    // OpenCode object format → array
    return Object.entries(tools)
        .filter(([_, enabled]) => enabled)
        .map(([name]) => name);
}
```

**Permission Format**: AUTO-APPROVE ALL (No Permission Prompts)

**Atomic bypasses all permission checks.** Each SDK is configured to auto-approve:

```typescript
// Claude SDK - bypass all permissions
query({ options: { permissionMode: "bypassPermissions" } });

// OpenCode SDK - allow all
const config = { permission: { "*": "allow" } };

// Copilot SDK - auto-approve callback
const session = await client.createSession({
    OnPermissionRequest: async () => ({ kind: "approved" }),
});
```

**Note**: `AskUserQuestion` is a HIL (Human-in-the-Loop) tool for gathering user input, NOT a permission mechanism.

---

#### 6.6 Implementation: Configuration Loading Architecture (SDK-First)

**Simplified Loading Flow** - Delegate to SDKs wherever possible:

```
initializeAsync()
    │
    ├── initClaudeSDK()
    │   └── query({ options: { settingSources: ['project'] } })
    │       └── SDK auto-loads: settings.json, agents/, skills/, CLAUDE.md
    │
    ├── initOpenCodeSDK()
    │   └── Config.get()
    │       └── SDK auto-loads: opencode.json, agents/, commands/, skills/
    │
    ├── initCopilotSDK()
    │   └── client.createSession({ skillDirectories: ['.github/skills'] })
    │       └── SDK auto-loads: skills/
    │   └── MANUAL: Parse .github/agents/*.md (SDK doesn't auto-load)
    │   └── MANUAL: Parse .github/copilot-instructions.md (SDK doesn't auto-load)
    │
    ├── loadAtomicConfig()  (ATOMIC-ONLY)
    │   └── Parse .atomic/workflows/*.ts
    │
    └── registerCrossSDKAgents()  (ATOMIC-ONLY)
        └── Merge agents from all three SDKs for unified @ autocomplete
```

**What SDKs Handle vs. What Atomic Implements**:

| Component | Claude SDK   | OpenCode SDK   | Copilot SDK  | Atomic          |
| --------- | ------------ | -------------- | ------------ | --------------- |
| Settings  | ✅ Auto      | ✅ Auto        | ❌ Manual    | -               |
| Agents    | ✅ Auto      | ✅ Auto        | ❌ Manual    | Cross-SDK merge |
| Commands  | ✅ Auto      | ✅ Auto        | N/A          | -               |
| Skills    | ✅ Auto      | ✅ Auto        | ✅ skillDirs | -               |
| MCP       | ✅ .mcp.json | ✅ mcp section | ❌ Manual    | -               |
| Hooks     | ✅ Auto      | N/A            | ❌ Manual    | -               |
| Workflows | N/A          | N/A            | N/A          | ✅ .atomic/     |

**Precedence Order** (later overrides earlier):

1. `.opencode/` (lowest) - via OpenCode SDK
2. `.github/` - manual parsing for agents
3. `.claude/` - via Claude SDK
4. `.atomic/` (highest, workflows only)
5. CLI flags (highest for model/permissions)

---

## Code References

### Graph System

- `src/graph/types.ts:277-295` - NodeDefinition interface
- `src/graph/types.ts:231-259` - ExecutionContext interface
- `src/graph/types.ts:322-362` - GraphConfig interface
- `src/graph/nodes.ts:57-94` - AgentNodeConfig interface
- `src/graph/nodes.ts:163-262` - AgentNode execution
- `src/graph/compiled.ts:519-531` - ExecutionContext construction

### Workflow System

- `src/workflows/ralph/workflow.ts:185-247` - createRalphWorkflow()
- `src/ui/commands/workflow-commands.ts:369-392` - discoverWorkflowFiles()
- `src/ui/commands/workflow-commands.ts:428-478` - loadWorkflowsFromDisk()

### Configuration

- `src/config/ralph.ts:17-55` - Ralph configuration types
- `src/ui/commands/agent-commands.ts:1003-1104` - parseMarkdownFrontmatter()
- `src/ui/commands/agent-commands.ts:1153-1169` - normalizeTools()

### Commands

- `src/ui/commands/builtin-commands.ts:28-158` - Built-in command definitions
- `src/ui/commands/registry.ts` - Command registry

### SDK Clients

- `src/sdk/types.ts:114-133` - SessionConfig interface
- `src/sdk/claude-client.ts:185-301` - buildSdkOptions()
- `src/sdk/opencode-client.ts` - OpenCode client
- `src/sdk/copilot-client.ts:156-185` - buildSdkOptions()

### Message Queue

- `src/ui/hooks/use-message-queue.ts:89-136` - useMessageQueue hook
- `src/ui/chat.tsx:784` - Hook instantiation
- `src/ui/chat.tsx:1633-1638` - Queue processing
- `src/ui/components/queue-indicator.tsx:89-142` - QueueIndicator component

---

## Architecture Documentation (SDK-First)

### Model Configuration Flow (SDK-First)

```
User Request → ChatApp → SDK Client
                 ↓
         Pass model alias directly (e.g., 'opus', 'sonnet')
                 ↓
         SDK resolves alias → versioned model ID (e.g., claude-opus-4-5-20251101)
                 ↓
         SDK handles model selection and session creation
```

**Key Point**: No manual mapping needed. Pass aliases directly to SDK.

### Per-Node Model Flow (Using SDK Aliases)

```
Workflow Start → GraphExecutor → For each node:
                      ↓
              node.model (SDK alias: 'opus' | 'sonnet' | 'haiku' | 'inherit')
                      ↓
              If 'inherit': use parentContext.model or config.defaultModel
              Else: pass alias directly to SDK
                      ↓
              node.execute(context)
                      ↓
              If agent node: context.model (alias) → SDK → resolved model ID
```

### Custom Workflow Loading Flow

```
initializeCommandsAsync() → loadWorkflowsFromDisk()
         ↓
Discover .ts files in .atomic/workflows and ~/.atomic/workflows
         ↓
Dynamic import each file → Extract exports (default, name, description, aliases)
         ↓
Create WorkflowMetadata → Register in workflow registry
         ↓
Generate CommandDefinition → Register in command registry
```

### SDK Initialization Flow

```
App Start → Initialize SDKs
         ↓
    ┌────┴────┐
    │ Claude  │ → query({ settingSources: ['project'] })
    │         │   └── Auto-loads: .claude/settings.json, agents/, skills/
    └────┬────┘
         │
    ┌────┴────┐
    │OpenCode │ → Config.get()
    │         │   └── Auto-loads: .opencode/*, opencode.json
    └────┬────┘
         │
    ┌────┴────┐
    │ Copilot │ → client.createSession({ skillDirectories: [...] })
    │         │   └── Auto-loads: skills from specified directories
    │         │   └── MANUAL: Parse .github/agents/, copilot-instructions.md
    └────┬────┘
         │
    ┌────┴────┐
    │ Atomic  │ → loadWorkflowsFromDisk()
    │         │   └── Parse .atomic/workflows/*.ts
    └─────────┘
```

---

## Historical Context (from research/)

No prior research documents directly address these topics. This is the first comprehensive research on:

- Per-node model configuration
- Custom workflow definition format
- Model command implementation
- Message queue UI integration

---

## Related Research

- No directly related research documents found in `research/` directory
- This research creates the foundation for feature implementation

---

## Open Questions

### Resolved by SDK-First Approach

1. ~~**Model availability**~~: Use SDK discovery methods:
    - Claude: `query.supportedModels()`
    - OpenCode: `local.model.list()`
    - Copilot: `client.ListModels()`

2. ~~**Permission system**~~: **NO PERMISSION PROMPTS** - Auto-approve all tool executions:
    - Claude: `permissionMode: 'bypassPermissions'`
    - OpenCode: `permission: { "*": "allow" }`
    - Copilot: `OnPermissionRequest: () => ({ kind: 'approved' })`
    - **Note**: `AskUserQuestion` is HIL (Human-in-the-Loop), not a permission check

### Remaining Questions

1. **Model inheritance semantics**: When a node specifies `model: 'inherit'`, should it inherit from:
    - The parent node that spawned it?
    - The graph-level default?
    - The current session model?
    - **Recommendation**: Follow Claude SDK subagent behavior - inherit from parent conversation

2. **Runtime model switching**: The `/model` command should:
    - Use `query.setModel()` (Claude) - works mid-session in streaming mode
    - OpenCode/Copilot may require new session
    - **Recommendation**: Attempt SDK switch, fallback to new session if not supported

3. **Queue editing UX**: How should queue editing work when user presses up-arrow?
    - **Recommendation**: Follow Claude Code pattern - move to input box for editing

4. **Config validation**: Should custom workflow files be validated against a schema at load time?
    - **Recommendation**: Yes, but defer to TypeScript type checking since workflows are `.ts` files

5. **Configuration precedence**: When the same agent/skill/command name exists in multiple directories:
    - **Proposed**: `.claude/` > `.github/` > `.opencode/` (Claude Code takes precedence as primary target)
    - SDKs don't handle cross-SDK merging - Atomic must implement

6. **Hook system**: Each SDK has different hook mechanisms:
    - Claude: Built-in `hooks` option
    - OpenCode: No built-in hooks
    - Copilot: JSON files in `.github/hooks/`
    - **Recommendation**: Use SDK-native hooks where available, don't unify

7. **MCP server merging**: Multiple sources define MCP servers:
    - Claude SDK handles `.mcp.json` automatically via `settingSources`
    - OpenCode SDK handles `mcp` section in config
    - Copilot: Manual parsing of `~/.copilot/mcp-config.json`
    - **Recommendation**: Let each SDK manage its own MCP servers, don't merge

8. **Skill directory collision**: Same skill name in multiple directories:
    - SDKs load their own skills independently
    - **Recommendation**: Higher-precedence SDK wins for @ autocomplete display

---

## Implementation Recommendations (SDK-First)

### Priority Order

1. **High Priority**:
    - ✅ Create example workflow in `.atomic/workflows/` (DONE: `.atomic/workflows/test-workflow.ts`)
    - Implement `/model` command using SDK discovery (no manual mappings)
    - Update `QueueIndicator` to match Claude Code's UX pattern
    - Configure SDK settings sources for automatic config loading

2. **Medium Priority**:
    - Extend `NodeDefinition` with model field (use SDK aliases: `'opus' | 'sonnet' | 'haiku' | 'inherit'`)
    - Update `ExecutionContext` with model propagation
    - Cross-SDK agent merging for unified @ autocomplete

3. **Lower Priority**:
    - Parse `.github/agents/` manually (Copilot SDK doesn't auto-load)
    - Parse `.github/copilot-instructions.md` manually
    - Schema validation for custom workflows

### Specific Implementation Tasks

#### SDK Initialization (Replaces Custom Config Loaders)

```typescript
// src/sdk/init.ts - SDK-first configuration loading with NO PERMISSION PROMPTS

// Claude SDK - auto-loads .claude/ configs, bypasses permissions
import { query } from "@anthropic-ai/claude-agent-sdk";

export function initClaudeSession(prompt: string) {
    return query({
        prompt,
        options: {
            settingSources: ["project"], // Auto-loads .claude/settings.json, agents/, etc.
            systemPrompt: { type: "preset", preset: "claude_code" }, // Loads CLAUDE.md
            permissionMode: "bypassPermissions", // NO PERMISSION PROMPTS
            // Model from frontmatter (opus, sonnet, haiku) is resolved by SDK
        },
    });
}

// OpenCode SDK - auto-loads .opencode/ configs, auto-allows all
import { Config, Provider } from "opencode";

export async function initOpenCodeSession() {
    const config = await Config.get(); // Auto-loads everything
    // Override permissions to allow all
    config.permission = { "*": "allow" }; // NO PERMISSION PROMPTS
    return config;
}

// Copilot SDK - partial auto-loading, auto-approves all
import { Client } from "@github/copilot-sdk";

export async function initCopilotSession(client: Client) {
    return client.createSession({
        skillDirectories: ["./.github/skills"], // SDK loads skills
        OnPermissionRequest: async () => ({ kind: "approved" }), // NO PERMISSION PROMPTS
        // NOTE: Agents and instructions require manual parsing
    });
}
```

**Note**: `AskUserQuestion` tool is for HIL (Human-in-the-Loop) interactions to gather user input - it is NOT a permission mechanism.

#### /model Command (SDK-First, No Manual Mapping)

```typescript
// src/ui/commands/builtin-commands.ts
export const modelCommand: CommandDefinition = {
    name: "model",
    aliases: ["m"],
    category: "builtin",
    description: "Switch or view the current model",
    execute: async (args, context) => {
        const trimmed = args.trim().toLowerCase();

        if (!trimmed) {
            return {
                success: true,
                message: `Current model: **${context.session.model}**`,
            };
        }

        if (trimmed === "list") {
            // Use SDK discovery - no hardcoded list!
            const models = await context.sdk.supportedModels();
            const lines = models.map((m) => `  ${m.displayName}`);
            return {
                success: true,
                message: `**Available Models**\n\n${lines.join("\n")}`,
            };
        }

        // Pass alias directly to SDK - it handles resolution
        // 'opus' → claude-opus-4-5-YYYYMMDD (SDK resolves)
        // 'sonnet' → claude-sonnet-4-5-YYYYMMDD (SDK resolves)
        await context.sdk.setModel(trimmed);
        return { success: true, message: `Model switched to **${trimmed}**` };
    },
};
```

#### Message Queue UI (Following Claude Code Pattern)

1. **Update QueueIndicator component** (`src/ui/components/queue-indicator.tsx`):
    - Add `editable` prop for queue item editing
    - Add `onEdit` callback for item selection
    - Display queued messages with `❯ ` prefix
    - Support up-arrow/down-arrow navigation

2. **Update ChatApp** (`src/ui/chat.tsx`):
    - Render `QueueIndicator` when `messageQueue.count > 0`
    - Change input placeholder during queued state
    - Handle up-arrow key to enter queue editing mode
    - Allow editing/reordering queued messages

3. **Update useMessageQueue hook** (`src/ui/hooks/use-message-queue.ts`):
    - Add `updateAt(index, message)` for in-place editing
    - Add `moveUp(index)` / `moveDown(index)` for reordering
    - Add `currentEditIndex` state for navigation

#### Per-Node Model Configuration (Using SDK Aliases)

```typescript
// src/graph/types.ts additions
export interface NodeDefinition<TState extends BaseState = BaseState> {
    // ...existing fields
    // Use SDK aliases - SDK resolves to full model IDs
    model?: "opus" | "sonnet" | "haiku" | "inherit" | string;
}

export interface ExecutionContext<TState extends BaseState = BaseState> {
    // ...existing fields
    model?: string; // Resolved by SDK at runtime
}

export interface GraphConfig<TState extends BaseState = BaseState> {
    // ...existing fields
    defaultModel?: "opus" | "sonnet" | "haiku" | string;
}
```

#### Copilot-Specific Manual Parsing (SDK Doesn't Auto-Load)

```typescript
// src/config/copilot-manual.ts
// Only parse what Copilot SDK doesn't auto-load

import { parseMarkdownFrontmatter } from "./utils";
import * as fs from "fs/promises";
import * as path from "path";

export async function loadCopilotAgents(projectRoot: string) {
    const agentsDir = path.join(projectRoot, ".github", "agents");
    // Manual parsing required - Copilot SDK doesn't auto-load agents
    const files = await fs.readdir(agentsDir).catch(() => []);
    return Promise.all(
        files
            .filter((f) => f.endsWith(".md"))
            .map(async (f) => {
                const content = await fs.readFile(
                    path.join(agentsDir, f),
                    "utf-8",
                );
                return parseMarkdownFrontmatter(content);
            }),
    );
}

export async function loadCopilotInstructions(projectRoot: string) {
    const instructionsPath = path.join(
        projectRoot,
        ".github",
        "copilot-instructions.md",
    );
    // Manual parsing required - Copilot SDK doesn't auto-load this file
    return fs.readFile(instructionsPath, "utf-8").catch(() => null);
}
```

---

## Files Created/Modified

### Created

- `.atomic/workflows/test-workflow.ts` - Example custom workflow demonstrating required exports

### To Be Created (Simplified - SDKs handle most loading)

- `src/sdk/init.ts` - SDK initialization with proper settingSources/Config.get()
- `src/config/copilot-manual.ts` - Manual parsing for Copilot (agents, instructions not auto-loaded)
- `src/config/cross-sdk-merge.ts` - Merge agents from all three SDKs for unified @ autocomplete

### NOT Needed (SDKs Handle or Not Used)

- ~~`src/config/claude-loader.ts`~~ - Claude SDK auto-loads via `settingSources: ['project']`
- ~~`src/config/opencode-loader.ts`~~ - OpenCode SDK auto-loads via `Config.get()`
- ~~`src/config/normalizers.ts`~~ - SDKs handle model normalization; permissions not needed (auto-approve all)
- ~~Permission handling code~~ - All SDKs configured to bypass/auto-approve

### To Be Modified

- `src/graph/types.ts` - Add model fields (use SDK aliases: `'opus' | 'sonnet' | 'haiku'`)
- `src/ui/components/queue-indicator.tsx` - Add editing support, Claude Code UX pattern
- `src/ui/chat.tsx` - Render QueueIndicator, handle queue editing
- `src/ui/hooks/use-message-queue.ts` - Add editing/reordering methods
- `src/ui/commands/builtin-commands.ts` - Add `/model` command using SDK discovery
