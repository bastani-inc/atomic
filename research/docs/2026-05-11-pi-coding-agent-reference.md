I have comprehensive understanding now. Let me produce the final structured report.

---

# Pi-Coding-Agent: Canonical Reference for Atomic Rewrite

All paths below are absolute. The source root used throughout is `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`.

---

## 1. Executive Summary

### What Pi is

Pi is a single npm package (`@earendil-works/pi-coding-agent`, distributed binary `pi`) that ships a small, opinionated coding TUI. It is structurally a Bun/Node monorepo split into `packages/ai` (provider/streaming layer), `packages/agent` (agent loop), `packages/tui` (terminal UI primitives), and `packages/coding-agent` (the CLI, interactive mode, RPC mode, JSON mode, SDK exports, and extension runtime).

### Core design principles (`docs/usage.md:271-277`)

> "Pi keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages. It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages."

This is the philosophy Atomic inherits by forking pi.

### What's bundled in pi-core vs. what's extension-only

| Capability | Bundled | Notes |
|---|---|---|
| Chat TUI (editor, messages, footer, header) | YES | OpenTUI-like primitives in `packages/tui`. |
| 7 file/shell tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) | YES | Toggleable via `--tools`, `--no-builtin-tools`. |
| Session persistence (JSONL tree, branching, fork/clone) | YES | `~/.pi/agent/sessions/`. |
| `/compact`, auto-compaction, branch summaries | YES | Driven by token budget. |
| `/tree` navigation, labels, `/resume`, `/new` | YES | |
| Skills standard (`/skill:name`, SKILL.md) | YES | Conforms to agentskills.io. |
| Prompt templates (`/<name>` from `.md` files) | YES | `$1..$@` arg expansion. |
| Theme system + hot reload | YES | 51 required color tokens. |
| Keybindings (namespaced ids, JSON config, `/reload`) | YES | |
| Built-in providers (Anthropic, OpenAI, Google, Copilot, …) | YES | OAuth (`/login`) + API keys + env vars. |
| Custom providers (Ollama, vLLM, proxies, OAuth flows) | YES | Via `models.json` or extensions. |
| Extensions (TS modules, hot-reload, `pi.registerTool`, `pi.registerCommand`, hooks, custom UI) | YES | The primary seam Atomic plugs into. |
| Packages (npm/git distribution) | YES | `pi install npm:…`, `pi install git:…`. |
| RPC mode (JSONL stdin/stdout) | YES | `pi --mode rpc`. |
| JSON event stream | YES | `pi --mode json`. |
| SDK (`createAgentSession`, `AgentSessionRuntime`, `AuthStorage`, `ModelRegistry`) | YES | Used by interactive/print/RPC modes themselves. |
| **MCP** | NO | Must be built as an extension. |
| **Sub-agents** | NO | Reference impl in `examples/extensions/subagent/` spawns `pi --mode json -p`. |
| **Plan mode** | NO | Reference impl in `examples/extensions/plan-mode/`. |
| **Permission popups** | NO | Built via `tool_call` hook + `ctx.ui.confirm`. |
| **Background bash** | NO | All bash is foreground; user `!` and `!!` are first-class. |
| **To-dos** | NO | `examples/extensions/todo.ts` shows the pattern. |
| **tmux integration** | NO | Pi is a single-process TUI; tmux is purely a deployment concern. |
| Multi-vendor coding agent configs (`.claude/`, `.opencode/`, `.github/`) | NO | Pi reads only its own (`~/.pi/agent/`, `.pi/`) plus optionally `AGENTS.md`/`CLAUDE.md` as context files. Skills can be sourced from `~/.claude/skills` via settings. |

### What this means for Atomic

Atomic = pi-core + bundled Atomic-owned extensions/skills/prompts/themes + a native workflow tool. The chat TUI is pi. The "workflow orchestrator pane inside the chat TUI" is, in pi terms, **a custom tool that uses `ctx.ui.custom(component, { overlay: true })` or `ctx.ui.setWidget(...)` to surface live state, combined with `pi.sendMessage()`/`pi.sendUserMessage()` to drive the agent.** All four pi reference examples that matter — `subagent/`, `plan-mode/`, `doom-overlay/`, `handoff.ts` — together prove every primitive needed for Atomic's workflow pane is already in pi.

---

## 2. Per-Doc Summary

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/index.md`
**Purpose:** Doc-site landing page; lists all docs in five buckets (Start here, Customization, Programmatic, Reference, Platform, Development).
**Key:** Establishes that pi is "minimal terminal coding harness … extended through TypeScript extensions, skills, prompt templates, themes, and pi packages" (`docs/index.md:3`).

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/quickstart.md`
**Purpose:** Install → authenticate → first session.
**Key APIs/paths:** `npm install -g @earendil-works/pi-coding-agent`; default tools `read/write/edit/bash` (+ optional `grep/find/ls`); context files loaded from `~/.pi/agent/AGENTS.md` and `AGENTS.md`/`CLAUDE.md` walking up. `pi -c`, `pi -r`, `pi --session`, `pi -p`, `pi --mode json`, `pi --mode rpc`. `@file` references and image paste.
**Atomic seam:** The four default tools and the AGENTS.md/CLAUDE.md walk-up loader are usable as-is.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/usage.md`
**Purpose:** Day-to-day reference for interactive mode, CLI flags, env vars, message queue, sessions.
**Key APIs:** Slash commands `/login /model /scoped-models /settings /resume /new /name /session /tree /fork /clone /compact /copy /export /share /reload /hotkeys /changelog /quit`. Message queueing: Enter (steer), Alt+Enter (followUp), Escape (abort + restore). `steeringMode`, `followUpMode` settings. SYSTEM.md / APPEND_SYSTEM.md per-project override.
**Env vars:** `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `VISUAL`/`EDITOR`.
**Constraint:** Explicitly enumerates pi's "no MCP / no sub-agents / no plan mode / no to-dos / no permission popups / no background bash" stance at lines 273-277.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/development.md`
**Purpose:** Fork & build instructions — **critical for Atomic**.
**Key:** `git clone https://github.com/earendil-works/pi-mono && npm install && npm run build`; `/path/to/pi-mono/pi-test.sh` runs from source. **Forking is officially supported via a `piConfig` object in `package.json`:**
```json
{ "piConfig": { "name": "pi", "configDir": ".pi" } }
```
Plus change the `bin` field. This automatically reflows the CLI banner, the config-directory name (`~/.pi/agent/` → `~/.atomic/agent/`), and environment variable names (`PI_*` → `ATOMIC_*`).
**Hidden command:** `/debug` writes rendered TUI lines + last LLM messages to `~/.pi/agent/pi-debug.log` (`docs/development.md:50-54`).
**Path resolution rule:** Always use `src/config.ts` (`getPackageDir`, `getThemeDir`), never `__dirname` directly. Three exec modes coexist: npm install / standalone binary / tsx from source.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
**Purpose:** THE foundational doc — 96 KB of API surface for pi's extension system.
**Default factory signature:**
```typescript
export default function (pi: ExtensionAPI) { ... }   // sync or async
```
Async factories are awaited before `session_start` and resource discovery (`docs/extensions.md:178-217`).

**Extension locations** (`docs/extensions.md:108-134`):
- `~/.pi/agent/extensions/*.ts` (global)
- `~/.pi/agent/extensions/*/index.ts` (global subdir)
- `.pi/extensions/*.ts` (project)
- `.pi/extensions/*/index.ts` (project subdir)
- `settings.json` → `extensions: [...]`
- `settings.json` → `packages: ["npm:…", "git:…"]`
- CLI `--extension ./path.ts` (repeatable)

**Available imports** (`docs/extensions.md:138-152`):
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, event types, helpers
- `typebox` — parameter schemas
- `@earendil-works/pi-ai` — `StringEnum` (use this, not Union+Literal, for Google compat)
- `@earendil-works/pi-tui` — TUI primitives
- Any npm dep (drop a `package.json` + `node_modules/`)

**Extension styles:** single-file `.ts` / directory with `index.ts` / package with `package.json` + `dependencies`.

**Events** (full lifecycle ASCII map at `docs/extensions.md:268-335`):
1. **Resource:** `resources_discover` (return additional `skillPaths/promptPaths/themePaths`).
2. **Session:** `session_start`, `session_before_switch` (cancellable), `session_before_fork` (cancellable), `session_before_compact` (cancel/custom summary), `session_compact`, `session_before_tree` (cancel/custom summary), `session_tree`, `session_shutdown`.
3. **Agent:** `before_agent_start` (inject message, modify systemPrompt, with full `systemPromptOptions`), `agent_start`, `agent_end`, `turn_start`, `turn_end`.
4. **Message:** `message_start`, `message_update`, `message_end` (can return replacement message keeping role).
5. **Tool exec:** `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
6. **Tool gating:** `tool_call` (mutate `event.input` in place; return `{block:true, reason}`); `tool_result` (return partial patches).
7. **Context:** `context` (mutate messages before LLM call).
8. **Provider:** `before_provider_request` (replace payload), `after_provider_response` (inspect status + headers).
9. **Model:** `model_select`, `thinking_level_select`.
10. **User bash:** `user_bash` (intercept `!`/`!!`).
11. **Input:** `input` — `continue` | `transform` | `handled`; sees raw text *before* skill/template expansion.

**`ExtensionAPI` methods (full list):**
- `pi.on(event, handler)`
- `pi.registerTool({name, label, description, promptSnippet, promptGuidelines, parameters, prepareArguments, execute, renderCall, renderResult, renderShell, terminate})`
- `pi.registerCommand(name, {description, handler, getArgumentCompletions})`
- `pi.registerShortcut(key, {description, handler})`
- `pi.registerFlag(name, {description, type, default})`
- `pi.registerMessageRenderer(customType, renderer)`
- `pi.registerProvider(name, config)` / `pi.unregisterProvider(name)`
- `pi.sendMessage(message, {deliverAs: "steer"|"followUp"|"nextTurn", triggerTurn})`
- `pi.sendUserMessage(content, {deliverAs})`
- `pi.appendEntry(customType, data)` — persists to session, never goes to LLM
- `pi.setSessionName(name)` / `pi.getSessionName()`
- `pi.setLabel(entryId, label)`
- `pi.getCommands()` — extension + prompt + skill commands w/ sourceInfo
- `pi.exec(cmd, args, {signal, timeout})`
- `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools([...])`
- `pi.setModel(model)` / `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`
- `pi.events` — shared event bus (`.on`/`.emit`) for inter-extension comms
- `pi.getFlag(name)`

**`ExtensionContext` fields:**
- `ctx.ui` (see below)
- `ctx.hasUI` (false in print/json modes, true in interactive/RPC)
- `ctx.cwd`
- `ctx.sessionManager` (read-only)
- `ctx.modelRegistry`, `ctx.model`
- `ctx.signal` (current agent abort signal)
- `ctx.isIdle()`, `ctx.abort()`, `ctx.hasPendingMessages()`
- `ctx.shutdown()` — deferred until idle
- `ctx.getContextUsage()`, `ctx.compact({...})`
- `ctx.getSystemPrompt()`

**`ExtensionCommandContext` extends `ExtensionContext` with session-replacement methods (only safe inside commands):**
- `ctx.waitForIdle()`
- `ctx.newSession({parentSession, setup, withSession})`
- `ctx.fork(entryId, {position: "before"|"at", withSession})`
- `ctx.navigateTree(targetId, {summarize, customInstructions, replaceInstructions, label})`
- `ctx.switchSession(path, {withSession})`
- `ctx.reload()` — equivalent to `/reload`

**`ctx.ui` methods (huge surface — this is where the workflow pane lives):**
- Dialogs: `ui.select(title, options, {timeout, signal})`, `ui.confirm`, `ui.input`, `ui.editor` (multi-line)
- Fire-and-forget: `ui.notify(text, type)`, `ui.setStatus(key, text)`, `ui.setWidget(key, lines|component, {placement: "aboveEditor"|"belowEditor"})`, `ui.setTitle(text)`, `ui.setEditorText`, `ui.setHeader(factory)`, `ui.setFooter(factory)`, `ui.setHiddenThinkingLabel`, `ui.setWorkingMessage`, `ui.setWorkingVisible`, `ui.setWorkingIndicator({frames, intervalMs})`, `ui.setToolsExpanded`, `ui.setEditorComponent(factory)`, `ui.getEditorComponent()`, `ui.pasteToEditor`
- Custom UI: `ui.custom(factory, {overlay, overlayOptions, onHandle})` — returns Promise resolving to whatever `done(value)` is called with. **Overlay mode (`overlay: true`) floats over existing content without clearing the screen; non-overlay temporarily replaces the editor.**
- Autocomplete: `ui.addAutocompleteProvider((current) => Provider)`
- Theme: `ui.theme`, `ui.getAllThemes()`, `ui.getTheme(name)`, `ui.setTheme(name|Theme)`

**Custom tool render slots (`docs/extensions.md:1976-2098`):**
- `renderCall(args, theme, context)` — header
- `renderResult(result, options, theme, context)` — body (receives `isPartial`, `expanded`)
- `renderShell: "self"` opt-out of default `Box` framing
- Both receive `context.state` (shared between slots), `context.lastComponent`, `context.invalidate()`

**File mutation safety:** `withFileMutationQueue(absolutePath, async () => {...})` to participate in the same per-file queue as built-in `edit`/`write`. Critical for parallel-safe tools.

**Output truncation utilities:** `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`, `DEFAULT_MAX_BYTES` (50KB), `DEFAULT_MAX_LINES` (2000).

**Override built-in tools:** Register a tool with the same name as built-in; rendering inheritance is per-slot (omit `renderCall`/`renderResult` → built-in fallback). See `tool-override.ts`.

**Custom editor:** Extend `CustomEditor` (not raw `Editor`) to keep app keybindings; pass `undefined` to restore default.

**Atomic seams that matter most:**
- `pi.registerTool` (the native workflow tool)
- `pi.registerCommand` (Atomic's slash UX)
- `ctx.ui.custom(component, {overlay: true, overlayOptions})` (the workflow pane)
- `ctx.ui.setWidget` (persistent above/below-editor pane)
- `ctx.ui.setFooter`, `setHeader` (rebrand surface)
- `pi.appendEntry` (persistent workflow state in session JSONL)
- `pi.sendMessage`/`sendUserMessage` (drive the chat from workflows)
- `ctx.newSession({withSession})` (workflows can spawn fresh sessions, `handoff.ts` pattern)

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
**Purpose:** TUI primitive reference. Source: `@earendil-works/pi-tui`.
**Component interface:** `{ render(width): string[], handleInput?(data), invalidate(), wantsKeyRelease? }`. Each rendered line must not exceed `width`. Styles do not carry across lines.
**Focusable interface:** `focused: boolean`; emit `CURSOR_MARKER` in render output to get hardware cursor + IME support.
**Built-ins:** `Text`, `Box`, `Container`, `Spacer`, `Markdown`, `Image` (Kitty/iTerm2/Ghostty/WezTerm img protocols), plus higher-level `SelectList`, `SettingsList`, `BorderedLoader`, `DynamicBorder`, `Input`, `Editor`, `CustomEditor`.
**Overlay options:** `width/height/minWidth/maxHeight` (numeric or `"50%"` strings), `anchor` (9-position grid), `offsetX/Y`, absolute `row/col`, `margin`, `visible(termW, termH)` predicate, `onHandle((handle) => handle.setHidden/hide)`.
**Keyboard:** `matchesKey(data, Key.x)`; `Key.up/down/left/right/enter/escape/tab/space/backspace`, modifiers via `Key.ctrl("c")`, `Key.shift("tab")`, `Key.ctrlShift("p")`, `Key.ctrlAlt("p")`. String form `"ctrl+shift+p"` also works.
**Theming:** Components NEVER import theme directly; always receive it from `ctx.ui.custom((tui, theme, keybindings, done) => …)`. When theme changes, `invalidate()` is called on all components — components that pre-bake themed strings must rebuild content in `invalidate()`.
**Width helpers:** `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`.
**Pattern docs (copy-paste blueprints, `docs/tui.md:586-905`):**
- Pattern 1: Selection dialog (SelectList + DynamicBorder)
- Pattern 2: Async-with-cancel (BorderedLoader)
- Pattern 3: Settings toggles (SettingsList)
- Pattern 4: Persistent status (setStatus)
- Pattern 4b: Working indicator customization
- Pattern 5: Widgets above/below editor
- Pattern 6: Custom footer (with reactive `footerData.onBranchChange`)
- Pattern 7: Custom editor (vim-like modal)
**Debug:** `PI_TUI_WRITE_LOG=/tmp/x.log` captures raw ANSI.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
**Purpose:** Agent Skills standard implementation. Pi implements [agentskills.io](https://agentskills.io/specification), warning on violations.
**Locations:**
- Global: `~/.pi/agent/skills/`, `~/.agents/skills/`
- Project: `.pi/skills/`, `.agents/skills/` walking up from cwd to git repo root
- Packages: `skills/` dirs or `pi.skills` in `package.json`
- Settings: `skills: [...]`
- CLI: `--skill <path>` (additive even with `--no-skills`)
- Cross-vendor: `~/.claude/skills`, `~/.codex/skills` can be added via settings — explicitly documented.
**Discovery rules:** Root `.md` files only discovered in `~/.pi/agent/skills/` and `.pi/skills/`. `.agents/skills/` only loads directories with `SKILL.md`.
**SKILL.md format:** YAML frontmatter (`name`, `description` required; `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` optional). Name must match parent directory, lowercase a-z/0-9/hyphens, ≤64 chars. Description ≤1024 chars.
**Invocation:** `/skill:name [args]` — args appended as `User: <args>` to skill content. Toggleable via `enableSkillCommands` setting.
**Bundling for Atomic:** Drop a `skills/` directory into the Atomic package (`pi.skills` array in `package.json`), or ship as a separate pi-package and bundle in dependencies. `dynamic-resources/index.ts` shows how an extension can register additional skill paths via the `resources_discover` event.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/prompt-templates.md`
**Purpose:** Markdown snippets that expand on `/<name>`.
**Locations:** `~/.pi/agent/prompts/*.md`, `.pi/prompts/*.md`, packages, settings, CLI `--prompt-template`.
**Format:** YAML frontmatter `description`, `argument-hint` (e.g. `"<PR-URL>"` or `"[instructions]"`); body is the template.
**Interpolation:** `$1`, `$2`, …, `$@`/`$ARGUMENTS`, `${@:N}`, `${@:N:L}`.
**Discovery:** Non-recursive by default. Use `prompts` settings array or package manifest for subdirectories.
**Atomic seam:** Bundle Atomic prompts in package's `prompts/` dir, point `pi.prompts` at it.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/themes.md`
**Purpose:** Theme system — 51 required color tokens.
**Locations:** Built-in `dark`/`light`; `~/.pi/agent/themes/*.json`; `.pi/themes/*.json`; packages (`pi.themes`); settings (`themes: [...]`); CLI `--theme`.
**Selection:** `theme` setting; first run auto-detects terminal background.
**Hot reload:** Editing the *currently active* custom theme file reloads automatically — visible feedback.
**Format:** `name`, optional `vars` (reusable named colors), required `colors` (51 tokens across Core UI, Backgrounds/Content, Markdown, Diffs, Syntax, Thinking-level borders, Bash mode). Optional `export` section for HTML export. Schema at `https://raw.githubusercontent.com/earendil-works/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json`.
**Color values:** hex `"#RRGGBB"`, 256-color index `0-255`, `vars` reference, `""` for terminal default.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md`
**Purpose:** Customization via `~/.pi/agent/keybindings.json`. Edit + `/reload` (no restart).
**ID namespaces:** `tui.*` (shared TUI ids) and `app.*` (coding-agent ids). Legacy un-namespaced ids auto-migrated.
**Key format:** `modifier+key`; modifiers `ctrl`, `shift`, `alt`; keys `a-z`, `0-9`, all special keys, `f1-f12`, symbols.
**All actions (~50):** editor cursor movement (12), deletion (6), input (3), kill ring (3), clipboard/selection (7), application (6), sessions (9), models/thinking (5), display/queue (3), tree navigation (10), scoped-models selector (6).
**Config:** `{ "app.thinking.cycle": ["shift+tab", "ctrl+i"] }` — single string or array.
**Extension API:** `keyHint("app.tools.expand", "to expand")`, `keyText("tui.select.confirm")`, `rawKeyHint("ctrl+k", "to kill")`. Custom editors and `ctx.ui.custom` components receive `keybindings: KeybindingsManager` injected.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
**Purpose:** Programmatic embedding via TypeScript. Used by pi's own interactive/print/RPC modes.
**Main exports:**
- `createAgentSession(opts) → {session, extensionsResult, modelFallbackMessage}`
- `createAgentSessionRuntime(factory, {cwd, agentDir, sessionManager})` for session-replacement flows (`newSession`, `switchSession`, `fork`, `importFromJsonl`)
- `AuthStorage.create(path?)` / `.inMemory()` / `setRuntimeApiKey(provider, key)`
- `ModelRegistry.create(authStorage, modelsJsonPath?)` / `.inMemory(authStorage)` — `find(provider, id)`, `getAvailable()`, `getApiKeyAndHeaders(model)`
- `SessionManager.create/open/continueRecent/inMemory/forkFrom`; static `list(cwd)`, `listAll()`; instance: full tree API (`getEntries`, `getTree`, `getBranch`, `branch`, `branchWithSummary`, `appendMessage`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendLabelChange`, `buildSessionContext`)
- `SettingsManager.create/inMemory`; `applyOverrides(partial)`; `flush()`; `drainErrors()`
- `DefaultResourceLoader({cwd, agentDir, settingsManager, systemPromptOverride, additionalExtensionPaths, extensionFactories, skillsOverride, promptsOverride, themesOverride, agentsFilesOverride, eventBus})` and the bare `ResourceLoader` interface (12-style full-control example)
- Tool factories: `codingTools`, `readOnlyTools`, `createReadTool(cwd)`, `createBashTool(cwd, {spawnHook, operations})`, etc.
- `defineTool({...})` for standalone tool definitions
- `runPrintMode(runtime, opts)` / `new InteractiveMode(runtime, opts).run()` / `runRpcMode(runtime)`
- `createEventBus()`, `createExtensionRuntime()`
**AgentSession API:** `prompt(text, {streamingBehavior, images, preflightResult})`, `steer(text)`, `followUp(text)`, `subscribe(listener)`, `setModel`, `setThinkingLevel`, `cycleModel`, `compact`, `abort`, `navigateTree`, `bindExtensions`, `dispose`.
**Atomic seam:** Atomic CAN be entirely built on `InteractiveMode(runtime)` with a customized `DefaultResourceLoader` that bundles Atomic's extensions/skills/prompts as `extensionFactories`/overrides. This is the cleanest path to "rebrand and bundle."

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
**Purpose:** JSONL protocol over stdin/stdout for subprocess integration (other languages, IDEs, custom UIs).
**Framing:** Strict JSONL with `\n` only (accept stripped `\r`). Node `readline` is NOT compliant — must use a manual line reader (example included).
**Commands (full list):** `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_last_assistant_text`, `set_session_name`, `get_commands`.
**Events:** Same as JSON mode (see below) + `extension_error`.
**Extension UI sub-protocol:** Dialogs (`select`/`confirm`/`input`/`editor`) emit `extension_ui_request` and block until matching `extension_ui_response`. Fire-and-forget (`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`) emit requests with no response expected. `ctx.hasUI === true` in RPC mode. Some methods degrade: `custom()` returns undefined, `setWorkingMessage/Indicator/Footer/Header/EditorComponent` are no-ops, `getAllThemes` returns `[]`, `setTheme` fails.
**Bash command bridge:** `bash` command creates `BashExecutionMessage` in state but emits NO event; output is bundled into the next `prompt`'s user message as `Ran \`cmd\`\n\`\`\`output\`\`\``.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/json.md`
**Purpose:** `pi --mode json` — one-way event stream to stdout, no command channel.
**Format:** First line is session header `{type:"session",version:3,id,timestamp,cwd}`. Then `AgentSessionEvent` lines: `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `queue_update`, `compaction_start/end`, `auto_retry_start/end`.
**Use:** Subagent example uses this exact mode to harvest structured output from spawned `pi -p` processes.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`
**Purpose:** Settings reference. Two-tier: `~/.pi/agent/settings.json` (global) overridden by `.pi/settings.json` (project), nested objects merge.
**All keys** (see table in §4).
**Path resolution:** Paths in global file resolve relative to `~/.pi/agent`; paths in project file resolve relative to `.pi`. `~` and absolute paths supported.
**Resource arrays** (`packages`, `extensions`, `skills`, `prompts`, `themes`) support globs, `!exclude`, `+force-include`, `-force-exclude`.
**Object form for `packages`:** Per-package filter `{source, extensions:[], skills:["only-this"], …}`.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
**Purpose:** Pi-package distribution model.
**Install:** `pi install npm:@scope/pkg@1.2.3`, `pi install git:github.com/user/repo@v1`, `pi install https://…`, `pi install ./local-path`. `-l` writes to project settings (`.pi/settings.json`) instead of global.
**Sources:** `npm:` (versioned pins skipped by `pi update`), `git:` (refs pin), local (relative paths resolved against the settings file they live in).
**Manifest:** `package.json` → `pi` key:
```json
{
  "keywords": ["pi-package"],
  "pi": { "extensions": [...], "skills": [...], "prompts": [...], "themes": [...], "video": "...", "image": "..." }
}
```
**Convention dirs (no manifest):** `extensions/` (.ts/.js), `skills/` (recursive SKILL.md), `prompts/` (.md), `themes/` (.json).
**Dependencies:** Runtime deps in `dependencies`. The five core pi packages (`@earendil-works/pi-ai`, `…pi-agent-core`, `…pi-coding-agent`, `…pi-tui`, `typebox`) go in `peerDependencies` with `"*"`. Other pi packages must be `bundledDependencies` + `dependencies` and referenced via `node_modules/…` paths.
**`npmCommand` setting:** Pin npm operations to wrappers like mise/asdf/bun: `["mise", "exec", "node@20", "--", "npm"]`. If first element is `"bun"`, modules location is queried via `bun pm bin -g` instead of `npm root -g`.
**Security:** Pi packages run with full system access — review before installing.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md` + `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
**Purpose:** Session storage and JSONL format reference.
**Path:** `~/.pi/agent/sessions/--<cwd-with-slashes-replaced>--/<timestamp>_<uuid>.jsonl`.
**Version 3** (current): Tree-structured entries via `id`/`parentId` (8-char hex). First line is `SessionHeader` `{type:"session",version:3,id,timestamp,cwd,parentSession?}`. Versions 1 and 2 auto-migrate.
**Entry types:** `message` (wraps `AgentMessage`), `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `custom` (extension state, never to LLM), `custom_message` (extension message, DOES go to LLM), `label`, `session_info`.
**AgentMessage union:** `UserMessage`, `AssistantMessage` (content: text/thinking/toolCall blocks), `ToolResultMessage`, `BashExecutionMessage` (from `!` and RPC `bash` cmd), `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`.
**Branching:** `/tree` selects entry → moves leaf to that point's parent (for user msgs) or that point (for non-user) → continues from there, creating new children.
**Context building:** `buildSessionContext()` walks leaf→root; if a `compaction` is on path, emits its summary + messages from `firstKeptEntryId`; converts `BranchSummary` and `CustomMessage` to LLM-friendly formats.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md`
**Purpose:** Context overflow handling.
**Trigger:** `contextTokens > contextWindow - reserveTokens` (default reserve 16384). Manual `/compact [instructions]`.
**Algorithm:** Walk back accumulating tokens until `keepRecentTokens` (default 20000); summarize the older slice; append `CompactionEntry` with `summary`, `firstKeptEntryId`, `tokensBefore`; reload uses summary + kept tail.
**Split turns:** When one turn exceeds the keep budget, cut lands mid-turn. Generates two summaries (history + turn prefix) and merges.
**Cut points:** User/assistant/bashExecution/custom — NEVER on a tool result (must stay with its tool call).
**Branch summarization:** `/tree` away from a branch can summarize abandoned work into a `BranchSummaryEntry` (3 user choices: none / default / custom focus).
**Extension hooks:** `session_before_compact` → `{cancel:true}` or `{compaction: {summary, firstKeptEntryId, tokensBefore, details}}`. `session_before_tree` similarly.
**Settings:** `compaction.enabled/reserveTokens/keepRecentTokens`, `branchSummary.reserveTokens/skipPrompt`.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
**Purpose:** `~/.pi/agent/models.json` schema for adding Ollama/vLLM/LM Studio/proxies.
**Minimal:**
```json
{"providers": {"ollama": {"baseUrl":"http://localhost:11434/v1","api":"openai-completions","apiKey":"ollama","models":[{"id":"llama3.1:8b"}]}}}
```
**APIs:** `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`. (More via extensions.)
**Value resolution for `apiKey`/`headers`:** `"!command"` (shell exec, no built-in TTL), `"ENV_VAR"`, or literal.
**`thinkingLevelMap`:** Per-model `{off?, minimal?, low?, medium?, high?, xhigh?}` mapping pi thinking level → provider value. `null` hides the level.
**Built-in provider overrides:** Just `{baseUrl: "..."}` reroutes all built-in models through a proxy keeping models intact.
**`modelOverrides`:** Per-built-in-model customization without replacing the provider's model list.
**Reload:** File reloaded each time `/model` opens — no restart needed.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/providers.md`
**Purpose:** Built-in providers + cloud setup.
**Subscription OAuth (via `/login`):** ChatGPT Plus/Pro (Codex), Claude Pro/Max, GitHub Copilot. Tokens stored in `~/.pi/agent/auth.json`, auto-refresh.
**API keys:** 20+ providers. Env vars or `auth.json` entries (`{type:"api_key", key:"…"}`); `auth.json` takes priority. Key field supports `"!shell-cmd"`, env-var name, or literal.
**Cloud:** Azure OpenAI (`AZURE_OPENAI_API_KEY` + base URL or resource name), Amazon Bedrock (`AWS_PROFILE` / IAM / bearer / ECS / IRSA), Cloudflare AI Gateway, Cloudflare Workers AI, Google Vertex AI (ADC).
**Resolution order:** CLI `--api-key` → `auth.json` → env var → `models.json` fallback.

### `/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
**Purpose:** Adding new providers via `pi.registerProvider()` in an extension.
**Use cases:** Proxies (just `{baseUrl}`), new providers (must include `models`), OAuth/SSO (provide `oauth: {name, login, refreshToken, getApiKey, modifyModels?}`), custom streaming APIs (`streamSimple: (model, context, opts) => AssistantMessageEventStream`).
**Async factory pattern:** Use async extension factory to fetch model lists at startup — they're available immediately, even to `pi --list-models`.
**`OAuthLoginCallbacks`:** `onAuth({url})` (browser), `onDeviceCode({userCode, verificationUri})`, `onPrompt({message})`.
**Custom streaming events:** `start` → `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end` → `done` or `error`.
**API types:** `anthropic-messages`, `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `mistral-conversations`, `google-generative-ai`, `google-vertex`, `bedrock-converse-stream`.

### Platform docs

- **`terminal-setup.md`:** Pi uses Kitty keyboard protocol. Kitty/iTerm2 work out of box. Ghostty/WezTerm/VS Code/Windows Terminal need specific keybind remapping for `Shift+Enter`/`Alt+Enter`. xfce4-terminal and IntelliJ have known limitations (modified Enter collapses to plain Enter). `PI_HARDWARE_CURSOR=1` forces hardware cursor (off by default).
- **`shell-aliases.md`:** Pi runs `bash -c` (non-interactive); aliases need `shellCommandPrefix: "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""` in settings.
- **`windows.md`:** Needs bash on Windows; checks (1) `shellPath` (2) Git for Windows (3) `bash.exe` on PATH. Custom: `"shellPath": "C:\\cygwin64\\bin\\bash.exe"`.
- **`termux.md`:** Android via Termux. Install via `pkg install nodejs termux-api git && npm install -g …`. No image clipboard. Sample AGENTS.md for Termux env included.
- **`tmux.md`:** Pi works in tmux but requires `set -g extended-keys on; set -g extended-keys-format csi-u` in `.tmux.conf` to forward modified Enter keys. Requires tmux ≥3.2. **For Atomic's rewrite (which removes tmux), this is reference for "why we don't need tmux" — pi is a single TUI process; multi-pane comes from overlays and widgets, not tmux.**

---

## 3. Examples Inventory

### Top-level
- **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/rpc-extension-ui.ts`** — 632-line TUI chat client that spawns `pi --mode rpc` as a subprocess and renders RPC events + extension UI requests. Blueprint for "Atomic-shell hosts pi" though Atomic should use SDK directly instead.

### `examples/extensions/` (60 files, ~11K LOC)

**Tools & Tool Rendering:**
- **`hello.ts`** — Minimal `defineTool` + `pi.registerTool` example (27 lines).
- **`question.ts`** — Tool that calls `ctx.ui.select` to ask the user a question mid-tool-execution.
- **`questionnaire.ts`** — Multi-step wizard tool using `ctx.ui.custom` with tab-bar navigation.
- **`todo.ts`** — Stateful todo tool with custom `renderCall`/`renderResult`, persistence via `details` field, restored on `session_start`.
- **`dynamic-tools.ts`** — Registers tools at runtime in `session_start` AND inside a `/add-echo-tool` command (75 lines). Shows `promptSnippet`/`promptGuidelines` to teach the LLM about late-bound tools.
- **`structured-output.ts`** — Terminal tool returning `terminate: true` so the agent ends on the tool call instead of looping.
- **`truncated-tool.ts`** — Wraps `rg` with proper 50KB/2000-line truncation using exported helpers.
- **`tool-override.ts`** — Overrides built-in `read` to add logging + access control (144 lines). Shows that omitted `renderCall`/`renderResult` inherit built-in rendering per slot.
- **`built-in-tool-renderer.ts`** — Custom compact rendering for built-in tools while keeping original behavior.
- **`minimal-mode.ts`** — Override all built-in tool rendering for minimal display (no output in collapsed mode).
- **`inline-bash.ts`** — Expands `!{cmd}` patterns in user input via `input` event transformation.
- **`bash-spawn-hook.ts`** — Adjusts bash command/cwd/env via `createBashTool({spawnHook})`.
- **`ssh.ts`** — Full SSH delegation: `--ssh` flag, `user_bash` interception, custom tool operations for all 7 built-in tools (220 lines).

**Commands & UI:**
- **`preset.ts`** — Named presets (model + thinking + tools + instructions) via `--preset` flag, `/preset` command, Ctrl+Shift+U cycle, `~/.pi/agent/presets.json` + `.pi/presets.json` (430 lines). Snapshot/restore original state on clear.
- **`plan-mode/`** — Read-only exploration mode with `/plan`, `Ctrl+Alt+P`, step extraction via regex, `[DONE:n]` markers, progress widget, `pi.setActiveTools` switching, custom-message context injection, full state persistence via `appendEntry` + restore-on-resume scanning entries since last execute marker. **Closest reference for Atomic's workflow tool.**
- **`tools.ts`** — `/tools` opens `SettingsList` to enable/disable; persists per branch via `appendEntry`.
- **`handoff.ts`** — `/handoff <goal>` calls a model to compress current branch into a focused prompt, opens editor for review, then `ctx.newSession({parentSession, withSession: (newCtx) => newCtx.ui.setEditorText(prompt)})` (191 lines). **Direct blueprint for "spawn a new workflow session" pattern.**
- **`qna.ts`** — Extracts questions from last assistant response into the editor via `setEditorText` + `BorderedLoader`.
- **`summarize.ts`** — Runs `complete()` on a different model to summarize the conversation, shows result in transient UI.
- **`status-line.ts`** — Footer status indicator showing turn progress.
- **`github-issue-autocomplete.ts`** — Preloads `gh issue list` on session_start, registers an autocomplete provider that intercepts `#…` patterns (185 lines).
- **`widget-placement.ts`** — Minimal widget above/below editor example (9 lines).
- **`hidden-thinking-label.ts`** — Customize the collapsed thinking-block label.
- **`working-indicator.ts`** — Custom spinner frames (123 lines, includes `/working-indicator` toggle command).
- **`model-status.ts`** — React to `model_select` event.
- **`snake.ts`** — Full snake game in `ctx.ui.custom` with game loop + keyboard (343 lines).
- **`tic-tac-toe.ts`** — Tic-tac-toe vs agent with `executionMode: "sequential"` tools to prevent race on shared state (1008 lines).
- **`space-invaders.ts`** — Space Invaders game (560 lines).
- **`doom-overlay/`** — **DOOM compiled to WASM running at 35 FPS in an overlay** (`docs/extensions.md:60-75`). Uses `overlay: true` + `overlayOptions: {width:"75%",maxHeight:"95%",anchor:"center",margin:{top:1}}` and a persistent engine instance for resume. **Proof that overlays support real-time animation.**
- **`send-user-message.ts`** — `pi.sendUserMessage` patterns including `deliverAs` modes.
- **`reload-runtime.ts`** — `/reload-runtime` command + a `reload_runtime` tool that queues `/reload-runtime` as a follow-up (the only safe way to trigger reload from a tool).
- **`shutdown-command.ts`** — `/quit` via `ctx.shutdown()`.
- **`interactive-shell.ts`** — `user_bash` hook that runs vim/htop/etc with full terminal control.
- **`modal-editor.ts`** — Vim-like modal editor via `CustomEditor` subclass + `setEditorComponent`.
- **`rainbow-editor.ts`** — Animated rainbow text via custom editor.
- **`border-status-editor.ts`** — Custom editor with status/spinner in the border.
- **`overlay-test.ts`** — Single overlay with inline text inputs + wide-char/styled/emoji edge cases (150 lines).
- **`overlay-qa-tests.ts`** — Comprehensive overlay QA: anchors, margins, stacking, responsive visibility, animation (1348 lines).
- **`custom-footer.ts`** — Footer with git branch + token stats via reactive `footerData.onBranchChange`.
- **`custom-header.ts`** — Replace startup header with pi-mascot ASCII art (73 lines).
- **`timed-confirm.ts`** — Dialog with `timeout`/`signal` options.
- **`notify.ts`** — Desktop notifications via OSC 777 / OSC 99 / Windows toast on `agent_end` (56 lines).
- **`titlebar-spinner.ts`** — Braille spinner in terminal title.
- **`rpc-demo.ts`** — Exercises all RPC-supported `ctx.ui` methods (paired with `examples/rpc-extension-ui.ts`).

**Events & Gates:**
- **`permission-gate.ts`** — Confirm dangerous bash via `tool_call` hook + `ctx.ui.confirm`.
- **`protected-paths.ts`** — Block writes to `.env`, `.git/`, `node_modules/`.
- **`confirm-destructive.ts`** — Confirm on `session_before_switch`/`session_before_fork`.
- **`dirty-repo-guard.ts`** — Block session changes when git is dirty.
- **`input-transform.ts`** — `input` event: continue/transform/handled.
- **`provider-payload.ts`** — Inspect/replace payload via `before_provider_request` + status/headers via `after_provider_response`.
- **`system-prompt-header.ts`** — `ctx.getSystemPrompt()` debug display.
- **`claude-rules.ts`** — Load rules from `.claude/rules/` and append to system prompt.
- **`prompt-customizer.ts`** — Demonstrates `systemPromptOptions` (full structured access to context files, skills, tool snippets) (97 lines).
- **`file-trigger.ts`** — `fs.watch` a trigger file, inject contents via `sendMessage({triggerTurn:true})` (42 lines).

**Compaction & Sessions:**
- **`custom-compaction.ts`** — `session_before_compact` returns custom summary generated by a different model (127 lines). Uses `convertToLlm` + `serializeConversation`.
- **`trigger-compact.ts`** — Auto-trigger compaction when context > 100k tokens.
- **`git-checkpoint.ts`** — `git stash` at each `turn_start`, restore on `session_before_fork`.
- **`auto-commit-on-exit.ts`** — Auto-commit on `session_shutdown` using last assistant message.
- **`session-name.ts`** — `setSessionName`/`getSessionName`.
- **`bookmark.ts`** — `setLabel` for `/tree` navigation.

**Resources:**
- **`dynamic-resources/`** — Extension that ships its own SKILL.md, dynamic.md prompt, and dynamic.json theme, registered via `resources_discover` (16-line index.ts).

**Messages & Communication:**
- **`message-renderer.ts`** — Custom rendering via `registerMessageRenderer` for `customType` messages.
- **`event-bus.ts`** — Inter-extension `pi.events.on/emit` (44 lines).

**Sandbox & Sub-agents:**
- **`sandbox/`** — OS-level sandboxing via `@anthropic-ai/sandbox-runtime` (sandbox-exec on macOS, bubblewrap on Linux). `~/.pi/agent/extensions/sandbox.json` + `.pi/sandbox.json` config. Demonstrates package-with-dependencies pattern.
- **`subagent/`** — **988-line reference subagent implementation.** Spawns `pi --mode json -p --no-session` subprocesses with `--append-system-prompt <tempfile>` and `--tools <csv>` and `--model <id>`. Three modes: single/parallel/chain. Discovers agents from `~/.pi/agent/agents/*.md` (user) and `.pi/agents/*.md` (project) — markdown with YAML frontmatter (`name`, `description`, `tools`, `model`). Parallel concurrency limit 4, max 8 tasks. Streaming updates via `onUpdate` parsing JSON events from stdout. Sequential chain mode with `{previous}` placeholder. Per-step + total usage tracking. Custom `renderCall`/`renderResult` showing collapsed/expanded views with markdown rendering of final outputs. **Atomic's "spawn a workflow orchestrator pane" should use this as its model.**

**Custom Providers:**
- **`custom-provider-anthropic/`** — Custom Anthropic streaming impl with OAuth (has its own `package.json` + `package-lock.json`).
- **`custom-provider-gitlab-duo/`** — GitLab Duo via proxy + built-in Anthropic/OpenAI streaming.

**External Dependencies:**
- **`with-deps/`** — Demonstrates extension `package.json` with `dependencies: {"ms": "^2.1.3"}` + jiti's auto-resolution.

### `examples/sdk/` (13 files)

| File | Description |
|---|---|
| `01-minimal.ts` | `createAgentSession()` with all defaults; subscribe to text deltas. |
| `02-custom-model.ts` | `getModel("anthropic", "claude-opus-4-5")` + `thinkingLevel` + `scopedModels`. |
| `03-custom-prompt.ts` | `DefaultResourceLoader({systemPromptOverride: () => "..."})`. |
| `04-skills.ts` | `skillsOverride` to inject custom skill into the loader. |
| `05-tools.ts` | Built-in tool sets, `defineTool`, `createReadTool(cwd)` factories. |
| `06-extensions.ts` | `additionalExtensionPaths` + inline `extensionFactories`. |
| `07-context-files.ts` | Inject virtual AGENTS.md via `agentsFilesOverride`. |
| `08-prompt-templates.ts` | Inject in-memory `PromptTemplate` via `promptsOverride`. |
| `09-api-keys-and-oauth.ts` | `AuthStorage.create("/custom/auth.json")`, `setRuntimeApiKey`. |
| `10-settings.ts` | `SettingsManager.create/inMemory`, `applyOverrides`, `flush`. |
| `11-sessions.ts` | `SessionManager.create/open/continueRecent/inMemory`, `list/listAll`. |
| `12-full-control.ts` | Bare `ResourceLoader` interface with empty everything — replace all discovery. |
| `13-session-runtime.ts` | `createAgentSessionRuntime`, `runtime.newSession()`, `runtime.switchSession()`, re-binding subscriptions after replacement. |

---

## 4. Reference Tables

### 4.1 Every Extension Hook / Event

| Event | When fired | Return shape (if any) | Source |
|---|---|---|---|
| `resources_discover` | After `session_start`; on `/reload` | `{skillPaths?, promptPaths?, themePaths?}` | `docs/extensions.md:340` |
| `session_start` | Session start/load/reload | — | `docs/extensions.md:361` |
| `session_before_switch` | Before `/new` or `/resume` | `{cancel?: true}` | `docs/extensions.md:374` |
| `session_before_fork` | Before `/fork` or `/clone` | `{cancel?: true, skipConversationRestore?: true}` | `docs/extensions.md:393` |
| `session_before_compact` | Before auto- or manual compaction | `{cancel?: true}` or `{compaction: {summary, firstKeptEntryId, tokensBefore, details?}}` | `docs/extensions.md:411` |
| `session_compact` | After compaction entry written | — | `docs/extensions.md:429` |
| `session_before_tree` | Before `/tree` navigation | `{cancel?: true}` or `{summary: {summary, details?}}` | `docs/extensions.md:439` |
| `session_tree` | After tree navigation | — | `docs/extensions.md:447` |
| `session_shutdown` | Before extension runtime teardown | — | `docs/extensions.md:456` |
| `before_agent_start` | After input handled, before agent loop | `{message?, systemPrompt?}` | `docs/extensions.md:470` |
| `agent_start` / `agent_end` | Once per user prompt | — | `docs/extensions.md:506-513` |
| `turn_start` / `turn_end` | Once per LLM response + tools | — | `docs/extensions.md:519-527` |
| `message_start` / `message_update` / `message_end` | Per message | `message_end` can return `{message}` to replace | `docs/extensions.md:538-562` |
| `tool_execution_start` / `_update` / `_end` | Per tool execution | — | `docs/extensions.md:576-587` |
| `context` | Before each LLM call | `{messages}` (modified deep copy) | `docs/extensions.md:593` |
| `before_provider_request` | After payload built, before send | Replacement payload | `docs/extensions.md:608` |
| `after_provider_response` | After response status/headers, before stream consumed | — | `docs/extensions.md:623` |
| `model_select` | `/model`, `Ctrl+P`, or restore | — | `docs/extensions.md:639` |
| `thinking_level_select` | Thinking level changes | — (notify only) | `docs/extensions.md:661` |
| `tool_call` | Before tool execute (mutates `event.input`) | `{block: true, reason?}` | `docs/extensions.md:680` |
| `tool_result` | After tool execute, before result event | Partial patch `{content?, details?, isError?}` | `docs/extensions.md:752` |
| `user_bash` | User runs `!` or `!!` | `{operations}` or `{result: BashResult}` | `docs/extensions.md:780` |
| `input` | Raw input (before skill/template expansion) | `{action: "continue"|"transform"|"handled", text?, images?}` | `docs/extensions.md:816` |

### 4.2 Every `settings.json` Key (`docs/settings.md`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `defaultProvider` | string | — | |
| `defaultModel` | string | — | |
| `defaultThinkingLevel` | string | — | |
| `hideThinkingBlock` | boolean | `false` | |
| `thinkingBudgets` | object | — | `{minimal,low,medium,high}` token budgets |
| `theme` | string | `"dark"` | Auto-detected on first run |
| `quietStartup` | boolean | `false` | |
| `collapseChangelog` | boolean | `false` | |
| `enableInstallTelemetry` | boolean | `true` | Anonymous install ping |
| `doubleEscapeAction` | string | `"tree"` | `"tree"|"fork"|"none"` |
| `treeFilterMode` | string | `"default"` | tree filter default |
| `editorPaddingX` | number | `0` | 0-3 |
| `autocompleteMaxVisible` | number | `5` | 3-20 |
| `showHardwareCursor` | boolean | `false` | |
| `warnings.anthropicExtraUsage` | boolean | `true` | |
| `compaction.enabled` | boolean | `true` | |
| `compaction.reserveTokens` | number | `16384` | |
| `compaction.keepRecentTokens` | number | `20000` | |
| `branchSummary.reserveTokens` | number | `16384` | |
| `branchSummary.skipPrompt` | boolean | `false` | |
| `retry.enabled` | boolean | `true` | |
| `retry.maxRetries` | number | `3` | |
| `retry.baseDelayMs` | number | `2000` | |
| `retry.provider.timeoutMs` | number | SDK default | |
| `retry.provider.maxRetries` | number | SDK default | |
| `retry.provider.maxRetryDelayMs` | number | `60000` | |
| `steeringMode` | string | `"one-at-a-time"` | `"all"|"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | `"all"|"one-at-a-time"` |
| `transport` | string | `"sse"` | `"sse"|"websocket"|"auto"` |
| `terminal.showImages` | boolean | `true` | |
| `terminal.imageWidthCells` | number | `60` | |
| `terminal.clearOnShrink` | boolean | `false` | |
| `images.autoResize` | boolean | `true` | 2000×2000 max |
| `images.blockImages` | boolean | `false` | |
| `shellPath` | string | — | Windows + custom shells |
| `shellCommandPrefix` | string | — | Prepended to all bash |
| `npmCommand` | string[] | — | argv for npm operations |
| `sessionDir` | string | — | Custom session directory |
| `enabledModels` | string[] | — | Ctrl+P cycle patterns |
| `markdown.codeBlockIndent` | string | `"  "` | |
| `packages` | array | `[]` | npm/git/local sources |
| `extensions` | string[] | `[]` | Paths/dirs |
| `skills` | string[] | `[]` | Paths/dirs |
| `prompts` | string[] | `[]` | Paths/dirs |
| `themes` | string[] | `[]` | Paths/dirs |
| `enableSkillCommands` | boolean | `true` | `/skill:name` registration |

### 4.3 Every Default Tool (`docs/usage.md:188`, `docs/quickstart.md:55-62`)

| Name | Description | Operations interface |
|---|---|---|
| `read` | Read files | `ReadOperations` |
| `bash` | Run shell commands | `BashOperations` |
| `edit` | Patch files via exact text replacement | `EditOperations` |
| `write` | Create/overwrite files | `WriteOperations` |
| `grep` | Pattern search | `GrepOperations` |
| `find` | File-find | `FindOperations` |
| `ls` | List directory | `LsOperations` |

`codingTools` = `[read, bash, edit, write]`. `readOnlyTools` = `[read, grep, find, ls]`. Factories: `createReadTool(cwd, {operations})`, `createBashTool(cwd, {spawnHook, operations})`, etc.

### 4.4 Every CLI Flag (`docs/usage.md:140-219`)

**Modes:**
- (default) interactive
- `-p`, `--print` — print + exit
- `--mode json`
- `--mode rpc`
- `--export <in> [out]`

**Model:**
- `--provider <name>`
- `--model <pattern>` (supports `provider/id` and `:<thinking>`)
- `--api-key <key>`
- `--thinking <level>` (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`)
- `--models <patterns>` (comma-separated)
- `--list-models [search]`

**Session:**
- `-c`, `--continue`
- `-r`, `--resume`
- `--session <path|id>`
- `--fork <path|id>`
- `--session-dir <dir>`
- `--no-session`

**Tools:**
- `--tools <list>`, `-t <list>`
- `--no-builtin-tools`, `-nbt`
- `--no-tools`, `-nt`

**Resources:**
- `-e`, `--extension <source>` (repeatable; path, npm:, git:)
- `--no-extensions`
- `--skill <path>` (repeatable, additive)
- `--no-skills`
- `--prompt-template <path>` (repeatable)
- `--no-prompt-templates`
- `--theme <path>` (repeatable)
- `--no-themes`
- `--no-context-files`, `-nc`

**Other:**
- `--system-prompt <text>` — replace default
- `--append-system-prompt <text>` — append (supports `<path>` or `<text>`)
- `--verbose`
- `--offline`
- `-h`, `--help`
- `-v`, `--version`
- `@file` positional — include file in initial prompt

### 4.5 Every Keyboard Shortcut

See full table in `docs/keybindings.md:23-152`. Highlights for Atomic:

- `app.interrupt` = `escape`
- `app.clear` = `ctrl+c`
- `app.exit` = `ctrl+d`
- `app.suspend` = `ctrl+z` (none on Windows)
- `app.editor.external` = `ctrl+g`
- `app.clipboard.pasteImage` = `ctrl+v` (`alt+v` on Windows)
- `app.session.togglePath` = `ctrl+p` (in /resume)
- `app.session.toggleSort` = `ctrl+s`
- `app.session.toggleNamedFilter` = `ctrl+n`
- `app.session.rename` = `ctrl+r`
- `app.session.delete` = `ctrl+d`
- `app.model.select` = `ctrl+l`
- `app.model.cycleForward` = `ctrl+p`
- `app.model.cycleBackward` = `shift+ctrl+p`
- `app.thinking.cycle` = `shift+tab`
- `app.thinking.toggle` = `ctrl+t`
- `app.tools.expand` = `ctrl+o`
- `app.message.followUp` = `alt+enter`
- `app.message.dequeue` = `alt+up`
- `tui.input.submit` = `enter`
- `tui.input.newLine` = `shift+enter`

### 4.6 Every Pi CLI Sub-Command (`docs/usage.md:127-138`, `docs/packages.md:22-37`)

| Command | Description |
|---|---|
| `pi install <source> [-l]` | Install package; `-l` = project |
| `pi remove <source> [-l]` | Remove |
| `pi uninstall <source> [-l]` | Alias for remove |
| `pi update [source\|self\|pi]` | Update pi + non-pinned packages |
| `pi update --extensions` | Update packages only |
| `pi update --self [--force]` | Update pi only |
| `pi update --extension <src>` | Update one package |
| `pi list` | Show installed packages |
| `pi config` | Enable/disable package resources |

Pi also accepts `--export <in> [out]` to convert a session to HTML.

### 4.7 In-TUI Slash Commands (`docs/usage.md:37-56`)

| Command | Source |
|---|---|
| `/login`, `/logout` | built-in |
| `/model` | built-in |
| `/scoped-models` | built-in |
| `/settings` | built-in |
| `/resume`, `/new`, `/name <name>` | built-in |
| `/session` | built-in |
| `/tree`, `/fork`, `/clone` | built-in |
| `/compact [prompt]` | built-in |
| `/copy`, `/export [file]`, `/share` | built-in |
| `/reload` | built-in — reloads keybindings, extensions, skills, prompts, context files, themes |
| `/hotkeys` | built-in |
| `/changelog` | built-in |
| `/quit` | built-in |
| `/debug` (hidden) | built-in — dumps to `~/.pi/agent/pi-debug.log` |
| `/<template>` | from `prompts/*.md` |
| `/skill:<name>` | from skills (toggleable) |
| `/<custom>` | from `pi.registerCommand` |

---

## 5. Constraints That Will Shape the Atomic Rewrite

1. **No built-in MCP.** Atomic must ship an MCP-bridge extension if MCP servers are wanted. The reference `subagent/` extension is the closest pattern — spawn an external process, stream JSON, surface results through a custom-rendered tool. (`docs/usage.md:275`)
2. **No built-in sub-agents.** The `subagent/` example demonstrates the exact path: `pi.registerTool({renderCall, renderResult})` + `child_process.spawn("pi", ["--mode", "json", "-p", "--no-session", ...])`. Atomic's "native workflow tool" is precisely this pattern, generalized.
3. **No built-in plan mode / to-dos / permission popups / background bash.** All these exist as reference extensions. Atomic can fork them as bundled extensions.
4. **No tmux dependency in pi.** Multi-pane UX in pi comes from `ctx.ui.setWidget` (persistent above/below editor) and `ctx.ui.custom(component, { overlay: true, overlayOptions })` (floating modal). Atomic should keep `tmux.md` knowledge as "how a user can choose to deploy us in tmux" but should never depend on tmux itself.
5. **Single TS process, not multi-process.** All extensions, skills, prompts, themes load into the same process. The only sub-process spawning in stock pi is for sub-agent extensions (which spawn `pi` itself), package installs (npm/git), and shell tool execution.
6. **Bundled vs. user-discovered resources.** Atomic must ship its skills/prompts/themes/extensions through the **pi-package mechanism**: a `package.json` with a `pi` manifest pointing to in-repo dirs. The Atomic binary's `package.json` itself acts as the top-level package (per `docs/development.md:24-35`). Skills go in `skills/`, prompts in `prompts/`, themes in `themes/`, extensions in `extensions/`. The fork's name + `piConfig.configDir` + `bin` field control rebranding.
7. **`piConfig` in `package.json` is the rebrand seam** — change `name: "atomic"`, `configDir: ".atomic"`, and the `bin` field, and you get `atomic` CLI, `~/.atomic/agent/`, `ATOMIC_CODING_AGENT_DIR`, etc. for free.
8. **Skills cross-vendor compatibility is officially supported.** Pi can read `~/.claude/skills` and `~/.codex/skills` via the `skills: [...]` setting. Atomic is removing Claude/Copilot/OpenCode integrations but if existing users have skills in those dirs, settings can preserve them.
9. **Session JSONL is v3 with stable tree semantics.** Atomic inherits this format — `id`/`parentId` linking, `custom`/`custom_message` entry types for extension state, branchable. Don't reinvent.
10. **All extension auto-discovery is hot-reloadable via `/reload`.** This is critical for Atomic's workflow tool development UX: edit the tool file, run `/reload`, see changes without restarting.
11. **`ctx.ui.custom({overlay: true})` is the canonical "spawn a workflow pane" primitive.** The DOOM overlay proves it can render at 35 FPS. The subagent example shows live streaming updates. The `plan-mode` widget shows persistent above-editor display. Combining these gives Atomic everything a "workflow orchestrator pane" needs.
12. **`pi.registerProvider` removes any need to keep vendor-specific CLI integrations.** Atomic does not need to spawn Claude Code or Copilot CLI — pi already has Anthropic API + Claude Pro OAuth, OpenAI API + ChatGPT OAuth (Codex), and GitHub Copilot OAuth built in. Removing tmux/Claude-CLI/Copilot-CLI/OpenCode-CLI is a strict simplification.
13. **For RPC mode, do not use Node's `readline`.** Use a manual `\n`-splitting reader. This affects any host that embeds Atomic via RPC. (`docs/rpc.md:30-37`)
14. **`pi.registerTool` is dynamic — register tools at runtime in commands.** Atomic's native workflow tool can register additional helper tools when a workflow starts and `setActiveTools` to scope them.
15. **`pi.sendUserMessage`/`pi.sendMessage` with `deliverAs: "steer"|"followUp"|"nextTurn"` and `triggerTurn` is the only safe way for an extension to drive the chat agent.** No direct LLM calls in extensions for normal flow — use these or `complete()` from `@earendil-works/pi-ai` for one-off model calls (as `handoff.ts` and `summarize.ts` do).
16. **Theme hot-reload only fires for the currently active custom theme.** Atomic's bundled themes should ship as JSON files in `themes/`.
17. **`/skill:name` is enabled by default but toggleable via `enableSkillCommands` setting.** Atomic can ship with this on or off.
18. **All ctx.ui state-mutating methods are sync fire-and-forget.** `setStatus`, `setWidget`, `setFooter`, `setHeader`, `setWorkingMessage`, `setEditorComponent`, etc. do not return promises. Only dialog methods (`select`, `confirm`, `input`, `editor`) are async.
19. **Tool output truncation is the tool's responsibility.** Built-in limit is 50KB / 2000 lines. Use exported `truncateHead`/`truncateTail`. Write truncated overflow to a temp file and mention the path to the LLM.
20. **`withFileMutationQueue(path, fn)` is required for any custom tool that mutates files.** Otherwise parallel tool calls can race against built-in `edit`/`write`.

---

## Critical Files for the Spec Author

Read these first when authoring the rewrite spec:
1. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`** — every API Atomic plugs into.
2. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`** — UI primitives the workflow pane uses.
3. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/development.md`** — the fork/rebrand recipe.
4. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`** — how Atomic bundles its skills/prompts/themes/extensions.
5. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`** — how Atomic's entry point wires everything.
6. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`** — closest reference for Atomic's workflow tool.
7. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts`** — closest reference for Atomic's workflow-aware mode + widget.
8. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/handoff.ts`** — closest reference for "spawn a new focused session" pattern.
9. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/doom-overlay/`** — proof overlays handle high-FPS dynamic UI.
10. **`/home/alilavaee/.cache/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/sdk/12-full-control.ts`** — pattern for Atomic's main entry point when full discovery is replaced by bundled resources.