# Global Config Sync Mechanism - Atomic CLI

**Date**: 2026-02-25  
**Analysis Type**: Implementation Documentation  
**Focus**: How global config synchronization works in Atomic CLI

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Utilities Analysis](#core-utilities-analysis)
4. [Config Path Resolution](#config-path-resolution)
5. [Global Config Sync Process](#global-config-sync-process)
6. [Directory Structure](#directory-structure)
7. [Runtime Config Loading](#runtime-config-loading)
8. [Agent Detection and Config Usage](#agent-detection-and-config-usage)
9. [Installation Types](#installation-types)
10. [Data Flow Diagrams](#data-flow-diagrams)

---

## Overview

The Atomic CLI uses a sophisticated global config sync mechanism to provide baseline agent configurations, skills, and MCP server configs across all agents (Claude, OpenCode, Copilot). The system synchronizes templates from the installation source to `~/.atomic/` and merges them with project-specific and user-specific configurations at runtime.

**Key Design Principles**:

- **Separation of Concerns**: Global defaults (in `~/.atomic/`) vs. project-local configs (in `.claude/`, `.opencode/`, `.github/`)
- **SCM-Specific Skills Management**: GitHub/Git vs. Sapling/Phabricator skills are managed per-project, not globally
- **Multi-Source Config Resolution**: Configs overlay from multiple sources with clear precedence rules
- **Installation Type Flexibility**: Works across source, npm, and binary installations

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Atomic CLI Config System                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────┐  │
│  │ Config Root  │───▶│ Sync Engine  │───▶│ ~/.atomic/      │  │
│  │ Detection    │    │              │    │ (Global Store)  │  │
│  └──────────────┘    └──────────────┘    └─────────────────┘  │
│         │                     │                    │            │
│         │                     │                    │            │
│  ┌──────▼──────────────────────▼────────────────────▼────────┐ │
│  │             Runtime Config Resolution                      │ │
│  │  (Merges global + user + project configs per agent)       │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Utilities Analysis

### 1. `src/utils/atomic-global-config.ts`

This is the heart of the global config sync system. Let me document every function:

#### Constants and Configuration

**Lines 8-34**: Core configuration constants

```typescript
const ATOMIC_HOME_DIR = join(homedir(), ".atomic");
```

- **Purpose**: Defines the global Atomic home directory at `~/.atomic`
- **Usage**: All global configs are stored here

```typescript
export const MANAGED_SCM_SKILL_PREFIXES = ["gh-", "sl-"] as const;
```

- **Purpose**: Defines which skill name prefixes are SCM-managed
- **Usage**: Used to identify and exclude SCM skills during global sync
- **Pattern**: `gh-*` for GitHub/Git, `sl-*` for Sapling/Phabricator

```typescript
const GLOBAL_AGENT_FOLDER_BY_KEY: Record<AgentKey, string> = {
    claude: ".claude",
    opencode: ".opencode",
    copilot: ".copilot",
};
```

- **Purpose**: Maps agent keys to their global folder names in `~/.atomic/`
- **Usage**: Used by sync functions to determine destination directories

```typescript
const TEMPLATE_AGENT_FOLDER_BY_KEY: Record<AgentKey, string> = {
    claude: AGENT_CONFIG.claude.folder, // ".claude"
    opencode: AGENT_CONFIG.opencode.folder, // ".opencode"
    copilot: AGENT_CONFIG.copilot.folder, // ".github"
};
```

- **Purpose**: Maps agent keys to their template source folder names
- **Usage**: Used to locate template configs in the config root
- **Note**: Copilot templates come from `.github/` but sync to `.copilot/` globally

```typescript
const REQUIRED_GLOBAL_CONFIG_ENTRIES: Record<AgentKey, string[]> = {
    claude: ["agents", "skills", "settings.json"],
    opencode: ["agents", "skills", "opencode.json"],
    copilot: ["agents", "skills"],
};
```

- **Purpose**: Defines required files/folders for a complete global config per agent
- **Usage**: Used by `hasAtomicGlobalAgentConfigs()` to validate completeness

```typescript
const REQUIRED_ATOMIC_HOME_ENTRIES = [
    ".mcp.json",
    join(".copilot", "mcp-config.json"),
] as const;
```

- **Purpose**: Defines required MCP config files in `~/.atomic/`
- **Usage**: Additional validation check for complete global config

#### Public Functions

##### `getAtomicHomeDir()` (line 39)

```typescript
export function getAtomicHomeDir(): string {
    return ATOMIC_HOME_DIR;
}
```

- **Purpose**: Returns the path to `~/.atomic/`
- **Implementation**: Simple constant accessor
- **Returns**: `"/home/user/.atomic"` (Unix) or `"C:\Users\user\.atomic"` (Windows)
- **Usage**: Called by external modules needing the global home directory

##### `getAtomicManagedConfigDirs()` (line 46)

```typescript
export function getAtomicManagedConfigDirs(
    baseDir: string = ATOMIC_HOME_DIR,
): string[] {
    return [
        join(baseDir, GLOBAL_AGENT_FOLDER_BY_KEY.claude),
        join(baseDir, GLOBAL_AGENT_FOLDER_BY_KEY.opencode),
        join(baseDir, GLOBAL_AGENT_FOLDER_BY_KEY.copilot),
    ];
}
```

- **Purpose**: Returns array of all agent config directories in `~/.atomic/`
- **Parameters**: Optional `baseDir` override (for testing)
- **Returns**: Array of 3 paths: `[~/.atomic/.claude, ~/.atomic/.opencode, ~/.atomic/.copilot]`
- **Usage**: Used to enumerate all managed directories

##### `getAtomicGlobalAgentFolder()` (line 57)

```typescript
export function getAtomicGlobalAgentFolder(agentKey: AgentKey): string {
    return GLOBAL_AGENT_FOLDER_BY_KEY[agentKey];
}
```

- **Purpose**: Returns the folder name for a specific agent in `~/.atomic/`
- **Parameters**: `agentKey` - one of `"claude"`, `"opencode"`, `"copilot"`
- **Returns**: Folder name like `".claude"` (relative name only, not full path)
- **Usage**: Building paths dynamically based on agent key

##### `getTemplateAgentFolder()` (line 64)

```typescript
export function getTemplateAgentFolder(agentKey: AgentKey): string {
    return TEMPLATE_AGENT_FOLDER_BY_KEY[agentKey];
}
```

- **Purpose**: Returns the source folder name for agent templates
- **Parameters**: `agentKey` - agent to look up
- **Returns**: Source folder name (e.g., `".claude"`, `".github"`)
- **Usage**: Locating template configs during sync

##### `isManagedScmSkillName()` (line 71)

```typescript
export function isManagedScmSkillName(name: string): boolean {
    return MANAGED_SCM_SKILL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
```

- **Purpose**: Checks if a skill name is SCM-managed (starts with `gh-` or `sl-`)
- **Parameters**: `name` - skill directory name
- **Returns**: `true` if name starts with `gh-` or `sl-`
- **Implementation**: Uses `Array.some()` to check against both prefixes
- **Usage**: Filtering skills during sync and project init

##### `pruneManagedScmSkills()` (line 78, private)

```typescript
async function pruneManagedScmSkills(agentDir: string): Promise<void> {
    const skillsDir = join(agentDir, "skills");
    if (!(await pathExists(skillsDir))) return;

    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!isManagedScmSkillName(entry.name)) continue;
        await rm(join(skillsDir, entry.name), { recursive: true, force: true });
    }
}
```

- **Purpose**: Removes all SCM-managed skill variants from a destination directory
- **Parameters**: `agentDir` - path to agent config directory
- **Implementation**:
    1. Check if `skills/` subdirectory exists (line 80)
    2. Read all entries in `skills/` (line 82)
    3. For each directory entry (line 84)
    4. Skip if not SCM-managed (line 85)
    5. Delete the skill directory recursively (line 86)
- **Usage**: Cleanup during global sync to ensure SCM skills don't pollute global configs
- **Rationale**: SCM skills are project-specific, not global

##### `getManagedScmSkillExcludes()` (line 93, private)

```typescript
async function getManagedScmSkillExcludes(
    sourceDir: string,
): Promise<string[]> {
    const skillsDir = join(sourceDir, "skills");
    if (!(await pathExists(skillsDir))) return [];

    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
        .filter(
            (entry) => entry.isDirectory() && isManagedScmSkillName(entry.name),
        )
        .map((entry) => join("skills", entry.name));
}
```

- **Purpose**: Builds list of relative paths for SCM skills to exclude during copy
- **Parameters**: `sourceDir` - source agent config directory
- **Returns**: Array of relative paths like `["skills/gh-commit", "skills/sl-commit"]`
- **Implementation**:
    1. Check if source `skills/` exists (line 95)
    2. Read all entries (line 97)
    3. Filter to directories with SCM-managed names (line 98-99)
    4. Map to relative paths (line 100)
- **Usage**: Building exclude list for `copyDir()` during global sync

##### `syncAtomicGlobalMcpConfigs()` (line 106, private)

```typescript
async function syncAtomicGlobalMcpConfigs(
    configRoot: string,
    baseDir: string,
): Promise<void> {
    const claudeMcpSource = join(configRoot, ".mcp.json");
    const claudeMcpDestination = join(baseDir, ".mcp.json");
    if (await pathExists(claudeMcpSource)) {
        await copyFile(claudeMcpSource, claudeMcpDestination);
    }

    const copilotMcpSource = join(
        configRoot,
        AGENT_CONFIG.copilot.folder,
        "mcp-config.json",
    );
    const copilotMcpDestination = join(
        baseDir,
        GLOBAL_AGENT_FOLDER_BY_KEY.copilot,
        "mcp-config.json",
    );
    if (await pathExists(copilotMcpSource)) {
        await mkdir(join(baseDir, GLOBAL_AGENT_FOLDER_BY_KEY.copilot), {
            recursive: true,
        });
        await copyFile(copilotMcpSource, copilotMcpDestination);
    }
}
```

- **Purpose**: Syncs MCP server configs from templates to `~/.atomic/`
- **Parameters**:
    - `configRoot` - source directory (from `getConfigRoot()`)
    - `baseDir` - destination directory (typically `~/.atomic/`)
- **Implementation**:
    1. **Claude MCP Config** (lines 107-111):
        - Source: `<configRoot>/.mcp.json`
        - Destination: `~/.atomic/.mcp.json`
        - Only copies if source exists
    2. **Copilot MCP Config** (lines 113-118):
        - Source: `<configRoot>/.github/mcp-config.json`
        - Destination: `~/.atomic/.copilot/mcp-config.json`
        - Creates parent directory if needed (line 116)
        - Only copies if source exists
- **Usage**: Called by `syncAtomicGlobalAgentConfigs()` at line 150

##### `syncAtomicGlobalAgentConfigs()` (line 128) **[MAIN SYNC FUNCTION]**

```typescript
export async function syncAtomicGlobalAgentConfigs(
    configRoot: string,
    baseDir: string = ATOMIC_HOME_DIR,
): Promise<void>;
```

- **Purpose**: Main function to sync all agent configs from templates to `~/.atomic/`
- **Parameters**:
    - `configRoot` - source directory containing templates
    - `baseDir` - destination (defaults to `~/.atomic/`)
- **Implementation** (lines 132-151):
    1. **Create base directory** (line 132):
        ```typescript
        await mkdir(baseDir, { recursive: true });
        ```

        - Ensures `~/.atomic/` exists
    2. **Iterate all agent keys** (lines 134-148):

        ```typescript
        const agentKeys = Object.keys(AGENT_CONFIG) as AgentKey[];
        for (const agentKey of agentKeys) {
            const sourceFolder = join(
                configRoot,
                getTemplateAgentFolder(agentKey),
            );
            if (!(await pathExists(sourceFolder))) continue;

            const destinationFolder = join(
                baseDir,
                getAtomicGlobalAgentFolder(agentKey),
            );
            const scmSkillExcludes =
                await getManagedScmSkillExcludes(sourceFolder);

            await copyDir(sourceFolder, destinationFolder, {
                exclude: [
                    ...AGENT_CONFIG[agentKey].exclude,
                    ...scmSkillExcludes,
                ],
            });

            await pruneManagedScmSkills(destinationFolder);
        }
        ```

        - For each agent (claude, opencode, copilot):
            - Locate source templates (line 136)
            - Skip if source doesn't exist (line 137)
            - Build destination path (line 139)
            - Get SCM skills to exclude (line 140)
            - Copy directory with combined exclusions (lines 142-144)
            - Remove any stale SCM skills (line 147)

    3. **Sync MCP configs** (line 150):
        ```typescript
        await syncAtomicGlobalMcpConfigs(configRoot, baseDir);
        ```

- **Key Behaviors**:
    - **Excludes SCM skills**: `gh-*` and `sl-*` skills are never synced globally
    - **Respects agent-specific exclusions**: Each agent has its own exclude list from `AGENT_CONFIG`
    - **Prunes stale skills**: Ensures old SCM skills from previous installs are removed
- **Usage**: Called by:
    - `postinstall.ts` at line 17
    - `update.ts` at line 258
    - `init.ts` at line 366 (via `ensureAtomicGlobalAgentConfigs()`)
    - `chat.ts` at line 218 (via `ensureAtomicGlobalAgentConfigs()`)

##### `hasAtomicGlobalAgentConfigs()` (line 156)

```typescript
export async function hasAtomicGlobalAgentConfigs(
    baseDir: string = ATOMIC_HOME_DIR,
): Promise<boolean>;
```

- **Purpose**: Checks if complete global configs exist in `~/.atomic/`
- **Parameters**: Optional `baseDir` override (for testing)
- **Returns**: `true` if all required configs are present
- **Implementation** (lines 159-182):
    1. **Check each agent** (lines 160-173):

        ```typescript
        const agentKeys = Object.keys(AGENT_CONFIG) as AgentKey[];
        for (const agentKey of agentKeys) {
            const agentDir = join(
                baseDir,
                getAtomicGlobalAgentFolder(agentKey),
            );
            if (!(await pathExists(agentDir))) return false;

            const requiredEntries = REQUIRED_GLOBAL_CONFIG_ENTRIES[agentKey];
            const entryChecks = await Promise.all(
                requiredEntries.map((entryName) =>
                    pathExists(join(agentDir, entryName)),
                ),
            );

            if (entryChecks.some((exists) => !exists)) {
                return false;
            }
        }
        ```

        - Verify agent directory exists (line 163)
        - Check all required entries for that agent (lines 165-172)
        - Return `false` if any required entry is missing

    2. **Check atomic home entries** (lines 175-180):
        ```typescript
        const atomicHomeChecks = await Promise.all(
            REQUIRED_ATOMIC_HOME_ENTRIES.map((entryName) =>
                pathExists(join(baseDir, entryName)),
            ),
        );
        if (atomicHomeChecks.some((exists) => !exists)) {
            return false;
        }
        ```

        - Verify MCP configs exist

- **Usage**: Used to determine if sync is needed
- **Called by**:
    - `ensureAtomicGlobalAgentConfigs()` at line 192
    - `postinstall.ts` at line 10 (for verification)
    - Tests

##### `ensureAtomicGlobalAgentConfigs()` (line 188)

```typescript
export async function ensureAtomicGlobalAgentConfigs(
    configRoot: string,
    baseDir: string = ATOMIC_HOME_DIR,
): Promise<void> {
    if (await hasAtomicGlobalAgentConfigs(baseDir)) return;
    await syncAtomicGlobalAgentConfigs(configRoot, baseDir);
}
```

- **Purpose**: Ensures global configs exist, syncing only if needed
- **Parameters**: Same as `syncAtomicGlobalAgentConfigs()`
- **Implementation**:
    1. Check if configs already exist (line 192)
    2. If not, perform sync (line 193)
- **Optimization**: Skips sync if configs are already present
- **Usage**: Called at runtime by:
    - `init.ts` at line 366 (before configuring project)
    - `chat.ts` at line 218 (before starting chat)

---

## Config Path Resolution

### 2. `src/utils/config-path.ts`

This module handles the critical task of determining where config templates are stored based on installation type.

#### Installation Type Detection

##### `detectInstallationType()` (line 29)

```typescript
export function detectInstallationType(): InstallationType {
    const dir = import.meta.dir;

    // Bun compiled executables use a virtual filesystem with '$bunfs' prefix
    // On Windows this can manifest as drive letters like 'B:\' when navigating up
    if (
        dir.includes("$bunfs") ||
        dir.startsWith("B:\\") ||
        dir.startsWith("b:\\")
    ) {
        return "binary";
    }

    // Check for node_modules in path (npm/bun installed)
    if (dir.includes("node_modules")) {
        return "npm";
    }

    // Default to source (development mode)
    return "source";
}
```

- **Purpose**: Detects how the CLI was installed
- **Returns**: One of `"source"`, `"npm"`, or `"binary"`
- **Detection Logic**:
    1. **Binary** (lines 34-36):
        - Bun compiled executables use virtual filesystem `$bunfs`
        - Windows may show as `B:\` or `b:\` drive letter
    2. **npm** (lines 38-41):
        - Path contains `node_modules` (npm/bun global install)
    3. **source** (line 44):
        - Default for development (running from source code)
- **Implementation Detail**: Uses `import.meta.dir` which provides the directory of the current module
- **Usage**: Called by `getConfigRoot()` to determine config location

##### `getBinaryDataDir()` (line 54)

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

- **Purpose**: Returns the data directory for binary installations
- **Implementation**:
    - **Windows** (lines 56-58):
        - Uses `%LOCALAPPDATA%\atomic` (e.g., `C:\Users\user\AppData\Local\atomic`)
        - Falls back to `%USERPROFILE%\AppData\Local\atomic`
    - **Unix** (lines 61-63):
        - Follows XDG Base Directory spec
        - Uses `$XDG_DATA_HOME/atomic` or defaults to `~/.local/share/atomic`
- **Usage**: Called by `getConfigRoot()` for binary installs
- **Rationale**: Binary installations can't access source files, so configs are extracted to a data directory

##### `getConfigRoot()` (line 77) **[CRITICAL PATH RESOLVER]**

```typescript
export function getConfigRoot(): string {
    const installType = detectInstallationType();

    if (installType === "binary") {
        const dataDir = getBinaryDataDir();

        if (!existsSync(dataDir)) {
            throw new Error(
                `Config data directory not found: ${dataDir}\n\n` +
                    `This usually means the installation is incomplete.\n` +
                    `Please reinstall using the install script:\n` +
                    `  curl -fsSL https://raw.githubusercontent.com/bastani/atomic/main/install.sh | bash`,
            );
        }

        return dataDir;
    }

    // For source and npm installs, navigate up from the current file
    // src/utils/config-path.ts -> ../.. -> src -> .. -> package/repo root
    return join(import.meta.dir, "..", "..");
}
```

- **Purpose**: Returns the root directory where config templates are stored
- **Returns**: Absolute path to config root
- **Implementation by Install Type**:
    1. **Binary** (lines 80-93):
        - Returns data directory (e.g., `~/.local/share/atomic`)
        - Validates directory exists
        - Throws helpful error if missing
    2. **Source/npm** (lines 96-98):
        - Navigates up from current file location
        - Path calculation: `src/utils/config-path.ts` → `../..` → package root
        - Example result: `/home/user/projects/playwright-cli`
- **Usage**: Called by all sync operations to locate source templates
- **Error Handling**: Provides clear reinstall instructions for corrupted binary installs

##### Helper Functions

```typescript
export function configDataDirExists(): boolean; // line 105
export function getBinaryInstallDir(): string; // line 127
export function getBinaryPath(): string; // line 149
```

- **Purpose**: Additional utilities for binary installation management
- **Not directly related to config sync**, but used by update/install commands

---

## Global Config Sync Process

### 3. `src/scripts/postinstall.ts`

This script runs automatically after npm/bun package installation.

```typescript
async function main(): Promise<void> {
    try {
        await syncAtomicGlobalAgentConfigs(getConfigRoot());
        await verifyAtomicGlobalConfigSync();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `[atomic] Warning: failed to sync ~/.atomic global configs: ${message}`,
        );
    }
}
```

**Execution Flow** (lines 15-26):

1. **Sync configs** (line 17):
    - Calls `syncAtomicGlobalAgentConfigs(getConfigRoot())`
    - Resolves config root based on install type
    - Syncs all templates to `~/.atomic/`

2. **Verify sync** (line 18):
    - Calls `verifyAtomicGlobalConfigSync()`
    - Checks that all required configs exist (lines 9-13)
    - Throws error if verification fails

3. **Error Handling** (lines 19-22):
    - Catches all errors during sync
    - Logs warning but doesn't fail installation
    - **Design Decision**: Non-blocking so package installation succeeds even if sync fails

**When It Runs**:

- During `npm install -g @bastani/atomic`
- During `bun install -g @bastani/atomic`
- **NOT for binary installs** (binary installs use different mechanism)

---

## Directory Structure

### Expected `~/.atomic/` Structure After Sync

```
~/.atomic/
├── .mcp.json                          # Claude MCP config (HTTP servers like deepwiki)
├── settings.json                      # User preferences (optional, not synced)
│
├── .claude/                           # Claude global configs
│   ├── agents/                        # Custom agent definitions
│   │   ├── codebase-analyzer.md
│   │   ├── codebase-locator.md
│   │   ├── codebase-online-researcher.md
│   │   ├── codebase-pattern-finder.md
│   │   ├── codebase-research-analyzer.md
│   │   ├── codebase-research-locator.md
│   │   ├── debugger.md
│   │   ├── reviewer.md
│   │   └── worker.md
│   ├── skills/                        # Global skills (NO SCM skills)
│   │   ├── create-spec/
│   │   │   └── SKILL.md
│   │   ├── explain-code/
│   │   │   └── SKILL.md
│   │   ├── frontend-design/
│   │   │   └── SKILL.md
│   │   ├── init/
│   │   │   └── SKILL.md
│   │   ├── prompt-engineer/
│   │   │   ├── references/
│   │   │   └── SKILL.md
│   │   ├── research-codebase/
│   │   │   └── SKILL.md
│   │   └── testing-anti-patterns/
│   │       └── SKILL.md
│   └── settings.json                  # Claude-specific settings
│
├── .opencode/                         # OpenCode global configs
│   ├── agents/                        # Same agent set as Claude
│   │   ├── codebase-analyzer.md
│   │   ├── ... (same 9 agents)
│   │   └── worker.md
│   ├── skills/                        # Same global skills (NO SCM skills)
│   │   ├── create-spec/
│   │   ├── ... (same 7 skills)
│   │   └── testing-anti-patterns/
│   ├── opencode.json                  # OpenCode configuration
│   ├── package.json                   # OpenCode SDK dependencies
│   ├── bun.lock
│   └── node_modules/                  # OpenCode SDK packages
│       ├── @opencode-ai/
│       └── zod/
│
└── .copilot/                          # Copilot global configs
    ├── agents/                        # Same agent set as others
    │   ├── codebase-analyzer.md
    │   ├── ... (same 9 agents)
    │   └── worker.md
    ├── skills/                        # Same global skills (NO SCM skills)
    │   ├── create-spec/
    │   ├── ... (same 7 skills)
    │   └── testing-anti-patterns/
    └── mcp-config.json                # Copilot MCP config
```

### What's Inside Each Directory

#### `~/.atomic/.claude/`

- **agents/**: 9 custom agent definitions (codebase-analyzer, debugger, worker, etc.)
- **skills/**: 7 global skills (create-spec, explain-code, frontend-design, init, prompt-engineer, research-codebase, testing-anti-patterns)
- **settings.json**: Claude-specific settings (permissions, etc.)
- **Excluded**: `gh-*` and `sl-*` skills (project-specific)

#### `~/.atomic/.opencode/`

- **agents/**: Same 9 agents as Claude
- **skills/**: Same 7 global skills as Claude
- **opencode.json**: OpenCode SDK configuration
- **node_modules/**: OpenCode SDK packages (@opencode-ai/plugin, @opencode-ai/sdk, zod)
- **package.json**, **bun.lock**: Dependency management for OpenCode SDK
- **Excluded**: node_modules during sync (from `AGENT_CONFIG.opencode.exclude` at `src/config.ts:47-52`)

#### `~/.atomic/.copilot/`

- **agents/**: Same 9 agents as others
- **skills/**: Same 7 global skills as others
- **mcp-config.json**: Copilot MCP server configuration
- **Note**: Template source is `.github/` but syncs to `.copilot/` globally

#### `~/.atomic/.mcp.json`

- **Purpose**: Claude MCP server configuration (shared with project `.mcp.json`)
- **Format**: `{ "mcpServers": { "<name>": { "type": "http", "url": "...", ... } } }`
- **Example Content**:
    ```json
    {
        "mcpServers": {
            "deepwiki": {
                "type": "http",
                "url": "https://mcp.deepwiki.com/mcp",
                "tools": ["ask_question"]
            }
        }
    }
    ```

#### `~/.atomic/.copilot/mcp-config.json`

- **Purpose**: Copilot-specific MCP server configuration
- **Format**: Same as Claude MCP config
- **Separate from Claude** to support Copilot-specific MCP servers

### What's NOT in `~/.atomic/`

**SCM-Specific Skills** (managed per-project, not globally):

- `gh-commit/` - GitHub commit skill
- `gh-create-pr/` - GitHub PR creation skill
- `sl-commit/` - Sapling commit skill
- `sl-submit-diff/` - Sapling diff submission skill

**Rationale**: SCM skills depend on project-specific source control configuration, so they're installed per-project during `atomic init`.

---

## Runtime Config Loading

### How Configs Are Used at Runtime

#### 1. Chat Command (`src/commands/chat.ts`)

**Entry Point**: `chatCommand()` at line 196

**Config Loading Flow**:

1. **Ensure global configs exist** (lines 216-218):

    ```typescript
    if (detectInstallationType() !== "source") {
        await ensureAtomicGlobalAgentConfigs(getConfigRoot());
    }
    ```

    - Skipped for source installs (assumes configs are in place)
    - For npm/binary installs, ensures `~/.atomic/` is populated
    - Non-blocking: if sync fails, continues anyway

2. **OpenCode-specific config preparation** (lines 220-225):

    ```typescript
    if (agentType === "opencode") {
        const mergedConfigDir = await prepareOpenCodeConfigDir({ projectRoot });
        if (mergedConfigDir) {
            process.env.OPENCODE_CONFIG_DIR = mergedConfigDir;
        }
    }
    ```

    - Builds merged config directory at `~/.atomic/.tmp/opencode-config-merged/`
    - Precedence: `~/.atomic/.opencode` < `~/.config/opencode` < `~/.opencode` < `<project>/.opencode`
    - Sets `OPENCODE_CONFIG_DIR` environment variable for OpenCode SDK

3. **Auto-init if SCM skills missing** (lines 228-237):
    ```typescript
    if (await shouldAutoInitChat(agentType, projectRoot)) {
        await initCommand({
            showBanner: false,
            preSelectedAgent: agentType,
            configNotFoundMessage,
        });
    }
    ```

    - Checks if project has SCM skills (line 117-132)
    - If missing, triggers interactive init flow
    - Copies SCM skills from global templates to project

#### 2. Init Command (`src/commands/init.ts`)

**Entry Point**: `initCommand()` at line 194

**Config Loading Flow**:

1. **User selects agent and SCM type** (lines 216-286)
    - Interactive prompts for agent (claude/opencode/copilot) and SCM (github/sapling)

2. **Ensure global configs** (lines 361-367):

    ```typescript
    const configRoot = getConfigRoot();
    if (detectInstallationType() !== "source") {
        await ensureAtomicGlobalAgentConfigs(configRoot);
    }
    ```

    - Same logic as chat command

3. **Sync project SCM skills** (lines 369-383):

    ```typescript
    const templateAgentFolder = getTemplateAgentFolder(agentKey);
    const sourceSkillsDir = join(configRoot, templateAgentFolder, "skills");
    const targetSkillsDir = join(targetFolder, "skills");

    const copiedCount = await syncProjectScmSkills({
        scmType,
        sourceSkillsDir,
        targetSkillsDir,
    });
    ```

    - Copies **only** SCM-specific skills matching selected SCM type
    - E.g., if `scmType === "github"`, copies `gh-commit/` and `gh-create-pr/`
    - Function `syncProjectScmSkills()` at lines 165-189

4. **Reconcile SCM variants** (lines 386-392):

    ```typescript
    await reconcileScmVariants({
        scmType,
        agentFolder: agent.folder,
        skillsSubfolder: "skills",
        targetDir,
        configRoot,
    });
    ```

    - Removes stale SCM skills from unselected SCM type
    - E.g., if switching from Sapling to GitHub, removes `sl-*` skills
    - Function `reconcileScmVariants()` at lines 78-112

5. **Save config** (lines 395-398):
    ```typescript
    await saveAtomicConfig(targetDir, {
        scm: scmType,
        agent: agentKey,
    });
    ```

    - Persists selection to `.atomic/settings.json` in project root

### MCP Config Discovery (`src/utils/mcp-config.ts`)

**Entry Point**: `discoverMcpConfigs()` at line 148

**Discovery Process**:

1. **User-level configs** (lines 160-164):

    ```typescript
    addSources(
        parseClaudeMcpConfig(join(homeDir, ".claude", ".mcp.json")),
        "claude",
    );
    addSources(
        parseCopilotMcpConfig(join(homeDir, ".copilot", "mcp-config.json")),
        "copilot",
    );
    addSources(
        parseOpenCodeMcpConfig(join(homeDir, ".opencode", "opencode.json")),
        "opencode",
    );
    ```

    - Loads from `~/.claude/.mcp.json`, `~/.copilot/mcp-config.json`, `~/.opencode/opencode.json`

2. **Project-level configs** (lines 167-174):

    ```typescript
    addSources(parseClaudeMcpConfig(join(projectRoot, ".mcp.json")), "claude");
    addSources(
        parseCopilotMcpConfig(join(projectRoot, ".github", "mcp-config.json")),
        "copilot",
    );
    addSources(
        parseOpenCodeMcpConfig(join(projectRoot, "opencode.json")),
        "opencode",
    );
    // ... more project-level sources
    ```

3. **Deduplication with ecosystem isolation** (lines 176-185):
    ```typescript
    const byName = new Map<string, TaggedSource>();
    for (const entry of sources) {
        const existing = byName.get(entry.config.name);
        if (!existing || existing.ecosystem === entry.ecosystem) {
            byName.set(entry.config.name, entry);
        }
    }
    ```

    - Within same ecosystem (claude/opencode/copilot), project-level overrides user-level
    - Across ecosystems, configs are independent (no override)

**Result**: Unified list of MCP servers from all sources, passed to SDK clients at chat startup (line 264-272 in `chat.ts`)

---

## Agent Detection and Config Usage

### Agent Detection at Runtime

**Agent detection doesn't happen automatically** - the user explicitly selects or the config specifies the agent type.

#### Selection Methods:

1. **CLI Flag**: `atomic chat -a claude` (explicit agent selection)
2. **Saved Config**: `.atomic/settings.json` in project root stores last-used agent
3. **Auto-Init Prompt**: If no SCM skills exist, user is prompted to select agent

**No Auto-Detection Logic**: The system doesn't detect agents by inspecting installed CLI tools or config directories. The user must explicitly choose.

### How Agent Configs Are Loaded

#### Claude Code

- **Global Config**: `~/.atomic/.claude/`
- **Project Config**: `./.claude/`
- **Discovery**: Claude loads both automatically via its config system
- **Precedence**: Project config overrides global config

#### OpenCode

- **Global Config**: `~/.atomic/.opencode/`
- **User Config**: `~/.config/opencode/` (XDG standard)
- **Legacy User Config**: `~/.opencode/`
- **Project Config**: `./.opencode/`
- **Merged Config**: `~/.atomic/.tmp/opencode-config-merged/` (built at runtime)
- **Discovery**: Via `OPENCODE_CONFIG_DIR` environment variable set by chat command
- **Precedence**: Project > Legacy User > XDG User > Global (layered overlay)

#### GitHub Copilot CLI

- **Global Config**: `~/.atomic/.copilot/`
- **Project Config**: `./.github/`
- **Discovery**: Copilot uses native `--add-dir .` flag to discover `.github/agents/` and `.github/skills/`
- **Precedence**: Project config used directly, global config not auto-loaded by Copilot

---

## Installation Types

### Source Installation (Development Mode)

**Detection**: Path doesn't contain `$bunfs` or `node_modules`

**Config Root**: Repository root (e.g., `/home/user/projects/playwright-cli`)

**Characteristics**:

- Running via `bun run src/cli.ts`
- Config templates in `.claude/`, `.opencode/`, `.github/` subdirectories
- No global sync needed (templates are already accessible)
- Postinstall script still runs but operates on local directories

**Config Resolution**:

```
getConfigRoot() → /home/user/projects/playwright-cli
syncAtomicGlobalAgentConfigs(configRoot) → copies from .claude/ to ~/.atomic/.claude/
```

### npm/bun Installation

**Detection**: Path contains `node_modules`

**Config Root**: Package root in node_modules (e.g., `/usr/local/lib/node_modules/@bastani/atomic`)

**Characteristics**:

- Installed via `npm install -g @bastani/atomic` or `bun install -g @bastani/atomic`
- Config templates bundled with npm package
- Postinstall script runs automatically after install
- Syncs templates to `~/.atomic/` for global access

**Config Resolution**:

```
getConfigRoot() → /usr/local/lib/node_modules/@bastani/atomic
syncAtomicGlobalAgentConfigs(configRoot) → copies from package templates to ~/.atomic/
```

### Binary Installation

**Detection**: Path contains `$bunfs` or starts with `B:\` on Windows

**Config Root**: Data directory (Unix: `~/.local/share/atomic`, Windows: `%LOCALAPPDATA%\atomic`)

**Characteristics**:

- Installed via `install.sh` or `install.ps1` scripts
- Binary executable generated by Bun compiler
- Config templates extracted to data directory during installation
- Uses virtual filesystem (`$bunfs`) at runtime

**Config Resolution**:

```
getConfigRoot() → ~/.local/share/atomic (or %LOCALAPPDATA%\atomic on Windows)
syncAtomicGlobalAgentConfigs(configRoot) → copies from data dir to ~/.atomic/
```

**Installation Process** (see `install.sh`):

1. Download binary executable to `~/.local/bin/atomic`
2. Download config archive (`atomic-config-linux-x64.tar.gz`)
3. Extract archive to `~/.local/share/atomic/`
4. Archive contains `.claude/`, `.opencode/`, `.github/`, `.mcp.json`
5. On first run, binary syncs from data dir to `~/.atomic/`

**Update Process** (see `src/commands/update.ts`):

1. Download new binary and config archive (lines 206-218)
2. Verify checksums (lines 221-235)
3. Replace binary (lines 238-246)
4. Clean install: delete old data dir, extract new configs (lines 252-255)
5. Sync to `~/.atomic/` (line 258)

---

## Data Flow Diagrams

### Postinstall Sync Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    npm/bun install @bastani/atomic              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                   ┌─────────────────────┐
                   │  postinstall.ts     │
                   │  (automatic)        │
                   └─────────┬───────────┘
                             │
                             ▼
                ┌────────────────────────────┐
                │ getConfigRoot()            │
                │ Detect install type        │
                └────────┬───────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    "source"         "npm"          "binary"
  (repo root)  (node_modules)    (data dir)
         │               │               │
         └───────────────┴───────────────┘
                         │
                         ▼
          ┌──────────────────────────────┐
          │ syncAtomicGlobalAgentConfigs │
          └──────────┬───────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
    .claude/    .opencode/    .github/
        │            │            │
        └────────────┴────────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │ For each agent:       │
         │ 1. Get SCM excludes   │
         │ 2. copyDir()          │
         │ 3. pruneManagedScm    │
         └───────┬───────────────┘
                 │
                 ▼
         ┌────────────────┐
         │ ~/.atomic/     │
         │  ├─ .claude/   │
         │  ├─ .opencode/ │
         │  ├─ .copilot/  │
         │  └─ .mcp.json  │
         └────────────────┘
```

### Init Command Flow

```
┌─────────────────────────────────────────────────────────────────┐
│               User runs: atomic init                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                   ┌─────────────────────┐
                   │ Select Agent Type   │
                   │ (claude/opencode/   │
                   │  copilot)           │
                   └─────────┬───────────┘
                             │
                             ▼
                   ┌─────────────────────┐
                   │ Select SCM Type     │
                   │ (github/sapling)    │
                   └─────────┬───────────┘
                             │
                             ▼
        ┌────────────────────────────────────────┐
        │ ensureAtomicGlobalAgentConfigs()       │
        │ (populate ~/.atomic/ if needed)        │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ syncProjectScmSkills()                 │
        │ Copy ONLY selected SCM skills          │
        │ e.g., gh-commit/, gh-create-pr/        │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ reconcileScmVariants()                 │
        │ Remove unselected SCM skills           │
        │ e.g., remove sl-* if github selected   │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ saveAtomicConfig()                     │
        │ Save selection to .atomic/settings.json│
        └────────────┬───────────────────────────┘
                     │
                     ▼
         ┌──────────────────────────┐
         │ Project ready with:      │
         │  .claude/skills/         │
         │    ├─ gh-commit/         │
         │    └─ gh-create-pr/      │
         │ (or sl-* for Sapling)    │
         └──────────────────────────┘
```

### Chat Runtime Config Resolution

```
┌─────────────────────────────────────────────────────────────────┐
│            User runs: atomic chat -a opencode                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
        ┌────────────────────────────────────────┐
        │ ensureAtomicGlobalAgentConfigs()       │
        │ Check/populate ~/.atomic/              │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ prepareOpenCodeConfigDir()             │
        │ (OpenCode only)                        │
        └────────────┬───────────────────────────┘
                     │
           ┌─────────┴─────────┐
           ▼                   ▼
    Layer 1: Global      Layer 2: User
    ~/.atomic/.opencode  ~/.config/opencode
           │                   │
           └─────────┬─────────┘
                     │
           ┌─────────┴─────────┐
           ▼                   ▼
    Layer 3: Legacy      Layer 4: Project
    ~/.opencode          ./.opencode
           │                   │
           └─────────┬─────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ Merged Config Directory                │
        │ ~/.atomic/.tmp/opencode-config-merged/ │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ Set OPENCODE_CONFIG_DIR env var        │
        └────────────┬───────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────────┐
        │ shouldAutoInitChat()                   │
        │ Check if SCM skills exist              │
        └────────────┬───────────────────────────┘
                     │
              ┌──────┴──────┐
              │             │
        Yes   ▼             ▼  No
    ┌─────────────┐   ┌──────────────┐
    │ Run init    │   │ Start chat   │
    │ Configure   │   │ session      │
    │ SCM skills  │   │              │
    └─────────────┘   └──────────────┘
```

### MCP Config Discovery Flow

```
┌─────────────────────────────────────────────────────────────────┐
│              discoverMcpConfigs() called at chat start          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │ Scan User-Level Configs      │
              │ ~/.claude/.mcp.json          │
              │ ~/.copilot/mcp-config.json   │
              │ ~/.opencode/opencode.json    │
              └──────────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │ Scan Project-Level Configs   │
              │ ./.mcp.json                  │
              │ ./.github/mcp-config.json    │
              │ ./opencode.json              │
              │ ./.opencode/opencode.json    │
              └──────────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │ Tag each config with         │
              │ ecosystem (claude/opencode/  │
              │ copilot)                     │
              └──────────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │ Deduplicate by name          │
              │ - Same ecosystem: project    │
              │   overrides user             │
              │ - Different ecosystem:       │
              │   keep both independently    │
              └──────────┬───────────────────┘
                         │
                         ▼
              ┌──────────────────────────────┐
              │ Return unified MCP server    │
              │ list to SDK client           │
              └──────────────────────────────┘
```

---

## Key Takeaways

### Design Principles

1. **Global vs. Project Separation**:
    - Global configs (`~/.atomic/`) provide baseline agents/skills
    - Project configs (`.claude/`, `.opencode/`, `.github/`) customize per-project
    - SCM-specific skills NEVER go global - always per-project

2. **SCM Skill Management**:
    - `gh-*` and `sl-*` skills excluded during global sync
    - Installed per-project during `atomic init` based on selected SCM
    - Reconciliation ensures only selected SCM variant exists

3. **Multi-Source Config Overlay**:
    - OpenCode: 4 layers (global < xdg < legacy < project)
    - Claude: 2 layers (global < project)
    - Copilot: Project-only (global not auto-loaded)
    - MCP configs: Ecosystem-isolated deduplication

4. **Installation Type Handling**:
    - Source: Templates in repo, no extraction needed
    - npm: Templates in node_modules, synced via postinstall
    - Binary: Templates in data dir, synced on first run/update

### Critical Functions

- **`getConfigRoot()`**: Determines where templates are based on install type
- **`syncAtomicGlobalAgentConfigs()`**: Main sync function that populates `~/.atomic/`
- **`ensureAtomicGlobalAgentConfigs()`**: Lazy sync wrapper used at runtime
- **`prepareOpenCodeConfigDir()`**: Builds merged OpenCode config with 4-layer precedence
- **`discoverMcpConfigs()`**: Unified MCP server discovery across all config formats

### File Locations

**Templates** (source):

- Source: `.claude/`, `.opencode/`, `.github/`, `.mcp.json`
- npm: `node_modules/@bastani/atomic/.claude/`, etc.
- Binary: `~/.local/share/atomic/.claude/`, etc.

**Global Configs** (destination):

- Always: `~/.atomic/.claude/`, `~/.atomic/.opencode/`, `~/.atomic/.copilot/`, `~/.atomic/.mcp.json`

**Project Configs**:

- Claude: `./.claude/`
- OpenCode: `./.opencode/`
- Copilot: `./.github/`
- Shared: `./.atomic/settings.json` (saved SCM/agent selection)

---

## References

### Source Files Analyzed

- `src/utils/atomic-global-config.ts` - Global config sync engine (195 lines)
- `src/utils/config-path.ts` - Config root resolution (154 lines)
- `src/scripts/postinstall.ts` - npm install hook (26 lines)
- `src/commands/init.ts` - Project initialization (434 lines)
- `src/commands/chat.ts` - Chat runtime entry (312 lines)
- `src/commands/update.ts` - Binary update mechanism (307 lines)
- `src/utils/opencode-config.ts` - OpenCode config merging (59 lines)
- `src/utils/mcp-config.ts` - MCP config discovery (199 lines)
- `src/config.ts` - Agent configuration definitions (159 lines)
- `src/utils/copy.ts` - Directory/file copy utilities (244 lines)

### Related Documentation

- `specs/2026-01-20-init-config-merge-behavior.md` - Init command behavior
- `research/docs/2026-01-23-update-data-dir-clean-install.md` - Update mechanism
- `research/docs/2026-02-08-skill-loading-from-configs-and-ui.md` - Skill loading
- `specs/2026-02-09-mcp-support-and-discovery.md` - MCP config discovery

---

**End of Analysis**
