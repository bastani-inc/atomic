# Subagent Example

Delegate tasks to specialized agents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `atomic` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
└── agents/              # Sample agent definitions
    ├── scout.md         # Fast recon, returns compressed context
    ├── planner.md       # Creates implementation plans
    ├── reviewer.md      # Code review
    └── worker.md        # General-purpose (full capabilities)
```

## Installation

From the repository root, symlink the files:

```bash
mkdir -p ~/.atomic/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.atomic/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.atomic/agent/extensions/subagent/agents.ts

mkdir -p ~/.atomic/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.atomic/agent/agents/$(basename "$f")
done
```

## Security Model

This tool executes a separate `atomic` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.atomic/agents/*.md`, with legacy `.pi/agents/*.md` fallback) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.atomic/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent

```
Use scout to find all authentication code
```

### Parallel execution

```
Run 2 scouts in parallel: one to find models, one to find providers
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 50, 4 concurrent) |

## Output Display

**Collapsed view** (default):

- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage

**Parallel mode streaming**:

- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):

- `$ command` for bash
- `read ~/path:1-10` for read
- `search /pattern/ in ~/path` for search
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, search, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**

- `~/.atomic/agent/agents/*.md` - User-level (always loaded)
- `.atomic/agents/*.md` - Project-level (legacy `.pi/agents/*.md` also works) (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, search, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, search, find, ls |
| `reviewer` | Code review | Sonnet | read, search, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow prompts

This example focuses on direct single-agent and independent parallel delegation. Use the main Atomic workflow tools when a task needs ordered stages, review loops, or durable handoffs.

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 50 tasks, 4 concurrent
