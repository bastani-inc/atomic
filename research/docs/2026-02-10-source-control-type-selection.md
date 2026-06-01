---
date: 2026-02-10 13:13:52 PST
researcher: Claude Code
git_commit: 2685610703fed9d71ff0447287950059b05ffe70
branch: flora131/feature/sapling-integration
repository: atomic
topic: "Source Control Type Selection Feature - Extending Init Flow for Multi-SCM Support"
tags:
    [
        research,
        codebase,
        source-control,
        sapling,
        github,
        init-flow,
        commands,
        skills,
    ]
status: complete
last_updated: 2026-02-10
last_updated_by: Claude Code
---

# Research: Source Control Type Selection Feature

## Research Question

How can we extend the current agent selection flow to include source control type selection (initially supporting Sapling and GitHub, with future extensibility for Azure DevOps), where:

1. Non-built-in/configurable commands get separate prompt/md files per source control type (e.g., `commit-github.md`, `commit-sapling.md`)
2. General commands that don't use source control tools remain unified (e.g., `research-codebase.md`)
3. The `atomic init` flow places the correct files in the user's `.opencode`, `.github`, or `.claude` directory based on their source control selection
4. Auto-create the config directory if it doesn't exist when running atomic init

## Summary

The atomic CLI codebase has a well-structured agent configuration and command system that can be extended to support source control type selection. The current architecture already supports:

- Multiple agent types (Claude, OpenCode, Copilot) with different config folders
- Command/skill files with YAML frontmatter in markdown format
- A template-based init flow with preservation and merge logic
- Both built-in commands and disk-discoverable custom commands

**Key findings for source control integration:**

1. Only 2 commands currently use SCM-specific operations: `/commit` and `/create-gh-pr`
2. These commands exist as duplicates across all agent folders (`.claude/commands/`, `.opencode/command/`, `.github/skills/`)
3. The `/commit` command uses generic `git` commands that need Sapling equivalents
4. The `/create-gh-pr` command is GitHub-specific and would need a Sapling equivalent
5. General commands like `/research-codebase` do not use SCM tools and don't need variants

---

## Detailed Findings

### 1. Current Agent Configuration Architecture

The agent system is defined in `src/config.ts`:

```typescript
export interface AgentConfig {
    name: string; // Display name
    cmd: string; // Command to execute
    additional_flags: string[]; // Flags for agent spawning
    folder: string; // Config folder (.claude, .opencode, .github)
    install_url: string; // Installation URL
    exclude: string[]; // Files to skip when copying folder
    additional_files: string[]; // Extra files to copy (CLAUDE.md, AGENTS.md, .mcp.json)
    preserve_files: string[]; // Files to skip if user has customized them
    merge_files: string[]; // Files to merge instead of overwrite (.mcp.json)
}
```

**Current Agent Configurations:**

| Agent       | Folder      | Additional Files         | Preserve Files | Merge Files |
| ----------- | ----------- | ------------------------ | -------------- | ----------- |
| Claude Code | `.claude`   | `CLAUDE.md`, `.mcp.json` | `CLAUDE.md`    | `.mcp.json` |
| OpenCode    | `.opencode` | `AGENTS.md`              | `AGENTS.md`    | -           |
| Copilot     | `.github`   | `AGENTS.md`              | `AGENTS.md`    | -           |

### 2. Current Command/Skill File Locations

Commands and skills are stored in different directories per agent:

| Agent    | Commands Location    | File Pattern                |
| -------- | -------------------- | --------------------------- |
| Claude   | `.claude/commands/`  | `*.md` files                |
| OpenCode | `.opencode/command/` | `*.md` files                |
| Copilot  | `.github/skills/`    | `*/SKILL.md` subdirectories |

**Current command files found:**

```
.claude/commands/
├── commit.md           # Uses: git add, status, diff, commit, log
└── create-gh-pr.md     # Uses: git, gh (GitHub CLI)

.opencode/command/
├── commit.md           # Uses: git add, status, diff, commit, log
└── create-gh-pr.md     # Uses: git, gh (GitHub CLI)

.github/skills/
├── commit/
│   └── SKILL.md        # Empty placeholder (uses builtin)
└── create-gh-pr/
    └── SKILL.md        # Empty placeholder (uses builtin)
```

### 3. Commands That Use Source Control Tools

Based on comprehensive analysis, only **2 commands** use SCM-specific operations:

#### `/commit` Command

**Files:**

- `src/ui/commands/skill-commands.ts:72-316` - Embedded prompt in BUILTIN_SKILLS
- `.claude/commands/commit.md` - Claude Agent SDK configuration
- `.opencode/command/commit.md` - OpenCode SDK configuration
- `.github/skills/commit/SKILL.md` - Empty placeholder

**Git operations used:**

- `git status --porcelain`
- `git branch --show-current`
- `git diff --cached --stat`
- `git diff --stat`
- `git log --oneline -5`
- `git add`
- `git commit --message`
- `git commit --trailer`
- `git rebase -i` (referenced in docs)

**Git → Sapling Command Mapping for /commit:**

| Operation             | Git                         | Sapling                   |
| --------------------- | --------------------------- | ------------------------- |
| Check status          | `git status --porcelain`    | `sl status`               |
| Get current branch    | `git branch --show-current` | `sl bookmark` or smartlog |
| View staged changes   | `git diff --cached --stat`  | `sl diff --stat`          |
| View unstaged changes | `git diff --stat`           | `sl diff --stat`          |
| Recent commits        | `git log --oneline -5`      | `sl smartlog` or `sl ssl` |
| Stage files           | `git add <files>`           | `sl add <files>`          |
| Create commit         | `git commit -m "msg"`       | `sl commit -m "msg"`      |
| Amend commit          | `git commit --amend`        | `sl amend`                |

#### `/create-gh-pr` Command

**Files:**

- `src/ui/commands/skill-commands.ts:855-866` - Skill definition
- `.claude/commands/create-gh-pr.md`
- `.opencode/command/create-gh-pr.md`
- `.github/skills/create-gh-pr/SKILL.md` (empty placeholder)

**GitHub-specific operations:**

- `gh pr create --title "TITLE" --body "BODY" --base $BASE_BRANCH`
- Uses `/commit` command internally

**Git/GitHub → Sapling Mapping for /create-gh-pr:**

| Operation    | Git/GitHub     | Sapling                    |
| ------------ | -------------- | -------------------------- |
| Push changes | `git push`     | `sl push --to <bookmark>`  |
| Create PR    | `gh pr create` | `sl pr submit`             |
| Update PR    | Push + amend   | `sl amend && sl pr submit` |
| List PRs     | `gh pr list`   | `sl pr list`               |

### 4. Commands That Do NOT Need SCM Variants

All other built-in skills/commands are SCM-agnostic:

**Configurable Skills (no SCM usage):**

- `/research-codebase` - File analysis only
- `/create-spec` - Document generation only
- `/implement-feature` - Code writing only
- `/explain-code` - Code analysis only
- `/prompt-engineer` - Prompt optimization only (pinned builtin)
- `/testing-anti-patterns` - Pattern analysis only (pinned builtin)

**Built-in Commands (hardcoded, no SCM usage):**

- `/help`, `/theme`, `/clear`, `/compact`, `/exit`, `/model`, `/mcp`, `/context`

### 5. Init Command Flow Analysis

The init command (`src/commands/init.ts`) follows this flow:

1. **Display banner and intro** (`displayBanner()`, `intro()`)
2. **Agent selection** (`select()` prompt from @clack/prompts)
3. **Directory confirmation** (`confirm()` prompt)
4. **Telemetry consent** (`handleTelemetryConsent()`)
5. **Check for existing folder** and handle update/overwrite
6. **Copy template files** (`copyDirPreserving()`)
7. **Copy additional files** with preservation/merge logic
8. **Show success message**

**Key insertion point for source control selection:** Between steps 2 and 3 (after agent selection at line ~136, before directory confirmation).

**Template file storage locations:**

| Install Type   | Template Location                                  |
| -------------- | -------------------------------------------------- |
| Source/dev     | Repository root (`/atomic`)                        |
| npm/bun global | `node_modules/@bastani/atomic`                     |
| Binary         | `~/.local/share/atomic` or `%LOCALAPPDATA%\atomic` |

### 6. File Copy Logic

The `copyDirPreserving()` function (`src/commands/init.ts:49-79`) handles template copying:

- **Always overwrites** template files (ensures updates reach users)
- **Preserves** user's custom files not in template
- **Excludes** platform-specific files (`.ps1` on Unix, `.sh` on Windows)
- **Filters** items in `exclude` list

For `additional_files`:

- **Preserve files** (CLAUDE.md, AGENTS.md): Skip if exists and non-empty
- **Merge files** (.mcp.json): Deep merge user + template content
- **Default**: Only copy if destination doesn't exist

### 7. Sapling SCM Reference

A comprehensive Sapling reference document has been created at `research/docs/sapling-reference.md` with:

- Complete Git → Sapling command mapping
- GitHub integration via `sl pr` commands
- Key concepts (smartlog, stacks, bookmarks)
- Installation and configuration

**Key Sapling Concepts for Command Files:**

1. **Smartlog** (`sl smartlog` or `sl ssl`): Graphical commit view with PR status
2. **Bookmarks**: Equivalent to Git branches
3. **`sl amend`**: Automatically rebases descendant commits
4. **`sl pr submit`**: Native GitHub PR support
5. **No staging area**: Sapling commits directly (no git add equivalent for staging)

---

## Code References

### Core Configuration

- `src/config.ts:5-24` - AgentConfig interface definition
- `src/config.ts:26-70` - AGENT_CONFIG object with all agent definitions
- `src/config.ts:72-82` - Helper functions (isValidAgent, getAgentConfig, getAgentKeys)

### Init Command Flow

- `src/commands/init.ts:84-300` - Main initCommand function
- `src/commands/init.ts:49-79` - copyDirPreserving function
- `src/commands/init.ts:124-135` - Agent selection prompt (insertion point for SCM)

### Skill Commands

- `src/ui/commands/skill-commands.ts:72-316` - commit skill (embedded)
- `src/ui/commands/skill-commands.ts:855-866` - create-gh-pr skill
- `src/ui/commands/skill-commands.ts:1708-1711` - PINNED_BUILTIN_SKILLS

### Built-in Commands

- `src/ui/commands/builtin-commands.ts` - All built-in command definitions

### Command Files (SCM-Specific)

- `.claude/commands/commit.md` - Git commit command for Claude
- `.claude/commands/create-gh-pr.md` - GitHub PR command for Claude
- `.opencode/command/commit.md` - Git commit command for OpenCode
- `.opencode/command/create-gh-pr.md` - GitHub PR command for OpenCode

---

## Architecture Documentation

### Current Command Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Command Registry                         │
│  (Global singleton - stores all commands from all sources)  │
└─────────────────────────────────────────────────────────────┘
                              ▲
          ┌───────────────────┼───────────────────┐
          │                   │                   │
┌─────────┴─────────┐ ┌───────┴───────┐ ┌────────┴────────┐
│  Built-in Commands │ │ Skill Commands │ │ Agent Commands  │
│  (Hardcoded TS)    │ │ (Embedded+Disk)│ │ (Embedded+Disk) │
└───────────────────┘ └───────────────┘ └─────────────────┘
         │                   │                   │
    8 commands          8 built-in           Discovery paths:
    (help, theme,      + disk discovery      .*/agents/
     clear, etc.)       (.*/skills/)
```

### Proposed Source Control Extension Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     atomic init flow                         │
└─────────────────────────────────────────────────────────────┘
                              │
                    1. Select Agent Type
                      (claude/opencode/copilot)
                              │
                    2. Select Source Control ← NEW STEP
                      (github/sapling/azure-devops)
                              │
                    3. Copy Template Files
                      (SCM-specific commands)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Target Directory (.claude, etc.)                │
├─────────────────────────────────────────────────────────────┤
│  commands/                                                   │
│  ├── commit.md          ← Copied from commit/github.md      │
│  │                        OR commit/sapling.md based on     │
│  │                        user's SCM selection              │
│  ├── create-gh-pr.md    ← Only for GitHub users            │
│  └── create-sl-pr.md    ← Only for Sapling users           │
└─────────────────────────────────────────────────────────────┘
```

### Proposed Template Directory Structure

**Option A: SCM folders within agent commands**

```
.claude/
├── commands/
│   ├── commit/
│   │   ├── github.md         # Git-based commit
│   │   └── sapling.md        # Sapling-based commit
│   ├── create-pr/
│   │   ├── github.md         # gh pr create
│   │   └── sapling.md        # sl pr submit
│   └── research-codebase.md  # General (no variants)

.opencode/
├── command/
│   ├── commit/
│   │   ├── github.md
│   │   └── sapling.md
│   ├── create-pr/
│   │   ├── github.md
│   │   └── sapling.md
│   └── research-codebase.md
```

**Option B: Separate template directories per SCM**

```
templates/
├── github/
│   └── .claude/
│       └── commands/
│           ├── commit.md
│           └── create-gh-pr.md
├── sapling/
│   └── .claude/
│       └── commands/
│           ├── commit.md
│           └── create-sl-pr.md
└── common/
    └── .claude/
        └── commands/
            └── research-codebase.md
```

---

## Historical Context (from research/)

Related research documents:

- `research/docs/2026-01-19-cli-auto-init-agent.md` - Auto-init behavior when config missing
- `research/docs/2026-01-20-cli-agent-rename-research.md` - Agent naming research
- `research/docs/sapling-reference.md` - Complete Sapling command reference

---

## Related Research

### External References

- **Facebook Sapling Repository:** https://github.com/facebook/sapling
- **Sapling Documentation:** https://sapling-scm.com/docs/
- **DeepWiki Sapling:** https://deepwiki.com/facebook/sapling

### Created Reference Documents

- `research/docs/sapling-reference.md` - Complete Git → Sapling command mapping guide

---

## Open Questions

1. **SCM Detection**: Should atomic auto-detect the SCM type (look for `.sl` vs `.git` directory) or always prompt the user?

2. **Hybrid Repositories**: Some users might work with Sapling-on-top-of-Git (Sapling can work with Git repos). How should we handle this case?

3. **Azure DevOps Support**: What CLI tools does ADO use? Will need similar research for ADO as done for Sapling.

4. **Command Naming**: Should Sapling PR command be named:
    - `create-sl-pr.md` (matches tool name)
    - `create-pr-sapling.md` (matches pattern `create-pr-{scm}`)
    - `submit-pr.md` (matches Sapling's `sl pr submit`)

5. **Backwards Compatibility**: How do we handle existing installations when a user switches SCM types?

6. **Built-in Skills**: The current `/commit` and `/create-gh-pr` are embedded in `skill-commands.ts`. Should SCM-specific variants also be embedded, or only disk-based?

7. **Config Storage**: Should we store the selected SCM type in a config file (`.atomic.json`?) for future runs?

8. **Auto-Init Enhancement**: The spec mentions auto-creating the config directory. Currently `run-agent.ts` already calls init automatically when folder doesn't exist (lines 88-98). Should the SCM prompt also appear during auto-init, or should it default to Git/GitHub?

---

## Implementation Considerations

### Required Changes Summary

| File                        | Change Type | Description                                     |
| --------------------------- | ----------- | ----------------------------------------------- |
| `src/config.ts`             | Extend      | Add `SourceControlType` and `SCM_CONFIG`        |
| `src/commands/init.ts`      | Modify      | Add SCM selection prompt after agent selection  |
| `.claude/commands/`         | Create      | SCM-specific command file variants              |
| `.opencode/command/`        | Create      | SCM-specific command file variants              |
| `.github/skills/`           | Create      | SCM-specific skill file variants                |
| `src/commands/run-agent.ts` | Verify      | Auto-init already exists, may need SCM handling |

### Proposed Configuration Extensions

```typescript
// src/config.ts additions

export type SourceControlType = "github" | "sapling" | "azure-devops";

export interface ScmConfig {
    name: string; // "GitHub/Git" or "Sapling"
    displayName: string; // For prompts
    cliTool: string; // "git" or "sl"
    prTool: string; // "gh" or "sl pr"
    detectDir?: string; // ".git" or ".sl" for auto-detection
}

export const SCM_CONFIG: Record<SourceControlType, ScmConfig> = {
    github: {
        name: "github",
        displayName: "GitHub / Git",
        cliTool: "git",
        prTool: "gh",
        detectDir: ".git",
    },
    sapling: {
        name: "sapling",
        displayName: "Sapling",
        cliTool: "sl",
        prTool: "sl pr",
        detectDir: ".sl",
    },
    "azure-devops": {
        name: "azure-devops",
        displayName: "Azure DevOps",
        cliTool: "git",
        prTool: "az repos",
        detectDir: ".git", // ADO uses git
    },
};

// Commands that have SCM-specific variants
export const SCM_SPECIFIC_COMMANDS = ["commit", "create-pr"];
```

### Proposed Init Flow Extension

```typescript
// src/commands/init.ts additions (after agent selection, ~line 136)

// Select source control type
const scmOptions = Object.entries(SCM_CONFIG).map(([key, config]) => ({
    value: key as SourceControlType,
    label: config.displayName,
}));

const selectedScm = await select({
    message: "Select source control type:",
    options: scmOptions,
});

if (isCancel(selectedScm)) {
    cancel("Operation cancelled.");
    process.exit(0);
}

const scmType = selectedScm as SourceControlType;

// Store selection for file copying logic
// Pass to copyDirPreserving or use separate SCM-aware copy function
```

### Minimal Viable Implementation

For the initial implementation:

1. **Add SCM selection prompt** after agent selection in init flow
2. **Create Sapling command variants:**
    - `.claude/commands/commit-sapling.md`
    - `.claude/commands/create-sl-pr.md`
    - Similar for `.opencode/` and `.github/`
3. **Modify file copy logic** to select appropriate command files based on SCM
4. **Store selection** in a config file for future reference

This keeps the initial scope small while enabling future expansion.

---

## Commands Summary Table

| Command                 | Category       | Uses SCM?            | Needs Variants? | Notes                               |
| ----------------------- | -------------- | -------------------- | --------------- | ----------------------------------- |
| `commit`                | skill          | **YES** (git)        | **YES**         | Primary SCM command                 |
| `create-gh-pr`          | skill          | **YES** (gh, git)    | **YES**         | Becomes `create-pr` with variants   |
| `research-codebase`     | skill          | No                   | No              | File analysis only                  |
| `create-spec`           | skill          | No                   | No              | Document generation                 |
| `implement-feature`     | skill          | No                   | No              | Code writing                        |
| `explain-code`          | skill          | No                   | No              | Code analysis                       |
| `prompt-engineer`       | skill (pinned) | No                   | No              | Prompt optimization                 |
| `testing-anti-patterns` | skill (pinned) | No                   | No              | Pattern analysis                    |
| `/help`                 | builtin        | No                   | No              | UI command                          |
| `/theme`                | builtin        | No                   | No              | UI command                          |
| `/clear`                | builtin        | No                   | No              | UI command                          |
| `/model`                | builtin        | No                   | No              | UI command                          |
| `/mcp`                  | builtin        | No                   | No              | UI command                          |
| `/context`              | builtin        | No                   | No              | UI command                          |
| `/compact`              | builtin        | No                   | No              | UI command                          |
| `/exit`                 | builtin        | No                   | No              | UI command                          |
| `/ralph`                | workflow       | **YES** (in PR node) | **Maybe**       | Uses `gh pr create` in createPRNode |
