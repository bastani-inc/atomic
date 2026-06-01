# Research: README.md Update — What Has Changed Since Last Update

**Date**: 2026-02-20
**Current Version**: v0.4.12
**Last README Update**: v0.4.8 (commit `b8fffeb`)

---

## Executive Summary

The README was substantially updated in v0.4.8 and is largely accurate. However, there are several discrepancies between the current codebase and what the README documents. Below is a detailed comparison organized by README section, identifying what needs to change.

---

## 1. CLI Commands Table (README lines 341-351)

### Current README

| Command                     | Description                                                  |
| --------------------------- | ------------------------------------------------------------ |
| `atomic init`               | Interactive setup (default command)                          |
| `atomic chat`               | Start TUI chat with a coding agent                           |
| `atomic config set <k> <v>` | Set CLI configuration values (example: telemetry opt-in/out) |
| `atomic update`             | Self-update Atomic (binary installs only)                    |
| `atomic uninstall`          | Remove Atomic installation (binary installs only)            |

### What Exists in Code

The same 5 commands exist. There is one hidden command (`atomic upload-telemetry`) that should not be documented. The commands table is **accurate**.

### `atomic chat` Flags

The README does not document all flags for `atomic chat`. The actual flags are:

| Flag                   | Default    | Description                                          |
| ---------------------- | ---------- | ---------------------------------------------------- |
| `-a, --agent <name>`   | `"claude"` | Agent to chat with (`claude`, `opencode`, `copilot`) |
| `-w, --workflow`       | `false`    | Enable graph workflow mode                           |
| `-t, --theme <name>`   | `"dark"`   | UI theme (`dark`, `light`)                           |
| `-m, --model <name>`   | (none)     | Model to use for the chat session                    |
| `--max-iterations <n>` | `"100"`    | Maximum iterations for workflow mode                 |
| `[prompt...]`          | (none)     | Initial prompt to send                               |

The README currently shows `atomic chat -a <claude|opencode|copilot>` and `atomic chat -a opencode --theme <light/dark>` in the Ralph section, but the full flag reference is not in the CLI Commands table.

### `atomic init` Flags

`atomic init` also supports a `-a, --agent <name>` flag to pre-select the agent, which is not documented in the CLI Commands table.

### Action Needed

- Consider adding a more detailed flag reference for `atomic chat` and `atomic init`

---

## 2. Slash Commands Table (README lines 353-373)

### Current README

| Command              | Arguments               | Description                                                |
| -------------------- | ----------------------- | ---------------------------------------------------------- |
| `/help`              |                         | Show all available commands                                |
| `/clear`             |                         | Clear all messages and reset session                       |
| `/compact`           |                         | Compact context to reduce token usage                      |
| `/model`             | `[model\|list\|select]` | View/switch active model                                   |
| `/mcp`               | `[enable\|disable]`     | View and toggle MCP servers                                |
| `/init`              |                         | Generate `CLAUDE.md` and `AGENTS.md` by exploring codebase |
| `/research-codebase` | `"<question>"`          | Analyze codebase and document findings                     |
| `/create-spec`       | `"<research-path>"`     | Generate technical specification                           |
| `/explain-code`      | `"<path>"`              | Explain code section in detail                             |
| `/gh-commit`         |                         | Create a Git commit using Git/GitHub workflow              |
| `/gh-create-pr`      |                         | Commit, push, and open a GitHub pull request               |
| `/sl-commit`         |                         | Create a Sapling commit                                    |
| `/sl-submit-diff`    |                         | Submit Sapling changes to Phabricator                      |
| `/ralph`             | `"<prompt>"`            | Run autonomous implementation workflow                     |

### What's Missing from the README

| Command  | Aliases       | Description                                                 | Notes                        |
| -------- | ------------- | ----------------------------------------------------------- | ---------------------------- |
| `/theme` | (none)        | Toggle between dark and light theme. Arg: `[dark \| light]` | Built-in command, not listed |
| `/exit`  | `/quit`, `/q` | Exit the chat application                                   | Built-in command, not listed |

### Alias Not Documented

| Command  | Alias        |
| -------- | ------------ |
| `/ralph` | `/loop`      |
| `/help`  | `/h`, `/?`   |
| `/clear` | `/cls`, `/c` |
| `/model` | `/m`         |

### Action Needed

- Add `/theme` and `/exit` to the Slash Commands table
- Optionally add aliases column to the table

---

## 3. Agents Table (README lines 374-387)

### Current README

| Agent                        | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `codebase-analyzer`          | Analyze implementation details of specific components |
| `codebase-locator`           | Locate files, directories, and components for a task  |
| `codebase-pattern-finder`    | Find similar implementations and usage examples       |
| `codebase-online-researcher` | Research questions using web sources                  |
| `codebase-research-analyzer` | Deep dive on research topics                          |
| `codebase-research-locator`  | Discover relevant documents in `research/` directory  |
| `debugger`                   | Debug errors, test failures, and unexpected behavior  |

### What's Missing from the README

| Agent      | Purpose                                                                                         | Notes                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `reviewer` | Code reviewer for proposed code changes. Outputs structured JSON findings with priority levels. | Used internally by Ralph Step 3. Exists in all three agent directories.                  |
| `worker`   | Implements a SINGLE task from a task list. Used by the Ralph workflow.                          | Used internally by Ralph for task implementation. Exists in all three agent directories. |

### Action Needed

- Add `reviewer` and `worker` to the Agents table

---

## 4. Skills Table (README lines 388-396)

### Current README

| Skill                   | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `testing-anti-patterns` | Prevent common testing mistakes (mock misuse, test pollution) |
| `prompt-engineer`       | Apply best practices when creating or improving prompts       |

### What's Missing from the README

| Skill             | Purpose                                                                           | Notes                                 |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| `frontend-design` | Create distinctive, production-grade frontend interfaces with high design quality | Exists in all three skill directories |

### Notes

The README's "Skills" table specifically documents skills that are "automatically invoked when relevant" (i.e., passive/background skills). The slash-command skills (`/init`, `/research-codebase`, `/create-spec`, etc.) are already listed in the Slash Commands table. The `frontend-design` skill falls into the same category as `testing-anti-patterns` and `prompt-engineer` — it provides domain knowledge during work and should be listed here.

### Action Needed

- Add `frontend-design` to the Skills table

---

## 5. Supported Coding Agents Table (README lines 399-406)

### Current README

| Agent              | CLI Command               | Folder       | Context File |
| ------------------ | ------------------------- | ------------ | ------------ |
| Claude Code        | `atomic chat -a claude`   | `.claude/`   | `CLAUDE.md`  |
| OpenCode           | `atomic chat -a opencode` | `.opencode/` | `AGENTS.md`  |
| GitHub Copilot CLI | `atomic chat -a copilot`  | `.github/`   | `AGENTS.md`  |

### Current State

This table is **accurate**. All three agents are still supported with the same folders and context files.

### Action Needed

- No changes needed

---

## 6. Ralph Section (README lines 409-453)

### Current README Description

The README describes Ralph as enabling "multi-hour autonomous coding sessions" with 3 steps:

1. Create and approve your spec (`/create-spec`)
2. Start the workflow (`/ralph "<prompt-or-spec-path>"`)
3. Ralph decomposes tasks and implements features one-by-one until complete

### What Actually Happens in Code

The Ralph workflow (`workflow-commands.ts:547-800`) implements a **3-step process**:

1. **Step 1 (Task Decomposition)**: Sends the prompt through `buildSpecToTasksPrompt()` and parses a JSON task list
2. **Step 2 (Implementation Loop)**: Loops up to `MAX_RALPH_ITERATIONS` (100) dispatching **worker sub-agents** until all tasks complete
3. **Step 3 (Review & Fix)**: Spawns a **reviewer sub-agent**, parses findings, generates fix specs, and re-invokes Steps 1-2 if needed. Up to 1 review-fix cycle.

The README's description is largely accurate but does not mention:

- The **review step** (Step 3 with reviewer sub-agent)
- The **worker sub-agent dispatch** pattern
- Custom workflows loadable from `.atomic/workflows/` directories

### Action Needed

- Update the "How It Works" subsection to mention the 3-step process including review
- Note: The usage examples and arguments table are still accurate

---

## 7. Configuration Files Section (README lines 456-494)

### Current README — `.atomic.json`

```json
{
    "version": 1,
    "agent": "claude",
    "scm": "github",
    "lastUpdated": "2026-02-12T12:00:00.000Z"
}
```

### Current State

This is **accurate**. The `.atomic.json` schema and fields table are correct.

### Agent-Specific Files Table

| Agent          | Folder       | Skills              | Context File |
| -------------- | ------------ | ------------------- | ------------ |
| Claude Code    | `.claude/`   | `.claude/skills/`   | `CLAUDE.md`  |
| OpenCode       | `.opencode/` | `.opencode/skills/` | `AGENTS.md`  |
| GitHub Copilot | `.github/`   | `.github/skills/`   | `AGENTS.md`  |

This is **accurate**.

### Action Needed

- No changes needed

---

## 8. Installation Section (README lines 118-248)

### Current State

Installation methods are **accurate**:

- Native install (macOS/Linux via curl, Windows via PowerShell)
- Bun installation (`bun add -g @bastani/atomic`)
- Version pinning and custom directories

### Action Needed

- No changes needed

---

## 9. Telemetry Section (README lines 608-689)

### Current State

The telemetry section is **accurate**. It correctly documents:

- What is collected (command names, agent type, success/failure, session metrics)
- What is never collected (prompts, file paths, code, IP addresses, PII)
- Privacy features (anonymous ID, local logging, CI auto-disable, first-run consent)
- Data storage paths for all platforms
- Opt-out methods (config command, environment variables)
- Programmatic configuration examples

### Action Needed

- No changes needed

---

## 10. Troubleshooting Section (README lines 693-718)

### Current README

Documents:

- Git identity error fix
- Windows command resolution
- Generating CLAUDE.md/AGENTS.md (correctly states to use `/init` in chat)
- Best practice: use git worktrees for Ralph

### Current State

This is **accurate**.

### Action Needed

- No changes needed

---

## 11. The Workflow Section (README lines 269-337)

### Current README Steps

```
Research -> Plan (Spec) -> Implement (Ralph) -> (Debug) -> PR
```

1. `/research-codebase [Describe your feature or question]`
2. `/create-spec [research-path]`
3. `/ralph "<prompt-or-spec-path>"`
4. Manual debugging
5. `/gh-create-pr`

### Current State

This workflow is still **accurate**. The only enhancement is that Ralph now includes an automatic review step (Step 3 with reviewer sub-agent), which means debugging may be less necessary for issues Ralph catches itself.

### Action Needed

- Optionally mention that Ralph includes built-in review in Step 3

---

## Summary of All Required Changes

### Must Fix (Discrepancies)

1. **Agents Table**: Add `reviewer` and `worker` agents
2. **Skills Table**: Add `frontend-design` skill

### Should Fix (Missing Documentation)

3. **Slash Commands Table**: Add `/theme` and `/exit` commands
4. **Ralph Section**: Update "How It Works" to mention the 3-step process (decompose, implement, review & fix)

### Nice to Have (Enhancements)

5. **Slash Command Aliases**: Document aliases (`/loop` for `/ralph`, `/h` for `/help`, etc.)
6. **Chat Command Flags**: Document the full flag reference for `atomic chat` (currently partially shown in examples but not in the CLI Commands table)
7. **TUI Features**: The README doesn't mention TUI-specific features like themes, @mentions, model selector, transcript view, keyboard shortcuts (Ctrl+O for transcript, Ctrl+C for interrupt), verbose mode, etc. This could be a new section or additions to existing sections.

---

## Files Analyzed

- `/Users/norinlavaee/atomic/README.md` — Current README
- `/Users/norinlavaee/atomic/src/cli.ts` — CLI entry point and command definitions
- `/Users/norinlavaee/atomic/src/commands/chat.ts` — Chat command implementation
- `/Users/norinlavaee/atomic/src/commands/init.ts` — Init command implementation
- `/Users/norinlavaee/atomic/src/commands/config.ts` — Config command implementation
- `/Users/norinlavaee/atomic/src/commands/update.ts` — Update command implementation
- `/Users/norinlavaee/atomic/src/commands/uninstall.ts` — Uninstall command implementation
- `/Users/norinlavaee/atomic/src/config.ts` — Agent and SCM configuration
- `/Users/norinlavaee/atomic/src/ui/commands/builtin-commands.ts` — Built-in slash commands
- `/Users/norinlavaee/atomic/src/ui/commands/workflow-commands.ts` — Workflow commands (Ralph)
- `/Users/norinlavaee/atomic/src/ui/commands/skill-commands.ts` — Skill discovery
- `/Users/norinlavaee/atomic/src/ui/commands/agent-commands.ts` — Agent discovery
- `/Users/norinlavaee/atomic/src/ui/index.ts` — TUI entry and rendering
- `/Users/norinlavaee/atomic/src/ui/theme.tsx` — Theme system
- `/Users/norinlavaee/atomic/src/ui/chat.tsx` — Chat component
- `/Users/norinlavaee/atomic/src/utils/atomic-config.ts` — .atomic.json handling
- `/Users/norinlavaee/atomic/src/utils/settings.ts` — Settings persistence
- `/Users/norinlavaee/atomic/src/utils/mcp-config.ts` — MCP config discovery
- `/Users/norinlavaee/atomic/src/telemetry/` — Full telemetry module
- `/Users/norinlavaee/atomic/.claude/skills/` — Claude skills
- `/Users/norinlavaee/atomic/.claude/agents/` — Claude agents
- `/Users/norinlavaee/atomic/.opencode/skills/` — OpenCode skills
- `/Users/norinlavaee/atomic/.github/skills/` — Copilot skills
- `/Users/norinlavaee/atomic/package.json` — Package metadata
- Git history (100+ commits analyzed)
