# Partition 3 of 12 — Findings

## Scope
`packages/atomic/` (98 files, 21,364 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
# Partition 3 Locator: `packages/atomic/` — CLI Surface & Commands (21k LOC)

Comprehensive audit of user-facing CLI binary with Commander-based subcommands, tmux integration, workflow orchestration dispatch, agent configuration, and telemetry.

---

## Implementation

### CLI Entry Point & Command Registry
- `packages/atomic/src/cli.ts` — Master program definition; 625 lines. Creates Commander instance, defines all top-level commands (chat, workflow, config, session, completions, install, uninstall, update), wires internal hook handlers (_orchestrator-entry, _claude-stop-hook, _claude-session-start-hook, _claude-ask-hook, _claude-inflight-hook, _cc-debounce, _runtime-assets-smoke). Re-entry point for SDK orchestrator. Bootstraps custom workflows at startup.
- `packages/atomic/src/commands/builtin-registry.ts` — Builtin workflow registry loader; imports 3 static WorkflowDefinitions (drc for claude/copilot/opencode), creates registry singleton via `createRegistry()` from @bastani/atomic-sdk.

### Chat Command
- `packages/atomic/src/commands/cli/chat.ts` — Barrel export for chat subcommand.
- `packages/atomic/src/commands/cli/chat/index.ts` — Chat implementation; 446 lines. Spawns native agent CLI (claude/copilot/opencode) in tmux session with optional footer pane. Handles agent executable detection, preflight setup, launcher script generation (bash/powershell), tmux session creation, TTY detection, fallback to direct spawn. Exports `chatCommand()`, `buildAgentArgs()`, `buildLauncherScript()`, agent config helpers.

### Workflow Commands
- `packages/atomic/src/commands/cli/workflow.ts` — Workflow command dispatcher from @bastani/atomic-sdk/registry; rebuildable with custom workflows.
- `packages/atomic/src/commands/cli/workflow-list.ts` — List available workflows; filters by agent, renders builtin + custom registries.
- `packages/atomic/src/commands/cli/workflow-inputs.ts` — Print workflow input schema (JSON); resolves by name+agent.
- `packages/atomic/src/commands/cli/workflow-read.ts` — Print on-disk path to workflow run or stage under ~/.atomic/sessions; takes --sessionId, --stageId, --format.
- `packages/atomic/src/commands/cli/workflow-status.ts` — Query workflow status (in_progress, error, completed, needs_review); takes optional session ID, --format json|text.
- `packages/atomic/src/commands/cli/workflow-refresh.ts` — Reload custom workflows from settings.json; emits JSON when ATOMIC_AGENT is set (model consumer).

### Session Management
- `packages/atomic/src/commands/cli/management-commands.ts` — Shared session subcommand builders for atomic session, atomic chat session, atomic workflow session. Exports `addSessionSubcommand()` which adds list, connect, kill subcommands to any Command parent. Uses tmux session introspection.
- `packages/atomic/src/commands/cli/session.ts` — Session command implementation; list, connect, kill operations on tmux sessions.

### Install / Update / Uninstall
- `packages/atomic/src/commands/cli/install.ts` — Install command; copies binary to platform-specific install dir, adds to PATH, sets up shell completions. Uninstall also lives here (--purge removes ~/.atomic). Exports `installCommand()`, `uninstallCommand()`.
- `packages/atomic/src/commands/cli/install-method.ts` — Platform-specific install/uninstall logic (POSIX, Windows). Detects multiplexer (tmux/psmux), wraps binary, persists PATH.
- `packages/atomic/src/commands/cli/update.ts` — Update command; fetches latest release metadata, optionally installs. Takes --check, --version.

### Claude Code Hooks
- `packages/atomic/src/commands/cli/claude-ask-hook.ts` — AskUserQuestion lifecycle handler; enters/exits HIL (human-in-loop) marker-file state for pauses during tool use.
- `packages/atomic/src/commands/cli/claude-session-start-hook.ts` — SessionStart hook handler; writes ready-marker file.

### Initialization & Project Setup
- `packages/atomic/src/commands/cli/init.ts` — Init command barrel export.
- `packages/atomic/src/commands/cli/init/index.ts` — Project setup: ensures .atomic/ dir, merges global + local settings.json, installs bundled skills, syncs agent configs.
- `packages/atomic/src/commands/cli/init/onboarding.ts` — Onboarding UI flows; prompts for agent selection, skill installation.

### Config & Completions
- `packages/atomic/src/commands/cli/config.ts` — Config set command; updates global settings (telemetry flag, scm provider).
- `packages/atomic/src/commands/cli/completions.ts` — Shell completion generator (bash/zsh/fish/powershell); emits completion script.

### Internal Commands
- `packages/atomic/src/commands/cli/runtime-assets-smoke.ts` — Verifies bundled runtime assets (tmux.conf, debounce script, orchestrator entry) materialize to real disk paths; smoke check for CI cross-platform harness.

### Custom Workflows
- `packages/atomic/src/commands/custom-workflows.ts` — Custom workflow loader; spawns each entry's command with `_emit-workflow-meta`, parses JSON output. Returns successfully loaded + broken workflows. Merges results into registry.
- `packages/atomic/src/commands/custom-workflows.integration.test.ts` — Integration test.
- `packages/atomic/src/commands/custom-workflows.test.ts` — Unit tests.

### Configuration Services
- `packages/atomic/src/services/config/index.ts` — Reexports @bastani/atomic-sdk definitions (AGENT_CONFIG, isValidAgent, etc.).
- `packages/atomic/src/services/config/settings.ts` — Global settings bootstrap; ensures ~/.atomic/settings.json exists with schema scaffold.
- `packages/atomic/src/services/config/atomic-global-config.ts` — Agent config sync; copies bundled .claude/agents, .opencode/agents, .github/agents (→ .copilot/agents) to user's home dirs.

### System Services
- `packages/atomic/src/services/system/agents.ts` — Global agent directory installer; mirrors bundled agents (claude, opencode, github) to provider-native roots, renames github lsp.json → copilot/lsp-config.json.
- `packages/atomic/src/services/system/auto-sync.ts` — Lazy dependency sync; triggers once per version (gated on marker file under ~/.atomic), installs tmux/psmux, syncs agents, syncs global skills. Skipped for info commands.
- `packages/atomic/src/services/system/install-method.ts` — Multiplex installer detection; chooses tmux/psmux fallback based on platform. Tests in install-method.test.ts, install-method.win32.test.ts.
- `packages/atomic/src/services/system/install-ui.ts` — TUI spinner display for install steps.
- `packages/atomic/src/services/system/release-fetch.ts` — GitHub release metadata fetcher; used by update command.
- `packages/atomic/src/services/system/auth.ts` — OAuth flow handler (unused in current codebase, present for future agent integrations).
- `packages/atomic/src/services/system/file-lock.ts` — Simple file-based locking (prevent concurrent syncs).
- `packages/atomic/src/services/system/skills.ts` — Skill loader; copies bundled skills from embedded asset to ~/.atomic/skills and local ./.agents/skills.

### Telemetry
- `packages/atomic/src/lib/telemetry/index.ts` — Reexports @bastani/atomic-sdk's `getProductionTelemetrySink()` and `TelemetrySink` type.
- `packages/atomic/src/lib/telemetry/offload-events.ts` — Event-name constants and payload shapes for workflow offload/resume observability (WORKFLOW_OFFLOAD_SCHEDULED, WORKFLOW_OFFLOAD_COMPLETED, WORKFLOW_OFFLOAD_RESUME_*, etc.). Pure registry; no emit sites.

### Utilities
- `packages/atomic/src/lib/embedded-assets.ts` — Unpacks tar-gzipped bundled assets (claude, opencode, github configs) from generated tar-modules (bun build). Exports `getEmbeddedAsset()`.
- `packages/atomic/src/lib/workspace-paths.ts` — Resolves workspace directories (.atomic, .atomic/workflows, etc.).
- `packages/atomic/src/lib/merge.ts` — Recursive config merge utility (global + local settings.json).
- `packages/atomic/src/version.ts` — Version constant from package.json.
- `packages/atomic/src/url-placeholders.test.ts` — Tests URL placeholder expansion in launcher scripts.
- `packages/atomic/src/info-command-skip.ts` — Detects info-only commands (--help, --version) to skip autosync/custom workflow bootstrap.

### Theme
- `packages/atomic/src/theme/logo.ts` — ASCII logo display.

### Shell Completions
- `packages/atomic/src/completions/index.ts` — Completion generators for bash, zsh, fish, powershell.
- `packages/atomic/src/completions/bash.ts` — Bash completion script generator.
- `packages/atomic/src/completions/zsh.ts` — Zsh completion script generator.
- `packages/atomic/src/completions/fish.ts` — Fish completion script generator.
- `packages/atomic/src/completions/powershell.ts` — PowerShell completion script generator.

### Build & Release Scripts
- `packages/atomic/script/build.ts` — Main build orchestrator; bundles CLI, embeds runtime assets (tmux.conf, debounce script, orchestrator entry), generates tar-modules.
- `packages/atomic/script/build-assets.ts` — Embeds agent configs + skills into tar-gzipped modules.
- `packages/atomic/script/bundle-configs.ts` — Bundles provider configs (claude, opencode, github) into tar modules.
- `packages/atomic/script/publish.ts` — Release publisher; invokes GitHub release API, uploads binaries.
- `packages/atomic/script/release-assets.ts` — Binary artifact builder; compiles OS/arch variants (darwin x64/arm64, linux x64/arm64 glibc/musl, windows x64).
- `packages/atomic/script/bump-version.ts` — Version bumper; updates package.json version across workspace.
- `packages/atomic/script/clean-dist.ts` — Cleans dist/ folder.
- `packages/atomic/script/targets.ts` — Build target definitions (platforms, architectures).
- `packages/atomic/script/constants-base.ts` — Build constants (paths, asset definitions).
- `packages/atomic/script/chat-smoke.ts` — Chat command smoke test; verifies basic flow without agent CLI installed.

### Type Definitions
- `packages/atomic/src/tar-modules.d.ts` — Type definitions for dynamically-generated tar modules.

### Binary Wrapper
- `packages/atomic/bin/atomic` — Node.js wrapper script; detects platform/arch, resolves platform-specific binary package (@bastani/atomic-{platform}-{arch}), spawns compiled binary with inherited stdio.

---

## Tests

### CLI Tests
- `packages/atomic/src/cli.test.ts` — Tests program creation, subcommand routing, error handling.
- `packages/atomic/src/cli.skip-set.test.ts` — Tests info-command detection.

### Command Tests
- `packages/atomic/src/commands/cli/chat/index.test.ts` — Chat implementation tests; launcher script generation, agent arg building, tmux fallback logic.
- `packages/atomic/src/commands/cli/workflow.test.ts` — Workflow command tests.
- `packages/atomic/src/commands/cli/workflow-list.test.ts` — Workflow list tests; registry filtering.
- `packages/atomic/src/commands/cli/workflow-list.shadow.test.ts` — Shadow test (integration variant).
- `packages/atomic/src/commands/cli/workflow-command.test.ts` — Workflow dispatcher tests.
- `packages/atomic/src/commands/cli/workflow-inputs.test.ts` — Workflow inputs schema tests.
- `packages/atomic/src/commands/cli/workflow-read.test.ts` — Session path resolution tests.
- `packages/atomic/src/commands/cli/workflow-refresh.test.ts` — Refresh command tests; custom workflow loading.
- `packages/atomic/src/commands/cli/workflow-status.test.ts` — Status query tests.
- `packages/atomic/src/commands/cli/install.test.ts` — Install/uninstall tests.
- `packages/atomic/src/commands/cli/install-method.test.ts` — Install method detection tests (POSIX).
- `packages/atomic/src/commands/cli/install-method.win32.test.ts` — Install method tests (Windows).
- `packages/atomic/src/commands/cli/update.test.ts` — Update command tests.
- `packages/atomic/src/commands/cli/session.test.ts` — Session management tests.
- `packages/atomic/src/commands/cli/claude-ask-hook.test.ts` — Claude AskUserQuestion hook tests.
- `packages/atomic/src/commands/cli/claude-stop-hook.test.ts` — Claude Stop hook tests.
- `packages/atomic/src/commands/cli/claude-inflight-hook.test.ts` — Claude Subagent/TeammateIdle lifecycle tests.

### Custom Workflows Tests
- `packages/atomic/src/commands/custom-workflows.test.ts` — Custom workflow loader unit tests.
- `packages/atomic/src/commands/custom-workflows.integration.test.ts` — Integration tests with real spawned processes.

### Service Tests
- `packages/atomic/src/services/system/auth.test.ts` — Auth flow tests (OAuth placeholders).
- `packages/atomic/src/services/system/auto-sync.test.ts` — Autosync version marker tests.
- `packages/atomic/src/services/system/release-fetch.test.ts` — GitHub release fetch tests.

### Library Tests
- `packages/atomic/src/lib/embedded-assets.test.ts` — Tar-module unpacking tests.
- `packages/atomic/src/lib/telemetry/offload-events.test.ts` — Telemetry event shape validation.
- `packages/atomic/src/lib/telemetry/getProductionTelemetrySink.test.ts` — Telemetry sink initialization.
- `packages/atomic/src/lib/telemetry/offload-events.test.ts` — Offload event definitions.
- `packages/atomic/src/url-placeholders.test.ts` — URL placeholder expansion.

### Build Script Tests
- `packages/atomic/script/__tests__/bump-version.test.ts` — Version bump logic.
- `packages/atomic/script/__tests__/cli-build-host-default.test.ts` — Build host detection.
- `packages/atomic/script/__tests__/embedded-assets-shape.test.ts` — Tar-module shape validation.
- `packages/atomic/script/__tests__/publish-artifact-naming.test.ts` — Release artifact naming.
- `packages/atomic/script/__tests__/wrapper-tarball-shape.test.ts` — Binary wrapper tarball structure.
- `packages/atomic/script/__tests__/workspace-paths.test.ts` — Workspace path resolution.
- `packages/atomic/script/build-assets.test.ts` — Asset bundling tests.
- `packages/atomic/script/release-assets.test.ts` — Binary compilation tests.
- `packages/atomic/script/clean-dist.test.ts` — Dist cleanup tests.

---

## Types / Interfaces

### Public Exports from `packages/atomic/src`
- `ChatCommandOptions` — Options for `chatCommand()`: agentType, passthroughArgs, preflightOnly.
- `AgentType` — Alias for AgentKey (claude | copilot | opencode).
- `AgentKind` — Telemetry-scoped alias for AgentType.
- `LoadedWorkflow` — Custom workflow + metadata (alias, origin: local|global, workflow).
- `LoadCustomWorkflowsResult` — Result of custom workflow load: loaded[], broken[].
- `EmittedWorkflowDef` — Workflow metadata emitted by `_emit-workflow-meta`: name, description, agent, inputs, source, minSDKVersion.
- `WorkflowOffload*Payload` — Telemetry event payloads (ScheduledPayload, CompletedPayload, ResumeAttemptedPayload, ResumeSucceededPayload, ResumeFailedPayload, ResumeLat encyPayload, etc.).

### Reexported from @bastani/atomic-sdk
- `AgentKey` (as AgentType in CLI context).
- `AGENT_CONFIG` — Static config map (claude, copilot, opencode) with name, cmd, install_url, chat_flags, env_vars.
- `isValidAgent(name: string): boolean`.
- `TerminalEnvKey`, `BuildLauncherEnv`, `BuildSpawnEnv`, `BuildTmuxEnv`.
- `TelemetrySink`, `getProductionTelemetrySink()`.

---

## Configuration

### Package Definition
- `packages/atomic/package.json` — Defines @bastani/atomic as private workspace package. Bin entry: atomic → src/cli.ts. Dependencies: @anthropic-ai/claude-agent-sdk ^0.2.132, @github/copilot-sdk ^0.3.0, @bastani/atomic-sdk (workspace), @clack/prompts, @commander-js/extra-typings, @opentui/core, @opentui/react, react ^19.2.6, @catppuccin/palette.

### TypeScript
- `packages/atomic/tsconfig.json` — TypeScript configuration.

---

## Tests Summary

Total test files: 39
- Unit tests cover individual commands, config services, auto-sync, release fetching, auth flows.
- Integration tests cover custom workflow loading with real spawned processes.
- Build script tests validate artifact naming, tar-module shapes, binary distribution.
- All tests use Bun test framework (no jest/vitest config visible).

---

## Notable Clusters

### CLI Commands Cluster
- `packages/atomic/src/commands/cli/` — 21 implementation files, 39 test files. Heart of the CLI: every user-visible command, hook handler, and session management. All use Commander subcommand pattern. Heavy tmux integration (session creation, pane management, attach fallback).

### Configuration & Onboarding Cluster
- `packages/atomic/src/services/config/` + `packages/atomic/src/services/system/` + `packages/atomic/src/commands/cli/init/` — 14 files. Handles global config sync (agent configs, skills), project setup (.atomic/ dir, settings.json scaffold), dependency installation (tmux/psmux), multiplexer detection.

### Build & Release Cluster
- `packages/atomic/script/` — 14 files including 7 tests. Bun-based build orchestrator: compiles 6 platform/arch variants (darwin x64/arm64, linux x64/arm64 glibc/musl, windows x64), embeds tar-gzipped runtime assets (tmux.conf, orchestrator entry, debounce script), generates tar-modules for bundled agent configs + skills, publishes releases to GitHub, manages version bumps.

### Telemetry Cluster
- `packages/atomic/src/lib/telemetry/` — 3 files. Event registry for workflow offload/resume observability; pure type definitions + constants (no emit sites in partition 3). Emitters live in @bastani/atomic-sdk (orchestrator runtime).

### Chat Command Cluster
- `packages/atomic/src/commands/cli/chat/` — 2 files + 1 test. 446-line implementation of agent CLI spawning: launcher script generation (bash/pwsh), tmux session creation, TTY detection, fallback to direct spawn. Heavy tmux + environment variable management.

---

## Key Dependency Pins

### Agent SDK Dependencies (Load-Bearing for Current Architecture)
- `@anthropic-ai/claude-agent-sdk ^0.2.132` — Claude Code CLI integration; needed for hook handlers (Stop, SessionStart, AskUserQuestion, Inflight), config sync, additional-instructions resolution.
- `@github/copilot-sdk ^0.3.0` — Copilot CLI SDK; needed for command-path resolution, scm-disable flags, custom-instructions env var.
- Atomic SDK re-exports these, but partition 3 directly imports from them only in: auth.ts (OAuth placeholders), chat/index.ts (copilot command resolution), claude-ask-hook.ts, claude-session-start-hook.ts.

### Agent-Agnostic Dependencies
- `@clack/prompts` — CLI prompts (used in init onboarding).
- `@commander-js/extra-typings` — Command-line argument parsing; all commands defined via Commander.
- `@opentui/core`, `@opentui/react` — TUI components (footer pane spinners, session picker).
- `@catppuccin/palette` — Color theme.

### Atomic SDK Dependencies (Boundary Layer)
- Heavy reliance on @bastani/atomic-sdk for: AGENT_CONFIG, tmux runtime, terminal env building, system detection, embedded asset unpacking, config definitions, telemetry sinks, orchestrator re-entry, copilot launch options, additional-instructions resolution.

---

## Removal & Replatforming Implications for pi-coding-agent

### Load-Bearing (Must Replace)
1. **tmux integration** — Every command that spawns agents (chat, workflow stages) depends on `isInsideTmux()`, `createSession()`, `spawnMuxAttach()`, `killSession()`. Chat command has fallback to direct spawn, but workflow stages heavily depend on tmux session persistence, pane management, offload/resume.
2. **Claude Code SDK** — Stop hook, SessionStart hook, AskUserQuestion hook, Inflight lifecycle hooks are Claude-specific. Replacements needed for pi equivalents.
3. **Copilot SDK** — Used only for command-path resolution and scm-disable flags; replaceable with generic platform-specific detection.
4. **OpenCode SDK** — No direct imports in partition 3; abstractly supported via AGENT_CONFIG. Removal is low-cost.

### Removable (Low Cost)
1. **OpenTUI** — Spinner/footer components in chat command and init onboarding. Can be replaced with simpler stdio-based progress indicators.
2. **@clack/prompts** — Used in init onboarding. Replaceable with builtin prompts.
3. **@catppuccin/palette** — Color theme; replaceable with ANSI color constants.

### Keep As-Is (Agent-Agnostic)
1. **Commander.js** — Excellent fit for pi-coding-agent CLI; no replacement needed.
2. **Custom workflow loader** — Mechanism is agent-agnostic; only output format (JSON) needs validation for pi-agent compatibility.
3. **Configuration merge** — Global + local settings.json strategy is sound; agent config locations will change but pattern holds.
4. **Telemetry event registry** — Offload/resume events are generic; emitters will move to pi-agent orchestrator runtime.

---

## Summary

Partition 3 is the **user-facing CLI surface** of Atomic: 101 files (98 source + config), 21.3k LOC, heavily focused on command dispatch (Commander), tmux session management, agent spawning, configuration sync, and telemetry event definitions.

**Core architectural features:**
- Master CLI (`cli.ts`) wires 13 top-level commands + 8 internal hooks.
- Chat command spawns agent CLIs in tmux with optional footer pane; fallback to direct spawn on TTY failure.
- Workflow command is SDK-provided dispatcher; list/inputs/status/read/refresh subcommands are CLI-local.
- Custom workflows loaded dynamically via `_emit-workflow-meta` IPC.
- Session management (list/connect/kill) wraps tmux session introspection across chat, workflow, and top-level `session` command.
- Global config sync (agents, skills) triggered on first launch post-install/upgrade.
- Shell completions (bash/zsh/fish/powershell) generated statically.
- Binary distribution via platform-specific wrapper + bun-compiled native binaries for 6 OS/arch combinations.

**Agent SDK dependencies:** Claude, Copilot, OpenCode are hardcoded as supported agents. Hook handlers and config paths are Claude-specific (easiest replatforming cost). Copilot support is minimal (command resolution + scm flags). OpenCode is lowest-touch (abstract via AGENT_CONFIG).

**Tmux criticality:** Every interactive feature (chat sessions, workflow stage panes, session management) relies on tmux. Replatforming to pi-coding-agent will require replacing with pi's native session/pane model or reimplementing a simpler subprocess orchestration layer.

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
### Files Analysed

1. `packages/atomic/src/cli.ts` (625 lines)
2. `packages/atomic/src/commands/cli/chat/index.ts` (446 lines)
3. `packages/atomic/src/commands/custom-workflows.ts` (413 lines)
4. `packages/atomic/src/commands/cli/init/index.ts` (41 lines)
5. `packages/atomic/src/commands/cli/init/onboarding.ts` (66 lines)
6. `packages/atomic/src/services/config/atomic-global-config.ts` (349 lines)
7. `packages/atomic/src/services/system/auto-sync.ts` (121 lines)
8. `packages/atomic/src/commands/builtin-registry.ts` (37 lines)
9. `packages/atomic/src/commands/cli/install.ts` (826 lines)
10. `packages/atomic/src/commands/cli/install-method.ts` (105 lines)
11. `packages/atomic/src/services/system/agents.ts` (88 lines)
12. `packages/atomic/src/lib/embedded-assets.ts` (101 lines)
13. `packages/atomic/src/commands/cli/workflow.ts` (435 lines)
14. `packages/atomic/src/services/system/skills.ts` (51 lines)
15. `packages/atomic/script/build.ts` (80 lines, partial)

---

### Per-File Notes

#### `packages/atomic/src/cli.ts`

- **Role:** Master Commander.js program factory; wires every top-level command and all hidden internal sub-commands into a single `program` singleton; owns the `main()` bootstrap sequence.
- **Key symbols:**
  - `createProgram()` (`cli.ts:46`) — constructs and returns the Commander `Command` tree; called once at module load.
  - `program` (`cli.ts:540`) — module-level singleton, exported for tests.
  - `bootstrapCustomWorkflowsAndRebuild()` (`cli.ts:549`) — calls `bootstrapCustomWorkflows` then `rebuildWorkflowCommand`; runs unless argv is an info-only command.
  - `main()` (`cli.ts:579`) — top-level async entry: runs `ensureGlobalAtomicSettings`, conditionally calls `autoSyncIfStale`, conditionally calls `bootstrapCustomWorkflowsAndRebuild`, then `program.parseAsync()`.
  - `isInfoCommandArgv(argv)` (`cli.ts:597`) — imported from `./info-command-skip.ts`; gates whether sync/custom-workflow steps run.
- **Control flow:**
  1. `main()` at `cli.ts:622` runs on `import.meta.main`.
  2. `ensureGlobalAtomicSettings()` seeds `~/.atomic/settings.json` (`cli.ts:587`).
  3. If not info-only: `autoSyncIfStale()` (`cli.ts:603`) then `bootstrapCustomWorkflowsAndRebuild()` (`cli.ts:609`).
  4. `program.parseAsync()` routes argv to the matched command.
  5. Each public command does a lazy `await import(...)` of its implementation module and calls the implementation function, then `process.exit(exitCode)`.
- **Data flow:** `argv → isInfoCommandArgv → conditional sync → bootstrapCustomWorkflows → rebuildWorkflowCommand (mutates module-level registry in workflow.ts) → parseAsync → command action → dynamic import → implementation → process.exit`.
- **Dependencies:**
  - `@commander-js/extra-typings` — CLI parsing.
  - `@bastani/atomic-sdk/theme/colors`, `@bastani/atomic-sdk/lib/runtime-env`, `@bastani/atomic-sdk/runtime/orchestrator-entry`, `@bastani/atomic-sdk/runtime/cc-debounce`, `@bastani/atomic-sdk/providers/claude-stop-hook`, `@bastani/atomic-sdk/providers/claude-inflight-hook`.
  - Local: `./version.ts`, `./services/config/index.ts`, `./completions/index.ts`, `./commands/cli/workflow.ts`, `./commands/cli/management-commands.ts`, `./info-command-skip.ts`.
- **Load-bearing vs removable (pi-rewrite):** The Commander structure, `main()` bootstrap, `isInfoCommandArgv` gate, and `bootstrapCustomWorkflowsAndRebuild` are all load-bearing skeleton. Every hidden internal sub-command (`_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook`) is Claude/tmux-specific and removable. `_orchestrator-entry` is load-bearing but its body would be replaced with a pi-coding-agent orchestrator call.
- **Pi extension seam:** The `_orchestrator-entry` hidden command at `cli.ts:325` is the single injection point for replacing the SDK orchestrator. The `chatCommand` lazy-import at `cli.ts:124` is the agent-spawn seam.

---

#### `packages/atomic/src/commands/cli/chat/index.ts`

- **Role:** Implements `atomic chat -a <agent>`; builds a launcher script, creates a tmux session on the atomic socket, spawns an attached footer pane, and connects the user's terminal. Falls back to direct `Bun.spawn` when no TTY or tmux is unavailable.
- **Key symbols:**
  - `chatCommand(options)` (`chat/index.ts:260`) — main export; orchestrates preflight, arg-building, launcher creation, tmux session, and attach.
  - `buildAgentArgs(agentType, passthroughArgs, projectRoot)` (`chat/index.ts:102`) — resolves `chatFlags` from `AGENT_CONFIG` or `getProviderOverrides`, appends SCM flags (Copilot), `--append-system-prompt-file` (Claude), and passthrough args.
  - `buildLauncherScript(cmd, args, projectRoot, envVars)` (`chat/index.ts:198`) — generates a POSIX bash or PowerShell script that `cd`s to project root, exports env vars, runs the agent CLI, and exits with its exit code; escapes all strings to prevent injection.
  - `resolveChatCommand(agentType, resolveCommandPath)` (`chat/index.ts:146`) — calls `resolveCopilotCliPath` for copilot or `getCommandPath(config.cmd)` for others; returns executable path or undefined.
  - `spawnDirect(cmd, projectRoot, env)` (`chat/index.ts:433`) — fallback: `Bun.spawn` with inherited stdio.
  - `getAgentDisplayName`, `getAdditionalInstructionsDir` — minor helpers.
- **Control flow:**
  1. `preflightOnly` branch: runs `ensureAtomicGlobalAgentConfigs` + `ensureProjectSetup`, returns 0 (`chat/index.ts:272-277`).
  2. Resolves executable; errors if not found (`chat/index.ts:281-290`).
  3. Runs global config sync + project setup (`chat/index.ts:293-297`).
  4. Builds `args` via `buildAgentArgs`; assembles `envVars` with `ATOMIC_AGENT=<agentType>`, Claude temp env, Copilot instructions dirs (`chat/index.ts:299-332`).
  5. Builds `spawnEnv`, `launcherEnv`, `tmuxEnv` via three SDK helpers (`chat/index.ts:334-336`).
  6. No TTY → `spawnDirect` (`chat/index.ts:339-341`).
  7. Ensures tmux via `isTmuxInstalled()` / `ensureTmuxInstalled()` (`chat/index.ts:344-356`).
  8. Writes launcher script to `~/.atomic/sessions/chat/<windowName>.<ext>` (`chat/index.ts:359-376`).
  9. `createSession(windowName, shellCmd, ...)` → `spawnAttachedFooter(paneId, ...)` → `killSessionOnPaneExit(windowName, paneId)` (`chat/index.ts:379-381`).
  10. Branches on `isInsideAtomicSocket()` (switch client), `isInsideTmux()` (detach+attach), else `spawnMuxAttach(windowName)` and awaits exit (`chat/index.ts:383-417`).
- **Data flow:** `AGENT_CONFIG[agentType]` → flags + env → launcher script → tmux session → agent CLI process. Exit code from tmux attach propagates back to `chatCommand` → `process.exit`.
- **Dependencies (all tmux/agent-SDK pinned):**
  - `@bastani/atomic-sdk/runtime/tmux` — `isInsideAtomicSocket`, `isInsideTmux`, `isTmuxInstalled`, `resetMuxBinaryCache`, `createSession`, `detachAndAttachAtomic`, `killSessionOnPaneExit`, `killSession`, `spawnMuxAttach`, `switchClient`.
  - `@bastani/atomic-sdk/runtime/attached-footer` — `spawnAttachedFooter`.
  - `@bastani/atomic-sdk/lib/spawn` — `ensureTmuxInstalled`.
  - `@bastani/atomic-sdk/lib/terminal-env` — `buildLauncherEnv`, `buildSpawnEnv`, `buildTmuxEnv`.
  - `@bastani/atomic-sdk/lib/atomic-temp` — `atomicTempEnv` (Claude-specific temp env).
  - `@bastani/atomic-sdk/providers/copilot` — `resolveCopilotCliPath`.
  - `@bastani/atomic-sdk/services/config/atomic-config` — `getProviderOverrides`.
  - `@bastani/atomic-sdk/services/config/scm-sync` — `getCopilotScmDisableFlags`.
  - `@bastani/atomic-sdk/services/config/additional-instructions` — `resolveAdditionalInstructionsPath`.
  - `@bastani/atomic-sdk/services/system/detect` — `getCommandPath`.
  - Local: `../init/index.ts` (`ensureProjectSetup`), `../../../services/config/atomic-global-config.ts` (`ensureAtomicGlobalAgentConfigs`), `../../../lib/embedded-assets.ts`.
- **Load-bearing vs removable:** `buildLauncherScript`, `spawnDirect`, the env assembly block, and `resolveChatCommand` are structurally reusable. All tmux imports and the entire session-creation/attach block (`chat/index.ts:344-426`) are removed in the pi-rewrite. The pi-agent launch would replace lines 379-417 with a direct pi-coding-agent spawn.
- **Pi extension seam:** Lines 379-417 in `chatCommand`; replace `createSession` + `spawnMuxAttach` with a pi-coding-agent process launch. `buildLauncherScript` remains usable as-is.

---

#### `packages/atomic/src/commands/custom-workflows.ts`

- **Role:** Loads external (third-party) workflow definitions by spawning each entry's CLI with `_emit-workflow-meta`, parsing the `ATOMIC_WORKFLOW_META: <json>` line from stdout, and merging results into the builtin registry.
- **Key symbols:**
  - `loadCustomWorkflows(workflows, origin, settingsPath)` (`custom-workflows.ts:73`) — top-level loader; fans out over `workflows` map with `Promise.all` over `loadOne`.
  - `loadOne(alias, entry, origin, settingsPath)` (`custom-workflows.ts:94`) — spawns `[entry.command, ...args, "_emit-workflow-meta", "--dispatch-token=<token>"]` with env `ATOMIC_HOST=1, ATOMIC_DISPATCH_TOKEN=<token>`; imposes a timeout (`DEFAULT_TIMEOUT_MS=5000`); parses the `ATOMIC_WORKFLOW_META: ` line; validates the JSON array; matches per declared agent.
  - `mergeIntoRegistry(builtin, global, local)` (`custom-workflows.ts:282`) — local overrides global overrides builtin. Builds two healthy sets for shadow-subtraction of broken entries; returns `{ registry, brokenList, brokenIndex, summary }`.
  - `bootstrapCustomWorkflows(projectDir)` (`custom-workflows.ts:391`) — reads global + local `settings.json` via `readAtomicConfigSplit`, calls `loadCustomWorkflows` in parallel, then `mergeIntoRegistry`; returns a `BootstrapResult`.
  - `META_PREFIX = "ATOMIC_WORKFLOW_META: "` (`custom-workflows.ts:52`) — the line prefix the spawned child must emit.
- **Control flow:**
  1. `bootstrapCustomWorkflows` → reads `getGlobalSettingsPath()` + `getLocalSettingsPath(projectDir)`.
  2. `readAtomicConfigSplit(projectDir)` splits config into global/local.
  3. Two parallel `loadCustomWorkflows` calls.
  4. Each entry spawned with 5s timeout; stdout scanned for `META_PREFIX`; JSON parsed; per-agent matching.
  5. `mergeIntoRegistry` applies global then local with audit stderr lines; shadow-subtraction removes broken entries that have a healthy counterpart.
  6. `cli.ts:563` calls `rebuildWorkflowCommand(registry, brokenIndex, brokenList)` to hot-swap the active Commander registry.
- **Data flow:** `settings.json["workflows"]` → subprocess spawn → stdout line → JSON array of `EmittedWorkflowDef` → `ExternalWorkflow` objects → registry upsert.
- **Dependencies:** `@bastani/atomic-sdk/services/config/atomic-config` (settings read), `@bastani/atomic-sdk` (`AgentType`, `BrokenWorkflow`, `ExternalWorkflow`, `WorkflowInput`, `listWorkflows`), local `builtin-registry.ts`.
- **Load-bearing vs removable:** The subprocess protocol (`_emit-workflow-meta` + `META_PREFIX`) and the registry merge logic are entirely load-bearing for the custom workflow feature. The only agent-specific dependency is the `AgentType` union; replacing it with a pi-agent type is the sole change required.
- **Pi extension seam:** `entry.agents` type (`AgentType[]`) — replace with pi-agent type. The subprocess protocol is agent-agnostic and reusable.

---

#### `packages/atomic/src/commands/cli/init/index.ts`

- **Role:** Thin coordinator for per-`chat` project setup. Called on every `atomic chat` invocation; idempotent.
- **Key symbols:**
  - `ensureProjectSetup(agentKey, projectRoot)` (`init/index.ts:26`) — two-phase: (1) `applyManagedOnboardingFiles` from `onboarding.ts`; (2) `syncScmMcpServers(projectRoot)` from SDK; (3) if `agentKey === "opencode"`, `reconcileOpencodeInstructions(projectRoot)`.
- **Control flow:** Sequential `await` chain; no branching except the `opencode` guard.
- **Data flow:** `agentKey → AGENT_CONFIG[agentKey].onboarding_files → syncJsonFile per file`. SCM state comes from `.atomic/settings.json`.
- **Dependencies:** `@bastani/atomic-sdk/services/config/scm-sync` (`syncScmMcpServers`), `@bastani/atomic-sdk/services/config/additional-instructions` (`reconcileOpencodeInstructions`), local `./onboarding.ts`, `../../../lib/embedded-assets.ts`.
- **Load-bearing vs removable:** `applyManagedOnboardingFiles` and `syncScmMcpServers` are agent-specific. In a pi-rewrite, this file becomes the pi-agent project setup coordinator. The SCM sync step is removable unless pi-coding-agent needs MCP server management.

---

#### `packages/atomic/src/commands/cli/init/onboarding.ts`

- **Role:** Copies/merges bundled onboarding JSON files (MCP configs, settings) from embedded assets into the project root or `~/<home>` paths.
- **Key symbols:**
  - `applyManagedOnboardingFiles(agentKey, projectRoot, resolveKind)` (`onboarding.ts:24`) — iterates `AGENT_CONFIG[agentKey].onboarding_files`; resolves source from extracted tar asset; calls `syncJsonFile(source, destination, merge, excludeKeys, overwriteKeys)` for each.
  - `hasProjectOnboardingFiles(agentKey, projectRoot)` (`onboarding.ts:51`) — check-only variant.
  - `KindResolver` type alias (`onboarding.ts:9`) — `(kind: EmbeddedAssetKind) => Promise<string>`; the test seam for embedded assets.
  - `resolveDestination(destination, projectRoot)` (`onboarding.ts:17`) — expands leading `~/` to `homedir()`.
- **Data flow:** `AGENT_CONFIG[agentKey].onboarding_files[]` → `resolveKind(managedFile.kind)` → tar extraction → `syncJsonFile` → disk write.
- **Dependencies:** `@bastani/atomic-sdk/services/system/copy` (`pathExists`), `../../../lib/merge.ts` (`syncJsonFile`), local `../../../services/config/index.ts`.
- **Pi extension seam:** `KindResolver` is the injection point for providing pi-coding-agent config assets. The `onboarding_files` descriptor in `AGENT_CONFIG` drives what gets merged.

---

#### `packages/atomic/src/services/config/atomic-global-config.ts`

- **Role:** Syncs Atomic's bundled agent config templates into provider-native global roots (`~/.claude`, `~/.opencode`, `~/.copilot`). Also provides the remove (uninstall) path.
- **Key symbols:**
  - `GLOBAL_SYNC_SUBDIRECTORIES = ["agents"]` (`atomic-global-config.ts:37`) — only `agents/` is synced from bundled templates.
  - `GLOBAL_SYNC_FILES = { copilot: ["lsp.json"] }` (`atomic-global-config.ts:43`) — Copilot's `lsp.json` → `lsp-config.json`.
  - `syncAtomicGlobalAgentConfigs(resolveKind, baseDir)` (`atomic-global-config.ts:240`) — for each agent key: resolves source folder from `resolveKind(AGENT_KIND_BY_KEY[agentKey])`; `copyDir` into `~/.<agentFolder>/agents/`; `syncJsonFile` for top-level files.
  - `hasAtomicGlobalAgentConfigs(resolveKind, baseDir)` (`atomic-global-config.ts:287`) — presence check to avoid unnecessary disk ops.
  - `ensureAtomicGlobalAgentConfigs(resolveKind, baseDir)` (`atomic-global-config.ts:342`) — verify-and-repair entrypoint: calls `hasAtomicGlobalAgentConfigs`; on miss calls `syncAtomicGlobalAgentConfigs`.
  - `removeAtomicManagedGlobalAgentConfigs(resolveKind, baseDir)` (`atomic-global-config.ts:182`) — inverse: removes only the files Atomic would have installed; leaves user-managed files alone.
  - `AGENT_KIND_BY_KEY: Record<AgentKey, ProviderConfigKind>` (`atomic-global-config.ts:13`) — maps `claude→"claude"`, `opencode→"opencode"`, `copilot→"github"`.
- **Data flow:** `resolveKind(kind)` → extracted tar dir → `copyDir(sourceSubdir, destDir)` + `syncJsonFile(sourceFile, destFile)` → `~/.claude/agents/`, `~/.opencode/agents/`, `~/.copilot/agents/`, `~/.copilot/lsp-config.json`.
- **Dependencies:** `@bastani/atomic-sdk/services/system/copy`, `@bastani/atomic-sdk/lib/common-ignore`, `@bastani/atomic-sdk/services/config/definitions` (`ProviderConfigKind`), local `./index.ts` (AGENT_CONFIG), `../../lib/merge.ts`.
- **Load-bearing vs removable:** The entire file is agent-specific. For pi-rewrite: replace the `AGENT_KIND_BY_KEY` map with a pi-agent entry and update `GLOBAL_AGENT_FOLDER_BY_KEY` to target `~/.pi` (or equivalent). `syncAtomicGlobalAgentConfigs` itself is structurally reusable.
- **Pi extension seam:** `AGENT_KIND_BY_KEY` (`atomic-global-config.ts:13`) and `GLOBAL_AGENT_FOLDER_BY_KEY` (`atomic-global-config.ts:21`) are the configuration tables to replace/extend.

---

#### `packages/atomic/src/services/system/auto-sync.ts`

- **Role:** Lazy first-run dependency sync. Compares `VERSION` against `~/.atomic/.synced-version`; on mismatch installs tmux/psmux, global agents, global tool packages (playwright, liteparse, ast-grep), and global skills. Version-matched runs only re-check for the mux binary.
- **Key symbols:**
  - `autoSyncIfStale()` (`auto-sync.ts:82`) — the public entry point; skips when not an installed package (`isInstalledPackage`); runs `silentStep` wrappers for each step.
  - `markSynced()` (`auto-sync.ts:53`) — writes `VERSION` to `syncMarkerPath()`.
  - `syncMarkerPath()` (`auto-sync.ts:44`) — `~/.atomic/.synced-version`; honors `ATOMIC_SETTINGS_HOME`.
  - Steps:
    - `seedGlobalAdditionalInstructions` (always, outside installed-package gate) (`auto-sync.ts:88`).
    - `seedGlobalProviderEnvVars` (always) (`auto-sync.ts:89`).
    - `ensureTmuxInstalled({ quiet: true })` — installs tmux/psmux (`auto-sync.ts:104`).
    - `installGlobalAgents()` — copies bundled agent definitions (`auto-sync.ts:105`).
    - `upgradeGlobalToolPackages()` — `bun install -g` for playwright/liteparse/ast-grep (`auto-sync.ts:106`).
    - `installGlobalSkills()` — copies bundled skills (`auto-sync.ts:107`).
- **Control flow:** Sequential guards → `Promise.all(steps)` → `markSynced()` only if all steps returned `true`.
- **Dependencies:** `@bastani/atomic-sdk/lib/spawn` (`hasRequiredMuxBinary`, `ensureTmuxInstalled`, `upgradeGlobalToolPackages`), `@bastani/atomic-sdk/lib/runtime-env` (`isInstalledPackage`), `@bastani/atomic-sdk/services/config/additional-instructions` (`seedGlobalAdditionalInstructions`), local `./agents.ts`, `./skills.ts`, `../config/settings.ts`.
- **Load-bearing vs removable:** `ensureTmuxInstalled` is fully removable for pi-rewrite. `installGlobalAgents` and `installGlobalSkills` are agent-specific (replace with pi-agent equivalents). `upgradeGlobalToolPackages` remains if those tools are still used. `seedGlobalAdditionalInstructions` and `seedGlobalProviderEnvVars` depend on whether pi-agent uses the same instructions mechanism.
- **Pi extension seam:** The `steps` array at `auto-sync.ts:101-108` — swap out individual steps; the marker/idempotency logic is reusable.

---

#### `packages/atomic/src/commands/builtin-registry.ts`

- **Role:** Atomic CLI's static catalog of builtin workflows. Constructs a registry via SDK `createRegistry()` and registers the nine built-in workflow definitions (ralph, deep-research-codebase, open-claude-design × {claude, copilot, opencode}).
- **Key symbols:**
  - `createBuiltinRegistry()` (`builtin-registry.ts:26`) — factory; returns a `Registry` value (immutable data type from SDK).
- **Data flow:** Statically imports nine workflow modules from `@bastani/atomic-sdk/workflows/builtin/...`; chains `.register()` calls; returns the registry.
- **Dependencies:** `@bastani/atomic-sdk/registry` (`createRegistry`), nine workflow modules from `@bastani/atomic-sdk/workflows/builtin/`.
- **Load-bearing vs removable:** Entirely removable. For pi-rewrite: replace all imports and registrations with pi-agent workflow definitions.
- **Pi extension seam:** The `createBuiltinRegistry` factory is the only seam. Replace imported workflow modules; the `createRegistry().register()` chain pattern is reusable.

---

#### `packages/atomic/src/commands/cli/workflow.ts`

- **Role:** Builds the `workflow` Commander sub-command. Manages a module-level mutable registry (`activeRegistry`) that is hot-swapped by `rebuildWorkflowCommand`. Handles both builtin and external workflow dispatch, and the interactive TUI picker.
- **Key symbols:**
  - `workflowCommand` (`workflow.ts:434`) — module-level singleton `Command` built with `liveRegistry=true`.
  - `buildWorkflowCommand(registry, liveRegistry)` (`workflow.ts:313`) — factory; declares `-n`, `-a`, `-d`, dynamic `--<input>` options, and `[prompt...]`.
  - `rebuildWorkflowCommand(registry, brokenIndex, brokenList)` (`workflow.ts:159`) — hot-swaps `activeRegistry`, `activeBroken`, `activeBrokenList`; calls `resyncDynamicOptions`.
  - `resyncDynamicOptions(cmd, registry)` (`workflow.ts:138`) — strips all non-reserved Commander options, re-adds from `buildInputUnion(listWorkflows(registry))`.
  - `dispatch(workflow, cliInputs, detach)` (`workflow.ts:261`) — routes external workflows to `dispatchExternal`; builtin workflows to `runWorkflow` from SDK.
  - `dispatchExternal(w, cliInputs, detach)` (`workflow.ts:229`) — spawns `[w.source.command, ...args, "_atomic-run", "--dispatch-token=<token>", ...]` with `ATOMIC_HOST=1`.
  - `blockIfBroken(name, agent)` (`workflow.ts:74`) — looks up `activeBroken.get("${agent}/${name}")` and exits 2 with diagnostic if found.
  - `runPicker(registry, agent, detach)` (`workflow.ts:287`) — opens `WorkflowPickerPanel` TUI, awaits selection, dispatches.
- **Control flow:** Command action at `workflow.ts:368`: resolves `name`, `agent`, `detach` from opts → calls `blockIfBroken` → extracts `cliInputs` from opts → collapses `[prompt...]` → if no `name` and TTY → picker → else `resolveWorkflow` → `dispatch`.
- **Dependencies:** `@bastani/atomic-sdk` (core types, `runWorkflow`, `listWorkflows`, `getInputSchema`), `@bastani/atomic-sdk/services/config/definitions` (`isValidAgent`, `getAgentKeys`), `@bastani/atomic-sdk/worker-shared` (`buildInputUnion`, `toCamelCase`), `@bastani/atomic-sdk/workflows/components` (`WorkflowPickerPanel`), local `builtin-registry.ts`, `custom-workflows.ts`.
- **Pi extension seam:** `dispatch` at `workflow.ts:261` — replace `runWorkflow` with a pi-coding-agent workflow runner. `buildExternalDispatchArgv`/`buildExternalDispatchEnv` are reusable pure helpers. `WorkflowPickerPanel` depends on OpenTUI and stays if the TUI layer is kept.

---

#### `packages/atomic/src/commands/cli/install.ts`

- **Role:** Implements `atomic install` (binary self-placement, PATH persistence, completions) and `atomic uninstall` (cleanup). Mirrors Claude Code's installer pattern.
- **Key symbols:**
  - `installCommand(opts)` (`install.ts:751`) — copies binary via `copyBinary`, persists PATH via `persistPathEntry`, detects mux binary, installs completions; queues artifact reaper via `queueMicrotask`.
  - `uninstallCommand(opts)` (`install.ts:695`) — detects install method via `detectInstallMethod`; for `"binary"` method calls `uninstallBinary`; optionally purges `~/.atomic`.
  - `copyBinary(paths, sourcePath)` (`install.ts:96`) — atomic-move pattern: copy to `.tmp.<pid>.<ts>`, `chmodSync(0o755)`, `renameSync` to final; Windows: renames existing exe to `.old.<ts>` first.
  - `getInstallPaths()` (`install.ts:58`) — Unix: `~/.local/bin/atomic`; Windows: `%LOCALAPPDATA%/atomic/bin/atomic.exe`.
  - `detectMuxBinary()` (`install.ts:411`) — checks `tmux` (Unix) or `psmux`/`pmux` (Windows) on PATH, then searches `wellKnownMuxInstallDirs()`.
  - `persistPathEntry(dir)` (`install.ts:223`) — Unix: appends `case ":$PATH:" in` snippet to shell rc files; Windows: reads/writes `HKCU\Environment\Path` via PowerShell.
  - `installCompletions(paths)` (`install.ts:472`) — detects shell, writes cache file to `~/.atomic/completions/`, sources from rc file.
  - `stripRcSnippet(rcPath, marker)` (`install.ts:555`) — marker-based rc-file cleanup for uninstall.
  - `cleanupOldArtifacts(binDir, now)` (`install.ts:160`) — reaps `.old.<ts>` archives and `.tmp.<pid>.<ts>` orphans older than 1 hour.
- **Data flow:** `process.execPath` → `copyBinary` → `~/.local/bin/atomic` → `persistPathEntry` → shell rc files / Windows registry. Shell detection: `$SHELL` → `/etc/passwd` → bash fallback.
- **Dependencies:** Node.js `fs` sync APIs, `node:os`, `node:path`. Local: `./install-method.ts`, `../../completions/index.ts`.
- **Load-bearing vs removable:** `copyBinary`, `persistPathEntry`, `installCompletions`, `cleanupOldArtifacts` are agent-agnostic and fully reusable. `detectMuxBinary` and the mux PATH persistence block are tmux-specific and removable. In pi-rewrite, the mux block is replaced with detection of the pi-coding-agent binary.
- **Pi extension seam:** `installCommand` at `install.ts:776` — the mux detection block (lines 776-793) is replaced with pi-agent binary detection.

---

#### `packages/atomic/src/commands/cli/install-method.ts`

- **Role:** Detects how atomic was installed (binary, bun, npm, pnpm, yarn, source, unknown) by inspecting `process.execPath`. Memoized; test seams for exec path and platform.
- **Key symbols:**
  - `detectInstallMethod(opts)` (`install-method.ts:45`) — public entry; reads/writes module-level `cached`.
  - `computeInstallMethod(opts)` (`install-method.ts:54`) — heuristics: (1) canonical bin dir match → `"binary"`; (2) `node_modules/@bastani/atomic` path match → pkg manager probe; (3) ends with `/bun` → `"source"`; else `"unknown"`.
  - `PKG_PATH_RE = /\/node_modules\/@bastani\/atomic(?:-[a-z0-9-]+)?\//` (`install-method.ts:22`).
  - `_resetInstallMethodCache()` (`install-method.ts:104`) — test-only.
- **Data flow:** `process.execPath → normalize → path heuristics → optional PM probe via Bun.spawnSync`.
- **Pi extension seam:** `PKG_PATH_RE` references `@bastani/atomic`; would be updated to the pi-rewrite package name.

---

#### `packages/atomic/src/services/system/agents.ts`

- **Role:** Copies bundled agent definition files from extracted tar assets into the three provider global roots (`~/.claude/agents`, `~/.opencode/agents`, `~/.copilot/agents`) and copies Copilot's `lsp.json` → `~/.copilot/lsp-config.json`.
- **Key symbols:**
  - `AGENT_DIR_PAIRS: AgentSyncPair[]` (`agents.ts:44`) — `[{kind:"claude", dest:".claude/agents"}, {kind:"opencode", dest:".opencode/agents"}, {kind:"github", dest:".copilot/agents"}]`.
  - `installGlobalAgents()` (`agents.ts:55`) — iterates pairs: `getEmbeddedAsset(kind)` → `copyDir(src, target)`. Then handles `lsp.json` → `lsp-config.json` copy.
- **Data flow:** `getEmbeddedAsset(kind)` extracts tar → `copyDir(src, ~/.*/agents)`.
- **Dependencies:** `@bastani/atomic-sdk/services/system/copy`, `@bastani/atomic-sdk/lib/common-ignore`, `@bastani/atomic-sdk/services/config/definitions`, local `../../lib/embedded-assets.ts`.
- **Load-bearing vs removable:** Entirely agent-specific. For pi-rewrite: replace `AGENT_DIR_PAIRS` with `[{kind:"pi", dest:".pi/agents"}]`; drop the Copilot lsp block.

---

#### `packages/atomic/src/lib/embedded-assets.ts`

- **Role:** Extracts tar bundles embedded in the compiled binary (or shipped alongside the package) into a versioned on-disk cache under `~/.cache/atomic/<VERSION>/<kind>/`. Handles compiled binary (`/$bunfs/`) vs installed-package path differences.
- **Key symbols:**
  - `BUNDLES: Record<EmbeddedAssetKind, string>` (`embedded-assets.ts:15`) — maps `claude`, `opencode`, `github`, `skills` to their respective `.tar` import paths (Bun static file imports).
  - `getEmbeddedAsset(kind)` (`embedded-assets.ts:41`) — checks SHA-256 + VERSION marker in `<cacheDir>/.extracted`; if stale, materializes tar to real FS path (when in bunfs), runs `tar -xf`, writes marker, atomic-renames staging dir to final dir.
  - `cacheRoot()` (`embedded-assets.ts:22`) — platform-specific: `%LOCALAPPDATA%/atomic/Cache` (win32), `~/Library/Caches/atomic` (darwin), `~/.cache/atomic` (linux).
  - Tar imports at `embedded-assets.ts:10-13` — Bun `with { type: "file" }` static imports that embed the tars into the binary.
- **Data flow:** `BUNDLES[kind]` (path to tar) → `Bun.file(tarPath).bytes()` → SHA-256 fingerprint → cache miss → `mkdir staging` → `tar -xf` → marker write → `rename(staging, finalDir)` → return `finalDir`.
- **Dependencies:** `node:fs`, `node:crypto`, `node:os`, `node:path`, `@bastani/atomic-sdk/lib/runtime-env` (`isCompiledBinaryRuntime`), `@bastani/atomic-sdk/services/config/definitions` (`EmbeddedAssetKind`), local `../version.ts`.
- **Pi extension seam:** Add `"pi"` key to `BUNDLES` and add a corresponding tar import. The extraction logic is fully reusable. `EmbeddedAssetKind` type in the SDK must also be extended.

---

#### `packages/atomic/src/services/system/skills.ts`

- **Role:** Copies bundled skills from the `skills` embedded tar into `~/.agents/skills` and `~/.claude/skills`. Called by `autoSyncIfStale`.
- **Key symbols:**
  - `SKILL_DEST_DIRS = [".agents/skills", ".claude/skills"]` (`skills.ts:27`).
  - `installGlobalSkills()` (`skills.ts:35`) — `getEmbeddedAsset("skills")` → `copyDir(src, join(home, rel))` for each dest dir.
- **Pi extension seam:** Add `".pi/skills"` to `SKILL_DEST_DIRS`; remove `".claude/skills"` if Claude is dropped.

---

#### `packages/atomic/script/build.ts`

- **Role:** Build orchestrator for the compiled binary. Runs `bundleEmbeddedAssets` first, then `bun build --compile --target=bun-<os>-<arch>` per target.
- **Key symbols:**
  - `bundleEmbeddedAssets(WORKSPACE_ROOT)` (`build.ts:50`) — imported from `./build-assets.ts`; creates the `.claude.tar`, `.opencode.tar`, `.github.tar`, `.agents/skills.tar` that `embedded-assets.ts` imports.
  - `TARGETS`, `hostTarget`, `BuildTarget` — from `./targets.ts`.
  - Cross-compile pre-install at `build.ts:78`: `bun install --os="*" --cpu="*" @opentui/core@<spec>` to force all OpenTUI native binding variants.
- **Pi extension seam:** `bundleEmbeddedAssets` must be extended to pack a `.pi.tar`; the CLI entry and target list remain unchanged.

---

### Cross-Cutting Synthesis

The `packages/atomic/` CLI is structured as a thin Commander.js program (`cli.ts`) that lazy-imports implementation modules on action. The `main()` bootstrap sequence at `cli.ts:579` is authoritative: it gates sync operations with `isInfoCommandArgv`, runs `autoSyncIfStale` (tmux + agents + skills), bootstraps custom workflows (subprocess protocol against `_emit-workflow-meta`), and calls `program.parseAsync()`. Every user-visible command (`chat`, `workflow`, `session`, `install`, `update`) is agent-agnostic in structure but agent-specific in its dependency surface.

The three deepest tmux dependencies are: (1) `chat/index.ts` which calls nine functions from `@bastani/atomic-sdk/runtime/tmux` and `runtime/attached-footer`; (2) `auto-sync.ts` which calls `ensureTmuxInstalled` from the SDK; and (3) `install.ts` which calls `detectMuxBinary()` and persists the mux binary directory to PATH. These three files contain all the tmux wiring.

The three deepest multi-agent (Claude/Copilot/OpenCode) dependencies are: (1) `atomic-global-config.ts` which hardcodes the `AGENT_KIND_BY_KEY` and `GLOBAL_AGENT_FOLDER_BY_KEY` maps; (2) `agents.ts` which hardcodes `AGENT_DIR_PAIRS`; and (3) `builtin-registry.ts` which imports nine workflow definitions, three per agent.

Embedded assets flow exclusively through `embedded-assets.ts:getEmbeddedAsset(kind)` — a single function that all agent sync, onboarding, and skill paths call. This is the primary extension seam for adding pi-coding-agent asset bundles. The `EmbeddedAssetKind` union in the SDK (`@bastani/atomic-sdk/services/config/definitions`) must be extended to include a `"pi"` key.

The custom workflow subprocess protocol (`_emit-workflow-meta` + `ATOMIC_WORKFLOW_META:` line) is fully agent-agnostic and can be preserved as-is in the pi-rewrite. The `ATOMIC_AGENT` environment variable baked into the launcher env in `chat/index.ts:310` is the sole runtime signal agents use to detect they are running inside Atomic.

---

### Out-of-Partition References

The following symbols from `packages/atomic/` call into `packages/atomic-sdk/` (out of partition) and are critical cross-boundary seams for the pi-rewrite:

- `@bastani/atomic-sdk/runtime/tmux` — `createSession`, `spawnMuxAttach`, `isInsideAtomicSocket`, `isInsideTmux`, `isTmuxInstalled`, `switchClient`, `detachAndAttachAtomic`, `killSessionOnPaneExit`, `killSession`, `resetMuxBinaryCache` — consumed by `chat/index.ts`.
- `@bastani/atomic-sdk/runtime/attached-footer` — `spawnAttachedFooter` — consumed by `chat/index.ts`.
- `@bastani/atomic-sdk/lib/spawn` — `ensureTmuxInstalled`, `hasRequiredMuxBinary`, `upgradeGlobalToolPackages` — consumed by `auto-sync.ts`.
- `@bastani/atomic-sdk/runtime/orchestrator-entry` — `runOrchestratorEntry`, `runOrchestratorWithDefinition` — consumed by `cli.ts:_orchestrator-entry` hidden command.
- `@bastani/atomic-sdk/runtime/cc-debounce` — `runCcDebounce` — consumed by `cli.ts:_cc-debounce` hidden command.
- `@bastani/atomic-sdk/providers/claude-stop-hook` — `claudeStopHookCommand` — consumed by `cli.ts:_claude-stop-hook`.
- `@bastani/atomic-sdk/providers/claude-inflight-hook` — `claudeInflightHookCommand` — consumed by `cli.ts:_claude-inflight-hook`.
- `@bastani/atomic-sdk/services/config/definitions` — `AGENT_CONFIG`, `AgentKey`, `isValidAgent`, `getAgentKeys`, `ProviderConfigKind`, `EmbeddedAssetKind` — consumed throughout.
- `@bastani/atomic-sdk/services/config/atomic-config` — `getProviderOverrides`, `readAtomicConfigSplit`, `getGlobalSettingsPath`, `getLocalSettingsPath`, `CustomWorkflowEntry` — consumed by `chat/index.ts`, `custom-workflows.ts`.
- `@bastani/atomic-sdk/services/config/scm-sync` — `getCopilotScmDisableFlags`, `syncScmMcpServers` — consumed by `chat/index.ts`, `init/index.ts`.
- `@bastani/atomic-sdk/services/config/additional-instructions` — `resolveAdditionalInstructionsPath`, `reconcileOpencodeInstructions`, `seedGlobalAdditionalInstructions` — consumed by `chat/index.ts`, `init/index.ts`, `auto-sync.ts`.
- `@bastani/atomic-sdk/workflows/builtin/ralph/*`, `deep-research-codebase/*`, `open-claude-design/*` — workflow definition modules — consumed by `builtin-registry.ts`.
- `@bastani/atomic-sdk/workflows/components` — `WorkflowPickerPanel` — consumed by `workflow.ts`.
- `@bastani/atomic-sdk` (root barrel) — `runWorkflow`, `listWorkflows`, `getInputSchema`, type exports — consumed by `workflow.ts`, `custom-workflows.ts`.

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
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
}
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
  const argv = [entry.command, ...args, "_emit-workflow-meta", `--dispatch-token=${token}`];
  
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: token },
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
    agentType === "copilot" ? await getCopilotScmDisableFlags(projectRoot) : [];
  
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
      warnings.push(`bundled agents missing at ${src} — skipping ${target}`);
      continue;
    }
    
    await copyDir(src, target, { ignoreFilter: createCommonIgnoreFilter() });
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
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
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

export function copyBinary(paths: InstallPaths, sourcePath: string = process.execPath): void {
    if (resolve(sourcePath).toLowerCase() === resolve(paths.binPath).toLowerCase()) {
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
      `Error: branch "${branch}" does not match release/v<version> or prerelease/v<version>`
    );
    process.exit(1);
  }
  return match[1] as string;
}

function validateVersion(version: string): void {
  // Accept semver with optional prerelease suffix: 0.4.46, 0.4.46-0, 1.0.0-1
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error(
      `Error: "${version}" is not a valid semver version`
    );
    process.exit(1);
  }
}

async function getVersion(): Promise<string> {
  const arg = positional[0];
  if (!arg) {
    console.error(
      "Usage: bun run src/scripts/bump-version.ts <version|--from-branch>"
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
const DEFAULT_GITHUB_API_BASE = "https://api.github.com/repos/flora131/atomic";

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
    if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
        throw new Error("Set GITHUB_TOKEN to lift the 60 req/h anonymous limit");
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
export const WORKFLOW_OFFLOAD_RESUME_ATTEMPTED = "workflow.offload.resume.attempted" as const;
export const WORKFLOW_OFFLOAD_RESUME_SUCCEEDED = "workflow.offload.resume.succeeded" as const;
export const WORKFLOW_OFFLOAD_RESUME_FAILED = "workflow.offload.resume.failed" as const;

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
    .description("Internal: load a workflow definition and run the orchestrator panel")
    .argument("<workflowName>", "Workflow name (matches builtin registry)")
    .argument("<agent>", "claude | copilot | opencode")
    .argument("[inputsB64]", "Base64-encoded JSON record of structured inputs", "")
    .argument("[workflowSource]", "Workflow source path (dynamic-import fallback for non-builtin workflows in dev)", "")
    .action(async (
        workflowName: string,
        agent: string,
        inputsB64: string,
        workflowSource: string,
    ) => {
        const { isCompiledBinaryRuntime } = await import(
            "@bastani/atomic-sdk/lib/runtime-env"
        );
        
        if (isCompiledBinaryRuntime(workflowSource)) {
            // Compiled binary: resolve by name+agent in builtin registry
            const { createBuiltinRegistry } = await import(
                "./commands/builtin-registry.ts"
            );
            const resolved = createBuiltinRegistry().resolve(workflowName, agent);
            // ...
        } else {
            // Dev: dynamic-import workflow file
            const { runOrchestratorEntry } = await import(
                "@bastani/atomic-sdk/runtime/orchestrator-entry"
            );
            await runOrchestratorEntry(workflowSource, workflowName, agent, inputsB64);
        }
    });
```

---

## Pattern 14: Claude Integration Hooks (Stop, SessionStart, Ask, Inflight)

**Where:** `packages/atomic/src/cli.ts:399-464`
**What:** Hidden internal subcommands registered as Claude Code hook handlers for idle detection, user prompts, and lifecycle events.

```typescript
program
    .command("_claude-stop-hook", { hidden: true })
    .description("Internal: Claude Code Stop hook handler — writes a marker file for idle detection")
    .action(async () => {
        const { claudeStopHookCommand } = await import("@bastani/atomic-sdk/providers/claude-stop-hook");
        const exitCode = await claudeStopHookCommand();
        process.exit(exitCode);
    });

program
    .command("_claude-session-start-hook", { hidden: true })
    .description("Internal: Claude Code SessionStart hook handler — writes a ready-marker file")
    .action(async () => {
        const { claudeSessionStartHookCommand } = await import("./commands/cli/claude-session-start-hook.ts");
        const exitCode = await claudeSessionStartHookCommand();
        process.exit(exitCode);
    });

program
    .command("_claude-ask-hook", { hidden: true })
    .description("Internal: Claude Code AskUserQuestion hook handler — writes/removes HIL marker")
    .argument("<mode>", "enter (PreToolUse) or exit (PostToolUseFailure)")
    .action(async (mode: string) => {
        // ... mode validation
        const { claudeAskHookCommand } = await import("./commands/cli/claude-ask-hook.ts");
        const exitCode = await claudeAskHookCommand(mode);
        process.exit(exitCode);
    });

program
    .command("_claude-inflight-hook", { hidden: true })
    .description("Internal: Claude Code Subagent/TeammateIdle lifecycle hook handler")
    .argument("<mode>", "start (SubagentStart), stop (SubagentStop), or wait (TeammateIdle)")
    .action(async (mode: string) => {
        const { claudeInflightHookCommand } = await import("@bastani/atomic-sdk/providers/claude-inflight-hook");
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

## External References
<!-- Source: codebase-online-researcher sub-agent -->
# Online Research — Partition 3: `packages/atomic/` External Libraries

Researched libraries: `@commander-js/extra-typings` v14.0.0, Claude Code CLI hooks (affecting `@anthropic-ai/claude-agent-sdk` usage at the CLI surface), and `@github/copilot-sdk` v0.3.0 as used in `packages/atomic/src/`.

---

#### @commander-js/extra-typings (v14.0.0)
**Docs:** https://github.com/commander-js/extra-typings, https://www.npmjs.com/package/@commander-js/extra-typings  
**Relevant behaviour:**

`@commander-js/extra-typings` is a re-export wrapper around `commander@~14.0.0` that adds full TypeScript inference for options and arguments. The lockfile entry confirms the peer: `"peerDependencies": { "commander": "~14.0.0" }`.

Key API surface in active use across `packages/atomic/src/`:

- **`new Command(name?)`** — root program or subcommand. `createProgram()` (cli.ts:47) creates the root with `.name("atomic")`.
- **`.command(name, opts?)`** — registers a named subcommand; `{ isDefault: true }` makes it the fallback when no subcommand is given (cli.ts:73); `{ hidden: true }` hides from `--help` (cli.ts:325).
- **`.enablePositionalOptions()`** — prevents the parent from greedily binding flags meant for subcommands. Critical for `atomic workflow list -a claude` routing `-a` to `list` rather than the `workflow` dispatcher (cli.ts:53, workflow.ts:322).
- **`.passThroughOptions()`** — treats everything after a recognised flag as trailing args, allowing unknown flags to be forwarded to the underlying agent CLI (cli.ts:88).
- **`.allowUnknownOption(bool)`** — suppresses Commander's "unknown option" error for pass-through args (cli.ts:86, workflow.ts:364).
- **`.allowExcessArguments(bool)`** — same as above for positional excess (cli.ts:87).
- **`.addOption(new Option(flags).hideHelp())`** — registers an option while omitting it from `--help` output; used for the internal `--preflight-only` flag (cli.ts:83-84).
- **`.action(async (localOpts, cmd) => { … })`** — async action handler; `cmd.args` supplies the raw pass-through tokens (cli.ts:103).
- **`this.opts()`** inside an action — returns the fully-typed options object; used in `buildWorkflowCommand`'s action via `this` context (workflow.ts:369).
- **`.addCommand(cmd)`** — mounts a pre-built `Command` instance as a subcommand (cli.ts:172, workflowCommand is built separately then added).
- **`.configureOutput({ writeErr, outputError })`** — overrides Commander's error output with coloured stderr (cli.ts:60-67).
- **`.addHelpText("after", text)`** — appends usage examples after the auto-generated help section (cli.ts:89, workflow.ts:152).
- **`.requiredOption(flags, description)`** — errors if the flag is absent (cli.ts:198, 244).
- **`.argument("<pos>", description)`** and **`"[optional]"`** — typed positional argument declarations (cli.ts:329, 363).
- **Option value coercion functions** — the second argument to `.option()` can be a `(v) => T` coercer that validates at parse-time and throws to produce Commander's formatted error (workflow.ts:323-338, 341-353).
- **Dynamic option mutation at runtime** — `workflowCommand` strips and re-adds `--<input>` options on `rebuildWorkflowCommand()` by directly mutating the internals array (`options`) and calling `removeAllListeners`; this is an intentional use of Commander's EventEmitter inheritance (workflow.ts:118-151).
- **`program.parseAsync()`** — async entry point, called once in `main()` (cli.ts:613).

For the pi-rewrite context: if tmux-based workflow dispatch is removed, the hidden `_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook`, and `_runtime-assets-smoke` Commander subcommands (cli.ts:304-448) are all candidates for removal or replacement. The core `chat`, `workflow`, `session`, `config`, `install`, `uninstall`, `update`, and `completions` subcommands are non-tmux surface.

**Where used:**  
- `packages/atomic/src/cli.ts:26` — `import { Command, Option } from "@commander-js/extra-typings"` — root program construction  
- `packages/atomic/src/commands/cli/workflow.ts:21` — workflow dispatcher Command  
- `packages/atomic/src/commands/cli/management-commands.ts:10` — session sub-command builder (type import only)

---

#### Claude Code CLI Hook Contracts (consumed via `@anthropic-ai/claude-agent-sdk` v0.2.132 + CLI hooks)
**Docs:** https://code.claude.com/docs/hooks (local copy: `docs/claude-code/cli/hooks.md`), local research: `research/web/2026-04-19-claude-code-hook-askuserquestion.md`  
**Relevant behaviour:**

The atomic CLI registers four Claude Code hook handlers as hidden Commander subcommands. Each reads a JSON payload from stdin and returns exit 0 (never exit 2 from these handlers — an error from a hook shows as a red annotation in Claude's transcript, which is worse than a silently-missed signal).

**Stop hook** (`_claude-stop-hook`, `@bastani/atomic-sdk/providers/claude-stop-hook`):
- Fires when Claude finishes responding (once per turn). No matcher support; always fires on every stop.
- Stdin payload: `{ session_id: string, transcript_path?: string, cwd?: string, stop_hook_active?: boolean, last_assistant_message?: string, hook_event_name: "Stop" }`.
- `stop_hook_active: true` is set on every subsequent turn after the hook has returned `{ decision: "block", reason }` at least once. The implementation still writes the idle-marker and polls for queued prompts on every call regardless of `stop_hook_active` (confirmed by test: `claude-stop-hook.test.ts:90`).
- To block Claude from stopping (i.e., to inject a follow-up turn): stdout must be `{ "decision": "block", "reason": "<next prompt text>" }` with exit 0.
- To allow Claude to stop: exit 0 with no stdout (or any stdout that does not parse as JSON with `decision: "block"`).
- The hook is registered in `.claude/settings.json` as a command hook on the `Stop` event.

**SessionStart hook** (`_claude-session-start-hook`, `packages/atomic/src/commands/cli/claude-session-start-hook.ts`):
- Fires when a new Claude session starts (matcher value `"startup"`). Also fires for `resume`, `clear`, `compact` if no matcher is specified.
- Stdin payload: `{ session_id: string, source?: "startup"|"resume"|"clear"|"compact", transcript_path?: string, cwd?: string, model?: string, hook_event_name: "SessionStart" }`.
- Decision control: stdout text is added as context for Claude. Return `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }` for structured context injection.
- The atomic implementation writes a `~/.atomic/claude-ready/<session_id>` file immediately on receipt so the workflow runtime can resolve spawn-readiness via `fs.watch` without polling the transcript file.

**AskUserQuestion hook (PreToolUse / PostToolUse / PostToolUseFailure)** (`_claude-ask-hook`, `packages/atomic/src/commands/cli/claude-ask-hook.ts`):
- Fires on every `PreToolUse` for the `AskUserQuestion` tool (matcher string: `"AskUserQuestion"`).
- PreToolUse stdin payload: `{ session_id: string, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: unknown, tool_use_id: string, cwd?: string, permission_mode?: string }`.
- PostToolUse stdin payload: same with `hook_event_name: "PostToolUse"` and `tool_response: unknown` replacing no error field.
- The atomic handler writes `~/.atomic/claude-hil/<session_id>` on PreToolUse (enter) and unlinks it on PostToolUse/PostToolUseFailure (exit), allowing the workflow runtime's `fs.watch` watcher to fire `onHIL(true|false)`.
- `_claude-ask-hook` is invoked as `atomic _claude-ask-hook enter` for PreToolUse and `atomic _claude-ask-hook exit` for both PostToolUse and PostToolUseFailure.

**Inflight / TeammateIdle hook** (`_claude-inflight-hook`, `@bastani/atomic-sdk/providers/claude-inflight-hook`):
- SubagentStart/SubagentStop: fires when a Claude subagent spawns or finishes. Payload includes `agent_id`, `agent_type`, `hook_event_name: "SubagentStart"|"SubagentStop"`, `session_id`.
- TeammateIdle: fires when an agent team teammate is about to go idle. Payload includes `hook_event_name: "TeammateIdle"`, `session_id`, `teammate_name`, `team_name`.
- Decision for TeammateIdle: exit code 2 keeps the teammate running (feeds stderr back as feedback). JSON `{ "continue": false, "stopReason": "..." }` stops the teammate entirely. The atomic handler resolves root session IDs via a `.session-roots` mapping file to correctly bucket nested subagent markers under the originating root session.

**Claude Agent SDK auth probe** (via `@anthropic-ai/claude-agent-sdk`):
- `auth.ts:100` — `query({ prompt: emptyStream(), options: { pathToClaudeCodeExecutable } })` is called then `q.initializationResult()` is awaited. The `account` object in the result (`{ email?, tokenSource?, apiKeySource? }`) determines authentication status.
- The SDK's `query()` function starts the Claude CLI subprocess on construction; `q.close()` tears it down.

**Where used:**  
- `packages/atomic/src/commands/cli/claude-stop-hook.test.ts:22` — imports `claudeStopHookCommand, claudeHookDirs` from `@bastani/atomic-sdk/providers/claude-stop-hook`  
- `packages/atomic/src/commands/cli/claude-ask-hook.ts:23` — uses `claudeHookDirs()` to resolve `hil` directory  
- `packages/atomic/src/commands/cli/claude-session-start-hook.ts:20` — uses `claudeHookDirs().ready`  
- `packages/atomic/src/commands/cli/claude-inflight-hook.test.ts:23` — imports inflight hook + stop hook helpers  
- `packages/atomic/src/services/system/auth.ts:100` — `import { query } from "@anthropic-ai/claude-agent-sdk"` for auth probe

---

#### @github/copilot-sdk (v0.3.0)
**Docs:** `docs/copilot-cli/sdk.md`, local research: `research/web/2026-04-14-copilot-sdk-hil-events.md`  
**Relevant behaviour:**

In `packages/atomic/src/`, the Copilot SDK is used in one place only: the auth probe in `auth.ts`.

```typescript
const { CopilotClient } = await import("@github/copilot-sdk");
const client = new CopilotClient(copilotSdkLaunchOptions());
await client.start();
const status = await client.getAuthStatus();
// status.isAuthenticated: boolean
// status.statusMessage: string
// status.login: string (GitHub login handle)
await client.stop();
```

`copilotSdkLaunchOptions()` is provided by `@bastani/atomic-sdk/providers/copilot` which resolves the Copilot CLI binary path and any launch configuration.

The full SDK surface (`CopilotSession`, `session.on()`, `user_input.requested`, `session.idle`, etc.) is consumed at the SDK layer (`@bastani/atomic-sdk`), not directly in `packages/atomic/src/`. In `packages/atomic/`, the SDK is only used for the thin auth-check pattern above.

The Copilot SDK v0.3.0 adds `zod ^4.3.6` as a dependency (lockfile), meaning zod v4 is in the dependency tree. The `CopilotClient` API is a JSON-RPC wrapper: `start()` launches the Copilot CLI subprocess, `getAuthStatus()` sends an `auth.status` RPC call, `stop()` terminates the subprocess. No command-path resolution or scm-disable flags are exercised in this package's own source.

**Where used:**  
- `packages/atomic/src/services/system/auth.ts:75` — `const { CopilotClient } = await import("@github/copilot-sdk")` — Copilot auth probe only

---

#### @clack/prompts (v1.3.0)
**Docs:** https://github.com/bombshell-dev/clack, https://www.npmjs.com/package/@clack/prompts  
**Relevant behaviour:**

Used for interactive CLI prompts in three files:

- `session.ts:10` — `import { select, multiselect, confirm, isCancel, cancel }` — drives the session picker (single select), multi-select kill picker, and yes/no confirmation for session kill. The `select` and `multiselect` return a `symbol` when the user cancels (Ctrl+C); `isCancel(value)` detects this sentinel.
- `update.ts:17` — `import { spinner, log, note }` — `spinner()` wraps the async update download with a visual spinner; `log.success()` / `log.error()` for styled terminal output; `note()` for boxed informational panels.
- `config.ts:11` — `import { log }` — `log.success()` / `log.error()` for styled config-set feedback.

The `select` API: `await select({ message: string, options: Array<{ value, label, hint? }> })` — returns the selected `value` or a cancellation symbol. The `multiselect` API is analogous with checkboxes. The `spinner` API: `const s = spinner(); s.start(msg); … s.stop(msg);`.

**Where used:**  
- `packages/atomic/src/commands/cli/session.ts:10` — session picker and kill confirmation  
- `packages/atomic/src/commands/cli/update.ts:17` — update download spinner and log output  
- `packages/atomic/src/commands/cli/config.ts:11` — config set success/error log output

---

## Summary

Three libraries are central to the `packages/atomic/` CLI surface for the pi-rewrite:

**Commander.js (`@commander-js/extra-typings` v14.0.0)** is the foundation for the entire CLI. The rewrite must preserve `enablePositionalOptions()` + `passThroughOptions()` on the `chat` command, the `{ isDefault: true }` flag on chat, the `{ hidden: true }` pattern for all internal `_`-prefixed subcommands, and the dynamic option mutation pattern on `workflowCommand` (strip then re-add per-input options on registry rebuild). Seven hidden subcommands (`_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook`, `_runtime-assets-smoke`) are all tmux/Claude-hook specific and are primary candidates for replacement or removal under the pi-coding-agent rewrite.

**Claude Code CLI hook contracts** define the stdin JSON payload shapes for `Stop` (`{ session_id, stop_hook_active?, last_assistant_message? }`), `SessionStart` (`{ session_id, source?, model? }`), `PreToolUse` for `AskUserQuestion` (`{ session_id, tool_name, tool_input, tool_use_id }`), and `SubagentStart/Stop` + `TeammateIdle` (`{ session_id, agent_id?, hook_event_name }`). The pi-coding-agent will need equivalent hook equivalents or a different inter-process signalling mechanism to replace the marker-file approach these hooks drive. The critical contracts: Stop hook blocks by returning `{ decision: "block", reason }` on stdout with exit 0; all other hooks must exit 0 unconditionally to avoid red transcript annotations.

**Copilot SDK (`@github/copilot-sdk` v0.3.0)** is narrowly used in `packages/atomic/` only for the `CopilotClient.getAuthStatus()` auth probe pattern. The broader session event and HIL API is consumed by the SDK layer, not by this package directly. If Copilot is dropped from the pi-rewrite scope, the only removal in `packages/atomic/src/` is the `checkCopilotAuth()` branch in `auth.ts`.

**`@clack/prompts` v1.3.0** is a lightweight interactive prompt library providing `select`, `multiselect`, `confirm`, `spinner`, `log`, and `note`. It is used only in session management, update, and config commands — none of which are fundamentally tied to tmux or agent backends, making it safe to retain as-is in the rewrite.

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.
