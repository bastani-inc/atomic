---
issue: https://github.com/bastani/atomic/issues/164
title: "feat: add MCP support and discovery for config files"
date: 2026-02-08
branch: lavaman131/feature/tui
commit: 5b33b79c1b8a4a2131b4640b077b16dd3a9bf352
related_research:
    - 2026-02-06-mcp-tool-calling-opentui.md
tags: [mcp, config-discovery, slash-command, sdk-parity]
---

# MCP Support and Discovery for Config Files

## Issue Summary

[Issue #164](https://github.com/bastani/atomic/issues/164) requests:

1. Parse MCP config files from all three SDK config formats (`.mcp.json`, `mcp-config.json`, `opencode.json`)
2. Auto-discover config files in the project root
3. Register MCP servers and expose their tools to agents
4. Implement a `/mcp` slash command to display and toggle MCP servers globally

> **Deferred**: `/context` command to display MCP tool information (separate effort).

## Current State of MCP in Atomic

### What Works

- **Claude SDK auto-discovery**: `settingSources: ["project"]` in [`src/sdk/init.ts:27`](https://github.com/bastani/atomic/blob/5b33b79/src/sdk/init.ts#L27) causes the Claude SDK to auto-discover and connect to MCP servers defined in `.mcp.json` at the project root.
- **Claude client MCP passthrough**: [`src/sdk/claude-client.ts:270-281`](https://github.com/bastani/atomic/blob/5b33b79/src/sdk/claude-client.ts#L270-L281) converts `SessionConfig.mcpServers` to the Claude SDK format.
- **Copilot client MCP mapping**: [`src/sdk/copilot-client.ts:641-661`](https://github.com/bastani/atomic/blob/5b33b79/src/sdk/copilot-client.ts#L641-L661) maps the unified `McpServerConfig[]` to Copilot SDK's `Record<string, MCPServerConfig>`.
- **MCP tool renderer**: [`src/ui/tools/registry.ts:506-589`](https://github.com/bastani/atomic/blob/5b33b79/src/ui/tools/registry.ts#L506-L589) with `parseMcpToolName()` at line 515 and `mcpToolRenderer` at line 525 can render MCP tool calls in the TUI.
- **Unified McpServerConfig type**: [`src/sdk/types.ts:26-39`](https://github.com/bastani/atomic/blob/5b33b79/src/sdk/types.ts#L26-L39) defines a shared interface.

### What Does NOT Work

- **OpenCode client ignores `mcpServers`**: [`src/sdk/opencode-client.ts`](https://github.com/bastani/atomic/blob/5b33b79/src/sdk/opencode-client.ts#L1019) does not pass `config.mcpServers` to the OpenCode SDK. OpenCode handles MCP server-side via its own config.
- **Only `.mcp.json` is read**: [`src/commands/chat.ts:177-194`](https://github.com/bastani/atomic/blob/5b33b79/src/commands/chat.ts#L177-L194) reads `.mcp.json` (Claude format) and passes `mcpServers` to `SessionConfig`, but does NOT read `mcp-config.json` (Copilot) or `opencode.json` (OpenCode) configs.
- **No `/mcp` slash command exists**: Not in [`src/ui/commands/builtin-commands.ts`](https://github.com/bastani/atomic/blob/5b33b79/src/ui/commands/builtin-commands.ts) or any other command file.
- **No multi-format config discovery**: No code discovers or normalizes MCP configs from Copilot or OpenCode config formats.
- **No MCP status display**: No UI component shows MCP server status to the user.

---

## SDK Config Formats

### Claude Code: `.mcp.json`

Location: project root or `~/.claude/.mcp.json`

```json
{
    "mcpServers": {
        "<server-name>": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@some/mcp-server"],
            "env": { "API_KEY": "..." }
        },
        "<server-name>": {
            "type": "http",
            "url": "https://example.com/mcp"
        },
        "<server-name>": {
            "type": "sse",
            "url": "https://example.com/sse",
            "headers": { "Authorization": "Bearer ..." }
        }
    }
}
```

**SDK types** (from `@anthropic-ai/claude-agent-sdk`):

- `McpStdioServerConfig`: `{ type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }`
- `McpSSEServerConfig`: `{ type: "sse"; url: string; headers?: Record<string, string> }`
- `McpHttpServerConfig`: `{ type: "http"; url: string; headers?: Record<string, string> }`
- `McpSdkServerConfigWithInstance`: `{ type: "sdk"; name: string; instance: McpServer }` (for programmatic MCP servers)
- `McpServerStatus`: `{ name: string; status: "connected" | "failed" | "needs-auth" | "pending"; serverInfo?: { name: string; version: string } }`
- Access via: `query().mcpServerStatus()` returns `McpServerStatus[]`
- Also available via `system` init message: `message.mcp_servers: { name: string; status: string }[]`

**Environment variable expansion**: Supports `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url`, and `headers` fields.

**Related settings** in `.claude/settings.json`:

- `enableAllProjectMcpServers: true` -- auto-approve project `.mcp.json` servers
- `enabledMcpjsonServers`, `disabledMcpjsonServers` -- per-server overrides

### Copilot CLI: `mcp-config.json`

Location: `~/.copilot/mcp-config.json` (user-level), `.copilot/mcp-config.json` (repo-level)

```json
{
    "mcpServers": {
        "<server-name>": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@some/mcp-server"],
            "env": { "KEY": "value" },
            "cwd": "/path",
            "tools": ["*"],
            "timeout": 30000
        },
        "<server-name>": {
            "type": "http",
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "..." },
            "tools": ["*"],
            "timeout": 30000
        },
        "<server-name>": {
            "type": "sse",
            "url": "https://example.com/sse",
            "headers": {},
            "tools": ["*"]
        }
    }
}
```

**SDK types** (from `@github/copilot-sdk`):

- `MCPLocalServerConfig`: `{ type: "local" | "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; tools?: string[]; timeout?: number }`
- `MCPRemoteServerConfig`: `{ type: "http" | "sse"; url: string; headers?: Record<string, string>; tools?: string[]; timeout?: number }`
- `SessionConfig.mcpServers`: `Record<string, MCPServerConfig>`

### OpenCode: `opencode.json` / `.opencode/opencode.json`

Location: project root `opencode.json` or `.opencode/opencode.json`

```json
{
    "mcp": {
        "<server-name>": {
            "type": "local",
            "command": ["npx", "-y", "@some/mcp-server"],
            "environment": { "KEY": "value" },
            "enabled": true,
            "timeout": 30000
        },
        "<server-name>": {
            "type": "remote",
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "..." },
            "enabled": true,
            "timeout": 30000
        }
    }
}
```

**Key differences from other SDKs**:

- Uses `"type": "local"` instead of `"stdio"`, `"remote"` instead of `"http"/"sse"`
- Uses `"command": string[]` (combined array) instead of separate `command` + `args`
- Uses `"environment"` instead of `"env"`
- Has `"enabled"` boolean field
- Has `"oauth"` field (`McpOAuthConfig | false`) for remote servers
- Supports variable substitution: `{env:VAR_NAME}`, `{file:path/to/file}`
- Remote transport auto-detects: tries StreamableHTTP first, falls back to SSE
- SDK methods: `sdk.client.mcp.status()`, `.connect()`, `.disconnect()`, `.add()`
- SSE events: `mcp.tools.changed`, `mcp.browser.open.failed`
- Tool naming: `{sanitizedServerName}_{sanitizedToolName}` (differs from Claude's `mcp__server__tool`)
- Config hierarchy: remote > global > custom > project > .opencode > inline > managed

---

## Unified McpServerConfig (Current)

Current interface at [`src/sdk/types.ts:26-39`](https://github.com/bastani/atomic/blob/5b33b79/src/sdk/types.ts#L26-L39):

```typescript
export interface McpServerConfig {
    name: string;
    type?: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
}
```

### Missing Fields

| Field         | Claude        | Copilot       | OpenCode           | Notes                       |
| ------------- | ------------- | ------------- | ------------------ | --------------------------- |
| `headers`     | SSE/HTTP only | Yes           | Yes                | Needed for auth tokens      |
| `cwd`         | No            | Yes           | No                 | Working directory for stdio |
| `timeout`     | No            | Yes           | Yes                | Connection timeout          |
| `tools`       | No            | Yes (`["*"]`) | No                 | Tool filter                 |
| `enabled`     | Via settings  | No            | Yes                | Toggle state                |
| `environment` | Uses `env`    | Uses `env`    | Uses `environment` | Alias needed                |
| `oauth`       | Separate      | No            | Yes                | OAuth config                |

### Recommended Extended Interface

```typescript
export interface McpServerConfig {
    name: string;
    type?: "stdio" | "http" | "sse";
    // stdio fields
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    // remote fields
    url?: string;
    headers?: Record<string, string>;
    // common fields
    enabled?: boolean;
    timeout?: number;
}
```

---

## Config File Discovery

### Files to Scan

| Config File               | SDK      | Key          | Location                                                 |
| ------------------------- | -------- | ------------ | -------------------------------------------------------- |
| `.mcp.json`               | Claude   | `mcpServers` | Project root, `~/.claude/.mcp.json`                      |
| `mcp-config.json`         | Copilot  | `mcpServers` | `~/.copilot/mcp-config.json`, `.copilot/mcp-config.json` |
| `opencode.json`           | OpenCode | `mcp`        | Project root                                             |
| `.opencode/opencode.json` | OpenCode | `mcp`        | Project root                                             |
| `opencode.jsonc`          | OpenCode | `mcp`        | Project root (JSONC format)                              |

### Parsing Strategy

Each config format needs a parser that normalizes entries to the unified `McpServerConfig`:

1. **Claude `.mcp.json`**: Direct mapping. `type` field matches. Add `name` from the object key.
2. **Copilot `mcp-config.json`**: Map `"local"` type to `"stdio"`. Add `name` from object key. Copilot uses same `command`/`args` split.
3. **OpenCode `opencode.json`**: Map `"local"` to `"stdio"`, `"remote"` to `"http"`. Split `command: string[]` into `command` (first element) and `args` (rest). Map `environment` to `env`. Respect `enabled` field.

### Discovery Order

When the user selects an agent in the chat, the appropriate config files should be read:

- **Claude agent**: Read `.mcp.json` (project root) + `~/.claude/.mcp.json` (personal)
- **Copilot agent**: Read `.copilot/mcp-config.json` (repo-level) + `~/.copilot/mcp-config.json` (user-level)
- **OpenCode agent**: Read `opencode.json` or `.opencode/opencode.json` (project root)

Additionally, a unified approach could read ALL config files and merge, deduplicating by server name.

---

## `/mcp` Command Behavior Across SDKs

### Claude Code `/mcp`

- **Display type**: Inline interactive list in terminal
- **Shows**: Server name, connection status (`connected`/`failed`/`needs auth`)
- **Actions**: View servers, check status, authenticate OAuth, clear auth
- **Cannot**: Add, remove, or edit servers (uses `claude mcp add/remove` CLI)
- **Scope aggregation**: Shows servers from local, project, and user scopes

### OpenCode `/mcp`

- **Display type**: Modal dialog overlay (searchable)
- **Shows**: Server name, connection status (color-coded: green/red/gray/orange), error messages
- **Actions**: Toggle connect/disconnect via Switch component, search/filter
- **Cannot**: Add, remove, or edit servers (uses `opencode mcp add/remove` CLI)
- **Keybind**: `Mod+;`
- **Sidebar**: Also shows MCP status with colored bullets, collapses when >2 entries

### Copilot CLI `/mcp`

- **Display type**: Inline text output with subcommands
- **Subcommands**: `show`, `add`, `edit`, `delete`, `enable`, `disable`
- **Shows**: Server name, type (built-in/local/remote), status, command, config path, total count
- **Actions**: Full CRUD via subcommands, interactive add wizard
- **Special**: Built-in GitHub MCP server, plugin-bundled servers

### Comparative Summary

| Feature               | Claude      | OpenCode        | Copilot                   |
| --------------------- | ----------- | --------------- | ------------------------- |
| Display               | Inline list | Modal overlay   | Inline text               |
| Toggle on/off         | Yes         | Yes (Switch)    | Yes (enable/disable)      |
| Add/Remove in-session | No          | No              | Yes                       |
| Search/Filter         | No          | Yes             | No                        |
| Color status          | No          | Yes             | Checkmark/cross           |
| Server details        | Minimal     | Status + errors | Name, type, command, path |
| OAuth in-session      | Yes         | Via CLI command | Yes                       |

---

## Slash Command Infrastructure

### Registration Pattern

From [`src/ui/commands/registry.ts`](https://github.com/bastani/atomic/blob/5b33b79/src/ui/commands/registry.ts):

```typescript
// CommandDefinition (lines 171-186)
interface CommandDefinition {
    name: string;
    description: string;
    category: "builtin" | "workflow" | "skill" | "agent" | "custom";
    execute: (context: CommandContext) => Promise<CommandResult>;
    aliases?: string[];
    hidden?: boolean;
    argumentHint?: string;
}

// CommandContext (lines 51-82)
interface CommandContext {
    session: SessionAPI;
    addMessage: (msg) => void;
    sendMessage: (text) => void;
    sendSilentMessage: (text) => void;
    spawnSubagent: (prompt) => void;
    // ...
}

// CommandResult (lines 138-161)
interface CommandResult {
    clearMessages?: boolean;
    showModelSelector?: boolean;
    themeChange?: ThemeConfig;
    showHelpOverlay?: boolean;
    // ...
}
```

### Existing Commands

6 built-in commands at [`src/ui/commands/builtin-commands.ts:460-467`](https://github.com/bastani/atomic/blob/5b33b79/src/ui/commands/builtin-commands.ts#L460-L467):

- `/help`, `/theme`, `/clear`, `/compact`, `/exit`, `/model`

Registration flow at [`src/ui/commands/index.ts:145-168`](https://github.com/bastani/atomic/blob/5b33b79/src/ui/commands/index.ts#L145-L168):

```
initializeCommandsAsync() → registerBuiltinCommands()
                           → registerWorkflowCommands()
                           → registerSkillCommands()
                           → registerAgentCommands()
```

### Adding `/mcp` Command

The `/mcp` command should be added in `builtin-commands.ts` and registered alongside existing builtins. It should:

1. Return a `CommandResult` with an appropriate flag (possibly a new `showMcpOverlay` flag)
2. Or render inline status using `addMessage()` from `CommandContext`

---

## Implementation Approach

### Phase 1: Config Discovery & Loading

1. **Create `src/utils/mcp-config.ts`** with parsers for each config format:
    - `parseClaudeMcpConfig(path: string): McpServerConfig[]` -- already partially done inline in `chatCommand` at `src/commands/chat.ts:177-194`; extract and generalize
    - `parseCopilotMcpConfig(path: string): McpServerConfig[]` -- reads `~/.copilot/mcp-config.json`
    - `parseOpenCodeMcpConfig(path: string): McpServerConfig[]` -- reads `opencode.json` or `.opencode/opencode.json`, maps `local`->`stdio`, `remote`->`http`, splits `command: string[]`
    - `discoverMcpConfigs(cwd: string, agentType?: string): McpServerConfig[]` -- auto-discovers all relevant configs

2. **Extend `McpServerConfig`** in `src/sdk/types.ts` with missing fields (`headers`, `enabled`, `cwd`, `timeout`)

3. **Refactor `chatCommand`** in `src/commands/chat.ts` to use `discoverMcpConfigs()` instead of inline `.mcp.json` parsing, enabling multi-format support

4. **Fix OpenCode client** to consume `config.mcpServers` when provided (or at minimum, log that OpenCode handles MCP server-side)

### Phase 2: `/mcp` Slash Command

1. **Add `/mcp` command** to `src/ui/commands/builtin-commands.ts`:
    - Display all discovered MCP servers with name, status, type
    - Support enable/disable toggle (updates `enabled` field)
    - Show inline status list (similar to Claude Code's approach, fits TUI patterns)

2. **Add a `CommandResult` flag** for MCP state changes if needed, or use `addMessage()` for inline display

3. **Consider using OpenTUI dialog** for the toggle UI (similar to OpenCode's modal pattern), leveraging existing dialog infrastructure

### Phase 3: Status Integration (Future)

- MCP server status in session sidebar or header
- `/context` command showing MCP tool count
- Real-time status updates via SSE events

---

## Key Code Locations

| File                                  | Lines      | Purpose                                        |
| ------------------------------------- | ---------- | ---------------------------------------------- |
| `src/sdk/types.ts`                    | 26-39, 116 | `McpServerConfig`, `SessionConfig.mcpServers`  |
| `src/sdk/claude-client.ts`            | 270-281    | Claude MCP config conversion                   |
| `src/sdk/copilot-client.ts`           | 641-661    | Copilot MCP config mapping                     |
| `src/sdk/opencode-client.ts`          | ~1019      | OpenCode MCP (not implemented)                 |
| `src/sdk/init.ts`                     | 27         | `settingSources: ["project"]`                  |
| `src/ui/tools/registry.ts`            | 506-589    | MCP tool renderer                              |
| `src/ui/commands/builtin-commands.ts` | 460-467    | Built-in command registration                  |
| `src/ui/commands/registry.ts`         | 171-186    | `CommandDefinition` type                       |
| `src/ui/commands/index.ts`            | 145-168    | `initializeCommandsAsync()`                    |
| `src/commands/chat.ts`                | -          | `chatCommand` (needs `mcpServers` passthrough) |
| `.mcp.json`                           | -          | Claude MCP config (project root)               |
| `.opencode/opencode.json`             | -          | OpenCode config with MCP section               |
| `.claude/settings.json`               | -          | Claude settings with MCP approval flags        |

---

## External References

- [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp)
- [Claude Code Interactive Mode](https://code.claude.com/docs/en/interactive-mode)
- [OpenCode MCP Docs](https://opencode.ai/docs/mcp-servers/)
- [OpenCode MCP TUI (DeepWiki)](https://deepwiki.com/sst/opencode/6.4-tui-theming-and-keybinds)
- [GitHub Blog: Copilot CLI Slash Commands](https://github.blog/ai-and-ml/github-copilot/a-cheat-sheet-to-slash-commands-in-github-copilot-cli/)
- [Copilot CLI MCP Beginners Guide](https://github.com/DanWahlin/github-copilot-cli-for-beginners/blob/main/06-mcp-servers/README.md)
- [Claude Code Issue #7936: MCP scope aggregation](https://github.com/anthropics/claude-code/issues/7936)
- [OpenCode PR #5757: MCP CLI management commands](https://github.com/sst/opencode/pull/5757)
- Prior research: [`research/docs/2026-02-06-mcp-tool-calling-opentui.md`](./2026-02-06-mcp-tool-calling-opentui.md)
