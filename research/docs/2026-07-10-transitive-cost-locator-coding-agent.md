I’m unable to write `/workspaces/atomic/research/docs/2026-07-10-transitive-cost-locator-coding-agent.md` or update `/workspaces/atomic/progress.md` because this subagent only has read/search/list tools available and no edit/write tool. Below are the requested read-only locator findings.

## File Locations for specs/2026-07-10-transitive-cost-status-bar.md / issue #1636

### Spec
- `specs/2026-07-10-transitive-cost-status-bar.md` - Target spec file exists.

---

## AgentSession Construction / SDK Interface

### Implementation Files
- `packages/coding-agent/src/core/sdk.ts`
  - `createAgentSession()` exported at line 107.
  - Re-exports SDK types at lines 46-49.
  - Creates/uses `SessionManager` at lines 130-132.
  - Checks existing session context at lines 157-159.
- `packages/coding-agent/src/core/sdk-types.ts`
  - `CreateAgentSessionOptions` exported at line 11.
  - `sessionManager?: SessionManager` option at line 67.
  - `CreateAgentSessionResult` exported at line 78.
  - `session: AgentSession` result at line 80.
- `packages/coding-agent/src/core/agent-session.ts`
  - `AgentSession` class exported at line 68.
  - Constructor `constructor(config: AgentSessionConfig)` at line 130.
  - Prototype method installation at lines 164-181.
  - Interface merge `export interface AgentSession extends AgentSessionPublicSurface {}` at line 162.
- `packages/coding-agent/src/core/agent-session-types.ts`
  - `AgentSessionConfig` exported at line 144.
  - Config fields include `agent`, `sessionManager`, `settingsManager`, `cwd`, `resourceLoader`, `customTools`, `modelRegistry`, etc. at lines 145-160.
  - `AgentSessionEvent` exported at line 29.
  - `AgentSessionEventListener` exported at line 70.
- `packages/coding-agent/src/core/agent-session-methods.ts`
  - `AgentSessionMethodSurface` exported at line 77.
  - `AgentSessionPublicSurface` exported at line 251.
  - `AgentSessionInternalSurface` exported at line 333.

### Runtime / Replacement Session Files
- `packages/coding-agent/src/core/agent-session-runtime.ts`
  - `CreateAgentSessionRuntimeResult` exported at line 23.
  - `CreateAgentSessionRuntimeFactory` exported at line 35.
  - `AgentSessionRuntime` class exported at line 74.
  - Runtime constructor at lines 84-90.
  - `newSession(options?: { parentSession?: string; setup?: ...; withSession?: ... })` starts at line 224.
  - `parentSession` option forwarded to `sessionManager.newSession()` at lines 237-238.
  - Fork path sets `parentSession: currentSessionFile` at lines 293-294.
  - Clone/new branch path uses `parentSession: this.session.sessionFile` at lines 327-328.
  - `createAgentSessionRuntime()` exported at line 405.
  - Re-exports `createAgentSessionFromServices`, `createAgentSessionServices`, runtime service types at lines 425-431.
- `packages/coding-agent/src/core/agent-session-services.ts`
  - `AgentSessionRuntimeDiagnostic` exported at line 27.
  - `createAgentSessionServices()` exported at line 141.
  - `createAgentSessionFromServices()` exported at line 203; calls `createAgentSession()` at line 206.
- `packages/coding-agent/src/index.ts`
  - Public exports include `CreateAgentSessionOptions`, `CreateAgentSessionResult`, runtime types, and factories at lines 161-175.
- `packages/coding-agent/src/core/index.ts`
  - Core exports include `AgentSessionRuntime`, `CreateAgentSessionRuntimeFactory`, `createAgentSessionRuntime` at lines 15-18.
  - Core exports include service factory types/functions at lines 21-26.

### Tests
- `packages/coding-agent/test/agent-session-branching.test.ts`
  - Imports `AgentSessionRuntime`, `CreateAgentSessionRuntimeFactory`, `createAgentSessionFromServices`, `createAgentSessionRuntime`, `createAgentSessionServices` at lines 17-22.
  - Creates `SessionManager` at line 49.
  - Defines `createRuntime` factory at line 63.
- Multiple `packages/coding-agent/test/agent-session-*.test.ts` / `.suite.ts` construct `new AgentSession({ ... })`, including:
  - `agent-session-async-bash.test.ts` lines 72-81.
  - `agent-session-auth-load-failure.test.ts` lines 76-81.
  - `agent-session-auto-compaction-overflow-await.suite.ts` lines 49-55.
  - `agent-session-auto-compaction-queue-03.suite.ts` lines 72-78.
  - `agent-session-compaction.test.ts` lines 65-72.

---

## Self Usage / Cost / Context Computation

### Implementation Files
- `packages/coding-agent/src/core/agent-session-export.ts`
  - `getSessionStats()` exported at line 13.
  - Sums assistant `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`, and `usage.cost.total` at lines 26-35.
  - Returns `tokens`, `cost`, and `contextUsage: this.getContextUsage()` at lines 38-55.
  - `getContextUsage()` exported at line 59.
  - Uses current model context window at lines 60-64.
  - Checks post-compaction assistant usage boundary at lines 66-92.
  - Uses `estimateContextTokens(this.messages)` at line 95.
  - Returns `{ tokens, contextWindow, percent }` at lines 98-102.
  - `agentSessionExportMethods` exports `getSessionStats`, `getContextUsage`, etc. at lines 233-238.
- `packages/coding-agent/src/core/compaction/compaction.ts`
  - `calculateContextTokens(usage: Usage)` exported at line 37.
  - Handles input/output/cacheRead/cacheWrite/totalTokens at lines 38-48.
  - `getLastAssistantUsage(entries: SessionEntry[])` exported at line 68.
  - `ContextUsageEstimate` exported at line 79.
  - `estimateContextTokens(messages: AgentMessage[])` exported at line 98.
  - Computes `usageTokens + trailingTokens` at lines 114-125.
- `packages/coding-agent/src/core/extensions/context-types.ts`
  - `ContextUsage` exported at line 10.
  - Fields: `tokens: number | null`, `contextWindow: number`, `percent: number | null` at lines 11-15.
  - `ExtensionContext.getContextUsage()` at lines 79-80.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts`
  - Binds extension context `getContextUsage: () => this.getContextUsage()` at line 209.
- `packages/coding-agent/src/core/agent-session-methods.ts`
  - Public method surface includes `getSessionStats()` and `getContextUsage()` at lines 242-243.
- `packages/coding-agent/src/core/agent-session-types.ts`
  - `SessionStats` exported at line 185.
  - `tokens` fields at lines 193-199.
  - `cost: number` at line 200.
  - `contextUsage?: ContextUsage` at line 201.

### Provider / External Cost Calculation References
- `packages/coding-agent/docs/custom-provider.md`
  - Imports `calculateCost` from `@earendil-works/pi-ai` at lines 369-370.
  - Usage update and `calculateCost(model, output.usage)` example at lines 501-510.
  - Provider model `cost` shape documented at lines 615-619.
- `packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts`
  - Imports `calculateCost` at lines 7-8.
  - Calls `calculateCost(model, output.usage)` at lines 366-367 and 447-448.

### Tests
- `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts`
  - Mocks `calculateContextTokens` at lines 42-48.
  - Mocks `estimateContextTokens` walking assistant usage at lines 57-73.
  - Mocks `shouldCompact` at lines 77-81.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-02.suite.ts`
  - Mocks `calculateContextTokens` at lines 41-47.
  - Mocks `estimateContextTokens` at lines 56-72.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-03.suite.ts`
  - Imports compaction constants at lines 8-11.
  - Mocks `calculateContextTokens` at lines 39-40.
  - Mocks `estimateContextTokens` at lines 35 and 43-44.

---

## Footer Usage Rendering / Usage Meter

### Implementation Files
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
  - `getUsageLine()` internal usage renderer begins around line 44.
  - Sums cumulative usage from all session entries at lines 45-64.
  - Uses `session.getContextUsage()` at line 69.
  - Computes context window/percent display at lines 70-74.
  - Builds token display parts for input/output/cache read/cache write at lines 76-92.
  - Adds cache hit rate at lines 93-94.
  - Detects OAuth subscription via `session.modelRegistry.isUsingOAuth(state.model)` at lines 97-100.
  - Adds cost display `$${totalCost.toFixed(3)}` and optional `(sub)` at lines 101-104.
  - Builds context percentage/window display at lines 107-119.
  - Returns right-aligned usage text at lines 122-127.
  - `formatCwdForFooter()` exported at line 130.
  - `UsageMeterComponent` exported at line 148.
  - `UsageMeterComponent.invalidate()` at lines 165-167.
  - `UsageMeterComponent.render()` at lines 169-170.
  - `FooterComponent` exported at line 178.
  - `FooterComponent.invalidate()` at lines 202-203.
  - `FooterComponent.render()` at line 214.
- `packages/coding-agent/src/core/footer-data-provider.ts`
  - `FooterDataProvider` exported at line 102.
  - Git watcher start at line 130.
  - Refresh path calls around line 232.
  - `ReadonlyFooterDataProvider` exported at lines 467-470.
- `packages/coding-agent/src/modes/interactive/components/index.ts`
  - Component barrel exports include nearby component exports; footer exports are in this cluster.

### Examples
- `packages/coding-agent/examples/extensions/custom-footer.ts`
  - Adds assistant output and `m.usage.cost.total` at lines 39-40.
- `packages/coding-agent/examples/extensions/border-status-editor.ts`
  - Calls `ctx.getContextUsage()` at lines 50-51.

---

## `/context` Slash Command and Command Registry

### Existing Slash Command Registry
- `packages/coding-agent/src/core/slash-commands.ts`
  - `SlashCommandSource` exported at line 10.
  - `SlashCommandInfo` exported at line 12.
  - `BuiltinSlashCommand` exported at line 19.
  - `BUILTIN_SLASH_COMMANDS` exported at line 163.
  - Existing built-ins include:
    - `settings`, `model`, `scoped-models`, `fast` at lines 164-167.
    - `export`, `import`, `share` at lines 168-170.
    - `copy`, `name`, `session`, `changelog` at lines 171-174.
    - `fork`, `clone`, `tree`, `trust`, `login`, `logout`, `new`, `compact`, `resume`, `reload`, `exit`, `quit` at lines 181-192.
  - No `/context` entry found in `BUILTIN_SLASH_COMMANDS`.
  - `BUNDLED_EXTENSION_SLASH_COMMANDS` exported at line 195.
- `packages/coding-agent/src/modes/interactive/interactive-autocomplete.ts`
  - Imports `BUILTIN_SLASH_COMMANDS` and `BUNDLED_EXTENSION_SLASH_COMMANDS` at line 2.
  - Builds `slashCommands` from `BUILTIN_SLASH_COMMANDS` at lines 178-181.
  - Builds skill command list at lines 269-276.
- `packages/coding-agent/src/modes/interactive/interactive-mode-helpers.ts`
  - `BUILTIN_SLASH_COMMAND_NAMES` built from `BUILTIN_SLASH_COMMANDS` at lines 59-60.
- `packages/coding-agent/src/modes/interactive/interactive-mode-deps.ts`
  - Re-exports `BUILTIN_SLASH_COMMANDS`, `BUNDLED_EXTENSION_SLASH_COMMANDS` at line 27.

### Existing Slash Command Handling
- `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts`
  - Handles `/session` at lines 318-321.
  - Handles `/tree` at lines 348-350.
  - Handles `/new` at lines 368-370.
  - Handles `/compact` at lines 373-379.
  - Handles `/resume` at lines 403-405.
  - No `/context` handler found in this file.
- `packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts`
  - `handleReloadCommand()` installed at line 5.
  - `handleExportCommand()` installed at line 101.
  - `handleImportCommand()` installed at line 148.
  - `handleShareCommand()` installed at line 210.
  - `handleCopyCommand()` installed at line 318.
  - `handleNameCommand()` installed at line 333.
  - `handleSessionCommand()` installed at line 357.
  - `handleChangelogCommand()` installed at line 394.
  - `handleSessionCommand()` displays `this.session.getSessionStats()` at lines 357-358 and session name/file/id at lines 359-366.
  - No `handleContextCommand` found.
- `packages/coding-agent/src/modes/interactive/interactive-mode-surface.ts`
  - Declares command methods including `handleSessionCommand()` at lines 254-255.
  - Declares `handleCompactCommand()` at line 267.
  - No `handleContextCommand` declaration found.
- `packages/coding-agent/src/core/agent-session-prompt.ts`
  - `_tryExecuteBuiltinSlashCommand()` exported at line 216; currently checks `ATOMIC_GUIDE_COMMAND_NAME` at lines 216-219.

### Chat Session Host Slash Command Hook
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-actions.ts`
  - Checks `state.commands.handleSlashCommand` for text starting `/` at lines 45-47.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-types.ts`
  - `handleSlashCommand?: (text: string) => Promise<boolean> | boolean` at line 49.

---

## Event Bus / `pi.events`

### Implementation Files
- `packages/coding-agent/src/core/event-bus.ts`
  - `EventBus` exported at line 3.
  - `EventBusController` exported at line 8.
  - `createEventBus()` exported at line 12.
  - Uses `EventEmitter` at line 13.
- `packages/coding-agent/src/core/extensions/api-types.ts`
  - Imports `EventBus` at line 5.
  - Extension API field `events: EventBus` at lines 314-315.
- `packages/coding-agent/src/core/extensions/loader-api.ts`
  - `createExtensionAPI(..., eventBus: EventBus, ...)` includes `eventBus` parameter at lines 32-33.
  - Sets `events: eventBus` at line 205.
- `packages/coding-agent/src/core/extensions/loader-core.ts`
  - Imports `createEventBus`, `EventBus` at line 3.
  - Accepts/passes `eventBus` through load functions at lines 45-47, 90-92, 116-118, 166-168, 184-186.
  - Defaults to `eventBus ?? createEventBus()` at line 127.
- `packages/coding-agent/src/core/resource-loader-core.ts`
  - Imports `createEventBus`, `EventBus` at line 2.
  - `eventBus` field at line 34.
  - Defaults `this.eventBus = options.eventBus ?? createEventBus()` at line 99.
- `packages/coding-agent/src/core/resource-loader-types.ts`
  - `eventBus?: EventBus` option at line 71.
- `packages/coding-agent/src/core/index.ts`
  - Exports `createEventBus`, `EventBus`, `EventBusController` at line 30.
- `packages/coding-agent/src/index.ts`
  - Public package exports `createEventBus`, `EventBus`, `EventBusController` at line 123.

### Documentation
- `packages/coding-agent/docs/extensions.md`
  - `### pi.events` section starts at line 1644.
  - Documents `pi.events.on(...)` and `pi.events.emit(...)` at lines 1649-1650.
  - Examples table references `event-bus.ts` / `pi.events` at lines 2692-2693.

---

## UI `requestRender` / Usage-Meter Invalidation

### Implementation Files
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
  - `UsageMeterComponent.invalidate()` exists at lines 165-167; comment says render pulls live session data.
  - `UsageMeterComponent.render()` at lines 169-170.
  - `FooterComponent.invalidate()` exists at lines 202-203.
- `packages/coding-agent/src/modes/interactive/chat-input-actions.ts`
  - `ExternalEditorHost.requestRender(force?: boolean)` at line 16.
  - `ClipboardImageEditorTarget` path calls `requestRender?.()` at line 149.
  - External editor host type uses `Pick<TUI, "stop" | "start" | "requestRender">` at lines 159-161.
  - Calls `host.requestRender(true)` at line 213.
- `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts`
  - `ChatMessageRenderOptions` has `ui: Pick<TUI, "requestRender">` at lines 24-25.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-actions.ts`
  - Calls `state.requestRender?.()` in multiple lifecycle paths:
    - line 35
    - line 50
    - line 83
    - lines 89-90
    - line 117
    - line 133
    - line 147
    - line 173
    - line 195
    - line 230
    - line 237
    - line 255
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-state.ts`
  - `requestRender` field at lines 39-41.
  - Assigned from opts at lines 84-87.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-types.ts`
  - `requestRender?: () => void` option at lines 55-57.
- `packages/coding-agent/src/modes/interactive/components/armin.ts`
  - Calls `this.ui.requestRender()` at line 185.
- `packages/coding-agent/src/modes/interactive/components/countdown-timer.ts`
  - Calls `this.tui?.requestRender()` at line 30.
- `packages/coding-agent/src/modes/interactive/components/model-selector.ts`
  - Calls `this.tui.requestRender()` after models are loaded at line 134.
- `packages/coding-agent/src/cli/config-selector.ts`
  - Calls `ui.requestRender()` at line 45.
- `packages/coding-agent/src/cli/session-picker.ts`
  - Calls `ui.requestRender()` at line 44.
- `packages/coding-agent/src/cli/startup-ui.ts`
  - Calls `ui.requestRender()` at line 18.

---

## Session Persistence / Load / Resume / Session Headers / Parent Session

### Session Types / Header
- `packages/coding-agent/src/core/session-manager-types.ts`
  - `CURRENT_SESSION_VERSION = 3` at line 5.
  - `SessionWorkflowMetadata` exported at line 12.
  - `SessionHeader` exported at line 18.
  - Header fields include `type`, `version`, `id`, `timestamp`, `cwd`, `parentSession`, `internal`, `workflow` at lines 19-28.
  - `parentSession?: string` at line 24.
  - `NewSessionOptions` exported at line 31.
  - `NewSessionOptions.parentSession?: string` at line 33.
  - `SessionInfo.parentSessionPath?: string` at lines 195-203.
  - `ReadonlySessionManager` begins at line 222.
- `packages/coding-agent/src/core/session-manager-entries.ts`
  - `createSessionHeader()` exported at line 34.
  - `parentSession?: string` parameter at line 38.
  - Assigns `header.parentSession = parentSession` at line 49.
  - `createSessionFilePath()` exported at line 55.
  - `getEntriesWithoutHeader()` exported at line 220.
- `packages/coding-agent/src/core/agent-session-export.ts`
  - `exportToJsonl()` writes session header and branch entries.
  - Comment says “Writes the session header followed by all entries on the current branch path” at lines 133-134.
  - Constructs `const header: SessionHeader = { ... }` at lines 149-158.

### SessionManager Core
- `packages/coding-agent/src/core/session-manager-core.ts`
  - `SessionManager` class exported at line 57.
  - Constructor calls `this.newSession(newSessionOptions)` at lines 86-87.
  - `setSessionFile(sessionFile: string)` at line 92.
  - Loads entries via `loadEntriesFromFile(this.sessionFile)` at line 95.
  - `newSession(options?: NewSessionOptions)` at line 126.
  - Passes `options?.parentSession` to `createSessionHeader()` at lines 135-137.
  - Creates session file path at line 147.
  - `getSessionDir()` at line 182.
  - `getSessionFile()` at line 194.
  - `getHeader()` at line 356.
  - Branch/session creation logic around lines 399-430.
  - `SessionManager.list()` static method at lines 469-475.
  - `SessionManager.listAll()` area starts after line 478 in same file.
- `packages/coding-agent/src/core/session-manager-storage.ts`
  - `loadEntriesFromFile(filePath)` exported at line 36.
  - `readSessionHeader(filePath)` exported at line 80.
  - `isInternalHeader()` exported at line 128.
  - `getSessionHeaderCwd()` exported at line 132.
  - `sessionCwdMatches()` exported at line 137.
  - `findMostRecentSession(sessionDir, cwd?, includeInternal?)` exported at line 142.
  - Uses `readdirSync(...).filter(f => f.endsWith(".jsonl"))` at lines 146-148.
  - Calls `readSessionHeader(path)` during most-recent scan at line 149.
  - `serializeSessionEntries()` exported at line 165.
- `packages/coding-agent/src/core/session-manager-list.ts`
  - Imports `readSessionHeader`, `isInternalHeader`, `sessionCwdMatches` at lines 11-14.
  - Reads full session file in `buildSessionInfo()` around lines 80-82.
  - Extracts `parentSessionPath = header.parentSession` at line 118.
  - Adds `parentSessionPath` to `SessionInfo` at lines 130-131.
  - `listSessionsFromDir()` exported at line 145.
  - Reads `.jsonl` files from a dir at lines 157-159.
  - Prefilters internal headers via `isInternalHeader(readSessionHeader(file))` at lines 165-168.
  - `listProjectSessions()` exported at line 190.
  - `listAllSessions()` exported at line 206.
  - Walks default sessions dir directories and counts `.jsonl` files around lines 225-235.
- `packages/coding-agent/src/core/session-manager-history.ts`
  - `getLatestCompactionBoundaryEntry()` exported at line 15.
  - `buildContextDeletionFilters()` exported at line 34.
  - `buildEffectiveContextDeletionFilters()` exported at line 110.
  - `buildContextDeletionFilteredPath()` exported at line 223.
  - `buildSessionContext()` exported at line 261; comment says it walks from leaf to root at lines 257-259.
  - `buildSessionIndex()` exported at line 352.
  - `getBranchPath()` exported at line 376; walks parent chain at lines 376-385.
  - `buildSessionTree()` exported at line 387.
- `packages/coding-agent/src/core/session-manager-archive.ts`
  - `createBackupSnapshot()` exported at line 19.
  - `createBranchedSessionState()` exported at line 103.
  - Creates header with previous session file as parent at lines 112-118.
  - `forkSessionFromFile()` exported at line 149.
  - Loads source entries at line 157.
  - Writes new header pointing to source as parent at lines 178-180.
  - Appends non-header source entries at lines 182-185.

### Interactive Resume / Session Picker
- `packages/coding-agent/src/modes/interactive/interactive-input-handling.ts`
  - `/resume` opens session selector at lines 403-405.
- `packages/coding-agent/src/modes/interactive/interactive-mode-surface.ts`
  - `showSessionSelector()` declared at line 236.
  - `handleResumeSession(sessionPath, options?)` declared at line 237.
- `packages/coding-agent/src/cli/session-picker.ts`
  - CLI session picker UI; render callback at line 44.
- `packages/coding-agent/src/modes/interactive/components/session-selector*.ts`
  - Cluster of session selector UI files:
    - `session-selector.ts`
    - `session-selector-list.ts`
    - `session-selector-search.ts`
    - `session-selector-header.ts`
    - `session-selector-delete.ts`
    - `session-selector-tree.ts`
    - `session-selector-types.ts`
    - `session-selector-utils.ts`

### Documentation
- `packages/coding-agent/docs/session-format.md`
- `packages/coding-agent/docs/sessions.md`
- `packages/coding-agent/docs/usage.md`
- `packages/coding-agent/README.md`
  - `/session` command documented at line 168.
  - Footer described as including total token/cache usage, cost, context usage, current model at lines 138-139.

---

## Docs / Changelogs

### Documentation Files
- `packages/coding-agent/README.md`
  - Footer description at lines 138-139.
  - Slash command table includes `/session` at line 168.
  - SDK programmatic usage imports `createAgentSession`, `SessionManager`, etc. at lines 425-431.
  - Mentions `createAgentSessionRuntime()` / `AgentSessionRuntime` at line 439.
- `packages/coding-agent/docs/sdk.md`
  - Referenced by README at line 441.
- `packages/coding-agent/docs/json.md`
  - `AgentSessionEvent` docs reference `packages/coding-agent/src/core/agent-session.ts#L152` at line 11.
  - Event union snippet at lines 14-27.
- `packages/coding-agent/docs/extensions.md`
  - Example mutating assistant `usage.cost.total` at lines 613-619.
  - `ctx.getContextUsage()` section starts at line 1035.
  - `ctx.newSession({ parentSession, ... })` example at lines 1103-1109.
  - `parentSession` option documented at lines 1127-1128.
  - `pi.events` section at lines 1644-1650.
  - Example list maps `event-bus.ts` to `pi.events` at lines 2692-2693.
- `packages/coding-agent/docs/custom-provider.md`
  - Provider model cost docs and `calculateCost()` example; see lines 369-370, 501-510, 615-619.
- `packages/coding-agent/docs/compaction.md`
  - Source file list includes `session-manager.ts`, `provider-context-usage.ts`, `session-events.ts` at lines 15-17.
  - Context usage / compaction behavior docs at lines 73, 111-121, 951-954.
- `packages/coding-agent/docs/changelog.mdx`
  - Usage-related changelog entry at lines 24-26.
- `packages/coding-agent/CHANGELOG.md`
  - `ContextUsage.tokens` / `ContextUsage.percent` now `number | null` at line 2843.
  - Added `ctx.compact()` and `ctx.getContextUsage()` at line 3505.

---

## Existing Tests Relevant to This Work

### AgentSession / SDK / Runtime Tests
- `packages/coding-agent/test/agent-session-branching.test.ts`
  - Runtime/session replacement/forking test; imports runtime factories at lines 17-22.
- `packages/coding-agent/test/agent-session-auth-load-failure.test.ts`
  - Direct `AgentSession` construction at lines 76-81.
- `packages/coding-agent/test/agent-session-concurrent-01.suite.ts`
  - Direct `AgentSession` construction and mock assistant usage at lines 18-23, 47-55.
- `packages/coding-agent/test/agent-session-async-bash.test.ts`
  - Direct `AgentSession` construction at lines 72-81.
- `packages/coding-agent/test/agent-session-compaction.test.ts`
  - E2E compaction/session persistence test; imports `AgentSession`, `AgentSessionEvent`, `SessionManager` at lines 16-20.
  - Subscribes to events at lines 74-77.

### Compaction / Context Usage Tests
- `packages/coding-agent/test/agent-session-auto-compaction-overflow-await.suite.ts`
  - Auto-compaction continuation test.
- `packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`
  - Split test entrypoint importing queue suites at lines 1-4.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-01.suite.ts`
  - Mocks context token calculations at lines 42-81.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-02.suite.ts`
  - Mocks context token calculations at lines 41-80.
- `packages/coding-agent/test/agent-session-auto-compaction-queue-03.suite.ts`
  - Tests length-stop resume and context token mocks at lines 8-11, 35-48.

### Session Manager / Persistence Tests
Directories and files found:
- `packages/coding-agent/test/session-manager/` - Session manager tests cluster.
- `packages/coding-agent/test/context-window-session/session-journaling.suite.ts`
- `packages/coding-agent/test/session-cwd.test.ts`
- `packages/coding-agent/test/session-id-readonly.test.ts`
- `packages/coding-agent/test/session-info-modified-timestamp.test.ts`
- `packages/coding-agent/test/session-selector-path-delete.test.ts`
- `packages/coding-agent/test/session-selector-rename.test.ts`
- `packages/coding-agent/test/session-selector-search.test.ts`

### UI / Session Picker Tests
- `packages/coding-agent/test/session-selector-search.test.ts`
- `packages/coding-agent/test/session-selector-rename.test.ts`
- `packages/coding-agent/test/session-selector-path-delete.test.ts`
- `packages/workflows/test/unit/session-picker.test.ts`
- `packages/workflows/test/unit/session-confirm-list.test.ts`

---

## Related Directories / Clusters

### Core Agent Session Cluster
- `packages/coding-agent/src/core/agent-session*.ts`
  - Contains AgentSession class, types, runtime, services, events, export/stats, prompt, compaction, models, tree, state, tool hooks/registry, extension bindings.

### Session Manager Cluster
- `packages/coding-agent/src/core/session-manager*.ts`
  - Contains core manager, entries, types, storage, list, paths, archive/forking, history/tree, migrations, validation, tool dependency filtering.
- `packages/coding-agent/src/core/async/session-manager.ts`
  - Async job delivery/session integration.

### Interactive UI Cluster
- `packages/coding-agent/src/modes/interactive/`
  - Slash command handling, input handling, autocomplete, session routing/runtime, render chat, extension runtime/context.
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
  - Usage meter and footer.
- `packages/coding-agent/src/modes/interactive/components/session-selector*.ts`
  - Session resume/selection UI cluster.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host*.ts`
  - Reusable chat host, requestRender hooks, slash command injection.

### Extension API Cluster
- `packages/coding-agent/src/core/extensions/`
  - API types, context types, loader API/core/runtime, command types, event/session events.
- `packages/coding-agent/src/core/event-bus.ts`
  - Shared `pi.events` event bus.

### Docs Cluster
- `packages/coding-agent/docs/`
  - SDK, JSON events, extensions, custom providers, compaction, sessions, session format, changelog docs.
- `packages/coding-agent/README.md`
- `packages/coding-agent/CHANGELOG.md`

