---
date: 2026-01-19 19:23:13 UTC
researcher: Claude
git_commit: bac12df582f3752fc22f0a5d1b9806d568b0dcdb
branch: main
repository: atomic
topic: "Auto-initialize agent config when running atomic --agent if config not detected"
tags: [research, codebase, cli, init, agent, auto-setup]
status: complete
last_updated: 2026-01-19
last_updated_by: Claude
last_updated_note: "Added clarification for atomic init --agent flag and distinct command behaviors"
---

# Research: Auto-Initialize Agent Config When Running `atomic --agent`

## Research Question

How to update the CLI so that:

1. `atomic init --agent [name]` / `atomic init -a [name]` - Streamlined setup that skips agent selection dialogue (always runs init)
2. `atomic` - Remains aliased to `atomic init` (unchanged)
3. `atomic --agent [name]` (without init) - Only runs init if config doesn't exist, otherwise spawns the agent

## Summary

The CLI needs to support three distinct behaviors:

| Command                      | Behavior                                                         |
| ---------------------------- | ---------------------------------------------------------------- |
| `atomic`                     | Alias for `atomic init` - full interactive setup                 |
| `atomic init`                | Full interactive setup with agent selection                      |
| `atomic init --agent [name]` | Streamlined setup - skips selection, always runs init            |
| `atomic --agent [name]`      | Conditional: runs init only if config missing, then spawns agent |

**Key distinction:**

- `atomic init -a [name]` = "Set up this agent now" (always init)
- `atomic -a [name]` = "Run this agent, set up first if needed" (conditional init)

## Detailed Findings

### 1. Current CLI Argument Parsing

**Entry Point:** [src/index.ts:54-106](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/index.ts#L54-L106)

```typescript
const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        agent: { type: "string", short: "a" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        "no-banner": { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
});
```

Current routing logic (lines 80-101):

- `--agent` flag is handled at lines 80-84 (before positional command check)
- Positional `init` command is handled at lines 89-95

**Issue:** Currently `--agent` is processed before checking for `init` subcommand, so `atomic init --agent` would be routed to `runAgentCommand()` instead of `initCommand()`.

### 2. Current `--agent` Flow

**Entry Point:** [src/index.ts:80-84](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/index.ts#L80-L84)

```typescript
// Handle --agent
if (typeof values.agent === "string") {
    const exitCode = await runAgentCommand(values.agent);
    process.exit(exitCode);
}
```

**Run Agent Implementation:** [src/commands/run-agent.ts:24-57](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/commands/run-agent.ts#L24-L57)

Current flow:

1. Validates agent key against `AGENT_CONFIG` (line 26)
2. Checks if agent command is installed in PATH (line 37)
3. Spawns the agent process (lines 47-52)

**Missing:** No check for whether the agent's config folder exists.

### 3. Agent Config Detection

Each agent has a `folder` property in `AGENT_CONFIG` that specifies where its config lives:

| Agent         | Folder      | Additional Files         |
| ------------- | ----------- | ------------------------ |
| `claude-code` | `.claude`   | `CLAUDE.md`, `.mcp.json` |
| `opencode`    | `.opencode` | `AGENTS.md`              |
| `copilot-cli` | `.github`   | `AGENTS.md`              |

**Config Definition:** [src/config.ts:25-60](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/config.ts#L25-L60)

**Path Existence Check Utility:** [src/utils/copy.ts:169-176](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/utils/copy.ts#L169-L176)

```typescript
export async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
```

### 4. Init Command - Selection Flow

**Full Implementation:** [src/commands/init.ts:50-181](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/commands/init.ts#L50-L181)

The selection prompt is at lines 65-81:

```typescript
// Select agent
const agentKeys = getAgentKeys();
const agentOptions = agentKeys.map((key) => ({
    value: key,
    label: AGENT_CONFIG[key].name,
    hint: AGENT_CONFIG[key].install_url.replace("https://", ""),
}));

const selectedAgent = await select({
    message: "Select a coding agent to configure:",
    options: agentOptions,
});

if (isCancel(selectedAgent)) {
    cancel("Operation cancelled.");
    process.exit(0);
}

const agentKey = selectedAgent as AgentKey;
```

### 5. Current `InitOptions` Interface

[src/commands/init.ts:24-26](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/commands/init.ts#L24-L26)

```typescript
interface InitOptions {
    showBanner?: boolean;
}
```

### 6. Post-Selection Flow

After agent selection, the init command:

1. **Directory confirmation** (lines 87-101) - Confirms installation to current directory
2. **Overwrite check** (lines 103-124) - If folder exists, prompts for overwrite
3. **File copying** (lines 126-162) - Copies config files from package to target

## Architecture Documentation

### Key Files and Their Roles

| File                        | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `src/index.ts`              | CLI entry point, argument parsing, command routing     |
| `src/commands/run-agent.ts` | Handles `--agent` flag execution                       |
| `src/commands/init.ts`      | Interactive setup with agent selection                 |
| `src/config.ts`             | Agent configuration definitions                        |
| `src/utils/copy.ts`         | File/directory copy utilities including `pathExists()` |
| `src/utils/detect.ts`       | Command installation and platform detection            |

### Proposed Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              src/index.ts                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  atomic init --agent claude-code                                             │
│       │                                                                      │
│       ▼                                                                      │
│  [Check positional command FIRST]                                            │
│       │                                                                      │
│       ├── command === "init" && values.agent exists                          │
│       │         │                                                            │
│       │         ▼                                                            │
│       │   initCommand({ preSelectedAgent: "claude-code" })                   │
│       │         │                                                            │
│       │         ▼                                                            │
│       │   [Skip selection prompt, run full init flow]                        │
│       │                                                                      │
│  atomic --agent claude-code (no init)                                        │
│       │                                                                      │
│       ▼                                                                      │
│  [No positional command, --agent flag exists]                                │
│       │                                                                      │
│       ▼                                                                      │
│  runAgentCommand("claude-code")                                              │
│       │                                                                      │
│       ├── Validate agent key                                                 │
│       │                                                                      │
│       ├── [NEW] Check if .claude folder exists                               │
│       │         │                                                            │
│       │         ├── If exists → continue to spawn                            │
│       │         │                                                            │
│       │         └── If NOT exists → initCommand({ preSelectedAgent, ... })   │
│       │                    │                                                 │
│       │                    ▼                                                 │
│       │              [After init completes, continue to spawn]               │
│       │                                                                      │
│       ├── Check command installed                                            │
│       │                                                                      │
│       └── Spawn agent process                                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Implementation Approach

### Step 1: Modify Argument Routing in `src/index.ts`

The current routing checks `--agent` before positional commands. This needs to change to check for `init` command first.

**Current order (lines 68-101):**

1. `--version`
2. `--help`
3. `--agent` ← processes before checking positional
4. Positional commands (`init`, etc.)

**Proposed order:**

1. `--version`
2. `--help`
3. Positional commands (`init`, etc.) ← check first, pass `--agent` to init if present
4. `--agent` (only if no positional command)

**Location:** [src/index.ts:80-101](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/index.ts#L80-L101)

```typescript
// Handle positional commands FIRST
const command = positionals[0];

switch (command) {
    case undefined:
        // No command - check if --agent flag exists
        if (typeof values.agent === "string") {
            // atomic --agent [name] → run with conditional init
            const exitCode = await runAgentCommand(values.agent);
            process.exit(exitCode);
        }
        // atomic → full interactive init
        await initCommand({ showBanner: !values["no-banner"] });
        break;

    case "init":
        // atomic init [--agent name] → init with optional pre-selection
        await initCommand({
            showBanner: !values["no-banner"],
            preSelectedAgent: values.agent as AgentKey | undefined,
        });
        break;

    default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
}
```

### Step 2: Extend `InitOptions` Interface

**Location:** [src/commands/init.ts:24-26](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/commands/init.ts#L24-L26)

```typescript
interface InitOptions {
    showBanner?: boolean;
    preSelectedAgent?: AgentKey; // NEW: Skip selection if provided
}
```

### Step 3: Modify `initCommand()` Selection Logic

**Location:** [src/commands/init.ts:65-81](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/commands/init.ts#L65-L81)

```typescript
let agentKey: AgentKey;

if (options.preSelectedAgent) {
    // Pre-selected agent - skip selection prompt
    if (!isValidAgent(options.preSelectedAgent)) {
        cancel(`Unknown agent: ${options.preSelectedAgent}`);
        process.exit(1);
    }
    agentKey = options.preSelectedAgent;
} else {
    // Interactive selection
    const agentKeys = getAgentKeys();
    const agentOptions = agentKeys.map((key) => ({
        value: key,
        label: AGENT_CONFIG[key].name,
        hint: AGENT_CONFIG[key].install_url.replace("https://", ""),
    }));

    const selectedAgent = await select({
        message: "Select a coding agent to configure:",
        options: agentOptions,
    });

    if (isCancel(selectedAgent)) {
        cancel("Operation cancelled.");
        process.exit(0);
    }

    agentKey = selectedAgent as AgentKey;
}
```

### Step 4: Modify `runAgentCommand()` for Conditional Init

**Location:** [src/commands/run-agent.ts:24-57](https://github.com/bastani/atomic/blob/bac12df582f3752fc22f0a5d1b9806d568b0dcdb/src/commands/run-agent.ts#L24-L57)

After validating the agent key (line 32), add config detection:

```typescript
import { join } from "path";
import { pathExists } from "../utils/copy";
import { initCommand } from "./init";

export async function runAgentCommand(agentKey: string): Promise<number> {
    // Validate agent key
    if (!isValidAgent(agentKey)) {
        // ... existing validation error handling
        return 1;
    }

    const agent = AGENT_CONFIG[agentKey as AgentKey];

    // NEW: Check if config folder exists
    const configFolder = join(process.cwd(), agent.folder);
    if (!(await pathExists(configFolder))) {
        // Config not found - run init with pre-selected agent
        await initCommand({
            preSelectedAgent: agentKey as AgentKey,
            showBanner: false,
        });
    }

    // Check if command is installed
    if (!isCommandInstalled(agent.cmd)) {
        // ... existing install error handling
        return 1;
    }

    // Spawn the agent process
    // ... existing spawn logic
}
```

## Code References

- `src/index.ts:54-66` - Argument parsing with `parseArgs`
- `src/index.ts:80-84` - Current `--agent` handling (needs reordering)
- `src/index.ts:86-101` - Current positional command handling
- `src/commands/run-agent.ts:24-57` - `runAgentCommand()` implementation
- `src/commands/init.ts:50-181` - `initCommand()` implementation
- `src/commands/init.ts:65-81` - Agent selection prompt (needs conditional skip)
- `src/commands/init.ts:24-26` - `InitOptions` interface (needs `preSelectedAgent`)
- `src/config.ts:25-60` - `AGENT_CONFIG` with folder definitions
- `src/config.ts:62-64` - `isValidAgent()` type guard
- `src/utils/copy.ts:169-176` - `pathExists()` utility

## Historical Context (from research/)

No directly related research documents found. Existing research:

- `research/docs/2026-01-18-atomic-cli-implementation.md` - General CLI implementation details
- `research/docs/2026-01-19-readme-update-research.md` - README update research
- `research/docs/2026-01-19-slash-commands.md` - Slash commands research

## Related Research

- `research/docs/2026-01-18-atomic-cli-implementation.md` - Contains detailed documentation of the CLI structure

## Open Questions

1. **Help text update:** Should the help text (`--help`) be updated to document the new `atomic init --agent` behavior?

2. **What if the folder exists but is incomplete?** Current init checks only if the folder exists, not if it has all required files. Should the auto-init be more granular?

3. **Banner for `atomic init --agent`:** Should the banner be shown when running `atomic init --agent [name]`? (Currently `showBanner` defaults to `true` for init)

4. **Error handling:** If init fails during auto-init (via `atomic --agent`), should we abort the agent run or continue anyway?

## Summary of Changes Required

| File                        | Change                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`              | Reorder routing: check positional commands before `--agent` flag; pass `--agent` to `initCommand()` when `init` subcommand is used |
| `src/commands/init.ts`      | Add `preSelectedAgent` to `InitOptions`; conditionally skip selection prompt                                                       |
| `src/commands/run-agent.ts` | Add config folder detection; call `initCommand()` if missing                                                                       |
