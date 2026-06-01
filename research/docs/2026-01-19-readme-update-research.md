---
date: 2026-01-19 09:15:00 UTC
researcher: Claude Opus 4.5
git_commit: 37a37ca3ac5ec4d7020fab08d2f9b89aef8d3904
branch: lavaman131/feature/atomic-cli
repository: atomic
topic: "README.md Update Research - Atomic CLI Interface Documentation"
tags: [research, readme, cli, atomic, documentation, workflow]
status: complete
last_updated: 2026-01-19
last_updated_by: Claude Opus 4.5
---

# Research: README.md Update for Atomic CLI Interface

## Research Question

Research how to update the README.md to reflect the new atomic CLI interface way of doing things. Make the README.md intuitive and not overly verbose. Walk through the workflow steps, emphasizing that setup is now a simple CLI command. Include examples using `atomic --agent [agent_name] /slash-command` pattern, preferring `bun` (oven-sh/bun) or `npx`.

## Summary

The current README.md is **overly verbose** (~430 lines) with manual copy commands for setup. The new atomic CLI (`@bastani/atomic`) simplifies everything to a single interactive command: `bunx @bastani/atomic` or `npx @bastani/atomic`.

**Key changes needed:**

1. Replace manual `cp` commands with `bunx @bastani/atomic` (or `npx`)
2. Simplify Quick Start to ~5 lines
3. Show the new CLI workflow: `atomic` for setup, `atomic --agent <name>` for running
4. Update slash command examples to use `atomic --agent claude-code /create-feature-list`
5. Remove redundant copy instructions and consolidate platform-specific details

---

## Current README Structure (Problems)

### Lines 81-167: Overly Complex Quick Start

The current Quick Start has:

- Manual `cp -r .claude /path/to/your-project/` commands
- Separate steps for each platform
- MCP configuration copy steps
- Manual `.devcontainer` setup

**This is now replaced by:**

```bash
bunx @bastani/atomic
# or
npx @bastani/atomic
```

The CLI handles:

1. Agent selection (Claude Code, OpenCode, GitHub Copilot CLI)
2. Directory confirmation
3. Folder copying with proper exclusions
4. Additional files (CLAUDE.md, AGENTS.md)

### Lines 171-325: Procedure Section

The procedure section is good but examples should be updated to show the CLI-driven workflow:

**Old way (manual):**

```bash
# Copy files manually
cp -r .claude /path/to/your-project/
# Then run commands in editor
/research-codebase "..."
```

**New way (CLI-driven):**

```bash
# One-time setup
bunx @bastani/atomic

# Run agent with slash commands
atomic --agent claude-code /create-feature-list specs/YYYY-MM-DD-my-spec.md
```

---

## New Atomic CLI Interface

### Source: `src/index.ts`

```
Usage:
  atomic              Interactive setup (same as 'atomic init')
  atomic init         Interactive setup with banner
  atomic --agent <n>  Run agent directly (skips banner)
  atomic --version    Show version
  atomic --help       Show this help

Available agents: claude-code, opencode, copilot-cli
```

### Source: `src/config.ts`

| Agent Key     | Display Name       | Command    | Flags                                 | Folder      |
| ------------- | ------------------ | ---------- | ------------------------------------- | ----------- |
| `claude-code` | Claude Code        | `claude`   | `--dangerously-skip-permissions`      | `.claude`   |
| `opencode`    | OpenCode           | `opencode` | (none)                                | `.opencode` |
| `copilot-cli` | GitHub Copilot CLI | `copilot`  | `--allow-all-tools --allow-all-paths` | `.github`   |

### Package: `@bastani/atomic`

From `package.json`:

```json
{
    "name": "@bastani/atomic",
    "version": "1.0.1",
    "bin": {
        "atomic": "src/index.ts"
    }
}
```

---

## Recommended README Structure

### Proposed Outline (~150 lines)

```
# ⚛️ Atomic: Automated Procedures and Memory for AI Coding Agents

[Short intro - 3-4 sentences]

## Quick Start (5 lines)

    bunx @bastani/atomic
    # or: npx @bastani/atomic

    # Then run your agent
    atomic --agent claude-code

## The Workflow (with CLI examples)

1. Research → 2. Spec → 3. Features → 4. Implement → 5. PR

[Brief descriptions with CLI command examples]

## What's Included

[Table: 7 agents, 10 commands, 2 skills]

## Platform Reference

[Table: Which agent uses which folder/context file]

## Troubleshooting

[Git identity, permissions - keep brief]

## Credits & License
```

---

## Specific Changes Required

### 1. Quick Start Section

**Remove (lines 81-167):**

- All manual `cp` commands
- MCP configuration steps
- `.devcontainer` copy instructions
- Platform-specific folder copy instructions

**Replace with:**

````markdown
## Quick Start

Install the atomic configuration for your AI coding agent:

```bash
# Using bun (recommended)
bunx @bastani/atomic

# Or using npx
npx @bastani/atomic
```
````

Select your agent (Claude Code, OpenCode, or GitHub Copilot CLI) and the CLI will configure your project automatically.

### Prerequisites

- [bun](https://bun.sh/docs/installation) or Node.js 18+
- Your preferred AI coding agent installed ([Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup), [OpenCode](https://opencode.ai), or [GitHub Copilot CLI](https://github.com/github/copilot-cli))

````

### 2. Procedure Section

**Update examples to use atomic CLI pattern:**

```markdown
## The Workflow

### Step 1: Research the Codebase

```bash
atomic --agent claude-code /research-codebase "I'm building a real-time collaboration tool..."
````

### Step 2: Create a Specification

```bash
atomic --agent claude-code /create-spec research/docs/my-research.md
```

### Step 3: Break Into Features

```bash
atomic --agent claude-code /create-feature-list specs/YYYY-MM-DD-my-spec.md
```

### Step 4: Implement Features

```bash
atomic --agent claude-code /implement-feature
```

### Step 5: Create Pull Request

```bash
atomic --agent claude-code /create-gh-pr
```

````

### 3. Available Commands Table

**Add clear command reference:**

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/research-codebase` | `[question]` | Deep codebase analysis |
| `/create-spec` | `[research-path]` | Generate technical spec |
| `/create-feature-list` | `[spec-path]` | Break spec into tasks |
| `/implement-feature` | — | Implement next feature |
| `/commit` | `[message]` | Conventional commit |
| `/create-gh-pr` | — | Push and create PR |
| `/explain-code` | `[path]` | Explain code section |

### 4. Agent Invocation Examples

**Add this section:**

```markdown
## Running Commands

After setup, run commands through your agent:

```bash
# Claude Code
atomic --agent claude-code /create-feature-list specs/YYYY-MM-DD-my-spec.md

# OpenCode
atomic --agent opencode /implement-feature

# GitHub Copilot CLI
atomic --agent copilot-cli /research-codebase "How does authentication work?"
````

Or start the agent interactively and use slash commands directly:

```bash
atomic --agent claude-code
# Then type: /research-codebase "..."
```

````

### 5. Remove Redundant Sections

**Consider removing or condensing:**
- "The Memory Gap" table (move to docs)
- "The Flywheel" diagram (keep but simplify)
- "How Atomic Differs from Spec-Kit" (move to separate comparison doc)
- Long platform reference table (condense)
- Detailed "What's Included" lists (summarize)

---

## Slash Commands Reference

From `research/docs/2026-01-19-slash-commands.md`:

### Core Commands

| Command | Usage | Purpose |
|---------|-------|---------|
| `/commit` | `/commit "feat: add login"` | Conventional commits |
| `/research-codebase` | `/research-codebase "How does X work?"` | Document codebase |
| `/create-spec` | `/create-spec research/` | Create TDD/RFC |
| `/create-feature-list` | `/create-feature-list specs/YYYY-MM-DD-spec.md` | Generate feature-list.json |
| `/implement-feature` | `/implement-feature` | Implement one feature |
| `/create-gh-pr` | `/create-gh-pr` | Push and create PR |
| `/explain-code` | `/explain-code src/file.ts` | Explain code in detail |

### Ralph Commands (Autonomous Mode)

| Command | Usage | Purpose |
|---------|-------|---------|
| `/ralph-loop` | `/ralph-loop --max-iterations 10` | Start autonomous loop |
| `/cancel-ralph` | `/cancel-ralph` | Stop autonomous loop |
| `/ralph-help` | `/ralph-help` | Show Ralph documentation |

---

## Agent Definitions

From agent locator research:

| Agent | Purpose |
|-------|---------|
| `codebase-analyzer` | Analyze how code works |
| `codebase-locator` | Find files and components |
| `codebase-online-researcher` | External docs lookup |
| `codebase-pattern-finder` | Find existing patterns |
| `codebase-research-analyzer` | Synthesize research |
| `codebase-research-locator` | Find research docs |
| `debugger` | Debug errors |

---

## Code References

| File | Description |
|------|-------------|
| `src/index.ts:1-108` | CLI entry point and argument parsing |
| `src/config.ts:1-73` | Agent configuration definitions |
| `src/commands/init.ts:1-166` | Interactive setup flow |
| `src/commands/run-agent.ts:1-47` | Agent spawning logic |
| `package.json:19-21` | bin entry for `atomic` command |

---

## Recommended README.md Draft

```markdown
# ⚛️ Atomic

AI coding agents need context and procedures. Atomic provides both.

## Quick Start

```bash
bunx @bastani/atomic   # or: npx @bastani/atomic
````

Select your agent. That's it.

## The Workflow

```
Research → Spec → Features → Implement → PR
```

### 1. Research

```bash
atomic --agent claude-code /research-codebase "Describe your feature or question"
```

### 2. Create Spec

```bash
atomic --agent claude-code /create-spec research/
```

### 3. Generate Feature List

```bash
atomic --agent claude-code /create-feature-list specs/YYYY-MM-DD-your-spec.md
```

### 4. Implement

```bash
atomic --agent claude-code /implement-feature
```

Repeat until all features pass. Use `/ralph-loop` for autonomous mode.

### 5. Create PR

```bash
atomic --agent claude-code /create-gh-pr
```

## Commands

| Command                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `/research-codebase`   | Analyze codebase and document findings |
| `/create-spec`         | Generate technical specification       |
| `/create-feature-list` | Break spec into implementable tasks    |
| `/implement-feature`   | Implement next feature from list       |
| `/commit`              | Create conventional commit             |
| `/create-gh-pr`        | Push and create pull request           |
| `/explain-code`        | Explain code section in detail         |
| `/ralph-loop`          | Run autonomous implementation loop     |

## Supported Agents

| Agent              | Command                      |
| ------------------ | ---------------------------- |
| Claude Code        | `atomic --agent claude-code` |
| OpenCode           | `atomic --agent opencode`    |
| GitHub Copilot CLI | `atomic --agent copilot-cli` |

## Prerequisites

- [bun](https://bun.sh) (recommended) or Node.js 18+
- One of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup), [OpenCode](https://opencode.ai), [GitHub Copilot CLI](https://github.com/github/copilot-cli)

## What's Included

- **7 Agents**: codebase-analyzer, codebase-locator, codebase-pattern-finder, codebase-research-analyzer, codebase-research-locator, codebase-online-researcher, debugger
- **10 Commands**: research-codebase, create-spec, create-feature-list, implement-feature, commit, create-gh-pr, explain-code, ralph-loop, cancel-ralph, ralph-help
- **2 Skills**: prompt-engineer, testing-anti-patterns

## License

MIT

```

---

## Historical Context

- Prior research: `research/docs/2026-01-18-atomic-cli-implementation.md` - Implementation details for the CLI
- Prior research: `research/docs/2026-01-19-slash-commands.md` - Comprehensive slash command catalog

---

## Open Questions

1. **Video link**: Should the video overview be kept? It references old manual setup.
2. **Ralph section**: How detailed should Ralph documentation be in README vs separate doc?
3. **Comparison section**: Keep "How Atomic Differs from Spec-Kit" or move to wiki?
4. **Troubleshooting**: Keep in README or move to TROUBLESHOOTING.md?

---

## Summary of Changes

| Section | Action | Reason |
|---------|--------|--------|
| Quick Start | Replace with CLI command | Simpler onboarding |
| Step 1-2 (copy commands) | Remove entirely | CLI handles this |
| Procedure steps | Update examples | Show `atomic --agent` pattern |
| Platform Reference | Condense | Less redundant |
| Comparison section | Consider removing | Reduces noise |
| Memory/Flywheel | Keep but simplify | Still valuable |
| Commands table | Add/update | Clear reference |
```
