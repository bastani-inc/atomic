---
date: 2026-01-21 11:15:00 PST
researcher: Claude Code
git_commit: 5d58ef1724770799ec94649c4a6f3285a0b67461
branch: main
repository: atomic
topic: "Anonymous Telemetry Implementation for Atomic CLI"
tags: [research, telemetry, opentelemetry, privacy, hooks, cli]
status: complete
last_updated: 2026-01-21
last_updated_by: Claude Code
last_updated_note: "Triple collection strategy: (1) Atomic CLI commands (init/update/uninstall + agent type), (2) Slash command CLI tracking via run-agent.ts, (3) Session hooks for transcript parsing. All log to same JSONL file."
---

# Research: Anonymous Telemetry Implementation for Atomic CLI

## Research Question

How to implement anonymous telemetry for the Atomic CLI that:

1. Assigns a unique anonymous ID at install time
2. Tracks command usage (like `/research-codebase`) from both CLI and coding agent hooks
3. Logs locally to `.local` folder first
4. Sends to OpenTelemetry collector with secure backend storage
5. Maintains complete user anonymity and privacy

## Summary

This research documents the current Atomic codebase architecture and provides patterns for implementing privacy-preserving telemetry. Key findings:

1. **Current State**: Atomic has no existing telemetry, user identification, or session management
2. **Installation Points**: Binary installation creates `~/.local/share/atomic/` data directory - ideal location for anonymous ID storage
3. **Triple Collection Strategy**: Telemetry is collected from THREE sources:
    - **Atomic CLI Commands**: Tracks `atomic init`, `atomic update`, `atomic uninstall` + which agent is selected
    - **Slash Command CLI Tracking**: Captures `/commands` passed via `atomic -a <agent> -- /command`
    - **Session Hooks**: Captures `/commands` used inside ongoing agent sessions (transcript parsing)
4. **Agent Type Tracking**: Every event includes which agent (Claude Code, OpenCode, GitHub Copilot CLI) the user selected
5. **Hook System**: Session hooks (Stop/sessionEnd) parse transcripts locally, extract only command names
6. **Recommended Approach**: Local file-based buffering with batch upload to OpenTelemetry Collector, using Azure Monitor or Grafana Cloud as backend

---

## Detailed Findings

### 1. Current Codebase Architecture

#### Installation and Data Storage

**Binary Installation Directories:**
| Platform | Binary Location | Data Directory |
|----------|-----------------|----------------|
| Unix/macOS | `~/.local/bin/atomic` | `~/.local/share/atomic/` |
| Windows | `%USERPROFILE%\.local\bin\atomic.exe` | `%LOCALAPPDATA%\atomic\` |

**Source References:**

- [`install.sh:11-12`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/install.sh#L11-L12) - Defines `BIN_DIR` and `DATA_DIR`
- [`install.ps1:16-17`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/install.ps1#L16-L17) - Windows equivalents
- [`src/utils/config-path.ts:54-64`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/src/utils/config-path.ts#L54-L64) - `getBinaryDataDir()` function

**Key Code from `install.sh:11-12`:**

```bash
BIN_DIR="${ATOMIC_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
```

**Key Code from `src/utils/config-path.ts:54-64`:**

```typescript
export function getBinaryDataDir(): string {
    if (isWindows()) {
        const localAppData =
            process.env.LOCALAPPDATA ||
            join(process.env.USERPROFILE || "", "AppData", "Local");
        return join(localAppData, "atomic");
    }
    const xdgDataHome =
        process.env.XDG_DATA_HOME ||
        join(process.env.HOME || "", ".local", "share");
    return join(xdgDataHome, "atomic");
}
```

#### No Existing Telemetry

A comprehensive search confirms **no telemetry, user identification, or session management exists** in the current codebase:

- No `uuid`, `randomUUID`, `machineId`, `userId` generation
- No `telemetry`, `analytics`, `metrics` collection
- No external analytics services (PostHog, Amplitude, Mixpanel, Segment)

---

### 2. CLI Entry Points for Telemetry Integration

#### Main Entry Point

[`src/index.ts:87-243`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/src/index.ts#L87-L243)

The main function at line 87 processes all CLI commands:

```typescript
async function main(): Promise<void> {
    // Line 93: Raw args from Bun.argv.slice(2)
    const rawArgs = Bun.argv.slice(2);

    // Line 121: Agent run mode detection
    if (isAgentRunMode(rawArgs)) {
        // ... agent execution
    }

    // Line 198-230: Command routing (init, update, uninstall)
    switch (command) {
        case "init": // ...
        case "update": // ...
        case "uninstall": // ...
    }
}
```

**Telemetry Integration Point:** Before `main()` returns, track the command executed.

#### Agent Run Command

[`src/commands/run-agent.ts:58-129`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/src/commands/run-agent.ts#L58-L129)

```typescript
export async function runAgentCommand(
    agentKey: string,
    agentArgs: string[] = [],
    options: RunAgentOptions = {},
): Promise<number> {
    // Line 79: Get agent config
    const agent = AGENT_CONFIG[agentKey as AgentKey];

    // Line 119-128: Spawn agent process
    const proc = Bun.spawn(cmd, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });

    const exitCode = await proc.exited;
    return exitCode;
}
```

**Telemetry Integration Points:**

1. Before `Bun.spawn()`: Track agent selection and command
2. After `proc.exited`: Track exit code (success/failure)

#### CLI-Level Telemetry Implementation

This tracks commands invoked directly via `atomic -a <agent> -- /command`:

```typescript
// src/utils/telemetry-cli.ts
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getBinaryDataDir } from "./config-path";
import { VERSION } from "../version";

interface TelemetryState {
    enabled: boolean;
    anonymousId: string;
    consentGiven: boolean;
}

// Atomic commands to track (same list used by session hooks)
const ATOMIC_COMMANDS = [
    "/research-codebase",
    "/create-spec",
    "/create-feature-list",
    "/implement-feature",
    "/commit",
    "/create-gh-pr",
    "/explain-code",
    "/ralph-loop",
    "/ralph:ralph-loop",
    "/cancel-ralph",
    "/ralph:cancel-ralph",
    "/ralph-help",
    "/ralph:help",
];

function isTelemetryEnabled(): TelemetryState | null {
    // Check environment opt-out
    if (
        process.env.ATOMIC_TELEMETRY === "0" ||
        process.env.DO_NOT_TRACK === "1"
    ) {
        return null;
    }

    const dataDir = getBinaryDataDir();
    const telemetryFile = join(dataDir, "telemetry.json");

    if (!existsSync(telemetryFile)) return null;

    try {
        const state: TelemetryState = JSON.parse(
            readFileSync(telemetryFile, "utf-8"),
        );
        if (!state.enabled || !state.consentGiven) return null;
        return state;
    } catch {
        return null;
    }
}

/**
 * Extract Atomic command names from CLI arguments
 * Example: ["fix the bug", "/research-codebase", "src/"] → ["/research-codebase"]
 */
function extractCommandsFromArgs(args: string[]): string[] {
    const commands: string[] = [];

    for (const arg of args) {
        // Check if arg starts with a known command
        for (const cmd of ATOMIC_COMMANDS) {
            if (arg === cmd || arg.startsWith(cmd + " ")) {
                commands.push(cmd);
                break;
            }
        }

        // Also check for commands embedded in text (e.g., "please run /research-codebase")
        const matches = arg.match(/\/[a-zA-Z:-]+/g) || [];
        for (const match of matches) {
            if (ATOMIC_COMMANDS.includes(match) && !commands.includes(match)) {
                commands.push(match);
            }
        }
    }

    return [...new Set(commands)]; // Deduplicate
}

/**
 * Track CLI invocation - call this from run-agent.ts before spawning
 */
export function trackCliInvocation(
    agentKey: string,
    agentArgs: string[],
): void {
    const state = isTelemetryEnabled();
    if (!state) return;

    const commands = extractCommandsFromArgs(agentArgs);

    // Only log if Atomic commands were used
    if (commands.length === 0) return;

    const dataDir = getBinaryDataDir();
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    const logPath = join(dataDir, "telemetry-events.jsonl");

    const event = {
        anonymousId: state.anonymousId,
        eventId: randomUUID(),
        eventType: "cli_command",
        timestamp: new Date().toISOString(),
        agentType: agentKey,
        commands: commands, // Only command names, no arguments
        commandCount: commands.length,
        platform: process.platform,
        atomicVersion: VERSION,
        source: "cli", // Distinguishes from 'session_hook' source
    };

    try {
        appendFileSync(logPath, JSON.stringify(event) + "\n");
    } catch {
        // Fail silently - telemetry should never break the CLI
    }
}
```

**Integration in `run-agent.ts`:**

```typescript
// src/commands/run-agent.ts
import { trackCliInvocation } from "../utils/telemetry-cli";

export async function runAgentCommand(
    agentKey: string,
    agentArgs: string[] = [],
    options: RunAgentOptions = {},
): Promise<number> {
    // ... validation code ...

    // Track CLI invocation BEFORE spawning agent
    // This captures: atomic -a claude -- /research-codebase input
    trackCliInvocation(agentKey, agentArgs);

    // Spawn the agent process
    const proc = Bun.spawn(cmd, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        cwd: process.cwd(),
    });

    const exitCode = await proc.exited;
    return exitCode;
}
```

#### Atomic CLI Command Tracking

This tracks atomic's own commands (`init`, `update`, `uninstall`) and which agent is selected:

```typescript
// src/utils/telemetry-cli.ts (additional exports)

type AtomicCommand = "init" | "update" | "uninstall" | "run";

/**
 * Track atomic CLI command usage
 * Called from src/index.ts for init/update/uninstall commands
 */
export function trackAtomicCommand(
    command: AtomicCommand,
    options: {
        agentType?: "claude" | "opencode" | "copilot";
        success?: boolean;
    } = {},
): void {
    const state = isTelemetryEnabled();
    if (!state) return;

    const dataDir = getBinaryDataDir();
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    const logPath = join(dataDir, "telemetry-events.jsonl");

    const event = {
        anonymousId: state.anonymousId,
        eventId: randomUUID(),
        eventType: "atomic_command",
        timestamp: new Date().toISOString(),
        command: command, // 'init', 'update', 'uninstall', 'run'
        agentType: options.agentType || null, // Which agent was selected (if applicable)
        success: options.success ?? true,
        platform: process.platform,
        atomicVersion: VERSION,
        source: "cli",
    };

    try {
        appendFileSync(logPath, JSON.stringify(event) + "\n");
    } catch {
        // Fail silently
    }
}
```

**Integration in `src/index.ts`:**

```typescript
// src/index.ts
import { trackAtomicCommand } from "./utils/telemetry-cli";

async function main(): Promise<void> {
    // ... argument parsing ...

    // Handle positional commands
    const command = positionals[0];

    switch (command) {
        case "init":
            // Track init command with selected agent (if pre-selected)
            trackAtomicCommand("init", {
                agentType: values.agent as AgentKey | undefined,
            });
            await initCommand({
                /* ... */
            });
            break;

        case "update":
            trackAtomicCommand("update");
            await updateCommand();
            break;

        case "uninstall":
            trackAtomicCommand("uninstall");
            await uninstallCommand({
                /* ... */
            });
            break;

        case undefined:
            // Bare `atomic` command runs init
            trackAtomicCommand("init");
            await initCommand({
                /* ... */
            });
            break;
    }
}
```

**Track agent selection in init command** (`src/commands/init.ts`):

```typescript
// After user selects an agent in interactive mode
import { trackAtomicCommand } from "../utils/telemetry-cli";

// Inside initCommand, after agent selection:
const selectedAgent = await select({
    message: "Select a coding agent to configure:",
    options: agentOptions,
});

// Track which agent was selected
trackAtomicCommand("init", { agentType: selectedAgent as AgentKey });
```

#### Supported Agents and Commands

**Agent Configuration** ([`src/config.ts:29-70`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/src/config.ts#L29-L70)):
| Agent Key | CLI Command | Config Folder |
|-----------|-------------|---------------|
| `claude` | `claude` | `.claude/` |
| `opencode` | `opencode` | `.opencode/` |
| `copilot` | `copilot` | `.github/` |

**Available Commands** (from README.md):
| Command | Description |
|---------|-------------|
| `/research-codebase` | Analyze codebase and document findings |
| `/create-spec` | Generate technical specification |
| `/create-feature-list` | Break spec into implementable tasks |
| `/implement-feature` | Implement next feature from list |
| `/commit` | Create conventional commit |
| `/create-gh-pr` | Push and create pull request |
| `/explain-code` | Explain code section in detail |
| `/ralph:ralph-loop` | Run autonomous implementation loop |
| `/ralph:cancel-ralph` | Stop the autonomous loop |
| `/ralph:help` | Show Ralph documentation |

**Note:** The `ralph:` prefix is specific to Claude Code (plugin namespace). For OpenCode and Copilot CLI, use `/ralph-loop`, `/cancel-ralph`, and `/ralph-help` instead.

---

### 3. Existing Hook System

#### Hook Configuration Format

**GitHub Copilot CLI** ([`.github/hooks/hooks.json`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/.github/hooks/hooks.json)):

```json
{
    "version": 1,
    "hooks": {
        "sessionStart": [
            {
                "type": "command",
                "bash": "./.github/scripts/start-ralph-session.sh",
                "powershell": "./.github/scripts/start-ralph-session.ps1",
                "cwd": ".",
                "timeoutSec": 10
            }
        ],
        "sessionEnd": [
            {
                "type": "command",
                "bash": "./.github/hooks/stop-hook.sh",
                "powershell": "./.github/hooks/stop-hook.ps1",
                "cwd": ".",
                "timeoutSec": 30
            }
        ]
    }
}
```

**Claude Code Plugin** ([`plugins/ralph/hooks/hooks.json`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/plugins/ralph/hooks/hooks.json)):

```json
{
    "hooks": {
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "\"${CLAUDE_PLUGIN_ROOT}/run.cmd\" hooks/stop-hook.sh"
                    }
                ]
            }
        ]
    }
}
```

**OpenCode Plugin** ([`.opencode/plugin/ralph.ts`](https://github.com/bastani/atomic/blob/5d58ef1724770799ec94649c4a6f3285a0b67461/.opencode/plugin/ralph.ts)):

OpenCode uses a **completely different architecture** - TypeScript plugins via the `@opencode-ai/plugin` SDK instead of shell-based hooks:

```typescript
import type { Plugin } from "@opencode-ai/plugin";

export const RalphPlugin: Plugin = async ({ directory, client, $ }) => {
    return {
        event: async ({ event }) => {
            // Listen for session.status event
            if (event.type !== "session.status") return;
            if (event.properties.status?.type !== "idle") return;

            // Plugin logic here - access session via SDK
            const messages = await client.session.messages({
                path: { id: event.properties.sessionID },
            });

            // Continue session programmatically
            await client.session.prompt({
                path: { id: event.properties.sessionID },
                body: { parts: [{ type: "text", text: prompt }] },
            });
        },
    };
};
```

**Key Differences:**

- No `hooks.json` configuration file
- TypeScript code instead of shell scripts
- Uses OpenCode SDK client for session interaction
- Event-driven via `session.status` events
- Does NOT support external shell script hooks like Copilot CLI

#### Available Hook Events by Platform

| Event                   | Platform    | Description            | Data/Access                                         |
| ----------------------- | ----------- | ---------------------- | --------------------------------------------------- |
| `sessionStart`          | Copilot CLI | Session begins         | `{timestamp, cwd, source, initialPrompt}` via stdin |
| `sessionEnd`            | Copilot CLI | Session ends           | `{timestamp, cwd, reason}` via stdin                |
| `Stop`                  | Claude Code | Agent exits            | `{transcript_path}` via stdin                       |
| `userPromptSubmitted`   | Copilot CLI | User submits prompt    | `{timestamp, cwd, prompt}` via stdin                |
| `session.status` (idle) | OpenCode    | AI stops, awaits input | `{sessionID, status}` via SDK event                 |

#### Hook Data Flow by Platform

**GitHub Copilot CLI & Claude Code** - Hooks receive JSON via stdin:

```bash
INPUT=$(cat)
TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')
```

**OpenCode** - Plugins receive events via SDK callback:

```typescript
event: async ({ event }) => {
    if (event.type !== "session.status") return;
    const sessionId = event.properties.sessionID;
    const status = event.properties.status?.type; // "idle", "busy", etc.
};
```

---

### 4. Recommended Anonymous ID Implementation

#### ID Generation Pattern

Based on industry best practices (VS Code, npm, Yarn, Next.js):

```typescript
// src/utils/telemetry.ts
import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getBinaryDataDir } from "./config-path";

interface TelemetryState {
    enabled: boolean;
    anonymousId: string;
    createdAt: string;
    rotatedAt: string;
    consentGiven: boolean;
}

const TELEMETRY_FILE = "telemetry.json";

function getTelemetryFilePath(): string {
    return join(getBinaryDataDir(), TELEMETRY_FILE);
}

export function getAnonymousId(): string | null {
    // Check opt-out first
    if (isTelemetryDisabled()) return null;

    const filePath = getTelemetryFilePath();
    const dataDir = getBinaryDataDir();
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let state: TelemetryState;

    if (existsSync(filePath)) {
        state = JSON.parse(readFileSync(filePath, "utf-8"));

        // Rotate ID monthly for additional privacy
        if (new Date(state.rotatedAt) < firstOfMonth) {
            state.anonymousId = randomUUID();
            state.rotatedAt = now.toISOString();
            writeFileSync(filePath, JSON.stringify(state, null, 2));
        }
    } else {
        // Create new state on first run
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }

        state = {
            enabled: false, // Opt-in by default for GDPR compliance
            anonymousId: randomUUID(),
            createdAt: now.toISOString(),
            rotatedAt: now.toISOString(),
            consentGiven: false,
        };

        writeFileSync(filePath, JSON.stringify(state, null, 2));
    }

    return state.enabled && state.consentGiven ? state.anonymousId : null;
}

export function isTelemetryDisabled(): boolean {
    return (
        process.env.ATOMIC_TELEMETRY === "0" ||
        process.env.ATOMIC_TELEMETRY === "false" ||
        process.env.DO_NOT_TRACK === "1"
    );
}
```

#### Storage Location

| Installation Type | Telemetry File Path                               |
| ----------------- | ------------------------------------------------- |
| Binary (Unix)     | `~/.local/share/atomic/telemetry.json`            |
| Binary (Windows)  | `%LOCALAPPDATA%\atomic\telemetry.json`            |
| npm               | Project-local `.atomic/telemetry.json` (optional) |

---

### 5. Telemetry Data Schema

#### Triple Collection Strategy

Telemetry is collected from **three sources**:

| Source                            | Event Type       | Trigger                                  | What It Captures                            |
| --------------------------------- | ---------------- | ---------------------------------------- | ------------------------------------------- |
| **Atomic CLI Commands**           | `atomic_command` | `atomic init`, `atomic update`, etc.     | Atomic's own commands + agent type selected |
| **Agent Run with Slash Commands** | `cli_command`    | `atomic -a claude -- /research-codebase` | Slash commands passed via CLI               |
| **Session Hooks**                 | `agent_session`  | Agent session end                        | Slash commands used inside agent session    |

**Why all three?**

- **Atomic CLI Commands**: Tracks usage of atomic itself (init, update, uninstall) and which agent users choose
- **Agent Run CLI Tracking**: Captures slash commands passed directly via `atomic -a <agent> -- /command`
- **Session Hooks**: Captures slash commands typed inside an already-running agent session
- Together they provide complete coverage of both Atomic CLI usage and Atomic slash command usage

#### Atomic CLI Commands Flow

```
User runs: atomic init --agent claude
                │
                ▼
        src/index.ts calls trackAtomicCommand('init', {agentType: 'claude'})
                │
                ▼
        Log {eventType: "atomic_command", command: "init", agentType: "claude"}
                │
                ▼
        Execute initCommand()
```

#### Slash Command CLI Tracking Flow

```
User runs: atomic -a claude -- /research-codebase src/
                │
                ▼
        run-agent.ts calls trackCliInvocation()
                │
                ▼
        Extract "/research-codebase" from args
                │
                ▼
        Log {eventType: "cli_command", commands: ["/research-codebase"], source: "cli"}
                │
                ▼
        Spawn agent process
```

#### Session Hook Tracking Flow

```
User inside agent session types: /create-spec
                │
                ▼
        [Session continues...]
                │
                ▼
        Session ends → Stop/sessionEnd hook fires
                │
                ▼
        Parse transcript for /command patterns
                │
                ▼
        Log {eventType: "agent_session", commands: ["/create-spec"], source: "session_hook"}
```

#### Event Types

**1. Atomic Command Event** (`eventType: "atomic_command"`):

```typescript
interface AtomicCommandEvent {
    anonymousId: string; // UUID v4, rotated monthly
    eventId: string; // UUID v4, unique per event
    eventType: "atomic_command";
    timestamp: string; // ISO 8601
    command: "init" | "update" | "uninstall" | "run"; // Atomic CLI command
    agentType: "claude" | "opencode" | "copilot" | null; // Which agent selected (if applicable)
    success: boolean; // Did the command succeed
    platform: "darwin" | "linux" | "win32";
    atomicVersion: string;
    source: "cli";
}
```

**2. Slash Command CLI Event** (`eventType: "cli_command"`):

```typescript
interface CliCommandEvent {
    anonymousId: string; // UUID v4, rotated monthly
    eventId: string; // UUID v4, unique per event
    eventType: "cli_command";
    timestamp: string; // ISO 8601
    agentType: "claude" | "opencode" | "copilot";
    commands: string[]; // e.g., ["/research-codebase"]
    commandCount: number;
    platform: "darwin" | "linux" | "win32";
    atomicVersion: string;
    source: "cli";
}
```

**3. Agent Session Event** (`eventType: "agent_session"`):

```typescript
interface AgentSessionEvent {
    anonymousId: string; // UUID v4, rotated monthly
    sessionId: string; // UUID v4, per agent session
    eventType: "agent_session";
    timestamp: string; // ISO 8601 - session end time
    sessionStartedAt: string; // ISO 8601 - session start time
    agentType: "claude" | "opencode" | "copilot";
    commands: string[]; // e.g., ["/create-spec", "/implement-feature"]
    commandCount: number;
    platform: "darwin" | "linux" | "win32";
    atomicVersion: string;
    source: "session_hook";
}
```

#### Example Telemetry Events

**Atomic Command Event** (from `atomic init --agent claude`):

```json
{
    "anonymousId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "eventId": "evt-0000-1111-2222-333344445555",
    "eventType": "atomic_command",
    "timestamp": "2026-01-21T09:55:00Z",
    "command": "init",
    "agentType": "claude",
    "success": true,
    "platform": "darwin",
    "atomicVersion": "0.1.0",
    "source": "cli"
}
```

**Slash Command CLI Event** (from `atomic -a claude -- /research-codebase src/`):

```json
{
    "anonymousId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "eventId": "evt-1111-2222-3333-444455556666",
    "eventType": "cli_command",
    "timestamp": "2026-01-21T10:00:00Z",
    "agentType": "claude",
    "commands": ["/research-codebase"],
    "commandCount": 1,
    "platform": "darwin",
    "atomicVersion": "0.1.0",
    "source": "cli"
}
```

**Agent Session Event** (from session hook parsing transcript):

```json
{
    "anonymousId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "sessionId": "sess-1234-5678-90ab-cdef12345678",
    "eventType": "agent_session",
    "timestamp": "2026-01-21T10:30:00Z",
    "sessionStartedAt": "2026-01-21T10:00:00Z",
    "agentType": "claude",
    "commands": ["/create-spec", "/implement-feature", "/commit"],
    "commandCount": 3,
    "platform": "darwin",
    "atomicVersion": "0.1.0",
    "source": "session_hook"
}
```

#### What NOT to Collect

- User prompts or arguments passed to commands
- File paths or working directories
- File contents or code
- IP addresses
- Usernames or email addresses
- Environment variables
- Full error messages or stack traces
- Git repository names or URLs
- Full transcript content (parsed locally then discarded)

---

### 6. Hook Integration for Agent Session Tracking

#### Transcript-Parsing Approach

The telemetry hooks follow this flow:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SESSION LIFECYCLE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  sessionStart Hook                                                   │
│  ├─ Store session start timestamp in temp file                      │
│  └─ Exit (no telemetry sent yet)                                    │
│                                                                      │
│  [User runs commands: /research-codebase, /create-spec, etc.]       │
│                                                                      │
│  sessionEnd Hook                                                     │
│  ├─ Read transcript/session messages                                │
│  ├─ Grep for slash commands: /research-codebase, /create-spec, etc. │
│  ├─ Log ONLY command names to ~/.local/share/atomic/telemetry.jsonl │
│  ├─ DO NOT log: prompts, file paths, content, arguments             │
│  └─ Transcript content is NOT retained                              │
│                                                                      │
│  [Later: Batch upload command names to OTEL]                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

#### Atomic Commands to Track

These are the slash commands we extract from transcripts:

```bash
# Core workflow commands
ATOMIC_COMMANDS=(
  "/research-codebase"
  "/create-spec"
  "/create-feature-list"
  "/implement-feature"
  "/commit"
  "/create-gh-pr"
  "/explain-code"
  # Ralph commands (Claude Code uses ralph: prefix)
  "/ralph-loop"
  "/ralph:ralph-loop"
  "/cancel-ralph"
  "/ralph:cancel-ralph"
  "/ralph-help"
  "/ralph:help"
)
```

---

#### Claude Code Telemetry Hooks

Claude Code's `Stop` hook receives the transcript path, making it ideal for parsing.

**`.claude/hooks/telemetry-start.sh`** (sessionStart equivalent):

```bash
#!/usr/bin/env bash
# Store session start time for later use

set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
SESSION_FILE="$DATA_DIR/.current-session"

mkdir -p "$DATA_DIR"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SESSION_FILE"

exit 0
```

**`.claude/hooks/telemetry-stop.sh`** (Stop hook - parses transcript):

```bash
#!/usr/bin/env bash
# Parse transcript for slash commands and log to telemetry

set -euo pipefail

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
TELEMETRY_FILE="$DATA_DIR/telemetry.json"
LOCAL_LOG="$DATA_DIR/telemetry-events.jsonl"
SESSION_FILE="$DATA_DIR/.current-session"

# Check if telemetry is disabled
if [[ "${ATOMIC_TELEMETRY:-1}" == "0" ]] || [[ "${DO_NOT_TRACK:-0}" == "1" ]]; then
  rm -f "$SESSION_FILE"
  exit 0
fi

# Check if consent given
if [[ ! -f "$TELEMETRY_FILE" ]]; then
  rm -f "$SESSION_FILE"
  exit 0
fi

ENABLED=$(jq -r '.enabled // false' "$TELEMETRY_FILE")
CONSENT=$(jq -r '.consentGiven // false' "$TELEMETRY_FILE")

if [[ "$ENABLED" != "true" ]] || [[ "$CONSENT" != "true" ]]; then
  rm -f "$SESSION_FILE"
  exit 0
fi

# Get anonymous ID and session start time
ANON_ID=$(jq -r '.anonymousId // empty' "$TELEMETRY_FILE")
SESSION_START=$(cat "$SESSION_FILE" 2>/dev/null || echo "")
SESSION_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Extract slash commands from transcript (command names only, no arguments)
# Match patterns like: /research-codebase, /create-spec, /ralph:ralph-loop
COMMANDS=""
if [[ -f "$TRANSCRIPT_PATH" ]]; then
  # Extract unique command names from transcript
  # This greps for /command patterns and extracts just the command name
  COMMANDS=$(grep -oE '"/[a-zA-Z:-]+"' "$TRANSCRIPT_PATH" 2>/dev/null | \
    sed 's/"//g' | \
    sort -u | \
    jq -R -s -c 'split("\n") | map(select(length > 0))' || echo "[]")
fi

# Default to empty array if no commands found
if [[ -z "$COMMANDS" ]] || [[ "$COMMANDS" == "null" ]]; then
  COMMANDS="[]"
fi

COMMAND_COUNT=$(echo "$COMMANDS" | jq 'length')

# Create telemetry event with ONLY command names
EVENT=$(jq -n \
  --arg anon_id "$ANON_ID" \
  --arg session_id "$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "unknown")" \
  --arg started "$SESSION_START" \
  --arg ended "$SESSION_END" \
  --arg agent "claude" \
  --argjson commands "$COMMANDS" \
  --argjson count "$COMMAND_COUNT" \
  '{
    anonymousId: $anon_id,
    sessionId: $session_id,
    eventType: "agent_session",
    sessionStartedAt: $started,
    timestamp: $ended,
    agentType: $agent,
    commands: $commands,
    commandCount: $count,
    platform: "'"$(uname -s | tr '[:upper:]' '[:lower:]')"'"
  }')

# Append to local log (batch upload later)
echo "$EVENT" >> "$LOCAL_LOG"

# Clean up session file
rm -f "$SESSION_FILE"

exit 0
```

**Claude Code hooks.json registration** (in `plugins/` or `.claude/`):

```json
{
    "hooks": {
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "./.claude/hooks/telemetry-stop.sh"
                    }
                ]
            }
        ]
    }
}
```

---

#### GitHub Copilot CLI Telemetry Hooks

**`.github/hooks/telemetry-start.sh`**:

```bash
#!/usr/bin/env bash
# Store session start time

set -euo pipefail

INPUT=$(cat)
TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp // empty')

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
SESSION_FILE="$DATA_DIR/.current-session-copilot"

mkdir -p "$DATA_DIR"
echo "$TIMESTAMP" > "$SESSION_FILE"

exit 0
```

**`.github/hooks/telemetry-end.sh`**:

```bash
#!/usr/bin/env bash
# Parse session for commands (Copilot CLI may have different transcript access)

set -euo pipefail

INPUT=$(cat)
TIMESTAMP=$(echo "$INPUT" | jq -r '.timestamp // empty')

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atomic"
TELEMETRY_FILE="$DATA_DIR/telemetry.json"
LOCAL_LOG="$DATA_DIR/telemetry-events.jsonl"
SESSION_FILE="$DATA_DIR/.current-session-copilot"

# Check telemetry consent (same as Claude Code hook)
if [[ "${ATOMIC_TELEMETRY:-1}" == "0" ]] || [[ "${DO_NOT_TRACK:-0}" == "1" ]]; then
  rm -f "$SESSION_FILE"
  exit 0
fi

if [[ ! -f "$TELEMETRY_FILE" ]]; then
  rm -f "$SESSION_FILE"
  exit 0
fi

ENABLED=$(jq -r '.enabled // false' "$TELEMETRY_FILE")
CONSENT=$(jq -r '.consentGiven // false' "$TELEMETRY_FILE")

if [[ "$ENABLED" != "true" ]] || [[ "$CONSENT" != "true" ]]; then
  rm -f "$SESSION_FILE"
  exit 0
fi

ANON_ID=$(jq -r '.anonymousId // empty' "$TELEMETRY_FILE")
SESSION_START=$(cat "$SESSION_FILE" 2>/dev/null || echo "$TIMESTAMP")

# Note: Copilot CLI transcript access TBD - may need to check logs directory
# For now, log session without command details
COMMANDS="[]"
COMMAND_COUNT=0

# TODO: Parse Copilot CLI transcript/logs for commands if available

EVENT=$(jq -n \
  --arg anon_id "$ANON_ID" \
  --arg session_id "$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "unknown")" \
  --arg started "$SESSION_START" \
  --arg ended "$TIMESTAMP" \
  --arg agent "copilot" \
  --argjson commands "$COMMANDS" \
  --argjson count "$COMMAND_COUNT" \
  '{
    anonymousId: $anon_id,
    sessionId: $session_id,
    eventType: "agent_session",
    sessionStartedAt: $started,
    timestamp: $ended,
    agentType: $agent,
    commands: $commands,
    commandCount: $count,
    platform: "'"$(uname -s | tr '[:upper:]' '[:lower:]')"'"
  }')

echo "$EVENT" >> "$LOCAL_LOG"
rm -f "$SESSION_FILE"

exit 0
```

**`.github/hooks/hooks.json`**:

```json
{
    "version": 1,
    "hooks": {
        "sessionStart": [
            {
                "type": "command",
                "bash": "./.github/hooks/telemetry-start.sh",
                "timeoutSec": 5
            },
            {
                "type": "command",
                "bash": "./.github/scripts/start-ralph-session.sh",
                "timeoutSec": 10
            }
        ],
        "sessionEnd": [
            {
                "type": "command",
                "bash": "./.github/hooks/telemetry-end.sh",
                "timeoutSec": 10
            },
            {
                "type": "command",
                "bash": "./.github/hooks/stop-hook.sh",
                "timeoutSec": 30
            }
        ]
    }
}
```

---

#### OpenCode Telemetry Plugin

Since OpenCode uses TypeScript plugins instead of shell hooks, we parse session messages via the SDK:

**`.opencode/plugin/telemetry.ts`:**

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

interface TelemetryState {
    enabled: boolean;
    anonymousId: string;
    consentGiven: boolean;
}

// Atomic commands to track
const ATOMIC_COMMANDS = [
    "/research-codebase",
    "/create-spec",
    "/create-feature-list",
    "/implement-feature",
    "/commit",
    "/create-gh-pr",
    "/explain-code",
    "/ralph-loop",
    "/cancel-ralph",
    "/ralph-help",
];

function getDataDir(): string {
    const xdgDataHome =
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(xdgDataHome, "atomic");
}

function getTelemetryState(): TelemetryState | null {
    const filePath = join(getDataDir(), "telemetry.json");
    if (!existsSync(filePath)) return null;

    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
        return null;
    }
}

function logTelemetryEvent(event: Record<string, unknown>): void {
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    const logPath = join(dataDir, "telemetry-events.jsonl");
    appendFileSync(logPath, JSON.stringify(event) + "\n");
}

function extractCommands(text: string): string[] {
    // Extract slash commands from text (command names only)
    const commandPattern = /\/[a-zA-Z:-]+/g;
    const matches = text.match(commandPattern) || [];

    // Filter to only Atomic commands and deduplicate
    const uniqueCommands = [...new Set(matches)].filter((cmd) =>
        ATOMIC_COMMANDS.some((ac) => cmd.startsWith(ac)),
    );

    return uniqueCommands;
}

export const TelemetryPlugin: Plugin = async ({ directory, client }) => {
    // Check opt-out via environment
    if (
        process.env.ATOMIC_TELEMETRY === "0" ||
        process.env.DO_NOT_TRACK === "1"
    ) {
        return {};
    }

    const state = getTelemetryState();
    if (!state?.enabled || !state?.consentGiven) {
        return {};
    }

    let sessionStartTime: string | null = null;
    let currentSessionId: string | null = null;
    let collectedCommands: Set<string> = new Set();

    return {
        event: async ({ event }) => {
            // Track session start
            if (
                event.type === "session.status" &&
                event.properties.status?.type === "busy"
            ) {
                if (!sessionStartTime) {
                    sessionStartTime = new Date().toISOString();
                    currentSessionId = event.properties.sessionID;
                    collectedCommands = new Set();
                }
            }

            // Track session end - parse messages for commands
            if (
                event.type === "session.status" &&
                event.properties.status?.type === "idle"
            ) {
                if (sessionStartTime && currentSessionId) {
                    try {
                        // Get session messages to extract commands
                        const response = await client.session.messages({
                            path: { id: currentSessionId },
                        });

                        const messages = response.data || [];

                        // Extract commands from user messages only
                        for (const msg of messages) {
                            if (msg.info?.role === "user") {
                                const textParts =
                                    msg.parts
                                        ?.filter(
                                            (p: { type: string }) =>
                                                p.type === "text",
                                        )
                                        .map(
                                            (p: { text?: string }) =>
                                                p.text || "",
                                        )
                                        .join(" ") || "";

                                const commands = extractCommands(textParts);
                                commands.forEach((cmd) =>
                                    collectedCommands.add(cmd),
                                );
                            }
                        }
                    } catch (err) {
                        // Continue without command data if we can't access messages
                    }

                    // Log telemetry event with ONLY command names
                    logTelemetryEvent({
                        anonymousId: state.anonymousId,
                        sessionId: randomUUID(),
                        eventType: "agent_session",
                        sessionStartedAt: sessionStartTime,
                        timestamp: new Date().toISOString(),
                        agentType: "opencode",
                        commands: Array.from(collectedCommands),
                        commandCount: collectedCommands.size,
                        platform: process.platform,
                    });

                    // Reset for next session
                    sessionStartTime = null;
                    currentSessionId = null;
                    collectedCommands = new Set();
                }
            }
        },
    };
};
```

**Plugin Registration** - Add to `.opencode/opencode.json`:

```json
{
    "plugins": {
        "telemetry": {
            "path": ".opencode/plugin/telemetry.ts",
            "enabled": true
        }
    }
}
```

---

### 7. Local Logging and Batch Upload

#### Local Buffer File Format

Store events in JSONL format at `~/.local/share/atomic/telemetry-events.jsonl`:

```jsonl
{"anonymousId":"a1b2c3d4-...","sessionId":"sess-5678-...","eventType":"agent_session","sessionStartedAt":"2026-01-21T10:00:00Z","timestamp":"2026-01-21T10:30:00Z","agentType":"claude","commands":["/research-codebase","/create-spec"],"commandCount":2,"platform":"darwin"}
{"anonymousId":"a1b2c3d4-...","sessionId":"sess-9abc-...","eventType":"agent_session","sessionStartedAt":"2026-01-21T11:00:00Z","timestamp":"2026-01-21T11:45:00Z","agentType":"opencode","commands":["/implement-feature","/commit"],"commandCount":2,"platform":"linux"}
```

**Key Points:**

- Each line is a complete session with all commands used
- Only command names are stored - no prompts, arguments, or file paths
- Anonymous ID links sessions but cannot identify users
- Platform is generalized (darwin/linux/win32)

#### Batch Upload Implementation

```typescript
// src/utils/telemetry-upload.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { getBinaryDataDir } from "./config-path";

const LOCAL_LOG = join(getBinaryDataDir(), "telemetry-events.jsonl");
const UPLOAD_ENDPOINT =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    "https://your-collector.example.com/v1/traces";

export async function uploadTelemetryBatch(): Promise<void> {
    if (!existsSync(LOCAL_LOG)) return;

    const events = readFileSync(LOCAL_LOG, "utf-8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

    if (events.length === 0) return;

    try {
        const response = await fetch(UPLOAD_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events }),
            signal: AbortSignal.timeout(5000), // 5 second timeout
        });

        if (response.ok) {
            unlinkSync(LOCAL_LOG); // Clear on success
        }
    } catch {
        // Fail silently - retry next time
    }
}
```

---

### 8. OpenTelemetry Collector Configuration

#### Recommended Collector Setup

```yaml
# otel-collector-config.yaml
receivers:
    otlp:
        protocols:
            http:
                endpoint: 0.0.0.0:4318

processors:
    batch:
        send_batch_size: 1000
        timeout: 10s

    # Privacy: Remove any accidental PII
    attributes/privacy:
        actions:
            - key: user.ip
              action: delete
            - key: user.email
              action: delete
            - key: file.path
              action: delete

exporters:
    # Option 1: Azure Monitor
    azuremonitor:
        connection_string: ${APPLICATIONINSIGHTS_CONNECTION_STRING}

    # Option 2: Grafana Cloud
    otlp/grafana:
        endpoint: https://otlp-gateway-prod-us-east-0.grafana.net/otlp
        headers:
            Authorization: Basic ${GRAFANA_CLOUD_AUTH}

service:
    pipelines:
        traces:
            receivers: [otlp]
            processors: [attributes/privacy, batch]
            exporters: [azuremonitor] # or otlp/grafana
```

---

### 9. Backend Options Comparison

| Backend           | Pricing             | OTLP Support                   | Privacy Features          | Recommendation                  |
| ----------------- | ------------------- | ------------------------------ | ------------------------- | ------------------------------- |
| **Azure Monitor** | $2.30-2.76/GB       | Via Azure OpenTelemetry Distro | Good compliance tools     | Good for existing Azure users   |
| **Grafana Cloud** | Free tier + usage   | Native OTLP                    | Open-source, no lock-in   | **Recommended** for flexibility |
| **Honeycomb**     | Usage-based         | Native OTLP                    | High-cardinality analysis | Good for debugging              |
| **Self-hosted**   | Infrastructure cost | Full control                   | Maximum privacy           | For high-security needs         |

**Recommendation:** Grafana Cloud provides a good balance of:

- Native OTLP support (no vendor SDK required)
- Free tier for getting started
- Open-source foundations (no lock-in)
- Strong privacy controls

---

### 10. Opt-In/Opt-Out Implementation

#### Multiple Opt-Out Methods (Industry Standard)

1. **Environment Variable** (highest priority):

    ```bash
    export ATOMIC_TELEMETRY=0
    # or
    export DO_NOT_TRACK=1
    ```

2. **CLI Command**:

    ```bash
    atomic config set telemetry false
    atomic config set telemetry true
    ```

3. **Config File** (`~/.local/share/atomic/telemetry.json`):
    ```json
    {
        "enabled": false,
        "consentGiven": true,
        "anonymousId": "..."
    }
    ```

#### First-Run Consent (GDPR Compliance)

```typescript
// In initCommand or first run
import { confirm } from "@clack/prompts";

async function promptTelemetryConsent(): Promise<boolean> {
    console.log(`
Atomic collects anonymous usage data to improve the product.

What we collect:
  - Command names (e.g., "init", "/research-codebase")
  - Agent type (e.g., "claude", "copilot")
  - Success/failure status

What we NEVER collect:
  - Your prompts or file contents
  - File paths or project names
  - IP addresses or personal information

You can opt out anytime with: ATOMIC_TELEMETRY=0
  `);

    const consent = await confirm({
        message: "Help improve Atomic by enabling anonymous telemetry?",
        initialValue: true,
    });

    return consent === true;
}
```

---

## Architecture Documentation

### Current Architecture (No Telemetry)

```
User Command: atomic --agent claude -- /research-codebase
                │
                ▼
        src/index.ts:main()
                │
                ▼
        src/commands/run-agent.ts
                │
                ▼
        Bun.spawn(claude, ["/research-codebase"])
                │
                ▼
        Claude Code reads .claude/commands/research-codebase.md
                │
                ▼
        [sessionStart hook] → start-ralph-session.sh
                │
                ▼
        [Session runs...]
                │
                ▼
        [sessionEnd hook] → stop-hook.sh
```

### Proposed Architecture (With Telemetry)

```
User Command: atomic --agent claude -- /research-codebase
                │
                ▼
        src/index.ts:main()
                │
        ┌───────┴───────┐
        │               │
        ▼               ▼
  Track Command    src/commands/run-agent.ts
  (cli_command)           │
        │                 ▼
        │         Bun.spawn(claude, [...])
        │                 │
        ▼                 ▼
  ~/.local/share/  [sessionStart hook]
  atomic/          telemetry-hook.sh ──► Track agent_session_start
  telemetry-       (agent_session_start)    │
  events.jsonl              │               ▼
        ▲                   ▼         ~/.local/share/atomic/
        │           [Session runs...]  telemetry-events.jsonl
        │                   │
        │                   ▼
        │           [sessionEnd hook]
        │           telemetry-hook.sh ──► Track agent_session_end
        │           (agent_session_end)
        │
        └───────── Batch Upload (async, on next CLI run)
                        │
                        ▼
              OpenTelemetry Collector
                        │
                        ▼
              Backend (Grafana Cloud / Azure Monitor)
```

---

## Code References

| File                             | Line(s) | Description                   |
| -------------------------------- | ------- | ----------------------------- |
| `install.sh`                     | 11-12   | DATA_DIR definition           |
| `install.ps1`                    | 16-17   | Windows DATA_DIR definition   |
| `src/utils/config-path.ts`       | 54-64   | `getBinaryDataDir()` function |
| `src/index.ts`                   | 87-243  | Main CLI entry point          |
| `src/commands/run-agent.ts`      | 58-129  | Agent execution               |
| `src/config.ts`                  | 29-70   | Agent configuration           |
| `.github/hooks/hooks.json`       | 1-23    | Hook configuration            |
| `.github/hooks/stop-hook.sh`     | 1-207   | Hook implementation example   |
| `plugins/ralph/hooks/hooks.json` | 1-15    | Claude Code hook format       |

---

## Open Questions

1. **Consent Timing**: Should consent be requested during `atomic init` or on first `atomic --agent` run?

2. **npm Installation**: For npm-installed Atomic, should telemetry state be global (`~/.local/share/atomic/`) or per-project?

3. **Batch Upload Trigger**: Should batch upload happen:
    - On every CLI invocation (adds latency)?
    - Only on specific commands like `atomic init` or `atomic update`?
    - Via a separate `atomic telemetry upload` command?

4. **Retention Policy**: How long should local telemetry logs be retained before deletion (7 days? 30 days?)?

5. **OpenCode and Copilot Hooks**: The hook system differs per agent. Need to confirm OpenCode's hook format and whether Copilot CLI supports custom hooks.

---

## Related Research

- [OpenTelemetry JavaScript Documentation](https://opentelemetry.io/docs/languages/js/)
- [OpenTelemetry Collector Configuration](https://opentelemetry.io/docs/collector/configuration/)
- [VS Code Telemetry Implementation](https://code.visualstudio.com/docs/configure/telemetry)
- [Yarn Telemetry Privacy Design](https://yarnpkg.com/advanced/telemetry)
- [Next.js Telemetry](https://nextjs.org/telemetry)
- [GDPR Telemetry Requirements](https://www.activemind.legal/guides/telemetry-data/)

---

## Implementation Roadmap

### Phase 1: Foundation

- [ ] Create `src/utils/telemetry.ts` with anonymous ID generation
- [ ] Add `telemetry.json` creation to install scripts
- [ ] Implement opt-in/opt-out mechanism
- [ ] Define shared `ATOMIC_COMMANDS` list for slash command tracking

### Phase 2: Atomic CLI Command Tracking

- [ ] Create `src/utils/telemetry-cli.ts` with `trackAtomicCommand()` function
- [ ] Integrate into `src/index.ts` for `init`, `update`, `uninstall` commands
- [ ] Track which agent type is selected (claude, opencode, copilot)
- [ ] Log `atomic_command` events to `telemetry-events.jsonl`

### Phase 3: Slash Command CLI Tracking

- [ ] Add `trackCliInvocation()` function to `telemetry-cli.ts`
- [ ] Integrate into `src/commands/run-agent.ts` before `Bun.spawn()`
- [ ] Extract slash command names from `agentArgs` (not prompts/arguments)
- [ ] Log `cli_command` events to `telemetry-events.jsonl`

### Phase 4: Agent Session Tracking (Transcript Parsing)

- [ ] Create telemetry hook scripts for each agent:
    - [ ] Claude Code: `.claude/hooks/telemetry-stop.sh` (uses `transcript_path`)
    - [ ] Copilot CLI: `.github/hooks/telemetry-end.sh` (sessionEnd event)
    - [ ] OpenCode: `.opencode/plugin/telemetry.ts` (TypeScript plugin)
- [ ] Register hooks in respective configuration files
- [ ] Log `agent_session` events to `telemetry-events.jsonl`

### Phase 5: Backend Integration

- [ ] Set up OpenTelemetry Collector
- [ ] Configure Grafana Cloud or Azure Monitor backend
- [ ] Implement batch upload from local logs (all three event types)
- [ ] Add deduplication logic (same command from CLI and session)

### Phase 6: User Experience

- [ ] Add first-run consent prompt during `atomic init`
- [ ] Add `atomic config set telemetry <true|false>` command
- [ ] Document telemetry in README.md with clear privacy explanation
