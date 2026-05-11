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
