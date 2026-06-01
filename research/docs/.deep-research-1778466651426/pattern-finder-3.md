# Pattern Finder 3: CLI Surface, Commands, and Agent Adapter Layer

Maps concrete patterns from `packages/atomic/` (21k LOC) demonstrating how the Atomic CLI currently integrates agent SDKs, manages CLI commands, handles configuration sync, and loads custom workflows.

---

## Pattern 1: Commander Program Initialization with Global Options

**Where:** `packages/atomic/src/cli.ts:46-67`
**What:** Creates Commander program with global flags, version, and error formatting.

```typescript
export function createProgram() {
    const program = new Command()
        .name("atomic")
        .description("Configuration management CLI for coding agents")
        .version(VERSION, "-v, --version", "Show version number")
        .enablePositionalOptions()
        .option("-y, --yes", "Auto-confirm all prompts (non-interactive mode)")
        .option("--no-banner", "Skip ASCII banner display")
        .configureOutput({
            writeErr: (str) => {
                process.stderr.write(`${COLORS.red}${str}${COLORS.reset}`);
            },
            outputError: (str, write) => {
                write(`${COLORS.red}${str}${COLORS.reset}`);
            },
        });
    return program;
}
```

**Variations:**

- `packages/atomic/src/cli.ts:73-132` — `chat` subcommand with passthrough options
- `packages/atomic/src/cli.ts:149-281` — `workflow` command mounting with agent filtering
- `packages/atomic/src/cli.ts:287-301` — `config` command with nested `set` subcommand

---

## Pattern 2: Agent Type Validation and Configuration Registry

**Where:** `packages/atomic-sdk/src/services/config/definitions.ts:60-63, 63-97`
**What:** Hardcoded agent identifiers and per-agent configuration structures (command, flags, env vars, onboarding files).

```typescript
const AGENT_KEYS = ["claude", "opencode", "copilot"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const AGENT_CONFIG: Record<AgentKey, AgentConfig> = {
    claude: {
        name: "Claude Code",
        cmd: "claude",
        chat_flags: [
            "--allow-dangerously-skip-permissions",
            "--dangerously-skip-permissions",
        ],
        env_vars: {},
        folder: ".claude",
        install_url: "https://code.claude.com/docs/en/setup",
        exclude: [],
        onboarding_files: [
            {
                kind: "claude",
                source: ".mcp.json",
                destination: ".mcp.json",
                merge: true,
            },
            // ...
        ],
    },
    // opencode, copilot follow same pattern
};
```

**Usage sites:**

- `packages/atomic/src/cli.ts:29,70` — imported as `AGENT_CONFIG, isValidAgent`
- `packages/atomic/src/commands/cli/chat/index.ts:16` — agent display names and chat flags
- `packages/atomic/src/services/system/agents.ts:5,28-30` — agent folder sync destinations

---

## Pattern 3: Custom Workflow Loader (Spawn & Parse)

**Where:** `packages/atomic/src/commands/custom-workflows.ts:73-90, 94-150`
**What:** Spawns each custom workflow entry with `_emit-workflow-meta`, parses JSON emitted to stdout, collects broken/loaded workflows.

```typescript
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

async function loadOne(
    alias: string,
    entry: CustomWorkflowEntry,
    origin: "local" | "global",
    settingsPath: string,
): Promise<LoadCustomWorkflowsResult> {
    const timeoutMs = resolveTimeoutMs(); // reads ATOMIC_WORKFLOWS_META_TIMEOUT_MS
    const args = entry.args ?? [];

    const token = randomBytes(16).toString("hex");
    const argv = [
        entry.command,
        ...args,
        "_emit-workflow-meta",
        `--dispatch-token=${token}`,
    ];

    let child: ReturnType<typeof Bun.spawn>;
    try {
        child = Bun.spawn(argv, {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                ATOMIC_HOST: "1",
                ATOMIC_DISPATCH_TOKEN: token,
            },
        });
    } catch (err) {
        // fail(...) appends BrokenWorkflow record
    }
    // ... timeout race, stream collection, JSON parse
}
```

**Failure handling:** `packages/atomic/src/commands/custom-workflows.ts:109-117` — writes structured `BrokenWorkflow` records with `reason`, `source`, `fix`.

---

## Pattern 4: Builtin Workflow Registry

**Where:** `packages/atomic/src/commands/builtin-registry.ts:9-36`
**What:** Statically imports per-agent workflow definitions and registers them via SDK's `createRegistry()`.

```typescript
import ralphClaude from "@bastani/atomic-sdk/workflows/builtin/ralph/claude";
import ralphCopilot from "@bastani/atomic-sdk/workflows/builtin/ralph/copilot";
import ralphOpencode from "@bastani/atomic-sdk/workflows/builtin/ralph/opencode";
// ... deep-research-codebase, open-claude-design

export function createBuiltinRegistry() {
    return createRegistry()
        .register(ralphClaude)
        .register(ralphCopilot)
        .register(ralphOpencode)
        .register(drcClaude)
        .register(drcCopilot)
        .register(drcOpencode)
        .register(ocdClaude)
        .register(ocdCopilot)
        .register(ocdOpencode);
}
```

**Runtime registration:**

- `packages/atomic/src/commands/cli/workflow.ts:52-66` — module-level mutable state: `activeRegistry`, `activeBroken`, getters
- `packages/atomic/src/cli.ts:549-563` — `bootstrapCustomWorkflowsAndRebuild()` merges custom workflows and calls `rebuildWorkflowCommand(registry, brokenIndex, brokenList)`

---

## Pattern 5: Agent Adapter Glue (Chat Command Integration)

**Where:** `packages/atomic/src/commands/cli/chat/index.ts:91-131, 146-150`
**What:** Builds agent spawn arguments by merging SDK config, project overrides, SCM flags, and passthrough args.

```typescript
export async function buildAgentArgs(
    agentType: AgentType,
    passthroughArgs: string[] = [],
    projectRoot: string = process.cwd(),
): Promise<string[]> {
    const config = AGENT_CONFIG[agentType];
    const overrides = await getProviderOverrides(agentType, projectRoot);
    const flags = overrides.chatFlags ?? [...config.chat_flags];

    // Copilot: SCM disable flags via --disable-mcp-server
    const scmFlags =
        agentType === "copilot"
            ? await getCopilotScmDisableFlags(projectRoot)
            : [];

    // Claude only: custom instructions file
    const instructionsFlags: string[] = [];
    if (agentType === "claude") {
        const path = resolveAdditionalInstructionsPath(projectRoot);
        if (path) instructionsFlags.push("--append-system-prompt-file", path);
    }

    return [...flags, ...scmFlags, ...instructionsFlags, ...passthroughArgs];
}

export function resolveChatCommand(
    agentType: AgentType,
    resolveCommandPath: CommandPathResolver = getCommandPath,
): string | undefined {
    if (agentType === "copilot") {
        // Special case: resolve copilot CLI path
        return resolveCopilotCliPath(resolveCommandPath);
    }
    // ...
}
```

**Call sites:**

- `packages/atomic/src/commands/cli/chat/index.ts:16,29` — imports AGENT_CONFIG, getProviderOverrides, getCopilotScmDisableFlags, ensureProjectSetup
- `packages/atomic/src/commands/cli/chat/index.ts:150-160+` — spawns agent in tmux with `createSession`, `spawnMuxAttach`, `spawnAttachedFooter`

---

## Pattern 6: Configuration Sync (Agent Folders → Home)

**Where:** `packages/atomic/src/services/system/agents.ts:44-87`
**What:** Copies bundled agent configs from npm package to provider-native home roots (`~/.claude`, `~/.opencode`, `~/.copilot`).

```typescript
const AGENT_DIR_PAIRS: AgentSyncPair[] = [
    { kind: "claude", dest: ".claude/agents" },
    { kind: "opencode", dest: ".opencode/agents" },
    { kind: "github", dest: ".copilot/agents" },
];

export async function installGlobalAgents(): Promise<void> {
    const home = homeRoot(); // reads ATOMIC_SETTINGS_HOME
    const warnings: string[] = [];

    for (const { kind, dest } of AGENT_DIR_PAIRS) {
        const src = join(await getEmbeddedAsset(kind), "agents");
        const target = join(home, dest);

        if (!(await pathExists(src))) {
            warnings.push(
                `bundled agents missing at ${src} — skipping ${target}`,
            );
            continue;
        }

        await copyDir(src, target, {
            ignoreFilter: createCommonIgnoreFilter(),
        });
    }

    // Copilot lsp.json rename
    const lspSrc = join(await getEmbeddedAsset("github"), "lsp.json");
    const lspDest = join(home, ".copilot", "lsp-config.json");
    if (await pathExists(lspSrc)) {
        await ensureDir(dirname(lspDest));
        await copyFile(lspSrc, lspDest);
    }
}
```

**Integration:**

- Called by `packages/atomic/src/services/system/auto-sync.ts` (on first launch post-install/upgrade)
- Triggered during `atomic chat` preflight via `ensureAtomicGlobalAgentConfigs()` in `packages/atomic/src/commands/cli/chat/index.ts:29`

---

## Pattern 7: Install/Uninstall/Update Commands (Binary Placement & PATH)

**Where:** `packages/atomic/src/commands/cli/install.ts:58-100, 96-130`
**What:** Detects install method, copies binary to platform-specific dir, manages PATH and completions.

```typescript
export function getInstallPaths(): InstallPaths {
    if (isWindows()) {
        const localAppData =
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        const binDir = join(localAppData, "atomic", "bin");
        return {
            binDir,
            binPath: join(binDir, "atomic.exe"),
            completionsDir: join(homedir(), ".atomic", "completions"),
        };
    }
    const binDir = join(homedir(), ".local", "bin");
    return {
        binDir,
        binPath: join(binDir, "atomic"),
        completionsDir: join(homedir(), ".atomic", "completions"),
    };
}

export function copyBinary(
    paths: InstallPaths,
    sourcePath: string = process.execPath,
): void {
    if (
        resolve(sourcePath).toLowerCase() ===
        resolve(paths.binPath).toLowerCase()
    ) {
        return; // Already at install location
    }
    // Atomic-move pattern: copy to temp, chmod, rename (cross-filesystem portable)
    // Windows: rename old binary to .old.<ts> before rolling in new one
}
```

**Subcommands:**

- `packages/atomic/src/cli.ts:472-482` — `install` command (entry point from bootstrap scripts)
- `packages/atomic/src/cli.ts:484-492` — `uninstall` command with `--purge` option
- `packages/atomic/src/cli.ts:494-506` — `update` command with `--check` and `--version` pinning

---

## Pattern 8: Version Bump Script (Semver + Branch Extraction)

**Where:** `packages/atomic/script/bump-version.ts:54-92`
**What:** Extracts version from branch name (release/v0.4.46 → 0.4.46) or accepts explicit semver.

```typescript
function parseVersionFromBranch(branch: string): string {
    const match = branch.match(/^(?:release|prerelease)\/v(.+)$/);
    if (!match) {
        console.error(
            `Error: branch "${branch}" does not match release/v<version> or prerelease/v<version>`,
        );
        process.exit(1);
    }
    return match[1] as string;
}

function validateVersion(version: string): void {
    // Accept semver with optional prerelease suffix: 0.4.46, 0.4.46-0, 1.0.0-1
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
        console.error(`Error: "${version}" is not a valid semver version`);
        process.exit(1);
    }
}

async function getVersion(): Promise<string> {
    const arg = positional[0];
    if (!arg) {
        console.error(
            "Usage: bun run src/scripts/bump-version.ts <version|--from-branch>",
        );
        process.exit(1);
    }
    if (arg === "--from-branch") {
        const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
        return parseVersionFromBranch(branch);
    }
    return arg.replace(/^v/, "");
}
```

**Invocation:** `bun run packages/atomic/script/bump-version.ts 0.4.47` or `bun run packages/atomic/script/bump-version.ts --from-branch`

---

## Pattern 9: Release Fetch & Checksum Verification

**Where:** `packages/atomic/src/services/system/release-fetch.ts:30-68, 92-120`
**What:** Fetches GitHub Releases metadata, downloads assets with progress, verifies sha256.

```typescript
const DEFAULT_GITHUB_API_BASE = "https://api.github.com/repos/bastani/atomic";

function buildApiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "atomic-cli",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
}

async function githubGet(url: string): Promise<ReleaseInfo> {
    const res = await fetch(url, { headers: buildApiHeaders() });
    if (
        res.status === 403 &&
        res.headers.get("X-RateLimit-Remaining") === "0"
    ) {
        throw new Error(
            "Set GITHUB_TOKEN to lift the 60 req/h anonymous limit",
        );
    }
    if (!res.ok) {
        throw new Error(`GitHub API error ${res.status}: ${url}`);
    }
    return res.json() as Promise<ReleaseInfo>;
}

export async function downloadAssetFromUrl(
    url: string,
    destPath: string,
    onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
    const res = await fetch(url, { headers: buildAssetDownloadHeaders() });
    if (!res.ok) {
        throw new Error(`Failed to download asset: HTTP ${res.status}`);
    }
    const tmpPath = `${destPath}.tmp.${pid}.${Date.now()}`;
    // ... streaming with progress, atomic rename
}
```

**Called by:** `packages/atomic/src/commands/cli/update.ts:100+` (update command)

---

## Pattern 10: Telemetry Event Constants & Payloads

**Where:** `packages/atomic/src/lib/telemetry/offload-events.ts:20-74`
**What:** Exports event-name constants and typed payload interfaces for workflow offload observability.

```typescript
export const WORKFLOW_OFFLOAD_SCHEDULED = "workflow.offload.scheduled" as const;
export const WORKFLOW_OFFLOAD_COMPLETED = "workflow.offload.completed" as const;
export const WORKFLOW_OFFLOAD_RESUME_ATTEMPTED =
    "workflow.offload.resume.attempted" as const;
export const WORKFLOW_OFFLOAD_RESUME_SUCCEEDED =
    "workflow.offload.resume.succeeded" as const;
export const WORKFLOW_OFFLOAD_RESUME_FAILED =
    "workflow.offload.resume.failed" as const;

export interface WorkflowOffloadScheduledPayload {
    runId: string;
    count: number;
}

export interface WorkflowOffloadCompletedPayload {
    runId: string;
    name: string;
    agent: AgentKind;
}

export interface WorkflowOffloadResumeAttemptedPayload {
    runId: string;
    name: string;
    agent: AgentKind;
}
```

**Telemetry sink:** `packages/atomic/src/lib/telemetry/index.ts` re-exports `getProductionTelemetrySink()` and `TelemetrySink` from atomic-sdk.

---

## Pattern 11: Banner Display (Logo with Catppuccin Gradient)

**Where:** `packages/atomic/src/theme/logo.ts:14-123`
**What:** ASCII logo colorized with Catppuccin gradient, adapts to terminal color capability.

```typescript
export const ATOMIC_BLOCK_LOGO = [
    "█▀▀█ ▀▀█▀▀ █▀▀█ █▀▄▀█ ▀█▀ █▀▀",
    "█▄▄█   █   █  █ █ ▀ █  █  █  ",
    "▀  ▀   ▀   ▀▀▀▀ ▀   ▀ ▀▀▀ ▀▀▀",
];

export function displayBlockBanner(): void {
    const isDark = !(process.env.COLORFGBG ?? "").startsWith("0;");
    const truecolor = supportsTrueColor();
    const color256 = supports256Color();
    const hasColor = supportsColor();

    console.log();
    for (const line of ATOMIC_BLOCK_LOGO) {
        if (truecolor) {
            const gradient = isDark ? GRADIENT_DARK : GRADIENT_LIGHT;
            console.log(`  ${colorizeLineTrueColor(line, gradient)}`);
        } else if (color256 && hasColor) {
            console.log(`  ${colorizeLine256(line, GRADIENT_256)}`);
        } else {
            console.log(`  ${line}`);
        }
    }
    console.log();
}
```

**Integration:** Called by init command; skipped when `--no-banner` is set (global flag on line 57 of cli.ts).

---

## Pattern 12: Platform-Specific Binary Wrapper (Node.js → Native Binary)

**Where:** `packages/atomic/bin/atomic:1-83` (JavaScript wrapper)
**What:** npm package entry point that detects platform/arch, selects platform-specific npm sub-package, spawns native binary.

```javascript
const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
};

const archMap = {
    x64: "x64",
    arm64: "arm64",
};

function libcSuffix() {
    if (platform !== "linux") return "";
    const muslLinker =
        "/lib/ld-musl-" + (arch === "arm64" ? "aarch64" : "x86_64") + ".so.1";
    try {
        if (fs.existsSync(muslLinker)) return "-musl";
    } catch (_) {}
    return "";
}

const packageName = "@bastani/atomic-" + platform + "-" + arch + libcSuffix();
const binaryName = "atomic" + (platform === "windows" ? ".exe" : "");

const result = childProcess.spawnSync(binary, process.argv.slice(2), {
    stdio: "inherit",
});

process.exit(result.status != null ? result.status : 1);
```

**Packaging:** Works with bun build --compile to produce `packages/atomic-darwin-x64`, `packages/atomic-linux-x64`, `packages/atomic-linux-x64-musl`, `packages/atomic-windows-x64` sub-packages.

---

## Pattern 13: Orchestrator Entry (Internal Subcommand)

**Where:** `packages/atomic/src/cli.ts:324-384`
**What:** Hidden internal subcommand spawned in tmux pane by SDK; accepts workflow name, agent, inputs, source path.

```typescript
program
    .command("_orchestrator-entry", { hidden: true })
    .description(
        "Internal: load a workflow definition and run the orchestrator panel",
    )
    .argument("<workflowName>", "Workflow name (matches builtin registry)")
    .argument("<agent>", "claude | copilot | opencode")
    .argument(
        "[inputsB64]",
        "Base64-encoded JSON record of structured inputs",
        "",
    )
    .argument(
        "[workflowSource]",
        "Workflow source path (dynamic-import fallback for non-builtin workflows in dev)",
        "",
    )
    .action(
        async (
            workflowName: string,
            agent: string,
            inputsB64: string,
            workflowSource: string,
        ) => {
            const { isCompiledBinaryRuntime } =
                await import("@bastani/atomic-sdk/lib/runtime-env");

            if (isCompiledBinaryRuntime(workflowSource)) {
                // Compiled binary: resolve by name+agent in builtin registry
                const { createBuiltinRegistry } =
                    await import("./commands/builtin-registry.ts");
                const resolved = createBuiltinRegistry().resolve(
                    workflowName,
                    agent,
                );
                // ...
            } else {
                // Dev: dynamic-import workflow file
                const { runOrchestratorEntry } =
                    await import("@bastani/atomic-sdk/runtime/orchestrator-entry");
                await runOrchestratorEntry(
                    workflowSource,
                    workflowName,
                    agent,
                    inputsB64,
                );
            }
        },
    );
```

---

## Pattern 14: Claude Integration Hooks (Stop, SessionStart, Ask, Inflight)

**Where:** `packages/atomic/src/cli.ts:399-464`
**What:** Hidden internal subcommands registered as Claude Code hook handlers for idle detection, user prompts, and lifecycle events.

```typescript
program
    .command("_claude-stop-hook", { hidden: true })
    .description(
        "Internal: Claude Code Stop hook handler — writes a marker file for idle detection",
    )
    .action(async () => {
        const { claudeStopHookCommand } =
            await import("@bastani/atomic-sdk/providers/claude-stop-hook");
        const exitCode = await claudeStopHookCommand();
        process.exit(exitCode);
    });

program
    .command("_claude-session-start-hook", { hidden: true })
    .description(
        "Internal: Claude Code SessionStart hook handler — writes a ready-marker file",
    )
    .action(async () => {
        const { claudeSessionStartHookCommand } =
            await import("./commands/cli/claude-session-start-hook.ts");
        const exitCode = await claudeSessionStartHookCommand();
        process.exit(exitCode);
    });

program
    .command("_claude-ask-hook", { hidden: true })
    .description(
        "Internal: Claude Code AskUserQuestion hook handler — writes/removes HIL marker",
    )
    .argument("<mode>", "enter (PreToolUse) or exit (PostToolUseFailure)")
    .action(async (mode: string) => {
        // ... mode validation
        const { claudeAskHookCommand } =
            await import("./commands/cli/claude-ask-hook.ts");
        const exitCode = await claudeAskHookCommand(mode);
        process.exit(exitCode);
    });

program
    .command("_claude-inflight-hook", { hidden: true })
    .description(
        "Internal: Claude Code Subagent/TeammateIdle lifecycle hook handler",
    )
    .argument(
        "<mode>",
        "start (SubagentStart), stop (SubagentStop), or wait (TeammateIdle)",
    )
    .action(async (mode: string) => {
        const { claudeInflightHookCommand } =
            await import("@bastani/atomic-sdk/providers/claude-inflight-hook");
        const exitCode = await claudeInflightHookCommand(mode);
        process.exit(exitCode);
    });
```

---

## Summary

Partition 3 reveals the complete CLI surface architecture:

1. **Commander entry point** (`cli.ts:46-67`) with global options and error formatting
2. **Agent configuration registry** (definitions.ts:60-97) — hardcoded `claude`, `opencode`, `copilot` with per-agent command, flags, env vars, onboarding files
3. **Custom workflow loader** (custom-workflows.ts:73-150) — spawns with `_emit-workflow-meta`, collects broken/loaded records
4. **Builtin registry** (builtin-registry.ts:9-36) — statically imported per-agent definitions registered via SDK
5. **Agent adapter glue** (chat/index.ts:91-131) — merges AGENT_CONFIG, project overrides, SCM flags, spawn args
6. **Config sync** (agents.ts:44-87) — copies `.claude`, `.opencode`, `.github` to `~/.claude/agents`, `~/.opencode/agents`, `~/.copilot/agents`
7. **Install/Uninstall/Update** (cli.ts:472-506) — bootstrap entry points, PATH management, completion setup
8. **Version bump** (bump-version.ts:54-92) — branch name extraction + semver validation
9. **Release fetch** (release-fetch.ts:30-120) — GitHub Releases API + asset download + checksum
10. **Telemetry** (offload-events.ts:20-74) — event constants and typed payloads
11. **Banner** (logo.ts:14-123) — Catppuccin gradient colorization, terminal capability detection
12. **Binary wrapper** (bin/atomic:1-83) — Node.js shim selecting platform-specific native package
13. **Orchestrator entry** (cli.ts:324-384) — internal subcommand for workflow execution in tmux pane
14. **Claude hooks** (cli.ts:399-464) — Stop, SessionStart, Ask, Inflight lifecycle markers

All patterns are tightly coupled to three agent identifiers (`claude`, `opencode`, `copilot`) and three SDK packages (`@bastani/atomic-sdk`, `@commander-js/extra-typings`, `@clack/prompts`). The rewrite onto `pi-coding-agent` will require abstracting agent type, decoupling SDK dependencies, and replacing tmux integration with pi's native runtime model.
