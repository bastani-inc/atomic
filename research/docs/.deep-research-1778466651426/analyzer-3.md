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
