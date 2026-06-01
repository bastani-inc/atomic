# GitHub Copilot Agent Integration Implementation Analysis

**Date:** 2026-01-31
**Scope:** `.github/` directory implementation for GitHub Copilot

---

## Overview

The `.github/` directory implements GitHub Copilot agent integration with a hooks-based lifecycle system, TypeScript scripts for Ralph loop management, Markdown-based agent definitions, and a skills system. This implementation parallels the `.claude/` and `.opencode/` directories but with notable differences in hook architecture and capability.

---

## 1. Hooks System

### 1.1 Configuration File

**Location:** `.github/hooks/hooks.json:1-40`

The hooks configuration uses a JSON schema with version field and hook type mappings:

```
Hooks Configuration Schema
==========================

{
  "version": 1,
  "hooks": {
    "sessionStart": [...],
    "userPromptSubmitted": [...],
    "sessionEnd": [...]
  }
}
```

### 1.2 Hook Types and Handlers

| Hook Event            | Handler Script                           | Timeout | Purpose                                      |
| --------------------- | ---------------------------------------- | ------- | -------------------------------------------- |
| `sessionStart`        | `.github/scripts/start-ralph-session.ts` | 10 sec  | Detect active Ralph loops, log session start |
| `userPromptSubmitted` | `.github/hooks/telemetry-session.ts`     | 10 sec  | Extract and accumulate Atomic commands       |
| `sessionEnd`          | `.github/hooks/telemetry-stop.ts`        | 30 sec  | Write telemetry events, spawn upload         |
| `sessionEnd`          | `.github/hooks/ralph-stop.ts`            | 30 sec  | Track iterations, spawn next session         |

### 1.3 Hook Architecture Diagram

```
+------------------+     +-------------------------+     +------------------+
|                  |     |                         |     |                  |
|   Session Start  |---->|  start-ralph-session.ts |---->|  Log to JSONL    |
|                  |     |  (Detect Ralph state)   |     |  Parse YAML FM   |
+------------------+     +-------------------------+     +------------------+
         |
         v
+------------------+     +-------------------------+     +------------------+
|                  |     |                         |     |                  |
| Prompt Submitted |---->|  telemetry-session.ts   |---->|  Append to temp  |
|                  |     |  (Extract commands)     |     |  file (.tmp)     |
+------------------+     +-------------------------+     +------------------+
         |
         v
+------------------+     +-------------------------+     +------------------+
|                  |     |                         |     |                  |
|   Session End    |---->|  telemetry-stop.ts      |---->|  Write event,    |
|                  |     |  (Aggregate commands)   |     |  spawn upload    |
+------------------+     +-------------------------+     +------------------+
         |
         +-------------->+-------------------------+     +------------------+
                         |                         |     |                  |
                         |  ralph-stop.ts          |---->|  Spawn next      |
                         |  (Self-restart logic)   |     |  copilot session |
                         +-------------------------+     +------------------+
```

### 1.4 Hook Implementation Details

#### sessionStart Hook (`.github/scripts/start-ralph-session.ts:128-206`)

**Input:** JSON via stdin with fields `timestamp`, `cwd`, `source`, `initialPrompt`

**Data Flow:**

1. Read hook input from stdin at line 130
2. Parse JSON input at lines 138-146
3. Create log directory at lines 148-151
4. Append session start entry to JSONL log at lines 153-164
5. Check for active Ralph state via `parseRalphState()` at line 167
6. If active, output status to stderr at lines 170-186
7. If source is "resume" or "startup", increment iteration at lines 188-199

#### userPromptSubmitted Hook (`.github/hooks/telemetry-session.ts:55-73`)

**Input:** JSON via stdin with field `prompt`

**Data Flow:**

1. Read and parse stdin at lines 57-63
2. Extract Atomic commands from prompt text via `extractCommandsFromPrompt()` at line 65
3. Append commands to temp file at `.github/telemetry-session-commands.tmp` at lines 66-68

**Tracked Commands (lines 13-24):**

```typescript
const ATOMIC_COMMANDS = [
    "/research-codebase",
    "/create-spec",
    "/create-feature-list",
    "/implement-feature",
    "/commit",
    "/create-gh-pr",
    "/explain-code",
    "/ralph:ralph-loop",
    "/ralph:cancel-ralph",
    "/ralph:ralph-help",
];
```

#### sessionEnd Hook - Telemetry (`.github/hooks/telemetry-stop.ts:236-255`)

**Input:** JSON via stdin (fields vary)

**Data Flow:**

1. Check telemetry enabled at line 237
2. Read accumulated commands from temp file at line 242
3. Detect Copilot agents from session state at line 243
4. Merge commands from both sources at line 244
5. Write session event to JSONL file at line 247
6. Spawn background upload process at line 248
7. Clean up temp file at line 251

#### sessionEnd Hook - Ralph (`.github/hooks/ralph-stop.ts:136-309`)

**Input:** JSON via stdin with fields `timestamp`, `cwd`, `reason`

**Data Flow:**

1. Parse input at lines 145-152
2. Log session end to JSONL at lines 159-169
3. Parse Ralph state at line 172
4. Check completion conditions at lines 189-211
5. If continuing: increment iteration, write state, spawn new session at lines 214-251
6. If complete: archive state, clean up files at lines 252-293

### 1.5 Comparison: GitHub Copilot vs Claude Code Hooks

| Aspect                | GitHub Copilot                                      | Claude Code                 |
| --------------------- | --------------------------------------------------- | --------------------------- |
| **Configuration**     | `.github/hooks/hooks.json`                          | `.claude/settings.json`     |
| **Hook Events**       | `sessionStart`, `userPromptSubmitted`, `sessionEnd` | `SessionEnd` only           |
| **Event Format**      | Array of hook objects                               | Array within `hooks` object |
| **Session Blocking**  | Cannot block session exit                           | Cannot block session exit   |
| **Command Schema**    | `bash` and `powershell` fields                      | `command` field             |
| **Working Directory** | `cwd` field                                         | Implicit current directory  |
| **Cross-Platform**    | Explicit bash/powershell                            | Single command field        |

**Claude Code Hook Config (`.claude/settings.json:21-33`):**

```json
"hooks": {
  "SessionEnd": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bun run .claude/hooks/telemetry-stop.ts",
          "timeout": 30
        }
      ]
    }
  ]
}
```

**GitHub Copilot Hook Config (`.github/hooks/hooks.json:4-11`):**

```json
"sessionStart": [
  {
    "type": "command",
    "bash": "bun run ./.github/scripts/start-ralph-session.ts",
    "powershell": "bun run ./.github/scripts/start-ralph-session.ts",
    "cwd": ".",
    "timeoutSec": 10
  }
]
```

---

## 2. Scripts System

### 2.1 Ralph Loop Management Scripts

#### ralph-loop.ts (`.github/scripts/ralph-loop.ts:1-375`)

**Purpose:** Initialize Ralph loop state file for GitHub Copilot hooks

**CLI Argument Parsing (lines 177-228):**

```
USAGE:
  bun run .github/scripts/ralph-loop.ts [PROMPT...] [OPTIONS]

OPTIONS:
  --max-iterations <n>           Maximum iterations before auto-stop
  --completion-promise '<text>'  Promise phrase to signal completion
  --feature-list <path>          Path to feature list JSON
  -h, --help                     Show help message
```

**State File Schema (lines 245-262):**

```yaml
---
active: true
iteration: 1
max_iterations: 0
completion_promise: null
feature_list_path: research/feature-list.json
started_at: "2026-01-31T10:00:00Z"
---
<prompt content>
```

**Data Flow:**

1. Parse CLI arguments at line 270
2. Determine prompt (user-provided or default) at lines 278-299
3. Create `.github` directory if needed at lines 301-305
4. Build and write state at lines 307-318
5. Create continue flag at line 321
6. Output setup message at lines 323-346

#### start-ralph-session.ts (`.github/scripts/start-ralph-session.ts:1-207`)

**Purpose:** Hook handler for session start - detects Ralph loops and logs sessions

**Key Functions:**

- `parseRalphState()` at lines 52-97: Parse YAML frontmatter state file
- `writeRalphState()` at lines 104-121: Write state with YAML frontmatter
- `main()` at lines 128-206: Handle session start hook

**YAML Frontmatter Parsing (lines 56-76):**

```typescript
const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const getValue = (key: string): string | null => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!match) return null;
    return match[1].replace(/^["'](.*)["']$/, "$1");
};
```

#### cancel-ralph.ts (`.github/scripts/cancel-ralph.ts:1-223`)

**Purpose:** Cancel active Ralph loop, archive state, kill orphaned processes

**Key Functions:**

- `parseRalphState()` at lines 46-91: Parse state file
- `archiveState()` at lines 97-132: Write archived state with cancellation metadata
- `killOrphanedProcesses()` at lines 138-159: Kill copilot and sleep processes
- `main()` at lines 165-222: Execute cancellation workflow

**Process Termination (lines 142-158):**

```typescript
// Kill copilot processes
await Bun.$`pkill -f "copilot"`.quiet().nothrow();

// Kill sleep processes waiting to spawn copilot
await Bun.$`pkill -f "sleep.*copilot"`.quiet().nothrow();
```

### 2.2 State Management

**State Files:**
| File | Purpose |
|------|---------|
| `.github/ralph-loop.local.md` | Active Ralph state (YAML frontmatter + prompt) |
| `.github/ralph-continue.flag` | Continue flag with prompt for orchestrator |
| `.github/logs/ralph-sessions.jsonl` | Session event log |
| `.github/telemetry-session-commands.tmp` | Temporary command accumulator |

**Constants (used across scripts):**

```typescript
// From .github/scripts/ralph-loop.ts:23-25
const RALPH_STATE_FILE = ".github/ralph-loop.local.md";
const RALPH_CONTINUE_FILE = ".github/ralph-continue.flag";
const DEFAULT_FEATURE_LIST_PATH = "research/feature-list.json";
```

---

## 3. Agent Definitions

### 3.1 YAML Frontmatter Schema

**Location:** `.github/agents/*.md`

All agent definitions follow the same Markdown format with YAML frontmatter:

```yaml
---
name: agent-name
description: Brief description of agent purpose
tools: ["tool1", "tool2", ...]
model: claude-opus-4-5
mcp-servers: # Optional
    servername:
        type: http
        url: "https://..."
        tools: ["tool1"]
---
# Agent Instructions

Content describing agent behavior...
```

### 3.2 Agent Inventory

| Agent                      | File                                                 | Tools                                                          | Model           | Purpose                                                  |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| codebase-analyzer          | `.github/agents/codebase-analyzer.md:1-135`          | search, read, execute                                          | claude-opus-4-5 | Analyze implementation details with file:line references |
| codebase-locator           | `.github/agents/codebase-locator.md:1-114`           | search, read, execute                                          | claude-opus-4-5 | Find files and directories for features                  |
| codebase-pattern-finder    | `.github/agents/codebase-pattern-finder.md:1-218`    | search, read, execute                                          | claude-opus-4-5 | Find code examples and patterns                          |
| codebase-research-locator  | `.github/agents/codebase-research-locator.md:1-103`  | read, search, execute                                          | claude-opus-4-5 | Discover documents in research/ directory                |
| codebase-research-analyzer | `.github/agents/codebase-research-analyzer.md:1-146` | read, search, execute                                          | claude-opus-4-5 | Extract insights from research documents                 |
| codebase-online-researcher | `.github/agents/codebase-online-researcher.md:1-120` | search, read, execute, web, deepwiki/ask_question              | claude-opus-4-5 | Web research with DeepWiki MCP                           |
| debugger                   | `.github/agents/debugger.md:1-54`                    | execute, agent, edit, search, read, web, deepwiki/ask_question | claude-opus-4-5 | Debug errors and test failures                           |

### 3.3 MCP Server Configuration

The `codebase-online-researcher` and `debugger` agents include MCP server configuration (`.github/agents/codebase-online-researcher.md:6-11`):

```yaml
mcp-servers:
    deepwiki:
        type: http
        url: "https://mcp.deepwiki.com/mcp"
        tools: ["ask_question"]
```

### 3.4 Comparison: Agent Definitions Across Platforms

| Aspect           | GitHub Copilot                               | Claude Code                                  | OpenCode                                     |
| ---------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| **Location**     | `.github/agents/`                            | `.claude/agents/`                            | `.opencode/agents/`                          |
| **Format**       | Markdown + YAML frontmatter                  | Markdown + YAML frontmatter                  | Markdown + YAML frontmatter                  |
| **Schema**       | name, description, tools, model, mcp-servers | name, description, tools, model, mcp-servers | name, description, tools, model, mcp-servers |
| **Agent Count**  | 7 agents                                     | 7 agents                                     | 8 agents (includes ralph)                    |
| **Unique Agent** | None                                         | None                                         | `ralph.md`                                   |

**OpenCode-specific: ralph.md Agent (`.opencode/agents/ralph.md`)**

OpenCode includes a dedicated Ralph agent definition that is not present in GitHub Copilot or Claude Code directories.

---

## 4. Skills System

### 4.1 Skill File Structure

**Location:** `.github/skills/*/SKILL.md`

Skills use YAML frontmatter with the following schema:

```yaml
---
name: skill-name
description: Description shown when skill is discovered
tools: [...] # Optional
model: claude-opus-4-5 # Optional
---
# Skill Content
```

### 4.2 Skill Inventory

| Skill                 | File                                                  | Description                          |
| --------------------- | ----------------------------------------------------- | ------------------------------------ |
| ralph                 | `.github/skills/ralph/SKILL.md:1-32`                  | Manage Ralph Wiggum AI loop          |
| ralph-loop            | `.github/skills/ralph/ralph-loop.md:1-57`             | Start Ralph loop command             |
| cancel-ralph          | `.github/skills/ralph/cancel-ralph.md:1-22`           | Cancel Ralph loop command            |
| testing-anti-patterns | `.github/skills/testing-anti-patterns/SKILL.md:1-302` | Testing best practices               |
| prompt-engineer       | `.github/skills/prompt-engineer/SKILL.md:1-240`       | Prompt engineering guidance          |
| create-gh-pr          | `.github/skills/create-gh-pr/SKILL.md:1-14`           | Create pull requests                 |
| create-spec           | `.github/skills/create-spec/SKILL.md:1-238`           | Create technical specs               |
| explain-code          | `.github/skills/explain-code/SKILL.md:1-207`          | Explain code functionality           |
| implement-feature     | `.github/skills/implement-feature/SKILL.md:1-92`      | Implement features from feature-list |
| research-codebase     | `.github/skills/research-codebase/SKILL.md:1-206`     | Document codebase comprehensively    |
| create-feature-list   | `.github/skills/create-feature-list/SKILL.md:1-41`    | Create feature-list.json             |
| commit                | `.github/skills/commit/SKILL.md:1-244`                | Create conventional commits          |

### 4.3 Ralph Commands Mapping

The Ralph skill (`.github/skills/ralph/SKILL.md:12-16`) documents command mappings:

| Command               | Description              | Reference       |
| --------------------- | ------------------------ | --------------- |
| `/ralph:ralph-loop`   | Start a Ralph loop       | ralph-loop.md   |
| `/ralph:cancel-ralph` | Cancel active Ralph loop | cancel-ralph.md |
| `/ralph:ralph-help`   | Show Ralph help          | SKILL.md        |

### 4.4 Skill Execution Pattern

Skills reference script execution using code block markers (`.github/skills/ralph/ralph-loop.md:18-20`):

````markdown
## How to Start

Execute the setup script to initialize the Ralph loop:

```!
bun run ./.github/scripts/ralph-loop.ts $ARGUMENTS
```
````

````

The `$ARGUMENTS` placeholder is populated from user input.

### 4.5 Comparison: Skills/Commands Across Platforms

| Aspect | GitHub Copilot | Claude Code | OpenCode |
|--------|----------------|-------------|----------|
| **Location** | `.github/skills/` | `.claude/commands/` + `.claude/skills/` | `.opencode/command/` + `.opencode/skills/` |
| **Naming** | "skills" | "commands" and "skills" | "command" and "skills" |
| **Execution** | Code blocks with `!` marker | N/A (direct command mapping) | Inline templates in config |
| **Ralph Commands** | Skills with script references | Plugin marketplace integration | Config-based command templates |

**OpenCode Command Templates (`.opencode/opencode.json:5-19`):**
```json
"command": {
  "ralph:ralph-help": {
    "template": "# Ralph Wiggum Plugin Help...",
    "description": "Explain the Ralph Wiggum technique",
    "agent": "ralph"
  },
  "ralph:ralph-loop": { ... },
  "ralph:cancel-ralph": { ... }
}
````

---

## 5. Configuration Patterns

### 5.1 GitHub Copilot Configuration

**Primary Config:** `.github/hooks/hooks.json`

The GitHub Copilot integration relies on the hooks system for lifecycle management. Configuration is minimal, with most behavior defined in hook scripts.

### 5.2 Claude Code Configuration

**Primary Config:** `.claude/settings.json:1-35`

```json
{
  "env": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" },
  "includeCoAuthoredBy": false,
  "permissions": { "defaultMode": "bypassPermissions" },
  "enableAllProjectMcpServers": true,
  "extraKnownMarketplaces": {
    "atomic-plugins": {
      "source": { "source": "github", "repo": "bastani/atomic" }
    }
  },
  "enabledPlugins": { "ralph@atomic-plugins": true },
  "hooks": { ... }
}
```

**Key Differences:**

- Marketplace plugin system for Ralph
- Environment variable configuration
- Permission configuration
- MCP server enablement

### 5.3 OpenCode Configuration

**Primary Config:** `.opencode/opencode.json:1-97`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin/telemetry.ts"],
  "command": { ... },
  "mcp": { "deepwiki": { ... } },
  "permission": { ... },
  "provider": { ... }
}
```

**Key Differences:**

- Local plugin system (not marketplace)
- Command templates in config
- Provider model configuration
- Explicit permission configuration

### 5.4 Configuration Comparison Matrix

| Feature               | GitHub Copilot             | Claude Code                | OpenCode                   |
| --------------------- | -------------------------- | -------------------------- | -------------------------- |
| **Config Location**   | `.github/hooks/hooks.json` | `.claude/settings.json`    | `.opencode/opencode.json`  |
| **Hook System**       | JSON hook config           | JSON within settings       | Plugin event handlers      |
| **Plugin System**     | N/A                        | Marketplace plugins        | Local TypeScript plugins   |
| **Ralph Integration** | Hook scripts + skills      | Marketplace plugin         | Plugin + command templates |
| **MCP Servers**       | In agent frontmatter       | enableAllProjectMcpServers | Config-level mcp object    |
| **Permissions**       | N/A                        | defaultMode setting        | Explicit permission object |
| **Provider Config**   | N/A                        | N/A                        | Model and reasoning effort |

---

## 6. Ralph Loop Implementation Differences

### 6.1 GitHub Copilot Ralph Loop

**Architecture:** Self-restarting via session hooks

**Flow (`.github/hooks/ralph-stop.ts:214-251`):**

1. Hook intercepts session end
2. Check completion conditions
3. Increment iteration in state file
4. Spawn new detached `copilot` process via bash
5. New session reads prompt from state file

**Limitation (noted at `.github/scripts/ralph-loop.ts:137-145`):**

```
NOTE: GitHub Copilot hooks track state but cannot block session exit.
For full Ralph loop behavior, use an external orchestrator:

  while [ -f .github/ralph-continue.flag ]; do
    PROMPT=$(cat .github/ralph-continue.flag)
    echo "$PROMPT" | copilot --allow-all-tools --allow-all-paths
  done
```

### 6.2 OpenCode Ralph Loop

**Architecture:** Plugin-based event interception

**Flow (`.opencode/plugin/ralph.ts:253-410`):**

1. Plugin handles `session.status` event
2. Check for idle status at line 262-263
3. Parse state and check completion at lines 265-345
4. Compact context via `session.summarize()` at lines 376-397
5. Continue session via `session.prompt()` at lines 399-409

**Key Difference:** OpenCode plugin can intercept idle state and inject new prompts within the same session, avoiding process spawning.

### 6.3 Claude Code Ralph Loop

**Architecture:** Marketplace plugin integration

**Configuration (`.claude/settings.json:18-20`):**

```json
"enabledPlugins": {
  "ralph@atomic-plugins": true
}
```

The Ralph functionality is provided by an external plugin from the marketplace, not implemented locally in the `.claude/` directory.

---

## 7. Telemetry Implementation

### 7.1 GitHub Copilot Telemetry

**Two-Phase Collection:**

1. **Accumulation Phase** (`.github/hooks/telemetry-session.ts`)
    - Runs on each `userPromptSubmitted` event
    - Extracts commands from prompt
    - Appends to temp file

2. **Finalization Phase** (`.github/hooks/telemetry-stop.ts`)
    - Runs on `sessionEnd`
    - Reads accumulated commands
    - Detects Copilot agents from session state
    - Writes event to JSONL
    - Spawns background upload

### 7.2 Claude Code Telemetry

**Single-Phase Collection** (`.claude/hooks/telemetry-stop.ts`)

- Runs only on `SessionEnd`
- Reads entire transcript from file path provided in hook input
- Extracts commands from user messages
- Writes event to JSONL
- Spawns background upload

**Key Difference:** Claude Code receives transcript path in hook input; GitHub Copilot accumulates during session.

---

## 8. Key File References

### Hooks System

- `.github/hooks/hooks.json:1-40` - Hook configuration
- `.github/hooks/ralph-stop.ts:1-312` - Ralph self-restart hook
- `.github/hooks/telemetry-session.ts:1-74` - Command accumulator
- `.github/hooks/telemetry-stop.ts:1-256` - Telemetry finalization

### Scripts

- `.github/scripts/ralph-loop.ts:1-375` - Ralph loop initialization
- `.github/scripts/start-ralph-session.ts:1-207` - Session start handler
- `.github/scripts/cancel-ralph.ts:1-223` - Ralph cancellation

### Agents

- `.github/agents/codebase-analyzer.md:1-135` - Implementation analyzer
- `.github/agents/debugger.md:1-54` - Debugging specialist

### Skills

- `.github/skills/ralph/SKILL.md:1-32` - Ralph help
- `.github/skills/implement-feature/SKILL.md:1-92` - Feature implementation

### Comparisons

- `.claude/settings.json:1-35` - Claude Code configuration
- `.claude/hooks/telemetry-stop.ts:1-336` - Claude telemetry
- `.opencode/opencode.json:1-97` - OpenCode configuration
- `.opencode/plugin/ralph.ts:1-412` - OpenCode Ralph plugin
