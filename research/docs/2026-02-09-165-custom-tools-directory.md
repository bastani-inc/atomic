---
date: 2026-02-09 04:20:59 UTC
researcher: Claude Opus 4.6
git_commit: 3000880d86fb81de4b475404cf1f0503aa1474f9
branch: lavaman131/feature/tui
repository: atomic
topic: "Custom tools directory for user-defined TypeScript tools (issue #165)"
tags:
    [
        research,
        codebase,
        tools,
        sdk,
        custom-tools,
        tool-registration,
        opencode,
        claude-agent-sdk,
        copilot-sdk,
    ]
status: complete
last_updated: 2026-02-09
last_updated_by: Claude Opus 4.6
---

# Research: Custom Tools Directory (Issue #165)

## Research Question

How should the custom tools directory feature (issue #165) be implemented in Atomic CLI, leveraging existing SDK tool registration patterns from OpenCode SDK, Claude Agent SDK, and Copilot SDK?

Issue: https://github.com/bastani/atomic/issues/165

## Summary

Issue #165 requests adding support for a `tools/` directory in `~/.atomic` (global) or `.atomic` (project-local) that allows users to define arbitrary tools via TypeScript modules. The codebase already has a well-established `ToolDefinition` interface (`src/sdk/types.ts:471-484`), a `registerTool()` method on all three SDK clients, and a mature pattern for filesystem-based discovery from the skill loading system (`src/ui/commands/skill-commands.ts:1722-1906`). Each SDK client handles tool registration differently internally, but they all conform to the unified `CodingAgentClient.registerTool(tool: ToolDefinition)` interface.

## Detailed Findings

### 1. Unified Tool Definition Interface

The codebase defines a unified `ToolDefinition` interface that all SDK clients accept:

```typescript
// src/sdk/types.ts:471-484
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>; // JSON Schema
    handler: (input: unknown) => unknown | Promise<unknown>;
}
```

The `CodingAgentClient` interface declares `registerTool(tool: ToolDefinition): void` at `src/sdk/types.ts:524`, meaning any custom tool conforming to `ToolDefinition` can be registered with all three agents uniformly.

### 2. SDK-Specific Tool Registration Implementations

#### 2a. Claude Agent SDK (`src/sdk/claude-client.ts:756-798`)

Claude's `registerTool()` wraps each tool in an `McpSdkServerConfigWithInstance` via `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`. Key details:

- Tools are stored in `private registeredTools: Map<string, McpSdkServerConfigWithInstance>` (line 166-167)
- Each tool becomes its own MCP server named `tool-${tool.name}` (line 790)
- The handler wraps results in `{ content: [{ type: "text", text: ... }] }` format (line 768-787)
- Registered tools are injected into SDK options via `options.mcpServers` during session creation (lines 298-303) and session resumption (lines 645-649)
- **Note**: Claude SDK expects Zod schemas internally, but the implementation uses `any` casting for compatibility with JSON Schema (line 794)
- The `inputSchema` from `ToolDefinition` is passed as `{}` (empty) to the SDK tool definition (line 763), with actual validation deferred to the handler

#### 2b. Copilot SDK (`src/sdk/copilot-client.ts:527-534, 727-729`)

Copilot's `registerTool()` is simpler:

- Tools are stored in `private registeredTools: ToolDefinition[]` (line 155)
- Registration just pushes to the array (line 728)
- Tools are converted to `SdkTool` format via `convertTool()` (line 527-534) which maps:
    - `name` → `name`
    - `description` → `description`
    - `inputSchema` → `parameters` (direct JSON Schema passthrough)
    - `handler` → wrapped async handler
- Converted tools are passed in `SdkSessionConfig.tools` during `createSession()` (line 636) and `resumeSession()` (line 695)

#### 2c. OpenCode SDK (`src/sdk/opencode-client.ts:1070-1074`)

OpenCode's `registerTool()` stores tools but does not currently pass them to the SDK:

- Tools are stored in `private registeredTools: Map<string, ToolDefinition>` (line 157)
- Registration stores in the map (line 1071)
- Comment notes: "OpenCode tools are registered server-side via MCP or config" (line 1072)
- The tools are stored "for potential future use" — they are **not** currently injected into sessions

### 3. Existing Tool in `src/sdk/tools/`

The `src/sdk/tools/` directory currently contains one file:

**`src/sdk/tools/todo-write.ts`** — A TodoWrite tool that:

- Defines a `ToolDefinition` via factory function `createTodoWriteTool()` (line 67)
- Uses JSON Schema for `inputSchema` (lines 14-51)
- Implements a `handler` function that stores and summarizes todo items (lines 76-89)
- Exports a `TodoItem` interface (lines 53-59)
- Is designed "for SDK clients that don't have it built-in" (e.g., Copilot SDK)

This file serves as the canonical example of how custom tools should be defined within Atomic.

### 4. Tool Result Rendering (`src/ui/tools/registry.ts`)

The UI has a separate `ToolResultRegistry` for rendering tool results in the TUI:

- `ToolRenderer` interface (lines 45-52): defines `icon`, `getTitle()`, `render()` for each tool type
- `TOOL_RENDERERS` registry (lines 582-597): maps tool names to renderers (Read, Edit, Bash, Write, Glob, Grep, TodoWrite)
- `getToolRenderer()` (lines 610-614): returns renderer by name, falls back to `mcpToolRenderer` for MCP tools, then `defaultToolRenderer`
- `defaultToolRenderer` (lines 464-503): shows generic JSON input/output — **this is what custom tools would use by default**
- `parseMcpToolName()` (lines 515-519): parses `mcp__<server>__<tool>` naming convention

Custom tools from the tools directory would automatically get the `defaultToolRenderer` unless additional renderers are registered.

### 5. Filesystem Discovery Pattern (Skills as Analog)

The skill loading system (`src/ui/commands/skill-commands.ts:1663-1906`) provides the exact pattern to follow for tool discovery:

#### 5a. Directory Constants

```typescript
// skill-commands.ts:1669-1681
const HOME = homedir();

export const SKILL_DISCOVERY_PATHS = [
    join(".claude", "skills"),
    join(".opencode", "skills"),
    join(".github", "skills"),
    join(".atomic", "skills"),
] as const;

export const GLOBAL_SKILL_PATHS = [
    join(HOME, ".claude", "skills"),
    join(HOME, ".opencode", "skills"),
    join(HOME, ".copilot", "skills"),
    join(HOME, ".atomic", "skills"),
] as const;
```

**Analogous tool paths** (from issue #165):

- `~/.atomic/tools/` — Global custom tools
- `.atomic/tools/` — Project-local custom tools

#### 5b. Discovery Function (`discoverSkillFiles()`, lines 1722-1765)

Scans directories with `readdirSync({ withFileTypes: true })`, checks for expected files in subdirectories, and returns structured `DiscoveredSkillFile[]` with path, directory name, and source type.

#### 5c. Priority/Override System (`shouldSkillOverride()`, lines 1705-1720)

Implements a priority hierarchy: `project (4) > atomic (3) > user/global (2) > builtin (1)`, with pinned builtins that cannot be overridden. This pattern can be reused for tool name conflicts.

#### 5d. Lazy Loading Pattern (`loadSkillContent()`, lines 1807-1819)

Only metadata is loaded at discovery time (L1); full content is loaded at invocation time (L2). For tools, this could mean: parse the `tool()` export signature at discovery, but only `import()` the full module when a session is created.

#### 5e. Registration Orchestrator (`discoverAndRegisterDiskSkills()`, lines 1851-1906)

Calls discovery → builds priority-resolved map → registers with `globalRegistry`. For tools, the analogous function would discover → import → call `client.registerTool()` for each tool.

### 6. Configuration and Settings Patterns

#### 6a. Settings Loading (`src/utils/settings.ts`)

Settings are resolved with local-over-global priority:

1. `.atomic/settings.json` (project-local, higher priority)
2. `~/.atomic/settings.json` (global, lower priority)

Uses `existsSync()` + `readFileSync()` + `JSON.parse()` with silent failure (lines 30-39).

#### 6b. MCP Config Discovery (`src/utils/mcp-config.ts`)

The `discoverMcpConfigs()` function (lines 130-157) demonstrates a comprehensive multi-format, multi-location discovery pattern:

- Scans user-level and project-level config directories
- Supports multiple config formats (Claude `.mcp.json`, Copilot `mcp-config.json`, OpenCode `opencode.json`)
- Deduplicates by name with last-wins semantics
- Filters disabled entries
- Returns unified `McpServerConfig[]`

This is the closest analog to what custom tool discovery would look like.

### 7. Workflow Discovery — Dynamic Import Pattern for `.ts` Files

**Source**: `src/ui/commands/workflow-commands.ts:219-339`

Workflow discovery is the closest existing analog to what custom tool discovery would need, because it dynamically imports `.ts` files (not `.md` files like skills):

- **Paths**: `.atomic/workflows` (project-local) and `~/.atomic/workflows` (user-global) — workflows are the only system that searches exclusively under `.atomic/`
- **Discovery** (`discoverWorkflowFiles()`, lines 254-277): Reads directory with `readdirSync()`, collects `.ts` files. Local files are processed before global (local takes priority by first-found-wins)
- **Loading** (`loadWorkflowsFromDisk()`, lines 313-339): For each `.ts` file, performs `await import(path)` (line 321). Extracts `name`, `description`, `aliases` from the module exports
- **Path expansion**: Uses `process.env.HOME` (not `os.homedir()`) via `expandPath()` at lines 232-244

This is directly applicable to custom tool discovery: scan `.atomic/tools/` for `.ts` files → `import()` each → extract `ToolDefinition` from module exports.

**Note on home directory resolution inconsistency**: Three different approaches coexist:

- `os.homedir()` — used by `settings.ts`, `skill-commands.ts`, `copilot-client.ts`
- `process.env.HOME ?? process.env.USERPROFILE ?? ""` — used by `mcp-config.ts`
- `process.env.HOME || ""` — used by `workflow-commands.ts`

### 8. Initialization Registration Order

**Source**: `src/ui/commands/index.ts:145-168` — `initializeCommandsAsync()`

```
1. registerBuiltinCommands()           (line 149)
2. await loadWorkflowsFromDisk()       (line 152)
3. registerWorkflowCommands()          (line 153)
4. registerSkillCommands()             (line 156) — builtin skills, priority 1
5. await discoverAndRegisterDiskSkills() (line 160) — disk skills, priority 2-4
6. await registerAgentCommands()       (line 164) — builtin + disk agents
```

Custom tool discovery would need to be inserted into this sequence — likely after step 1 (builtins) and before step 6 (agents), so tools are available when sessions are created.

### 9. Issue #165 Acceptance Criteria Mapping

| Acceptance Criteria                                         | Existing Pattern                                                 | Key Files                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| Discover tools from `~/.atomic/tools/` and `.atomic/tools/` | `discoverSkillFiles()` pattern                                   | `src/ui/commands/skill-commands.ts:1722-1765` |
| Parse TypeScript tool modules with `tool()` helper          | `parseSkillFile()` + Bun dynamic `import()`                      | `src/ui/commands/skill-commands.ts:1767-1805` |
| Register tools so they are available to the LLM             | `CodingAgentClient.registerTool()` on all 3 clients              | `src/sdk/types.ts:524`, each `*-client.ts`    |
| Support Zod-based argument schemas                          | Claude SDK uses Zod internally, Copilot/OpenCode use JSON Schema | `src/sdk/claude-client.ts:756-798`            |
| Pass session context to tool execute functions              | `ToolDefinition.handler` receives `input: unknown`               | `src/sdk/types.ts:483`                        |
| Project-local tools override global tools with same name    | `shouldSkillOverride()` priority system                          | `src/ui/commands/skill-commands.ts:1705-1720` |
| Display custom tools in `/context` output                   | `getRegisteredToolNames()` + `TOOL_RENDERERS`                    | `src/ui/tools/registry.ts:619-626`            |

### 8. OpenCode Custom Tools Reference (External)

**Source**: `anomalyco/opencode` repo — `packages/plugin/src/tool.ts` (authoring API) and `packages/opencode/src/tool/registry.ts` (discovery/registry)
**Docs**: https://opencode.ai/docs/custom-tools/

#### 8a. The `tool()` Helper Function

The `tool()` helper is exported from `@opencode-ai/plugin`. It is an **identity function** that provides TypeScript type inference:

```typescript
// packages/plugin/src/tool.ts
export function tool<Args extends z.ZodRawShape>(input: {
    description: string;
    args: Args;
    execute(
        args: z.infer<z.ZodObject<Args>>,
        context: ToolContext,
    ): Promise<string>;
}) {
    return input;
}
```

- `tool.schema` is an alias for `z` (Zod), so users write `tool.schema.string()` instead of importing Zod directly
- The `.describe()` call on each schema field provides the description the LLM sees when deciding how to call the tool

#### 8b. ToolContext

The `ToolContext` passed to execute functions includes:

```typescript
export type ToolContext = {
    sessionID: string;
    messageID: string;
    agent: string;
    directory: string; // Current project directory
    worktree: string; // Project worktree root
    abort: AbortSignal;
    metadata(input: {
        title?: string;
        metadata?: { [key: string]: any };
    }): void;
    ask(input: AskInput): Promise<void>; // Request user permission
};
```

#### 8c. Filesystem Discovery (`ToolRegistry.state`)

```typescript
// packages/opencode/src/tool/registry.ts
const glob = new Bun.Glob("{tool,tools}/*.{js,ts}");

for (const dir of await Config.directories()) {
    for await (const match of glob.scan({
        cwd: dir,
        absolute: true,
        followSymlinks: true,
        dot: true,
    })) {
        const namespace = path.basename(match, path.extname(match));
        const mod = await import(match);
        for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            custom.push(
                fromPlugin(
                    id === "default" ? namespace : `${namespace}_${id}`,
                    def,
                ),
            );
        }
    }
}
```

- **Glob pattern**: `{tool,tools}/*.{js,ts}` — matches `.ts`/`.js` files in `tool/` or `tools/` subdirectories
- **Config.directories()** returns `.opencode/` (project-local) and `~/.config/opencode/` (global)
- **Naming**: Default export → filename as tool ID. Named exports → `<filename>_<exportname>`
- **Dynamic import**: Uses `await import(match)` — Bun can import `.ts` files natively

#### 8d. The `fromPlugin()` Bridge

Converts user-authored `ToolDefinition` to internal `Tool.Info`:

```typescript
function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
  return {
    id,
    init: async (initCtx) => ({
      parameters: z.object(def.args),  // Wraps flat args into ZodObject
      description: def.description,
      execute: async (args, ctx) => {
        const pluginCtx = { ...ctx, directory: Instance.directory, worktree: Instance.worktree }
        const result = await def.execute(args, pluginCtx)
        const out = await Truncate.output(result, {}, initCtx?.agent)
        return { title: "", output: out.truncated ? out.content : result, metadata: { ... } }
      },
    }),
  }
}
```

#### 8e. Multi-Language Support

Tool definitions must be TypeScript/JavaScript, but can shell out to any language via `Bun.$`:

```typescript
async execute(args, context) {
  const script = path.join(context.worktree, ".opencode/tools/add.py")
  const result = await Bun.$`python3 ${script} ${args.a} ${args.b}`.text()
  return result.trim()
}
```

### 9. Claude Agent SDK Tool Registration (External)

**Source**: `docs/claude-agent-sdk/typescript-sdk.md` (lines 46-87, 118, 292-321)

#### 9a. The `tool()` Function (SDK-native)

```typescript
// @anthropic-ai/claude-agent-sdk
function tool<Schema extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Schema, // Zod schema, NOT JSON Schema
    handler: (
        args: z.infer<ZodObject<Schema>>,
        extra: unknown,
    ) => Promise<CallToolResult>,
): SdkMcpToolDefinition<Schema>;
```

- Uses **Zod schemas** (peer dependency `zod ^4.0.0`)
- Handler `extra` parameter is typed `unknown` and unused in all known examples (MCP protocol compatibility)
- Returns `CallToolResult`: `{ content: [{ type: "text", text: string }], isError?: boolean }`

#### 9b. `createSdkMcpServer()` — In-Process MCP Server

```typescript
function createSdkMcpServer(options: {
    name: string;
    version?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance; // { type: 'sdk', name: string, instance: McpServer }
```

#### 9c. Wiring Into Sessions

Tools injected via `options.mcpServers: Record<string, McpServerConfig>` which accepts `McpSdkServerConfigWithInstance`.

#### 9d. Permission Control (`canUseTool`)

```typescript
type CanUseTool = (
    toolName: string,
    input: ToolInput,
    options: { signal: AbortSignal },
) => Promise<
    | { behavior: "allow"; updatedInput: ToolInput }
    | { behavior: "deny"; message: string; interrupt?: boolean }
>;
```

Used in Atomic at `src/sdk/claude-client.ts:210-268` for `AskUserQuestion` handling.

#### 9e. Zod-to-JSON Schema Gap

The Atomic codebase bridges `ToolDefinition` (JSON Schema) to the SDK's Zod-based `tool()` by passing `inputSchema: {}` (empty) and casting with `as any`. Schema validation happens in the handler, not at the SDK layer.

### 10. Copilot SDK Tool Registration (External)

**Source**: DeepWiki `github/copilot-sdk`, `docs/copilot-cli/usage.md`, `docs/copilot-cli/skills.md`

#### 10a. Upstream `Tool<TArgs>` Interface

```typescript
// @github/copilot-sdk
export interface Tool<TArgs = unknown> {
    name: string;
    description?: string;
    parameters?: ZodSchema<TArgs> | Record<string, unknown>; // Zod OR JSON Schema
    handler: ToolHandler<TArgs>;
}

export type ToolHandler<TArgs = unknown> = (
    args: TArgs,
    invocation: ToolInvocation, // { sessionId, toolCallId, toolName, arguments }
) => Promise<unknown> | unknown;
```

- `parameters` accepts **either** a Zod schema or raw JSON Schema — the SDK auto-converts Zod to JSON Schema via `toJSONSchema()`
- `handler` receives `(args, invocation)` where `invocation` provides session context

#### 10b. `defineTool()` Helper

```typescript
export function defineTool<T = unknown>(
    name: string,
    config: {
        description?: string;
        parameters?: ZodSchema<T> | Record<string, unknown>;
        handler: ToolHandler<T>;
    },
): Tool<T>;
```

#### 10c. `ToolResult` Type

```typescript
export type ToolResult =
    | string
    | {
          textResultForLlm: string;
          resultType: "success" | "failure";
          error?: string; // Internal error details, NOT sent to LLM
          binaryResultsForLlm?: ToolBinaryResult[];
          toolTelemetry?: Record<string, unknown>;
      };
```

#### 10d. `SessionConfig` — `tools` vs `availableTools`

- **`tools`** (`Tool[]`): Custom tool **implementations** with handler functions
- **`availableTools`** (`string[]`): Whitelist of tool names the AI can see

In the Atomic codebase, `config.tools` (unified `SessionConfig.tools: string[]`) maps to `availableTools`, while `this.registeredTools` (from `registerTool()`) maps to `tools` — see `src/sdk/copilot-client.ts:636`.

#### 10e. Gap: `ToolInvocation` Context Dropped

The Atomic `convertTool()` at `copilot-client.ts:527-534` wraps the handler as `async (args) => tool.handler(args)`, dropping the `invocation` parameter. This means registered tools cannot access `sessionId`, `toolCallId`, or `toolName` from within their handlers.

### 11. Tool Event Flow (SDK → UI Rendering)

The complete lifecycle from tool registration to UI rendering:

1. **Registration entry point** — `src/commands/chat.ts:168-173`: `createClientForAgentType()` creates the SDK client; for Copilot, `client.registerTool(createTodoWriteTool())` registers the TodoWrite tool
2. **Event subscription** — `src/ui/index.ts:342-569`: `subscribeToToolEvents()` registers handlers for `tool.start` and `tool.complete` events on the client before session creation (line 587)
3. **Tool start** (lines 343-403): Generates a unique `toolId`, tracks it in `toolNameToIds` FIFO stack, calls `state.toolStartHandler()`
4. **Tool complete** (lines 407-442): Matches `toolId` via FIFO stack, calls `state.toolCompleteHandler()` with `toolName`, `toolResult`, `success`
5. **ChatApp handler bridge** (lines 780-785): `registerToolStartHandler` and `registerToolCompleteHandler` callbacks are passed as props to `ChatApp`, registered via `useEffect` at `src/ui/chat.tsx:1634-1644`
6. **Rendering** — `src/ui/components/tool-result.tsx:256-353`: `ToolResult` component calls `getToolRenderer(toolName)` from the UI registry, renders title, content, and status indicator

**Tool event type mapping per SDK:**

| SDK      | Native Event                                        | Unified Event   |
| -------- | --------------------------------------------------- | --------------- |
| Claude   | `PreToolUse` hook                                   | `tool.start`    |
| Claude   | `PostToolUse` hook                                  | `tool.complete` |
| Copilot  | `tool.execution_start`                              | `tool.start`    |
| Copilot  | `tool.execution_complete`                           | `tool.complete` |
| OpenCode | SSE `message.part.updated` (status=pending/running) | `tool.start`    |
| OpenCode | SSE `message.part.updated` (status=completed/error) | `tool.complete` |

## Code References

- `src/sdk/types.ts:471-484` — `ToolDefinition` interface
- `src/sdk/types.ts:524` — `CodingAgentClient.registerTool()` method signature
- `src/sdk/types.ts:241-253` — `EventType` union including `tool.start`, `tool.complete`
- `src/sdk/types.ts:310-329` — `ToolStartEventData`, `ToolCompleteEventData`
- `src/sdk/claude-client.ts:756-798` — Claude `registerTool()` implementation
- `src/sdk/claude-client.ts:108-110` — Claude hook event mapping (`PreToolUse` → `tool.start`)
- `src/sdk/claude-client.ts:210-268` — AskUserQuestion HITL via `canUseTool`
- `src/sdk/copilot-client.ts:527-534` — Copilot `convertTool()` helper
- `src/sdk/copilot-client.ts:727-729` — Copilot `registerTool()` implementation
- `src/sdk/copilot-client.ts:124-140` — Copilot event type mapping
- `src/sdk/opencode-client.ts:1070-1074` — OpenCode `registerTool()` implementation
- `src/sdk/opencode-client.ts:446-496` — OpenCode SSE-based tool event handling
- `src/sdk/tools/todo-write.ts:67-92` — Canonical `ToolDefinition` example (`createTodoWriteTool()`)
- `src/sdk/base-client.ts:32-104` — `EventEmitter` shared utility
- `src/sdk/init.ts:24-33` — Claude initialization options
- `src/sdk/init.ts:54-59` — OpenCode permission rules
- `src/sdk/init.ts:70-77` — Copilot session options
- `src/sdk/index.ts` — SDK module re-exports
- `src/commands/chat.ts:168-173` — Tool registration entry point
- `src/ui/index.ts:342-569` — `subscribeToToolEvents()` event bridge
- `src/ui/components/tool-result.tsx:256-353` — `ToolResult` React component
- `src/ui/tools/registry.ts:582-614` — `TOOL_RENDERERS` and `getToolRenderer()`
- `src/ui/tools/registry.ts:464-503` — `defaultToolRenderer` (fallback for custom tools)
- `src/ui/tools/registry.ts:554-573` — `todoWriteToolRenderer`
- `src/ui/commands/skill-commands.ts:1669-1681` — Skill discovery path constants
- `src/ui/commands/skill-commands.ts:1722-1765` — `discoverSkillFiles()` directory scanner
- `src/ui/commands/skill-commands.ts:1705-1720` — `shouldSkillOverride()` priority resolution
- `src/ui/commands/skill-commands.ts:1851-1906` — `discoverAndRegisterDiskSkills()` orchestrator
- `src/utils/settings.ts:21-28` — `.atomic/settings.json` path resolution
- `src/utils/mcp-config.ts:130-157` — `discoverMcpConfigs()` multi-format discovery
- `src/utils/markdown.ts` — `parseMarkdownFrontmatter()` shared utility

## Architecture Documentation

### Current Tool Registration Flow

```
1. Client.start() → Initialize SDK connection
2. Client.registerTool(toolDef) → Store tool definition internally
   - Claude: createSdkMcpServer() → Map<string, McpSdkServerConfigWithInstance>
   - Copilot: push to ToolDefinition[] array
   - OpenCode: Map<string, ToolDefinition> (no-op for SDK passthrough)
3. Client.createSession(config) → Build session with registered tools
   - Claude: inject into options.mcpServers
   - Copilot: convert and inject into sdkConfig.tools
   - OpenCode: tools stored but not yet injected
4. Session.stream(message) → Agent can invoke registered tools
5. Tool events emitted: "tool.start" → "tool.complete"
6. UI renders tool result via getToolRenderer(toolName)
```

### Skill Discovery as Architectural Precedent

The skill loading system establishes the pattern for filesystem-based extension discovery:

```
Discovery Phase (startup):
  discoverSkillFiles() → scan multiple directory paths
  parseSkillFile() → extract metadata only (L1)

Priority Resolution:
  shouldSkillOverride() → project > atomic > global > builtin
  PINNED_BUILTIN_SKILLS → protected from override

Registration Phase:
  discoverAndRegisterDiskSkills() → register with globalRegistry

Invocation Phase (lazy, on-demand):
  loadSkillContent() → read full content (L2)
  expandArguments() → interpolate user args
  context.sendSilentMessage() → inject into session
```

### SDK Client Architecture (Strategy Pattern)

All three clients implement the `CodingAgentClient` interface, allowing uniform tool registration:

```
CodingAgentClient (src/sdk/types.ts:494-545)
  ├── ClaudeAgentClient (src/sdk/claude-client.ts)
  │   └── registerTool() → MCP server wrapping
  ├── CopilotClient (src/sdk/copilot-client.ts)
  │   └── registerTool() → direct tool array
  └── OpenCodeClient (src/sdk/opencode-client.ts)
      └── registerTool() → stored for future use
```

## Historical Context (from research/)

- `specs/2026-02-09-skill-loading-from-configs-and-ui.md` — Detailed spec for skill loading that establishes the discovery + priority + registration pattern. Sections 5.1-5.3 are directly applicable to tool discovery.
- `specs/2026-02-09-mcp-support-and-discovery.md` — MCP config discovery spec, demonstrates multi-format, multi-location config discovery.
- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md` — Research document supporting the skill loading spec.

## Related Research

- `specs/2026-02-09-skill-loading-from-configs-and-ui.md` — Most directly relevant: same discovery/priority/registration pattern
- `specs/2026-02-09-mcp-support-and-discovery.md` — MCP discovery pattern (multi-location, deduplication)

## Open Questions

1. **Schema format**: Issue #165 proposes Zod-based schemas (`tool.schema.string()`, etc.). The current `ToolDefinition.inputSchema` is JSON Schema (`Record<string, unknown>`). Should custom tools use Zod (which Bun can import natively) and convert to JSON Schema internally, or should they use JSON Schema directly? Claude SDK uses Zod internally, but the unified interface uses JSON Schema.

2. **Dynamic import mechanism**: Bun's dynamic `import()` can load `.ts` files directly. Should tools be imported eagerly at session start (like OpenCode) or lazily on first invocation (like the skill progressive disclosure model)?

3. **OpenCode tool passthrough**: `OpenCodeClient.registerTool()` currently stores tools but doesn't inject them into sessions. For custom tools to work with OpenCode, either:
    - Register them as MCP servers via `client.mcp.add()`, or
    - The OpenCode server itself would need to discover tools from `.atomic/tools/`

4. **Tool context**: Issue #165 proposes passing session context (agent, sessionID, directory, worktree) to tool execute functions. The current `ToolDefinition.handler` signature is `(input: unknown) => unknown | Promise<unknown>` with no context parameter. Should the interface be extended?

5. **Hot reload**: Issue #165 states "Tools should be discovered/reloaded on session start." The skill system discovers once at app startup. Should tools follow the same pattern (discover once at startup) or re-discover per session?

6. **`@atomic/plugin` import**: Issue #165 references `import { tool } from "@atomic/plugin"`. This package does not currently exist. It would need to be created as a helper library that exports the `tool()` factory function and `tool.schema` (Zod-based schema helpers).
