# Partition 1 — `packages/atomic-sdk/` Deep Implementation Audit

## Files Analysed

- `packages/atomic-sdk/src/index.ts`
- `packages/atomic-sdk/src/define-workflow.ts`
- `packages/atomic-sdk/src/types.ts`
- `packages/atomic-sdk/src/registry.ts`
- `packages/atomic-sdk/src/primitives/run.ts`
- `packages/atomic-sdk/src/runtime/orchestrator-entry.ts`
- `packages/atomic-sdk/src/runtime/executor.ts` (read in four slices: 1–600, 600–1000, 1000–1500, 1500–2000)
- `packages/atomic-sdk/src/runtime/tmux.ts` (read in two slices: 1–200, 200–550)
- `packages/atomic-sdk/src/runtime/offload-manager.ts` (first 200 lines)
- `packages/atomic-sdk/src/providers/claude.ts` (two slices: 1–200, 200–500)
- `packages/atomic-sdk/src/providers/copilot.ts`
- `packages/atomic-sdk/src/providers/opencode.ts`
- `packages/atomic-sdk/src/lib/host-local-workflows.ts`
- `packages/atomic-sdk/src/services/config/definitions.ts`

---

## Per-File Notes

### `packages/atomic-sdk/src/index.ts`

- **Role:** Public SDK barrel that re-exports every consumer-facing symbol from the internal submodules.
- **Key symbols:**
  - `defineWorkflow` (`index.ts:20`) — re-exported from `define-workflow.ts`
  - `WorkflowBuilder`, `getCompiledWorkflows` (`index.ts:20`) — same source
  - `createRegistry` (`index.ts:21`) — re-exported from `registry.ts`
  - `hostLocalWorkflows` (`index.ts:25`) — re-exported from `lib/host-local-workflows.ts`
  - `runWorkflow` (`index.ts:84`) — re-exported from `primitives/run.ts`
  - `setExecutorTelemetrySinks`, `TelemetrySink` (`index.ts:92–93`) — re-exported from `runtime/executor.ts`
  - `listSessions`, `getSession`, `stopSession`, `attachSession`, `detachSession`, `nextWindow`, `previousWindow`, `gotoOrchestrator`, `getSessionStatus`, `getSessionTranscript` (`index.ts:96–107`) — session management from `primitives/sessions.ts`
  - `filterSpawnEnv`, `persistResume`, `OffloadManager`, `OffloadManagerDeps` (`index.ts:117–121`) — offload state machine surface from `runtime/offload-manager.ts`
  - All core types (`AgentType`, `WorkflowDefinition`, `WorkflowContext`, `SessionContext`, `SessionHandle`, `WorkflowInput`, etc.) — from `types.ts`
- **Control flow:** Pure re-exports plus two small utility functions `listWorkflows` (`index.ts:66`) and `getWorkflow` (`index.ts:71`) that delegate to `registry.list()` and `registry.resolve()`.
- **Data flow:** No transformation; just surface expansion.
- **Dependencies:** All internal siblings; no external libraries imported directly.

---

### `packages/atomic-sdk/src/define-workflow.ts`

- **Role:** Implements the `defineWorkflow()` factory and `WorkflowBuilder` DSL that workflow authors call at module-load time to register and compile a `WorkflowDefinition`.
- **Key symbols:**
  - `_captureCallerPath(stack?)` (`define-workflow.ts:48`) — walks V8 stack trace to extract the calling file's absolute path; exported with `_` prefix for unit testing only
  - `RESERVED_INPUT_NAMES` (`define-workflow.ts:140`) — `const` array of names (`name`, `agent`, `detach`, `list`, `help`, `version`, `session`, `status`) that collide with the Atomic CLI's `workflow` subcommand flags; validated in `validateWorkflowInput`
  - `validateWorkflowInput(input, workflowName)` (`define-workflow.ts:156`) — throws on empty/invalid name, reserved names, enum without values, and non-integer defaults
  - `WorkflowBuilder<A, I>` (`define-workflow.ts:217`) — generic class; holds `options`, `runFn`, and `agentValue`; exposes `.for(agent)`, `.run(fn)`, `.compile()` chain
  - `WorkflowBuilder.compile()` (`define-workflow.ts:284`) — seals the definition; freezes inputs; throws if `source` is empty (compiled-binary bunfs path); pushes into module-private `_compiledWorkflowRegistry`
  - `getCompiledWorkflows()` (`define-workflow.ts:121`) — returns snapshot of `_compiledWorkflowRegistry`; called by `_emit-workflow-meta` auto-dispatch
  - `defineWorkflow<I>(options)` (`define-workflow.ts:376`) — factory; calls `_captureCallerPath()` to auto-populate `source` if not explicitly supplied; returns `new WorkflowBuilder`
- **Control flow:** `defineWorkflow()` → `new WorkflowBuilder` → `.for(agent)` returns new builder with `agentValue` set → `.run(fn)` sets `runFn` on same builder → `.compile()` validates, freezes inputs, checks `agentValue !== null` and `source` non-empty, constructs `WorkflowDefinition` literal, pushes into `_compiledWorkflowRegistry`, returns sealed object.
- **Data flow:** Input: `WorkflowOptions<I>` (author-supplied at call site). Output: `WorkflowDefinition<A, I>` pushed into module-private registry and returned to caller. `source` is the auto-captured absolute path of the caller's file, used by `orchestrator-entry.ts` to `import()` the module inside the child process.
- **Dependencies:** `./types.ts` (type imports only); no external libraries.

---

### `packages/atomic-sdk/src/types.ts`

- **Role:** Single file declaring every public TypeScript type in the SDK, including agent-specific type maps that pin the SDK to Claude/Copilot/OpenCode SDKs.
- **Key symbols (agent-pinning imports):**
  - `import type { SessionEvent } from "@github/copilot-sdk"` (`types.ts:7`) — Copilot message type in `SavedMessage`
  - `import type { SessionPromptResponse } from "@opencode-ai/sdk/v2"` (`types.ts:8`) — OpenCode response type in `SavedMessage`
  - `import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk"` (`types.ts:9`) — Claude message type in `SavedMessage`
  - `import type { ClaudeClientWrapper, ClaudeSessionWrapper } from "./providers/claude.ts"` (`types.ts:25–26`)
  - `import type { CopilotClient, CopilotClientOptions, CopilotSession, SessionConfig as CopilotSessionConfig } from "@github/copilot-sdk"` (`types.ts:13–17`)
  - `import type { OpencodeClient, Session as OpencodeSession } from "@opencode-ai/sdk/v2"` (`types.ts:19–21`)
- **Key public types:**
  - `AgentType = AgentKey` (`types.ts:33`) — `"claude" | "copilot" | "opencode"` — the union controlling all agent dispatch
  - `ClientOptionsMap` (`types.ts:41–45`) — internal map of agent → client init options; `opencode: { directory?, experimental_workspaceID? }`, `copilot: Omit<CopilotClientOptions, "cliUrl">`, `claude: { chatFlags?: string[] }`
  - `SessionOptionsMap` (`types.ts:53–62`) — internal map of agent → session create options
  - `ClientMap` / `SessionMap` (`types.ts:65–76`) — internal maps of agent → resolved client/session types
  - `StageClientOptions<A>`, `StageSessionOptions<A>`, `ProviderClient<A>`, `ProviderSession<A>` (`types.ts:79–88`) — distributed type lookups over the maps above
  - `WorkflowInputType` (`types.ts:157`) — `"string" | "text" | "enum" | "integer"`
  - `WorkflowInput` (`types.ts:169`) — per-field schema: `name`, `type`, `required?`, `description?`, `placeholder?`, `default?`, `values?`
  - `InputsOf<I>` (`types.ts:206`) — conditional mapped type producing typed `ctx.inputs` from the literal input schema
  - `SessionContext<A, I>` (`types.ts:296`) — per-stage callback context: `client`, `session`, `inputs`, `agent`, `transcript(ref)`, `getMessages(ref)`, `save`, `sessionDir`, `paneId`, `sessionId`, `stage()` (nested)
  - `WorkflowContext<A, I>` (`types.ts:355`) — top-level callback context: `inputs`, `agent`, `stage()`, `transcript()`, `getMessages()`
  - `WorkflowDefinition<A, I>` (`types.ts:584`) — sealed output of `.compile()`: `__brand`, `name`, `agent`, `description`, `source`, `inputs`, `minSDKVersion`, `run(ctx)`
  - `SavedMessage` (`types.ts:237`) — discriminated union `{ provider: "copilot"; data: SessionEvent } | { provider: "opencode"; data: SessionPromptResponse } | { provider: "claude"; data: SessionMessage }`
  - `ExternalWorkflow` (`types.ts:485`) — workflow from `settings.json` with `source: { command, args }` instead of a file path
  - `BrokenWorkflow` (`types.ts:466`) — workflow that failed to load; carries `alias`, `origin`, `agents`, `reason`, `fix`
  - `RegistrableWorkflow` (`types.ts:506`) — discriminated union of builtin (`__brand: "WorkflowDefinition"`) and external shapes
  - `Registry<T>` (`types.ts:527`) — interface with `register()`, `upsert()`, `get()`, `has()`, `list()`, `resolve()` — immutable/chainable
  - `validateWorkflowSource(source, rules)` (`types.ts:121`) — regex-based source validation helper
  - `createProviderValidator(rules)` (`types.ts:141`) — curried factory returning a `(source: string) => ValidationWarning[]`
- **Data flow:** Pure type declarations and two pure functions (`validateWorkflowSource`, `createProviderValidator`). The agent-specific type imports are the load-bearing coupling point — replacing agent SDKs requires replacing these import lines and the `ClientMap`/`SessionMap`/options maps.
- **Dependencies:** `@github/copilot-sdk`, `@opencode-ai/sdk/v2`, `@anthropic-ai/claude-agent-sdk` (type-only imports); `./providers/claude.ts`, `./services/config/definitions.ts` (type-only).

---

### `packages/atomic-sdk/src/registry.ts`

- **Role:** Implements the `Registry<T>` interface as an immutable chainable `RegistryImpl` class keyed by `${agent}/${name}`, with provider-specific validation on registration.
- **Key symbols:**
  - `providerValidators` (`registry.ts:21–28`) — `Record<AgentType, (source: string) => ValidationWarning[]>` mapping to `validateClaudeWorkflow`, `validateOpenCodeWorkflow`, `validateCopilotWorkflow`
  - `runProviderValidation(wf)` (`registry.ts:37`) — calls `.run.toString()` on the workflow function body as source text, passes to the agent's validator
  - `validateAtRegistration(wf)` (`registry.ts:48`) — skips external workflows; calls `runProviderValidation` and `console.warn`s each warning
  - `RegistryImpl<T>` (`registry.ts:65`) — private `ReadonlyMap<string, WorkflowDefinition | ExternalWorkflow>`; `register()` throws on duplicates; `upsert()` allows silent replacement; `list()` returns `Object.freeze(Array.from(this.map.values()))`; `resolve(name, agent)` returns `this.map.get(`${agent}/${name}`)`
  - `createRegistry()` (`registry.ts:151`) — factory returning `new RegistryImpl(new Map())`
- **Control flow:** `createRegistry()` → `.register(wf)` clones map, validates, sets key, returns new `RegistryImpl`. `resolve(name, agent)` is the primary lookup path used by the picker and executor.
- **Data flow:** In: `RegistrableWorkflow` objects; out: typed `Registry<T>` accumulating registered entries as a type-level intersection. Validation is a side-effect (console.warn) — not a throw.
- **Dependencies:** `./types.ts`, `./providers/copilot.ts` (for `validateCopilotWorkflow`), `./providers/opencode.ts` (for `validateOpenCodeWorkflow`), `./providers/claude.ts` (for `validateClaudeWorkflow`).

---

### `packages/atomic-sdk/src/primitives/run.ts`

- **Role:** Public entry point for spawning a workflow; validates inputs then delegates to `executeWorkflow` in `runtime/executor.ts`.
- **Key symbols:**
  - `RunWorkflowOptions` (`run.ts:26`) — `workflow: RegistrableWorkflow`, `inputs?`, `cwd?`, `detach?`, `pathToAtomicExecutable?`
  - `RunWorkflowResult` (`run.ts:58`) — `{ id: string; tmuxSessionName: string }`
  - `runWorkflow(options)` (`run.ts:82`) — validates inputs via `validateInputs()`, casts `workflow as unknown as WorkflowDefinition`, calls `executeWorkflow({ definition, agent, inputs, projectRoot, detach, pathToAtomicExecutable })`
- **Control flow:** Module import triggers `../lib/auto-dispatch.ts` as a side-effect (`run.ts:16`) — this intercepts `_orchestrator-entry` and `_cc-debounce` argv before any user code runs. `runWorkflow()` calls `validateInputs(workflow, inputs)` then `executeWorkflow(...)`.
- **Data flow:** Raw `inputs: Record<string, string>` → validated/resolved via `validateInputs` → passed to executor as clean record. Returns `{ id, tmuxSessionName }` which the caller can use to attach or monitor.
- **Dependencies:** `../lib/auto-dispatch.ts` (side-effect import), `../runtime/executor.ts` (`executeWorkflow`), `../types.ts`, `./inputs.ts` (`validateInputs`).

---

### `packages/atomic-sdk/src/runtime/orchestrator-entry.ts`

- **Role:** SDK-owned entry point for the `_orchestrator-entry` CLI sub-command; resolves a `WorkflowDefinition` from a source path (dynamic import) or from the host registry, then runs the orchestrator.
- **Key symbols:**
  - `resolveWorkflowDefinition(sourcePath, workflowName, agent)` (`orchestrator-entry.ts:57`) — `import(sourcePath)` to load the module; checks `lookupLocalWorkflow(workflowName, agent)` first (host registry populated by `hostLocalWorkflows`); falls back to `mod.default` if it has `__brand: "WorkflowDefinition"`; throws `InvalidWorkflowError` if neither resolves
  - `runOrchestratorWithDefinition(def, inputsB64)` (`orchestrator-entry.ts:88`) — compiled-binary path; skips dynamic import, decodes inputs, calls `runOrchestrator(def, inputs)`
  - `runOrchestratorEntry(sourcePath, workflowName, agentRaw, inputsB64)` (`orchestrator-entry.ts:130`) — dev/installed-package path; validates agent via `isValidAgent`, resolves definition via `resolveWorkflowDefinition`, validates `def.agent === agent`, decodes inputs, calls `runOrchestrator(def, inputs)`
  - `decodeInputs(b64)` (`orchestrator-entry.ts:97`) — base64-decodes the inputs JSON payload; returns `{}` on any parse failure
- **Control flow:** The CLI's `_orchestrator-entry` sub-command calls `runOrchestratorEntry(sourcePath, workflowName, agentRaw, inputsB64)` in dev mode, or `runOrchestratorWithDefinition(def, inputsB64)` in compiled-binary mode (CLI has already done the registry lookup). Both paths end in `runOrchestrator(def, inputs)` from `executor.ts`.
- **Data flow:** Inputs arrive as base64-encoded JSON (set by `executeWorkflow` in `executor.ts:750`). Source path is the auto-captured `import.meta.path` of the workflow file. Output: side-effect of running the orchestrator panel (no return value to caller).
- **Dependencies:** `./executor.ts` (`runOrchestrator`), `../types.ts`, `../services/config/definitions.ts` (`isValidAgent`), `../errors.ts` (`InvalidWorkflowError`), `../lib/host-local-workflows.ts` (`lookupLocalWorkflow`).

---

### `packages/atomic-sdk/src/runtime/executor.ts`

- **Role:** Core workflow execution engine; implements `executeWorkflow()` (spawns the orchestrator tmux session), `runOrchestrator()` (runs inside that session), and `createSessionRunner()` (implements `ctx.stage()` lifecycle).
- **Key symbols:**
  - `AGENT_CLI` (`executor.ts:86–111`) — `Record<AgentType, { cmd, chatFlags, envVars }>` hard-coding `copilot` / `opencode` / `claude` CLI spawn settings including `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for Claude
  - `TelemetrySink` (`executor.ts:137`) — interface `{ emit(event, payload) }`; `setExecutorTelemetrySinks()` (`executor.ts:152`) injects custom sinks for testing
  - `buildPaneCommand(agent, overrides, extraChatFlags)` (`executor.ts:464`) — builds the shell command string for each agent's tmux window: copilot uses `--ui-server --port 0`, opencode uses `--port 0`, claude spawns `$SHELL` (CLI launched lazily by `createClaudeSession`)
  - `waitForServer(agent, paneId)` (`executor.ts:533`) — for copilot/opencode: polls `capturePane` until 3+ lines render, discovers port via `getListeningPortForPid(panePid)`, probes copilot SDK via `CopilotClient.start()` + `listSessions()`, returns `"localhost:<port>"`; for claude returns `""`
  - `executeWorkflow(options)` (`executor.ts:659`) — spawns the tmux session: resolves dispatcher, reconciles opencode instructions, generates `workflowRunId`, writes launcher shell script embedding the `_orchestrator-entry` command with base64 inputs, calls `tmux.createSession(sessionName, shellCmd, "orchestrator", ...)`, calls `spawnAttachedFooter`, optionally attaches or detaches
  - `initProviderClientAndSession<A>(agent, serverUrl, paneId, ...)` (`executor.ts:1589`) — switch over `agent`: copilot uses `new CopilotClient({ cliUrl: serverUrl })` + `client.createSession()` + `client.setForegroundSessionId()`; opencode uses `createOpencodeClient({ baseUrl: serverUrl })` or `createOpencode({ port: 0 })` for headless; claude uses `new ClaudeClientWrapper(paneId, opts)` + `client.start()` or headless `HeadlessClaudeClientWrapper`
  - `cleanupProvider<A>(agent, client, session, paneId)` (`executor.ts:1750`) — copilot: `session.disconnect()` + `client.stop()`; opencode: no-op; claude: `clearClaudeSession(paneId)` unless headless
  - `createSessionRunner(shared, parentName)` (`executor.ts:1861`) — returns the `ctx.stage()` function; manages: name uniqueness check → graph frontier inference → tmux window creation or headless path → `waitForServer` → `initProviderClientAndSession` → runs callback → cleanup → transcript/messages persistence
  - `wrapCopilotSend()` (`executor.ts:1238`) — wraps Copilot `session.send()` to block until `session.idle` fires
  - `watchOpencodeStreamForHIL(stream, sessionId, onHIL)` (`executor.ts:1303`) — consumes OpenCode SSE stream, calls `onHIL(true/false)` on `question.asked/replied/rejected`
  - `watchCopilotSessionForHIL(session, onHIL)` (`executor.ts:1355`) — tracks `ask_user` via `tool.execution_start/complete` events
  - `renderClaudeTranscript`, `renderCopilotTranscript`, `renderOpencodeTranscript`, `renderMessagesToText` (`executor.ts:978–1201`) — per-agent Markdown rendering of session messages
  - `discoverCopilotBinary()`, `shouldOverrideCopilotCliPath()`, `applyContainerEnvDefaults()` (`executor.ts:375–442`) — Bun-without-node detection for Copilot CLI path override
- **Control flow:**
  1. `executeWorkflow()` → writes launcher.sh → `tmux.createSession(...)` → optionally attaches
  2. Inside tmux pane: launcher.sh runs `atomic _orchestrator-entry <name> <agent> <inputsB64> <source>`
  3. `runOrchestratorEntry()` → `resolveWorkflowDefinition()` → `runOrchestrator(def, inputs)`
  4. `runOrchestrator()` initialises `OrchestratorPanel`, creates `SharedRunnerState`, builds `WorkflowContext` with `stage()` pointing to `createSessionRunner(shared, "orchestrator")`
  5. `definition.run(ctx)` is called — user workflow code runs; each `ctx.stage(opts, clientOpts, sessionOpts, fn)` invocation goes through `createSessionRunner`
  6. Inside `createSessionRunner`: name uniqueness → graph inference → `tmux.createWindow(...)` or headless → `waitForServer` → `initProviderClientAndSession` → callback `fn(sessionCtx)` → cleanup → writes `inbox.md` / `messages.json`
- **Data flow:** `executeWorkflow` takes `WorkflowRunOptions` → spawns tmux session → inside pane `runOrchestrator` takes `WorkflowDefinition` + `Record<string, string>` inputs → `ctx.stage()` takes `SessionRunOptions` + per-agent client/session opts → returns `SessionHandle<T>`. Transcripts written to `~/.atomic/sessions/<runId>/<name-sessionId>/inbox.md` and `messages.json`.
- **Dependencies:** `node:path`, `node:os`, `node:fs/promises`, `node:fs`, `bun` (Bun.sleep, Bun.which, Bun.write), `@github/copilot-sdk` (dynamic `import()` in `initProviderClientAndSession` and `waitForServer`), `@opencode-ai/sdk/v2` (dynamic import), `@anthropic-ai/claude-agent-sdk` (dynamic import in `wrapMessages`), `./tmux.ts`, `./port-discovery.ts`, `./attached-footer.ts`, `./offload-manager.ts`, `./graph-inference.ts`, `./status-writer.ts`, `./panel.tsx`, `../providers/claude.ts`, `../providers/opencode.ts`, `../providers/copilot.ts`, `../services/config/atomic-config.ts`, `../services/config/scm-sync.ts`, `../services/config/additional-instructions.ts`, `../services/system/copy.ts`, `../lib/self-exec.ts`, `../lib/terminal-env.ts`, `../lib/atomic-temp.ts`, `../lib/telemetry/index.ts`, `../theme/colors.ts`, `../errors.ts`.

---

### `packages/atomic-sdk/src/runtime/tmux.ts`

- **Role:** Low-level tmux (and psmux for Windows) abstraction; every tmux CLI invocation in the SDK passes through this file.
- **Key symbols:**
  - `SOCKET_NAME = "atomic"` (`tmux.ts:22`) — dedicated socket name isolating Atomic from the user's default tmux server
  - `getMuxBinary()` (`tmux.ts:54`) — resolves `tmux` (Unix) or `psmux`/`pmux` (Windows) via `Bun.which`; caches result
  - `tmuxRun(args)` → `TmuxResult` (`tmux.ts:116`) — runs `<binary> -f <config> -L atomic <args>` via `Bun.spawnSync`; returns `{ ok, stdout|stderr }`
  - `createSession(sessionName, initialCommand, windowName?, cwd?, envVars?, pathToAtomicExecutable?)` (`tmux.ts:185`) — `tmux new-session -d -s <name> -P -F #{pane_id} -e KEY=VALUE ... <cmd>`; also calls `tmux source-file <config>` to reload keybindings and `tmux set-option -g @atomic-cc-debounce <cmd>` to expose the cc-debounce command server-wide
  - `createWindow(sessionName, windowName, command, cwd?, envVars?)` (`tmux.ts:286`) — `tmux new-window -d -t <session> -n <window> -P -F #{pane_id} -e ... <cmd>`
  - `respawnPane(paneId, command)` (`tmux.ts:331`) — `tmux respawn-pane -k -t <paneId> <cmd>`; used by claude.ts to exec `claude ...` in a bare shell pane
  - `sendLiteralText(paneId, text)` (`tmux.ts:346`) — `tmux send-keys -t <pane> -l -- <text>`; normalises newlines to spaces
  - `sendViaPasteBuffer(paneId, text)` (`tmux.ts:363`) — writes text to a temp file, `tmux load-buffer <tmp>` then `tmux paste-buffer -t <pane> -d`; for large payloads
  - `sendSpecialKey(paneId, key)` (`tmux.ts:387`) — `tmux send-keys -t <pane> <key>`
  - `capturePane(paneId, start?)` (`tmux.ts:401`) — `tmux capture-pane -t <pane> -p [-S <start>]`
  - `killWindow(sessionName, windowName)` (`tmux.ts:470`) — async; refuses names in `RESERVED_WINDOW_NAMES` (`{"0", "orchestrator"}`); calls `tmux kill-window -t <session>:<window>`
  - `killSession(sessionName)` (`tmux.ts:445`) — `tmux kill-session -t <name>`; swallows errors
  - `getPanePid(paneId)` (`tmux.ts:517`) — `tmux display-message -t <pane> -p #{pane_pid}` → `number | null`
  - `getSessionEnv(sessionName, key)` (`tmux.ts:528`) — `tmux show-environment -t <session> <key>` → `string | null`
  - `killSessionOnPaneExit(sessionName, paneId)` (`tmux.ts:262`) — installs `pane-exited` and `after-kill-pane` hooks to kill the entire session when the agent pane exits; used for chat sessions
  - `RESERVED_WINDOW_NAMES` (`tmux.ts:459`) — `ReadonlySet<string>` containing `"0"` and `"orchestrator"` — prevents `killWindow` from destroying the orchestrator pane
- **Control flow:** All tmux operations pass through `tmuxRun()` which calls `Bun.spawnSync` with the full `[binary, "-f", configPath, "-L", "atomic", ...args]` argv. No shell interpolation — arguments are passed as an array. `createSession` additionally calls `tmuxRun(["source-file", CONFIG_PATH])` and sets the `@atomic-cc-debounce` user option.
- **Data flow:** Input: discrete args arrays. Output: pane IDs (strings like `"%12"`), stdout text, or void. Side effects: tmux server state mutations (sessions, windows, panes, hooks, options).
- **Dependencies:** `../lib/spawn.ts` (`requiredMuxBinaryCandidatesForPlatform`), `../lib/runtime-assets.ts` (`tmuxConfPath`), `../lib/self-exec.ts` (`buildSelfExecCommand`, `resolveDispatcher`), `node:fs` (`writeFileSync`, `unlinkSync`), `../lib/atomic-temp.ts` (`atomicTempPath`), `../lib/terminal-env.ts` (`normalizedTerminalEnv`).

---

### `packages/atomic-sdk/src/runtime/offload-manager.ts`

- **Role:** State machine for workflow pane offload and resume; persists resume metadata to `metadata.json` with a per-stage in-process mutex.
- **Key symbols:**
  - `filterSpawnEnv(env)` (`offload-manager.ts:49`) — allowlist filter over `process.env`; exact-deny set includes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`; suffix-deny pattern `/_(API_KEY|AUTH_TOKEN|SECRET|TOKEN|PASSWORD)$/i`; exact-allow set: `CLAUDECODE`, `PATH`, `HOME`, `LANG`, `SHELL`; prefix-allow: `ATOMIC_`, `LC_`, `OPENCODE_`, `COPILOT_`
  - `persistResume(stageDir, patch)` (`offload-manager.ts:122`) — queues writes via `_stageMutex` (per-stageDir promise chain); calls `_doPersist(metaPath, patch)`
  - `_doPersist(metaPath, patch)` (`offload-manager.ts:149`) — reads `metadata.json`, merges `patch` over existing `resume` sub-object (defaults → existing → patch; `schemaVersion` always `1`), writes atomically via `.tmp` rename at mode `0o600`
  - `OffloadResumeMetadata` schema (`offload-types.ts`) — `{ schemaVersion: 1, agentSessionId, tmuxSessionName, tmuxWindowName, spawnEnv, spawnCwd, chatFlags, lastPrompt, lastSeenAt, offloadedAt }`
- **Control flow:** `persistResume` is called by the executor when a session starts to record its resume-relevant state (tmux window name, agent session ID, chat flags, spawn environment). The mutex prevents concurrent writes for the same stage from corrupting the file. `doResume` (not read in this slice) reads the persisted metadata to respawn a killed/detached session.
- **Data flow:** In: `stageDir` path + `Partial<OffloadResumeMetadata>`. Out: updated `metadata.json` in that directory. The allowlist filter strips secrets from the `spawnEnv` field before persisting to disk (tokens are re-injected from the live `process.env` at resume time).
- **Dependencies:** `node:fs` (`promises as fs`), `node:path`, `./offload-types.ts`, `../components/orchestrator-panel-types.ts`, `../providers/claude.ts` (`claudeOffloadCleanup`).

---

### `packages/atomic-sdk/src/providers/claude.ts`

- **Role:** Claude Code provider — manages interactive Claude TUI sessions inside tmux panes via send-keys, the Claude Agent SDK (for headless mode and transcript reads), and a hook-based idle/ready/HIL detection mechanism.
- **Key symbols:**
  - `WORKFLOW_HOOK_SETTINGS` (`claude.ts:250`) — JSON object with `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle` hooks all pointing to `atomic _claude-<hook>-hook` sub-commands; `Stop` timeout set to `2_147_483` seconds (~24 days)
  - `createClaudeSession(options)` (`claude.ts:393`) — generates `randomUUID()` session ID, stores in `initializedPanes` map, writes PID file, returns session UUID; does NOT spawn `claude` yet (lazy spawn on first query)
  - `spawnClaudeWithPrompt(paneId, promptFile, chatFlags, sessionId)` (`claude.ts:431`) — calls `ensureWorkflowHookSettings()` to write JSON settings file, builds `claude [chatFlags] --settings <path> --session-id <uuid> "Read <file>"` command, calls `respawnPane(paneId, cmd)` to exec directly in the tmux pane (no shell race), then `waitForReadyMarker(sessionId)` to poll for `~/.atomic/claude-ready/<uuid>` file
  - `ensureWorkflowHookSettings()` (`claude.ts:472`) — writes `WORKFLOW_HOOK_SETTINGS` to a content-addressed temp file at `atomicContentTempPath("claude-settings-atomic", ".json", ...)` with mode `0o600`, returns path
  - `waitForReadyMarker(sessionId)` (`claude.ts:496`) — watches `~/.atomic/claude-ready/<uuid>` via `fs.watch`; resolves when file appears; `READY_HOOK_TIMEOUT_MS = 2_147_483_000`
  - `clearClaudeSession(paneId)` (`claude.ts:88`) — releases the Stop hook marker, waits for in-flight subagents via `waitForInflightDrained`, clears PID file, ready marker, and inflight tracking; called by executor during cleanup
  - `ClaudeClientWrapper` (class, `claude.ts` ~line 550+) — wraps a pane's Claude state; `start()` calls `createClaudeSession` and returns session UUID; exposes `paneId`, `sessionDir`, session-level state
  - `ClaudeSessionWrapper` (class) — session wrapper used by `initProviderClientAndSession`; `sessionId` is the Claude UUID; exposes `query()` for sending prompts
  - `HeadlessClaudeClientWrapper` / `HeadlessClaudeSessionWrapper` — headless path using `sdkQuery()` from `@anthropic-ai/claude-agent-sdk`; `query()` calls the Agent SDK directly
  - `buildClaudeResumeArgs(meta)` — builds `claude [chatFlags] --resume <sessionId> --settings <path>` argv for offload resume
  - `validateClaudeWorkflow(source)` — `createProviderValidator([...])` checking for forbidden direct SDK API usage
- **Control flow (interactive path):** `createClaudeSession(paneId)` → `claudeQuery(paneId, prompt)` (first call) → `spawnClaudeWithPrompt(paneId, promptFile, chatFlags, sessionId)` → `waitForReadyMarker(sessionId)` → prompt delivery → `waitForIdle(sessionId)` watching JSONL. Subsequent queries: `sendViaPasteBuffer` or `sendLiteralText` + `sendSpecialKey("C-m")` into the already-running Claude pane.
- **Control flow (headless path):** `new HeadlessClaudeClientWrapper()` → `client.start()` → `new HeadlessClaudeSessionWrapper(projectRoot)` → `session.query(prompt, opts)` calls `sdkQuery(...)` from `@anthropic-ai/claude-agent-sdk` directly.
- **Data flow:** Prompts written to temp files at `atomicContentTempPath`, delivered via tmux paste buffer or send-keys. Responses read from JSONL transcript at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (discovered via `getSessionMessages` from the Agent SDK). Hook markers written to `~/.atomic/claude-ready/`, `~/.atomic/claude-inflight/`, `~/.atomic/claude-hil/`.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk` (`getSessionMessages`, `query as sdkQuery`, `SessionMessage`, `SDKUserMessage`, `Options as SDKOptions`), `../runtime/tmux.ts` (`respawnPane`), `./claude-stop-hook.ts`, `./claude-inflight-hook.ts`, `../lib/workspace-paths.ts`, `../lib/runtime-env.ts`, `node:crypto`, `node:fs/promises`, `node:fs`, `node:path`.

---

### `packages/atomic-sdk/src/providers/copilot.ts`

- **Role:** Copilot provider utilities — CLI path resolution, subprocess env setup, session system message merging, resume arg building, and source validation.
- **Key symbols:**
  - `isCopilotShim(candidate)` (`copilot.ts:61`) — detects `.js`/`.mjs`/`.cjs` Node shims (the npm-installed wrappers that need `node` to run); checks file extension, `node_modules/.bin` symlink target, and shebang/npm-loader-marker in first 256 bytes
  - `resolveCopilotCliPath(resolveCommandPath?)` (`copilot.ts:100`) — checks `COPILOT_CLI_PATH` env first; then `getCommandPath("copilot")`; if it's a shim, enumerates `PATH` candidates to find a non-shim binary
  - `copilotSdkLaunchOptions()` (`copilot.ts:127`) — returns `CopilotClientOptions` with `env: copilotSubprocessEnv()` (UTF-8 locale + `NODE_NO_WARNINGS=1`) and optional `cliPath`
  - `mergeCopilotSystemMessage(existing, extra)` (`copilot.ts:154`) — merges additional instructions into copilot session `systemMessage`; respects `replace` mode
  - `buildCopilotResumeArgs(meta)` (`copilot.ts:187`) — returns `["--ui-server", "--port", "0", "--resume=<sessionId>", ...meta.chatFlags]`
  - `validateCopilotWorkflow` (`copilot.ts:199`) — `createProviderValidator` checking for `new CopilotClient` and `client.createSession` patterns
- **Data flow:** Pure utility functions; no persistent state. `resolveCopilotCliPath` reads filesystem and `process.env`.
- **Dependencies:** `node:fs` (`closeSync`, `existsSync`, `openSync`, `readSync`, `realpathSync`), `node:path`, `@github/copilot-sdk` (type imports), `../lib/terminal-env.ts`, `../runtime/offload-types.ts`, `../services/system/detect.ts`, `../types.ts`.

---

### `packages/atomic-sdk/src/providers/opencode.ts`

- **Role:** OpenCode provider utilities — headless env wrapper, resume arg building, and source validation.
- **Key symbols:**
  - `HEADLESS_OPENCODE_CLIENT_ID = "sdk"` (`opencode.ts:25`) — set as `OPENCODE_CLIENT` env var to suppress the interactive `question` tool in headless stages
  - `withHeadlessOpencodeEnv<T>(fn)` (`opencode.ts:48`) — reference-counted wrapper that sets `process.env.OPENCODE_CLIENT = "sdk"` around a `Bun.spawn`-time call and restores the prior value on exit
  - `buildOpencodeResumeArgs(meta)` (`opencode.ts:88`) — returns `["--port", "0", "--session", meta.agentSessionId, ...meta.chatFlags]`
  - `validateOpenCodeWorkflow` (`opencode.ts:100`) — `createProviderValidator` checking for `createOpencodeClient()` and `client.session.create()`
- **Data flow:** Pure functions; `withHeadlessOpencodeEnv` mutates and restores `process.env.OPENCODE_CLIENT` around the supplied async function.
- **Dependencies:** `../runtime/offload-types.ts`, `../types.ts`.

---

### `packages/atomic-sdk/src/lib/host-local-workflows.ts`

- **Role:** Allows SDK consumers (third-party CLIs) to register their workflows with the Atomic host and respond to Atomic's `_emit-workflow-meta` and `_atomic-run` dispatch sub-commands.
- **Key symbols:**
  - `localWorkflowRegistry` (`host-local-workflows.ts:73`) — `Map<string, HostableLocalWorkflow>` keyed by `${agent}:${name}`; module-scoped; populated by every `hostLocalWorkflows()` call
  - `lookupLocalWorkflow(name, agent)` (`host-local-workflows.ts:87`) — read-only accessor used by `runOrchestratorEntry` to resolve definitions without requiring `export default`
  - `hostLocalWorkflows(workflows, options?)` (`host-local-workflows.ts:182`) — registers all `workflows` into `localWorkflowRegistry`; scans `argv` for `_emit-workflow-meta` (emits JSON meta line + `process.exit(0)`) or `_atomic-run` (calls `runWorkflow()` + `process.exit(0)`); both sub-commands are token-gated via `validateDispatchToken`
  - `HOST_SUBS = new Set(["_emit-workflow-meta", "_atomic-run"])` (`host-local-workflows.ts:59`) — the two sub-commands this module handles
- **Control flow:** `hostLocalWorkflows([wf1, wf2])` → registers all into map → scans argv → if `_emit-workflow-meta` found and token valid: writes `ATOMIC_WORKFLOW_META: <json>\n` to stdout and exits. If `_atomic-run` found and token valid: parses `--name`, `--agent`, `--detach`, input flags from argv tail, finds workflow, calls `runWorkflow({workflow, inputs, detach})`, exits.
- **Data flow:** `workflows` array → `localWorkflowRegistry` map. `_emit-workflow-meta` output: JSON array of `{ name, description, agent, inputs, source, minSDKVersion }`. `_atomic-run` triggers `runWorkflow()` which delegates to `executeWorkflow()`.
- **Dependencies:** `../types.ts`, `../primitives/run.ts` (type-only; loaded dynamically via `await import(...)` at `_atomic-run` dispatch time), `./dispatch-utils.ts` (`validateDispatchToken`, `parseAtomicRunArgv`).

---

### `packages/atomic-sdk/src/services/config/definitions.ts`

- **Role:** Defines the `AgentKey` type and the `AGENT_CONFIG` record with per-agent configuration (CLI command, flags, env vars, config folder, install URL, onboarding files).
- **Key symbols:**
  - `AgentKey = "claude" | "copilot" | "opencode"` (`definitions.ts:61`) — the fundamental agent union; aliased as `AgentType` in `types.ts`
  - `AGENT_CONFIG: Record<AgentKey, AgentConfig>` (`definitions.ts:63`) — contains for each agent: `name`, `cmd`, `chat_flags`, `env_vars`, `folder` (`.claude`/`.opencode`/`.github`), `install_url`, `exclude`, `onboarding_files` (what to copy/merge into project and global agent config)
  - `isValidAgent(key)` (`definitions.ts:154`) — `key in AGENT_CONFIG` type guard
  - `getAgentConfig(key)`, `getAgentKeys()` — accessors
  - `ProviderConfigKind = "claude" | "opencode" | "github"` (`definitions.ts:10`) — identifies which embedded asset bundle to extract for onboarding
  - `EmbeddedAssetKind = ProviderConfigKind | "skills"` (`definitions.ts:16`)
  - `ProviderOverrides` (`definitions.ts:149`) — `{ chatFlags?: string[]; envVars?: Record<string, string> }` — per-provider user overrides from `settings.json`
  - Claude `onboarding_files` (`definitions.ts:76–98`): copies `.mcp.json` (merge), `settings.json` to `.claude/settings.json` (merge), and `settings.json` to `~/.claude/settings.json` (merge, excluding `disabledMcpjsonServers`)
  - OpenCode `onboarding_files` (`definitions.ts:108–115`): copies `opencode.json` to `.opencode/opencode.json` (merge)
  - Copilot `onboarding_files` (`definitions.ts:125–136`): copies `.mcp.json` sourced from `claude` bundle (shared config)
- **Data flow:** Static data record consumed by: executor (`AGENT_CLI` mirrors `chat_flags`/`env_vars`), config service (`getProviderOverrides`), onboarding commands in `packages/atomic`.
- **Dependencies:** None (pure type/data declarations).

---

## Cross-Cutting Synthesis

The SDK engine layers cleanly into four strata:

1. **DSL stratum** (`define-workflow.ts`, `types.ts`, `registry.ts`): Agent-agnostic. `defineWorkflow().for(agent).run(fn).compile()` produces a sealed `WorkflowDefinition` stored in a module-private registry and stamped with the caller's source path. The only agent coupling is in `types.ts`'s `ClientMap`/`SessionMap`/`SavedMessage` union which imports from the three external SDKs.

2. **Dispatch stratum** (`primitives/run.ts`, `lib/host-local-workflows.ts`, `lib/auto-dispatch.ts`): Routes between "user invokes `runWorkflow()`" and "Atomic CLI dispatches `_orchestrator-entry` / `_atomic-run` / `_emit-workflow-meta`". The `auto-dispatch.ts` side-effect fires on module import; `host-local-workflows.ts` handles third-party CLI consumers. Both paths ultimately call `executeWorkflow()`.

3. **Execution stratum** (`runtime/executor.ts`, `runtime/orchestrator-entry.ts`, `runtime/tmux.ts`): 100% tmux-coupled. `executeWorkflow()` writes a launcher shell script, calls `tmux.createSession(...)`, then attaches. Inside the tmux pane, `runOrchestratorEntry()` resolves the definition and calls `runOrchestrator()`, which builds `WorkflowContext` and calls `definition.run(ctx)`. Each `ctx.stage()` call creates a tmux window via `createWindow()`, waits for the agent server, inits provider client/session via the agent-specific `initProviderClientAndSession` switch, and runs the user callback. Transcripts and messages are persisted under `~/.atomic/sessions/`.

4. **Provider stratum** (`providers/claude.ts`, `providers/copilot.ts`, `providers/opencode.ts`): One file per agent SDK. Claude uses send-keys + SessionStart/Stop hooks + the Agent SDK for headless and transcript reads. Copilot uses `@github/copilot-sdk` CopilotClient with `cliUrl` pointing at the tmux-pane CLI server. OpenCode uses `@opencode-ai/sdk/v2` createOpencodeClient or createOpencode for headless. This stratum is 100% removable and replaceable with a pi-coding-agent provider adapter.

The architectural seam is `initProviderClientAndSession`'s `switch (agent)` at `executor.ts:1610` — this is the single function where all three agent SDKs are invoked. Replacing the three cases with a single pi-agent call is the primary inversion point for the rewrite.

---

## Out-of-Partition References

- `packages/atomic/src/cli.ts` — CLI entry point that registers the `_orchestrator-entry`, `_cc-debounce`, `_claude-stop-hook`, `_claude-session-start-hook`, `_claude-ask-hook`, `_claude-inflight-hook` sub-commands dispatched by the SDK's internal mechanisms
- `packages/atomic/src/commands/` — Command files implementing `atomic workflow`, `atomic chat`, `atomic workflow session connect/kill/list`, `atomic workflow status` — these are the external callers of `runWorkflow()` and `executeWorkflow()`
- `packages/atomic/src/lib/telemetry/offload-events.ts` — Telemetry event-name constants mirrored (not imported) in `offload-manager.ts:13–22` to avoid cross-package dependency
- `packages/atomic-sdk/src/components/orchestrator-panel.tsx` — `OrchestratorPanel` class used by `executor.ts`'s `runOrchestrator()` as the TUI root for the workflow graph view
- `packages/atomic-sdk/src/runtime/offload-manager.ts` (full body) — `doResume()`, `createOffloadManager()`, `OffloadManager` interface — only the `persistResume` / `filterSpawnEnv` surface was read; the full state machine (resume, rollback, eligibility) was not
- `packages/atomic-sdk/src/runtime/graph-inference.ts` — `GraphFrontierTracker` class used inside `createSessionRunner` for DAG parent inference
- `packages/atomic-sdk/src/runtime/port-discovery.ts` — `getListeningPortForPid()` used by `waitForServer()` to discover the agent CLI's listening TCP port from `/proc/<pid>/fd` on Linux
- `packages/atomic-sdk/src/runtime/attached-footer.ts` — `spawnAttachedFooter()` called by `executeWorkflow()` and `createSessionRunner()` for each stage pane
- `packages/atomic-sdk/src/providers/claude-stop-hook.ts` — `claudeHookDirs()` and Stop hook registration used by `claude.ts`
- `packages/atomic-sdk/src/providers/claude-inflight-hook.ts` — `clearInflightTracking()`, `waitForInflightDrained()` used by `clearClaudeSession()`
- `packages/atomic-sdk/src/lib/auto-dispatch.ts` — side-effect module imported by `primitives/run.ts`; handles `_orchestrator-entry` and `_cc-debounce` argv at process start
- `packages/atomic-sdk/src/lib/self-exec.ts` — `buildSelfExecCommand()`, `resolveDispatcher()` — builds the re-exec command line for orchestrator launch
- `packages/atomic-sdk/src/services/config/atomic-config.ts` — `getProviderOverrides(agent, projectRoot)` called by `executeWorkflow()` to merge user settings
- `packages/atomic-sdk/src/services/config/additional-instructions.ts` — `resolveAdditionalInstructionsContent(projectRoot)` used by both `initProviderClientAndSession` (Copilot) and OpenCode instructions reconciliation
- `packages/atomic-sdk/src/workflows/builtin/` — builtin workflow definitions (ralph, deep-research-codebase, open-claude-design) × 3 agents; these use `ctx.stage()` and reference provider-specific APIs
