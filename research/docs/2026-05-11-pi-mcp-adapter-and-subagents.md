# pi-mcp-adapter, pi-subagents & pi-intercom — Research

Research conducted: 2026-05-11.

- **pi-mcp-adapter** @ `184d3cb75fa017b8badf657622b4b7efbf85cfb6` (v2.5.4, 2026-05-05).
- **pi-subagents** @ `635112deea068528d89694e58ca068ddc1fe4b2d` (v0.24.x, 2026-05-10).

Both extensions are authored against the **pi-coding-agent** extension API (entry: `export default function(pi: ExtensionAPI)`). pi-mcp-adapter still targets the deprecated `@bastani/atomic` namespace and has open issue #91 to migrate to `@bastani/atomic`. pi-subagents has already migrated (commit `c3d3737`).

---

## REPO 1: pi-mcp-adapter

### Summary

At the audited upstream revision, this single-tool MCP proxy provided MCP server access with lazy loading, direct tool promotion, multi-source config, several third-party import formats, OAuth 2.1, MCP UI resources, and sampling. Atomic's current first-party adapter no longer supports Cursor compatibility imports; the historical upstream inventory below is not a statement of current Atomic support.

Lifecycle modes per-server: `lazy` (default), `eager`, `keep-alive`.

### Source map (44 TS files)

Entry point: `index.ts` (`export default function mcpAdapter(pi: ExtensionAPI)`).

Top-level structure:

1. Module-load reads `mcp-config` argv flag and early metadata cache.
2. Calls `pi.registerTool({name: spec.prefixedName, ...})` once per direct tool (synchronously, BEFORE session_start).
3. `pi.registerFlag("mcp-config", {type: "string"})` — CLI flag for explicit config path.
4. `pi.on("session_start", ...)` — boots `initializeMcp()` async.
5. `pi.on("session_shutdown", ...)` — tears down everything.
6. `pi.registerCommand("mcp", ...)` — subcommands `reconnect`, `tools`, `setup`, `status`.
7. `pi.registerCommand("mcp-auth", ...)` — OAuth flow per server.
8. Conditionally `pi.registerTool({name: "mcp", ...})` — the proxy tool.

Key files: `index.ts`, `init.ts`, `server-manager.ts`, `lifecycle.ts`, `config.ts`, `direct-tools.ts`, `proxy-modes.ts`, `commands.ts`, `mcp-panel.ts`, `mcp-setup-panel.ts`, `mcp-auth.ts`, `mcp-auth-flow.ts`, `sampling-handler.ts`, `consent-manager.ts`, `metadata-cache.ts`, `tool-metadata.ts`, `tool-registrar.ts`, `ui-server.ts`, `ui-session.ts`, `npx-resolver.ts`, `types.ts`.

### Config schema (verbatim from `types.ts`)

```ts
interface McpConfig {
    mcpServers: Record<string, ServerEntry>;
    imports?: ImportKind[]; // historical upstream schema; Atomic supports claude-code | claude-desktop | codex | windsurf | vscode
    settings?: McpSettings;
}

interface ServerEntry {
    // stdio
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    // http
    url?: string;
    headers?: Record<string, string>;
    auth?: "oauth" | "bearer" | false;
    bearerToken?: string;
    bearerTokenEnv?: string;
    oauth?: OAuthConfig | false;
    // lifecycle
    lifecycle?: "keep-alive" | "lazy" | "eager";
    idleTimeout?: number;
    // tool surface
    exposeResources?: boolean;
    directTools?: boolean | string[];
    excludeTools?: string[];
    debug?: boolean;
}

interface McpSettings {
    toolPrefix?: "server" | "none" | "short";
    idleTimeout?: number;
    directTools?: boolean;
    disableProxyTool?: boolean;
    autoAuth?: boolean;
    sampling?: boolean;
    samplingAutoApprove?: boolean;
    authRequiredMessage?: string;
}
```

### Discovery / loading

Config files only. No autodiscovery from running processes. All three MCP transports via `@modelcontextprotocol/sdk@^1.25.1`:

- **stdio** via `StdioClientTransport` (npx commands rewritten to direct `node ...` for speed).
- **streamable-http** first choice when `url` set.
- **SSE** fallback when streamable-http throws non-`UnauthorizedError`.

### Tool surfacing

Hybrid by default:

1. **Direct tools** — one `pi.registerTool()` per MCP tool at module-load (uses cached metadata, works without active connection).
2. **Proxy tool** (`mcp`) — single tool with `tool?`, `args?`, `connect?`, `describe?`, `search?`, `regex?`, `includeSchemas?`, `server?`, `action?` params.
3. Both can coexist. Proxy omitted when every server is fully direct.

### Approval/permission

- **Connection consent**: `ConsentManager` with modes `"never" / "once-per-server" / "always"`.
- **MCP sampling**: requires `ctx.ui.confirm` unless `samplingAutoApprove`.
- **OAuth**: `settings.autoAuth` auto-launches browser on `needs-auth`.

### Open issues to know about

- **#91** (high priority): migrate `@mariozechner/pi-ai` → `@earendil-works/pi-ai`.
- **#85**: programmatic session-scoped config for SDK integrations.
- **#76**: shared server processes across sessions.
- **#74 / PR #72**: hot-load direct tools without reload.
- **#69**: lazy MCP tool discovery via `ctx_discover_tools` impossible (tools frozen at module-load).
- **#47**: CLI installer downloads from GitHub `main` instead of npm tarball.
- **#20**: subagents cannot see MCP tools — exactly the gap Atomic should close.

---

## REPO 2: pi-subagents

### Summary

Delegation extension turning pi into a multi-agent orchestrator with builtin agents, chains, parallel execution, and async/background runs. Eight builtin agents: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `context-builder`, `oracle`, `delegate`.

- Natural-language delegation via `subagent` tool.
- Direct slash commands: `/run`, `/chain`, `/parallel`, `/run-chain`, `/subagents-doctor`.
- Execution modes: `single`, `parallel`, `chain` (sequential pipeline with `{previous}` substitution).
- Sync vs async (foreground streams live; background detaches).
- Worktree isolation for parallel agents (`git worktree add/remove`).
- Skills injection (markdown skills merged into agent system prompts).
- Live progress widget above editor; Ctrl+O expands details.
- Recursion guard via `PI_SUBAGENT_MAX_DEPTH` (default 2).
- Optional `pi-intercom` companion for child-to-parent blocking calls.

### Source map

Entry: `src/extension/index.ts` (22 KB).

- `loadConfig()` from `~/.pi/agent/extensions/subagent/config.json`.
- **One** `pi.registerTool({name: "subagent", ...})` with `renderCall`/`renderResult`.
- Four `pi.on(...)` subscriptions (`tool_result`, `session_start`, `session_shutdown`).
- Three `pi.registerMessageRenderer(...)` for custom message types.
- `registerSlashCommands(pi, state)` — wires `/run /chain /parallel /run-chain /subagents-doctor`.
- `registerPromptTemplateDelegationBridge(pi, state)`.
- Event-bus subscriptions for async lifecycle events.

Key directories: `extension/`, `agents/`, `slash/`, `tui/render.ts` (55 KB), `runs/foreground/` (incl. `subagent-executor.ts` 86 KB, `chain-execution.ts`), `runs/background/` (incl. `subagent-runner.ts` 61 KB), `runs/shared/` (`pi-spawn.ts`, `pi-args.ts`, `worktree.ts`, `fork-context.ts`), `intercom/`, `shared/types.ts` (21 KB), `shared/settings.ts`.

### Agent definition format (markdown + YAML frontmatter)

```yaml
---
name: <required>
description: <required>
model: claude-sonnet-4-6
thinking: low|medium|high|off
tools: read, grep, find, ls, bash, edit, write, contact_supervisor
skills: skill-name, ...
systemPromptMode: append|replace
inheritProjectContext: true|false
inheritSkills: true|false
defaultContext: fresh|fork
defaultReads: file1.md,file2.md
output: filename.md
interactive: true|false
maxSubagentDepth: 2
---
<body becomes systemPrompt>
```

### Discovery roots

| Source | User                                       | Project                          | Builtins              |
| ------ | ------------------------------------------ | -------------------------------- | --------------------- |
| Agents | `~/.pi/agent/agents/`, `~/.agents/`        | `.pi/agents/`, `.agents/`        | shipped `agents/*.md` |
| Chains | `~/.pi/agent/chains/`                      | `.pi/chains/`                    | –                     |
| Skills | `~/.agents/skills/`, `~/.pi/agent/skills/` | `.pi/skills/`, `.agents/skills/` | –                     |

### Context isolation strategy — **subprocess-based**

`pi-spawn.ts` spawns a separate `pi` CLI process per sub-agent. Two flavors:

- `defaultContext: "fresh"` — child gets fresh `--session` directory.
- `defaultContext: "fork"` — `fork-context.ts` pre-creates a forked session from parent JSONL, child opens via `--session <file>`.

Tools inherited by **explicit re-spawn with curated tool list** (`--tools` flag).

Streaming back to parent: child writes JSONL to stdout; parent parses via `createJsonlWriter`; widget updates live.

### Interruption

- Foreground: `subagent-executor.ts` tracks per-run interrupt fn.
- Async: OS signal — `SIGBREAK` on Windows, `SIGUSR2` on Unix.

### Open issues to know about

- **#147**: fork-context child crashes after parent compaction (Anthropic thinking-block replay requirement).
- **#161**: parallel fork-context steps serialize on parent file lock.
- **#157**: jiti resolution fails on Homebrew installs post-rename.
- **#155**: `keepWorktrees` from config silently overridden by missing frontmatter.
- **#143**: subagents bypass parent permission gates.
- **#159**: hard-coded max-agents limit at 8.
- **#37**: generic `piArgs` pass-through requested (PR open).
- **#36**: "ask user" tool requested (plan-mode parity with Claude).

---

---

## REPO 3: pi-intercom (optional companion to pi-subagents)

### Summary

Per the pi-subagents README's [Optional pi-intercom companion](https://github.com/nicobailon/pi-subagents/tree/main#optional-pi-intercom-companion) section: pi-subagents works fine without pi-intercom, but with it, child agents get a **private coordination channel back to the parent Pi session while they are running**. The bridge auto-activates when pi-subagents detects pi-intercom is installed (recognizes the normal `pi install npm:pi-intercom` package install OR a legacy local extension checkout).

### What it gives children

- **`contact_supervisor` tool** with two `reason` values:
    - `reason: "need_decision"` — blocking call; child waits for parent's answer (clarification, decision when discovery changes the plan).
    - `reason: "progress_update"` — non-blocking; surfaces in the parent session as a notification when something meaningful changes.
- **Generic `intercom` tool** as fallback plumbing.

### What it gives the parent

- Parent-side **grouped delivery of child completion results** through pi-intercom: one grouped message per foreground parent `subagent` run + one per completed async result file. Acknowledged foreground deliveries return a compact receipt with artifact/session paths; unacknowledged falls back to full output.
- **Needs-attention notices** surfaced in the parent session when a child appears stalled, with actionable next steps (check `subagent({action: "status"})`, interrupt the run, nudge the child).
- New `pi.events` channels: `subagent:control-intercom`, `subagent:result-intercom`.

### Activation requirements (per pi-subagents README)

1. pi-intercom installed and enabled (`pi install npm:pi-intercom` or a legacy local extension checkout).
2. A targetable current session name OR fallback alias.
3. `pi-intercom` present in any explicit agent `extensions` allowlist (agents that omit `extensions` get all normal extensions including intercom; agents with an explicit allowlist must list it).

### Configuration (pi-subagents' `intercomBridge`)

Read from `~/.pi/agent/extensions/subagent/config.json`:

```jsonc
{
    "intercomBridge": {
        "mode": "always", // "always" | "fork-only" | "off"
        "instructionFile": "./intercom-bridge.md", // optional Markdown template; {orchestratorTarget} interpolated
    },
}
```

- `mode: "always"` (default upstream): inject bridge for every sub-agent run.
- `mode: "fork-only"`: only inject for forked-context children.
- `mode: "off"`: disable the bridge.

### Use-case examples (verbatim from README)

> _"Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom."_
>
> _"Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming."_

### Diagnostics

`/subagents-doctor` reports whether the intercom bridge is properly configured.

### Recommendation for Atomic

**Ship pi-intercom by default alongside pi-subagents.** Atomic's workflow extension (§5.4 in the rewrite spec) routinely spawns long-running background stages and lets users detach; without intercom, a stuck stage either burns tokens guessing or fails silently. Default `mode: "always"`; Atomic-side glue adds rate-limiting on `progress_update` to avoid chat-scroll noise. Stable parent session name set via `pi.setSessionName(...)` in our integration extension on `session_start`.

---

## Integration Recommendation for Atomic

**Ship them as separate, default-installed first-party packages in the Atomic monorepo, NOT as in-tree bundles.**

### Trade-offs

**Option 1 — Bundle in-tree (delete the extension shape):**

- Pros: zero install friction, tight integration, can fix open issues without extension API straitjacket.
- Cons: ~100 TS files merged; forfeit upstream patches; harder to support opt-out; tightly couples release cadence to MCP spec drift.

**Option 2 — First-class default-installed packages (`@atomic/mcp`, `@atomic/subagents`):**

- Pros: clean extension boundary; CLI guarantees presence (auto-install on `atomic init`/upgrade); users can pin/disable individually; can keep tracking upstream via thin fork.
- Cons: two more npm packages; deeper integration points need cross-package coordination.

**Option 3 — Extension-only, document third-party install:**

- Pros: zero new code in Atomic.
- Cons: defeats out-of-the-box pitch; users hit pi-mcp-adapter's brittle installer (issue #47); rebrand muddied.

### Recommended path

1. **Vendor both as `@atomic/mcp` and `@atomic/subagents`** in the monorepo (pi-subagents at `635112d`, pi-mcp-adapter at `184d3cb`).
2. **Atomic CLI auto-installs them on first launch** (silent, no GitHub clone).
3. **Immediate patches**:
    - pi-mcp-adapter: swap `@mariozechner/pi-ai` → `@earendil-works/pi-ai` (#91).
    - pi-subagents: add `jiti` to direct deps (#157). Test fork-context against compaction (#147).
4. **Cross-cutting wins**:
    - Share MCP server pool across parent + foreground sub-agents (closes #76 + #20 together).
    - Permission inheritance: parent's `tool_call` interceptors apply to children (#143).
    - Compact-friendly fork context.
    - Atomic-themed renderer for MCP tools (#57, #82, #55).
5. **Keep extension hook surface unchanged** so we can rebase from upstream.

### Public extension hook idioms to mirror

- **Generation-counter race guard** for `session_start` lifecycle (pi-mcp-adapter `index.ts:lifecycleGeneration`).
- **Synchronous tool registration at module load** when registrations must precede `session_start`.
- **Custom message renderers** (`pi.registerMessageRenderer`) for persistent in-conversation artifacts.
- **In-process event bus** (`pi.events`) for cross-extension coordination.
- **TypeBox `Type.Object({...})` parameters with a discriminator field** to keep one tool registration thin but multifunctional.
