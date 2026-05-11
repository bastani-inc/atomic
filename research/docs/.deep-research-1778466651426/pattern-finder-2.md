# Partition 2 Pattern Finder: Skills, Prompts, MCP Loading & Configuration

## Skills Discovery and Loading

### Pattern 1: YAML Frontmatter Skill Metadata
**Where:** `.agents/skills/*/SKILL.md:1-10`
**What:** All skills use YAML frontmatter to declare name, description, and optional metadata fields.

```yaml
---
name: atomic
description: |
  The Atomic guide. Activate whenever the user asks how Atomic works, when to use
  which workflow or skill, how to chain research → spec → implementation, how to
  create custom workflows, how to refine a prompt, how to see available workflows,
  or any "how do I" / "when do I" / decision question about using Atomic.
metadata:
  provider: atomic
---
```

**Variations:**
- `.agents/skills/bun/SKILL.md:1-9` - Includes `version` and `internal: true` flags in metadata
- `.agents/skills/typescript-expert/SKILL.md:1-10` - Marks `internal: true` for excluded skill
- `.agents/skills/tool-design/SKILL.md:1-6` - Includes `provider: atomic` in all bundled skills

### Pattern 2: Global Skills Directory Symlink
**Where:** `.claude/skills -> ../.agents/skills` (symlink)
**What:** Claude Code consumes bundled skills via symlink to the `.agents/skills` directory.

```bash
# .claude/skills is a symlink to .agents/skills
lrwxrwxrwx .claude/skills -> ../.agents/skills

# Results in three identical skill trees:
~/.claude/skills/       (Claude Code)
~/.agents/skills/       (OpenCode + Copilot)
```

**Related:**
- `.agents/` contains 43+ skill directories bundled with Atomic
- Symlink enables single-source-of-truth for all three coding agents
- Skills service: `packages/atomic/src/services/system/skills.ts:35-50`

### Pattern 3: Skills Installation to Global Homes
**Where:** `packages/atomic/src/services/system/skills.ts:35-50`
**What:** At install time, bundled skills are copied to provider-native global skill directories.

```typescript
async function installGlobalSkills(): Promise<void> {
  const src = await getEmbeddedAsset("skills");
  
  if (!(await pathExists(src))) {
    throw new Error(`Bundled skills missing at ${src}`);
  }
  
  const home = homeRoot();
  const ignoreFilter = createCommonIgnoreFilter();
  
  await Promise.all(
    SKILL_DEST_DIRS.map((rel) =>
      copyDir(src, join(home, rel), { ignoreFilter }),
    ),
  );
}
```

**Destinations (SKILL_DEST_DIRS):**
- `~/.agents/skills` (OpenCode + Copilot CLI)
- `~/.claude/skills` (Claude Code)

**Related:** `packages/atomic/src/services/system/skills.ts:27-30`

---

## Skills Lock and Version Management

### Pattern 4: Skills Lock File Registry
**Where:** `skills-lock.json:1-112`
**What:** JSON registry tracks installed skills with source, path, and hash for integrity verification.

```json
{
  "version": 1,
  "skills": {
    "ast-grep": {
      "source": "ast-grep/agent-skill",
      "sourceType": "github",
      "skillPath": "ast-grep/skills/ast-grep/SKILL.md",
      "computedHash": "3bca45167617f547e97454ae16d271ba3aeb2550d89e6ef1942057bd122c0061"
    },
    "bun": {
      "source": "bun.sh",
      "sourceType": "well-known",
      "computedHash": "e81aa6ae97fdbc21cbccdbee38e0f314171fe8d7a09c5fdda72b82095cf4b9fa"
    },
    "impeccable": {
      "source": "pbakaus/impeccable",
      "sourceType": "github",
      "skillPath": ".agents/skills/impeccable/SKILL.md",
      "computedHash": "15ca2efbf646ed89e85f56470d2a6bbe96268134b7e1e2ce9908ecf3d672119c"
    }
  }
}
```

**Variations (sourceType values):**
- `"github"` - GitHub repo references (e.g., `ast-grep/agent-skill`)
- `"well-known"` - Well-known sources (e.g., `bun.sh`)
- Local bundled skills have paths like `.agents/skills/impeccable/SKILL.md`

**Track:** 43+ skills registered with unique hashes for change detection

---

## Agent Discovery and Configuration

### Pattern 5: Multi-Agent Configuration Discovery
**Where:** `packages/atomic/src/services/config/atomic-global-config.ts:44-48`
**What:** Atomic discovers and installs agents into provider-native global config directories.

```typescript
const AGENT_DIR_PAIRS: AgentSyncPair[] = [
  { kind: "claude", dest: ".claude/agents" },
  { kind: "opencode", dest: ".opencode/agents" },
  { kind: "github", dest: ".copilot/agents" },
];
```

**Installation pattern (installGlobalAgents):**
```typescript
export async function installGlobalAgents(): Promise<void> {
  const home = homeRoot();
  
  for (const { kind, dest } of AGENT_DIR_PAIRS) {
    const src = join(await getEmbeddedAsset(kind), "agents");
    const target = join(home, dest);
    
    if (!(await pathExists(src))) {
      warnings.push(`bundled agents missing at ${src}`);
      continue;
    }
    
    await copyDir(src, target, { ignoreFilter: createCommonIgnoreFilter() });
  }
  
  // Copilot's lsp.json renamed to ~/.copilot/lsp-config.json
  const lspSrc = join(await getEmbeddedAsset("github"), "lsp.json");
  const lspDest = join(home, ".copilot", "lsp-config.json");
  if (await pathExists(lspSrc)) {
    await ensureDir(dirname(lspDest));
    await copyFile(lspSrc, lspDest);
  }
}
```

**Related:** `packages/atomic/src/services/config/atomic-global-config.ts:55-87`

### Pattern 6: Agent Definition Files
**Where:** `.claude/agents/*.md` (12 files), `.opencode/agents/*.md` (12 files), `.github/agents/*.md` (12 files)
**What:** YAML frontmatter agents declare name, description, tools, and model selection.

```markdown
---
name: orchestrator
description: Orchestrate sub-agents to accomplish complex long-horizon tasks without losing coherency by delegating to sub-agents.
tools: Bash, Agent, Edit, Grep, Glob, Read, TaskCreate, TaskList, TaskGet, TaskUpdate
model: opus
--- 

You are a sub-agent orchestrator that has a large number of tools available to you...
```

**Agent inventory:**
- `orchestrator.md` - Dispatches sub-agents for research/codebase tasks
- `planner.md` - Long-horizon planning and orchestration
- `worker.md` - Task implementation
- `reviewer.md` - Code review and quality assessment
- `codebase-analyzer.md` - Codebase understanding
- `codebase-pattern-finder.md` - Pattern discovery
- `debugger.md` - Debugging assistance
- Plus 5 more specialized agents

**Related:** `.claude/agents/`, `.opencode/agents/`, `.github/agents/` (identical files in all three)

---

## MCP Server Configuration and Discovery

### Pattern 7: MCP Server Configuration Files
**Where:** `.claude/.mcp.json:1-20`
**What:** Claude Code MCP configuration defines HTTP and stdio-based MCP servers.

```json
{
  "mcpServers": {
    "github-mcp-server": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GH_TOKEN}"
      }
    },
    "azure-devops": {
      "type": "stdio",
      "command": "bunx",
      "args": [
        "-y",
        "@azure-devops/mcp",
        "<your-org>"
      ]
    }
  }
}
```

**Pattern variants:**
- HTTP servers: requires `url` and optional `headers`
- Stdio servers: requires `command` and `args`
- Uses environment variables: `${GH_TOKEN}`
- Both HTTP and stdio patterns for SCM integration

**Related:** `.opencode/opencode.json:3-22`

### Pattern 8: OpenCode MCP Configuration
**Where:** `.opencode/opencode.json:3-22`
**What:** OpenCode uses nested `mcp` object with `type`, `command`/`url`, and `enabled` flags.

```json
{
  "mcp": {
    "azure-devops": {
      "type": "local",
      "command": [
        "bunx",
        "-y",
        "@azure-devops/mcp",
        "<your-org>"
      ],
      "enabled": false
    },
    "github-mcp-server": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:GH_TOKEN}"
      }
    }
  },
  "permission": "allow",
  "instructions": [
    "~/.atomic/AGENTS.md"
  ]
}
```

**OpenCode-specific syntax:**
- `type: "local"` vs `"remote"` (instead of `"stdio"` / `"http"`)
- Per-server `enabled: boolean` flag
- Environment variable syntax: `{env:GH_TOKEN}` (not `${...}`)
- Top-level `permission` and `instructions` fields

**Related:** `.opencode/opencode.json` entire file

### Pattern 9: SCM-Driven MCP Server Enable/Disable Sync
**Where:** `packages/atomic-sdk/src/services/config/scm-sync.ts:22-187`
**What:** Atomic automatically enables/disables MCP servers based on selected SCM in `.atomic/settings.json`.

```typescript
const SCM_MCP_SERVERS = ["github-mcp-server", "azure-devops"] as const;
type ScmMcpServer = (typeof SCM_MCP_SERVERS)[number];

function enabledServersFor(scm: ScmProvider): Set<ScmMcpServer> {
  if (scm === "github") return new Set(["github-mcp-server"]);
  if (scm === "azure-devops") return new Set(["azure-devops"]);
  return new Set();
}

// Copilot disable flags derived from scm selection
const COPILOT_DISABLE_BY_SCM: Record<ScmProvider, readonly string[]> = {
  github: ["azure-devops"],
  "azure-devops": ["github-mcp-server"],
  sapling: ["github-mcp-server", "azure-devops"],
};
```

**Sync actions (syncScmMcpServers):**
- Claude: Updates `.claude/settings.json` → `disabledMcpjsonServers` array
- OpenCode: Flips `.opencode/opencode.json` → `mcp.<server>.enabled` flags
- Copilot: Generates CLI flags `--disable-mcp-server <name>`

**Related:** `packages/atomic-sdk/src/services/config/scm-sync.ts:99-160`

---

## Custom Tools and Agent Configuration

### Pattern 10: Claude Settings with MCP Disabling
**Where:** `.claude/settings.json:1-28`
**What:** Claude Code stores global settings including MCP server enable/disable state.

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "ENABLE_LSP_TOOL": "1",
    "CLAUDE_CODE_NO_FLICKER": "1"
  },
  "includeCoAuthoredBy": false,
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "disabledMcpjsonServers": [
    "azure-devops"
  ],
  "enabledPlugins": {
    "pyright-lsp@claude-plugins-official": true,
    "typescript-lsp@claude-plugins-official": true,
    "gopls-lsp@claude-plugins-official": true,
    "rust-analyzer-lsp@claude-plugins-official": true
  }
}
```

**Key fields:**
- `disabledMcpjsonServers` - MCP servers to disable (managed by scm-sync)
- `enabledPlugins` - LSP and language support plugins
- `permissions.defaultMode` - Default permission mode for agent actions
- `env` - Environment variables for Claude Code runtime

**Related:** `.claude/settings.json` entire file; scm-sync updates `disabledMcpjsonServers`

---

## Skill-to-Agent Integration Patterns

### Pattern 11: Skill Provider Detection in Multi-Agent Environments
**Where:** `.agents/skills/atomic/SKILL.md:34-52`
**What:** Skills detect which coding agent is running and substitute agent-specific values.

```markdown
## Detect the calling agent

The skill runs inside one of three coding agents. Detect which by reading env
vars in order, then substitute the matching values throughout user-facing
examples. Never list multiple agents' values side-by-side — show only the
detected one.

| Detected | Env signal | `-a` flag | Display name | Agents directory |
|---|---|---|---|---|
| Claude Code | `CLAUDECODE=1` | `-a claude` | Claude Code | `.claude/agents/` |
| GitHub Copilot CLI | `COPILOT_AGENT_ID` or `COPILOT_ALLOW_ALL` | `-a copilot` | GitHub Copilot CLI | `.github/agents/` |
| OpenCode | `OPENCODE_CLIENT` or `OPENCODE_CONFIG*` | `-a opencode` | OpenCode | `.opencode/agents/` |

Probe with: `printenv | grep -E '^(CLAUDECODE|COPILOT_|OPENCODE_)' | head -20`.
If none match, default to `-a claude` and `Claude Code` as the display name.
```

**Agent-specific substitution pattern:**
- Environment variable signals for each agent
- Skill replaces placeholders like `<agent>` with detected agent name
- Prevents leaking alternate-agent values in user-facing prose

**Related:** `.agents/skills/atomic/SKILL.md:34-52`

### Pattern 12: MCP Tool Naming Conventions
**Where:** `.agents/skills/tool-design/SKILL.md:96-111`
**What:** Skills document that MCP tools require fully qualified names with server prefix.

```markdown
### MCP Tool Naming Requirements

Always use fully qualified tool names with MCP (Model Context Protocol) to avoid 
"tool not found" errors.

Format: `ServerName:tool_name`

# Correct: Fully qualified names
"Use the BigQuery:bigquery_schema tool to retrieve table schemas."
"Use the GitHub:create_issue tool to create issues."

# Incorrect: Unqualified names
"Use the bigquery_schema tool..."  # May fail with multiple servers

Without the server prefix, agents may fail to locate tools when multiple MCP 
servers are available. Establish naming conventions that include server context 
in all tool references.
```

**Pattern:** `<ServerName>:<tool_name>` for all MCP tool references in skills

**Related:** `.agents/skills/tool-design/SKILL.md:96-111`

---

## Custom Workflow Loading and Configuration

### Pattern 13: Custom Workflow Entry Discovery
**Where:** `packages/atomic/src/commands/custom-workflows.ts:1-90`
**What:** Atomic discovers custom workflows from `settings.json` `workflows` map entries.

```typescript
export interface LoadCustomWorkflowsResult {
  loaded: LoadedWorkflow[];
  broken: BrokenWorkflow[];
}

export async function loadCustomWorkflows(
  workflows: Record<string, CustomWorkflowEntry> | undefined,
  origin: "local" | "global",
  settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
  if (!workflows) return { loaded: [], broken: [] };
  
  const results = await Promise.all(
    Object.entries(workflows).map(([alias, entry]) =>
      loadOne(alias, entry, origin, settingsPath),
    ),
  );
  
  return {
    loaded: results.flatMap((r) => r.loaded),
    broken: results.flatMap((r) => r.broken),
  };
}
```

**Entry structure (CustomWorkflowEntry):**
- `alias` - Workflow name in `workflows` map
- `command` - Executable command string
- `args[]` - Optional command arguments
- `agents` - Array of supported agent types

**Related:** `packages/atomic/src/commands/custom-workflows.ts:94-138`

### Pattern 14: Workflow Metadata Emission
**Where:** `packages/atomic/src/commands/custom-workflows.ts:120-150`
**What:** Atomic spawns custom workflow commands with `_emit-workflow-meta` flag to extract metadata.

```typescript
async function loadOne(
  alias: string,
  entry: CustomWorkflowEntry,
  origin: "local" | "global",
  settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
  const loaded: LoadedWorkflow[] = [];
  const broken: BrokenWorkflow[] = [];
  const timeoutMs = resolveTimeoutMs();
  const args = entry.args ?? [];
  
  const token = randomBytes(16).toString("hex");
  const argv = [entry.command, ...args, "_emit-workflow-meta", `--dispatch-token=${token}`];
  
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: token },
    });
  } catch (err) {
    return fail(
      entry.agents,
      spawnErrorMessage(alias, entry.command, err),
      isNotFoundError(err)
        ? `install "${entry.command}" or use an absolute path`
        : "check file permissions and PATH",
    );
  }
  
  // Timeout race and output capture...
}
```

**Emission pattern:**
- Command spawned with: `<command> <args...> _emit-workflow-meta --dispatch-token=<hex>`
- Environment: `ATOMIC_HOST=1` + `ATOMIC_DISPATCH_TOKEN=<hex>`
- Captures stdout/stderr with timeout (default 5s)
- Parses JSON metadata from stdout

**Related:** `packages/atomic/src/commands/custom-workflows.ts:52-55`

---

## Session Configuration and Tool/Skill Loading

### Pattern 15: Headless Session Configuration for Skills/Agents
**Where:** `.agents/skills/workflow-creator/references/session-config.md:44-117`
**What:** Workflow sessions configure tools, skills, agents, and MCP servers via SDK options.

```typescript
const result = query({
  prompt: (ctx.inputs.prompt ?? ""),
  options: {
    // Model selection
    model: "claude-opus-4-6",
    effort: "high",
    thinking: { type: "adaptive" },
    
    // Tools — base set of available built-in tools
    tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    disallowedTools: ["AskUserQuestion"],
    
    // Skills — preload named skills into the headless session (v0.2.120+)
    skills: ["my-skill"],  // or "all" to preload every available skill
    
    // Agents — Record<string, AgentDefinition> keyed by name
    agents: {
      worker: { description: "Implement tasks", prompt: "You are a task implementer...", tools: ["Read", "Write", "Edit", "Bash"] },
    },
    agent: "worker",  // Main thread agent name (optional)
    
    // MCP servers
    mcpServers: {
      "my-server": { command: "node", args: ["server.js"] },
    },
    
    // System prompt
    systemPrompt: "You are a senior security auditor...",
    // Or: { type: "preset", preset: "claude_code", append: "Always explain your reasoning." }
  },
});
```

**Key configuration groups:**
- `tools` / `allowedTools` / `disallowedTools` - Control available tools
- `skills` - Preload named skills or "all"
- `agents` - Define sub-agents with their own tools/prompts
- `mcpServers` - Runtime MCP server definitions
- `systemPrompt` - Custom or preset system prompts

**Related:** `.agents/skills/workflow-creator/references/session-config.md:60-116`

---

## Bundled Skills Structure and Progressive Disclosure

### Pattern 16: Skill Progressive Disclosure with References
**Where:** `.agents/skills/skill-creator/SKILL.md:77-95`
**What:** Skills use three-level progressive disclosure: metadata → body → bundled resources.

```markdown
#### Anatomy of a Skill

skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)
```

**Directory patterns across bundled skills:**
- `docx/scripts/`, `pptx/scripts/`, `advanced-evaluation/scripts/`, etc.
- `references/` subdirs for large reference docs (context-fundamentals, filesystem-context, etc.)
- Assets and templates for document generation skills

**Related:** `.agents/skills/skill-creator/SKILL.md:75-112`

---

## Summary

Atomic's partition 2 (`.agents/`) contains **43+ bundled skills** and their supporting infrastructure. Key patterns identified:

1. **Skill Discovery**: YAML frontmatter in SKILL.md files; global symlink `.claude/skills -> ../.agents/skills`
2. **Installation**: `installGlobalSkills()` copies bundled skills to `~/.agents/skills` and `~/.claude/skills`
3. **Versioning**: `skills-lock.json` tracks source, path, and SHA-256 hash per skill
4. **Agent Config**: Three agent directories (`.claude/agents`, `.opencode/agents`, `.github/agents`) copied to provider homes
5. **MCP Discovery**: `.mcp.json` (Claude) and `.opencode/opencode.json` define server endpoints
6. **SCM Sync**: `scm-sync.ts` auto-enables/disables MCP servers based on selected version control
7. **Skill-Agent Bridge**: Skills detect calling agent via env vars; substitute agent-specific values
8. **Custom Workflows**: Loaded via `_emit-workflow-meta` spawning; metadata extracted from stdout
9. **Session Config**: Skills/agents preloaded via SDK `options` (tools, agents, mcpServers)
10. **Progressive Disclosure**: Skills load metadata → body → resources on-demand for context efficiency

**Clear seams for pi-coding-agent replacement:**
- MCP server definition loading (scm-sync, .mcp.json parsing)
- Custom agent definition discovery (.claude/agents, .opencode/agents, .github/agents)
- Skill metadata registry (skills-lock.json, YAML frontmatter parsing)
- Custom workflow spawning and metadata emission (_emit-workflow-meta)
- Skills installation (installGlobalSkills, copyDir patterns)
