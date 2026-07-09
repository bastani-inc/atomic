## Analysis: Atomic command, extension, and startup loading path

### Overview

`packages/coding-agent` starts through a thin CLI shim that handles `--version` before dynamically importing the full runtime, then `main()` resolves CLI mode, trust, sessions, built-in package roots, resources, extensions, model scope, and finally launches print/RPC/interactive mode. Extension, skill, prompt, theme, and workflow resources flow through `DefaultResourceLoader`, which uses `DefaultPackageManager` for settings/package/auto-discovery paths, then loads extension factories with jiti and exposes their registered tools, commands, flags, shortcuts, providers, and lifecycle handlers through `ExtensionRunner`.

### Entry Points

- `packages/coding-agent/package.json:16-18` - publishes the `atomic` binary as `dist/cli.js`.
- `packages/coding-agent/src/cli.ts:1-31` - executable CLI entry point; fast-paths `--version`, then dynamically imports HTTP dispatcher setup and `main()`.
- `packages/coding-agent/src/main.ts:40-500` - main startup orchestration for package/config commands, argument parsing, session selection, resource loading, runtime creation, and mode dispatch.
- `packages/coding-agent/src/cli/args.ts:74-232` - parses core CLI flags plus unknown `--flags` that may be extension-registered flags.
- `packages/coding-agent/src/core/agent-session-services.ts:141-194` - creates cwd-bound services and calls `resourceLoader.reload()`.
- `packages/coding-agent/src/core/sdk.ts:107-495` - SDK/session construction path used by CLI runtime and programmatic users.

---

### Core Implementation

#### 1. CLI boot path and metadata fast path

- `cli.ts` imports only `APP_NAME` and `VERSION` statically, with the file comment stating the rest of the CLI graph is loaded dynamically so metadata fast paths skip it (`packages/coding-agent/src/cli.ts:8-11`).
- It sets `process.title`, marks the process with an app-specific `*_CODING_AGENT` env var, and suppresses `process.emitWarning` (`packages/coding-agent/src/cli.ts:13-15`).
- `--version` and `-v` are handled before importing `main.ts`, printing `VERSION` and exiting (`packages/coding-agent/src/cli.ts:17-22`).
- Normal startup uses `Promise.all([import("./core/http-dispatcher.ts"), import("./main.ts")])`, calls `configureHttpDispatcher()`, then calls `main(args)` (`packages/coding-agent/src/cli.ts:24-31`).

#### 2. Top-level command handling before normal runtime creation

- `main()` resets timing state and enables offline mode when `--offline` or the offline env flag is present; offline mode also sets skip-version-check (`packages/coding-agent/src/main.ts:40-46`).
- Package-manager commands are handled before `parseArgs()`: `handlePackageCommand(args, { extensionFactories })` can exit the process after draining stdio (`packages/coding-agent/src/main.ts:48-53`).
- `handleConfigCommand()` also runs before standard CLI parsing and returns without entering normal app mode when handled (`packages/coding-agent/src/main.ts:55-57`).
- The user-facing command list documents `install`, `remove`, `uninstall`, `update`, `list`, and `config` (`packages/coding-agent/src/cli/args.ts:251-258`).

#### 3. CLI resource flags and extension flags

- Core parser fields include `extensions`, `skills`, `promptTemplates`, `themes`, `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and an `unknownFlags` map for possible extension flags (`packages/coding-agent/src/cli/args.ts:22-65`).
- `--extension`/`-e`, `--skill`, `--prompt-template`, and `--theme` append paths to arrays; `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes` set disable flags (`packages/coding-agent/src/cli/args.ts:172-193`).
- Unknown long flags are stored in `unknownFlags`; `--flag=value` stores a string value, `--flag value` stores the next token, and bare `--flag` stores `true` (`packages/coding-agent/src/cli/args.ts:211-224`).
- Help rendering accepts extension flag metadata and prints an “Extension CLI Flags” section when loaded extensions expose flags (`packages/coding-agent/src/cli/args.ts:235-244`).
- After resources load, `createAgentSessionServices()` validates unknown CLI flags against extension-registered flags and writes accepted values into the extension runtime’s `flagValues` map (`packages/coding-agent/src/core/agent-session-services.ts:88-134`, `packages/coding-agent/src/core/agent-session-services.ts:181-183`).

#### 4. Trust, session cwd, and resource path resolution

- Startup creates project trust state before reading project-local runtime resources, deriving `startupProjectTrusted` from CLI override, stored trust, lack of trust inputs, or global default project trust (`packages/coding-agent/src/main.ts:106-113`).
- CLI resource paths are resolved against startup cwd early: extensions, skills, prompt templates, and themes are resolved via `resolveCliPaths()` (`packages/coding-agent/src/main.ts:114-115`).
- Session selection occurs before cwd-bound runtime service creation because `--session` and `--resume` may point to sessions from another cwd; the comment explicitly says project-local settings/resources/providers/models must resolve after final session cwd is known (`packages/coding-agent/src/main.ts:133-137`).
- Final runtime cwd is `sessionManager.getCwd()` (`packages/coding-agent/src/main.ts:168`), and resource loader options later receive the already-resolved CLI resource paths (`packages/coding-agent/src/main.ts:269-283`).

#### 5. Built-in package roots: workflows, subagents, web-access, and others

- `WORKSPACE_BUILTINS` defines first-party package descriptors for:
  - `@bastani/workflows`
  - `@bastani/subagents`
  - `@bastani/mcp`
  - `@bastani/web-access`
  - `@bastani/intercom`
  - `@bastani/cursor`
  with required entries and dist directory names (`packages/coding-agent/src/core/builtin-packages.ts:26-63`).
- `getBuiltinPackagePaths()` computes candidate roots from source checkout paths and dist/binary layout paths, returning only directories whose required entry exists and whose `package.json` name matches the descriptor (`packages/coding-agent/src/core/builtin-packages.ts:80-119`, `packages/coding-agent/src/core/builtin-packages.ts:121-158`).
- `main()` calls `getBuiltinPackagePaths()` unless `MainOptions.builtinPackagePaths` is supplied, then passes those paths into `DefaultResourceLoader` as `builtinPackagePaths` (`packages/coding-agent/src/main.ts:172`, `packages/coding-agent/src/main.ts:269-275`).
- Build scripts copy those same built-ins into `dist/builtin/`; the copy plan lists the same six workspace packages (`packages/coding-agent/scripts/copy-builtin-packages.ts:44-51`), copies each to `dist/builtin/<name>` (`packages/coding-agent/scripts/copy-builtin-packages.ts:198-205`), and emits workflow authoring declarations/ambient bridge files for `@bastani/workflows` compatibility (`packages/coding-agent/scripts/copy-builtin-packages.ts:207-211`).
- The npm package build scripts call `copy-builtin-packages` as part of `copy-assets` and binary asset copying (`packages/coding-agent/package.json:69-72`).

#### 6. Runtime service creation and resource loader construction

- `createAgentSessionServices()` resolves cwd/agentDir, creates or reuses `AuthStorage`, `SettingsManager`, and `ModelRegistry`, constructs `DefaultResourceLoader`, and awaits `resourceLoader.reload(options.resourceLoaderReloadOptions)` (`packages/coding-agent/src/core/agent-session-services.ts:141-163`).
- After resource loading, it flushes provider registrations queued during extension loading into `ModelRegistry` (`packages/coding-agent/src/core/agent-session-services.ts:165-180`).
- Then it validates extension flags from parsed unknown CLI flags (`packages/coding-agent/src/core/agent-session-services.ts:181-183`).
- `createAgentSessionFromServices()` delegates to public `createAgentSession()` with loaded services, model/tool options, custom tools, and optional session-start event (`packages/coding-agent/src/core/agent-session-services.ts:203-225`).

#### 7. DefaultResourceLoader state and reload behavior

- `DefaultResourceLoader` stores cwd, agentDir, settings manager, package manager, additional resource paths, built-in package paths, inline extension factories, no-resource flags, system prompt inputs, current loaded extensions/skills/prompts/themes/context files, workflow resources, and source info maps (`packages/coding-agent/src/core/resource-loader-core.ts:30-86`).
- The constructor merges inherited resource loader snapshot values with explicit options, including additional extension/skill/prompt/theme paths and `builtinPackagePaths` (`packages/coding-agent/src/core/resource-loader-core.ts:87-129`).
- Accessors expose loaded extensions, skills, prompts, themes, AGENTS/CLAUDE context files, system prompt text, append-system-prompt fragments, and workflow resources (`packages/coding-agent/src/core/resource-loader-core.ts:160-190`).
- `reload()` delegates to `reloadDefaultResourceLoader()` (`packages/coding-agent/src/core/resource-loader-core.ts:249-250`).

#### 8. Package and resource discovery flow

- `resolvePackageResourcePaths()` reloads settings, calls `packageManager.resolve()` for configured packages/top-level/auto resources, separately resolves explicit CLI extension sources, and separately resolves built-in package paths as temporary extension sources (`packages/coding-agent/src/core/resource-loader-package-resources.ts:14-43`).
- Configured packages are taken from project settings first, then global settings, then deduped and resolved (`packages/coding-agent/src/core/package-manager-resolver.ts:32-49`).
- Top-level settings arrays for `extensions`, `skills`, `prompts`, `themes`, and `workflows` are resolved from project and global base dirs (`packages/coding-agent/src/core/package-manager-resolver.ts:51-78`).
- Auto-discovery adds project resources only when project is trusted, then adds user resources; it scans `.atomic`/legacy config dirs for extensions, skills, prompts, themes, workflows, and scans `.agents/skills` for user/project skill locations (`packages/coding-agent/src/core/package-manager-auto-resources.ts:49-108`).
- Package manifests are read from `package.json` using the current app-name key (for Atomic, `atomic`) or legacy `pi` (`packages/coding-agent/src/core/package-manager-manifest.ts:6-16`).
- Manifest entries map resource keys to arrays; workflows accept `workflows` or legacy singular `workflow` (`packages/coding-agent/src/core/package-manager-manifest.ts:43-50`).
- Without a manifest, convention directories are used: `extensions/`, `skills/`, `prompts/`, `themes/`, and `workflows/` or `workflow/` (`packages/coding-agent/src/core/package-manager-manifest.ts:36-41`).
- `collectPackageResources()` applies filters if present, otherwise reads manifest entries; when a manifest exists, default workflow convention resources are also collected if workflows are not declared (`packages/coding-agent/src/core/package-manager-resource-collector.ts:24-50`).
- If no manifest exists, convention dirs are scanned for all resource types (`packages/coding-agent/src/core/package-manager-resource-collector.ts:51-59`).

#### 9. Extension discovery file rules

- Extension directory resolution first checks package manifest extension entries, then root `index.ts`, then root `index.js`; if found, those are used (`packages/coding-agent/src/core/package-manager-resource-files.ts:180-200`).
- Auto extension collection returns root entries if present; otherwise it walks non-hidden, non-`node_modules` entries and collects `.ts`/`.js` files or subdirectories with their own extension entries (`packages/coding-agent/src/core/package-manager-resource-files.ts:203-229`).
- Resource scans honor `.gitignore`, `.ignore`, and `.fdignore` by adding ignore rules during traversal (`packages/coding-agent/src/core/package-manager-resource-files.ts:9-49`).

#### 10. Skills, prompt templates, and themes

- `reloadDefaultResourceLoader()` computes enabled skills, prompts, and themes from configured/package resources, built-in package resources, and CLI paths; disable flags cause only CLI resources and additional explicit paths to remain for that type (`packages/coding-agent/src/core/resource-loader-reload.ts:197-224`, `packages/coding-agent/src/core/resource-loader-reload.ts:254-303`).
- Package skill directories are mapped to `SKILL.md` when the resolved resource path is a directory containing that file (`packages/coding-agent/src/core/resource-loader-reload.ts:45-68`).
- `updateSkillsFromPathsAsync()` calls `loadSkillsAsync()` with `includeDefaults: false`, then applies source info from extension/package metadata (`packages/coding-agent/src/core/resource-loader-assets.ts:23-50`).
- `loadSkillsAsync()` loads `SKILL.md` or markdown skill files, parses frontmatter, requires a non-empty description, derives default name from containing directory, validates name characters/length, and returns `Skill` objects with `filePath`, `baseDir`, and `disableModelInvocation` (`packages/coding-agent/src/core/skills-async.ts:84-104`).
- Skill directory scanning stops at a directory containing `SKILL.md` and does not descend into nested skills under that directory (`packages/coding-agent/src/core/skills-async.ts:127-141`).
- Default/user/project skill loading can include `agentDir/skills`, project `.atomic/skills`, and `.agents/skills`, depending on caller options and package-manager resource selection (`packages/coding-agent/src/core/skills-async.ts:172-241`).
- Prompt templates are loaded through `loadPromptTemplatesAsync()` and deduped by template name, with collision diagnostics for duplicate names (`packages/coding-agent/src/core/resource-loader-assets.ts:52-79`, `packages/coding-agent/src/core/resource-loader-assets.ts:181-198`).
- Themes load from `.json` files, are deduped by theme name, and produce collision diagnostics for duplicate names (`packages/coding-agent/src/core/resource-loader-assets.ts:81-109`, `packages/coding-agent/src/core/resource-loader-assets.ts:118-179`, `packages/coding-agent/src/core/resource-loader-assets.ts:200-218`).

#### 11. System prompt and context file integration

- Resource reload loads project context files unless `noContextFiles` is set; the load is gated by cwd, agentDir, and project trust (`packages/coding-agent/src/core/resource-loader-reload.ts:313-327`).
- System prompt input resolves from explicit `systemPromptSource` or discovered system prompt file; append-system-prompt resolves from explicit append sources or a discovered append prompt file (`packages/coding-agent/src/core/resource-loader-reload.ts:329-345`).
- During prompt rebuild, `AgentSession` pulls loader system prompt, append-system-prompt fragments, loaded skills, and loaded context files from `ResourceLoader` into `BuildSystemPromptOptions` (`packages/coding-agent/src/core/agent-session-state.ts:104-124`).
- `buildSystemPrompt()` uses a custom prompt when present, appends configured append text, appends project context files, appends skills only when `read` is available, then appends model name, reasoning level, date, and cwd (`packages/coding-agent/src/core/system-prompt.ts:89-117`).
- With the default prompt, it builds visible tool snippets, guidelines, docs references, append section, context files, skills when `read` is active, and the same metadata footer (`packages/coding-agent/src/core/system-prompt.ts:119-222`).
- Skill invocation text `/skill:<name> args` is expanded at prompt time by reading the skill file, stripping frontmatter, wrapping it in a `<skill>` block with `name`, `location`, and base-dir reference text, then appending user args (`packages/coding-agent/src/core/agent-session-prompt.ts:286-310`).

#### 12. Extension module loading

- Extension loading uses `loadExtensionsCached()` from `resource-loader-extensions.ts` and `extensions/loader-core.ts`; paths are loaded in order, yielding between extension loads after the first (`packages/coding-agent/src/core/resource-loader-extensions.ts:18-49`, `packages/coding-agent/src/core/extensions/loader-core.ts:114-162`).
- Each extension path is resolved relative to cwd, imported through `loadExtensionModule()`, checked for a default factory function, then invoked with an `ExtensionAPI` instance (`packages/coding-agent/src/core/extensions/loader-core.ts:43-83`).
- Inline factories supplied through `MainOptions.extensionFactories` or SDK/test harness options are loaded as `<inline:n>` extensions against the same runtime (`packages/coding-agent/src/core/resource-loader-extensions.ts:93-129`).
- `loadExtensionModule()` uses jiti, with alias resolution in normal Node/dev mode and virtual modules in bundled/single-file builds; it aliases `@bastani/atomic`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `@earendil-works/pi-ai`/compat imports for extension modules (`packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:16-52`, `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:168-220`, `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:237-275`).
- `@earendil-works/pi-ai` root imports are mapped to the compat module in virtual modules and aliases (`packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:23-28`, `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:41-45`, `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts:201-205`).
- Extension load conflicts for tools and flags are detected after loading; conflicts are added to extension errors while keeping extensions loaded (`packages/coding-agent/src/core/resource-loader-extensions.ts:131-176`).

#### 13. Extension API registration surface

- `createExtensionAPI()` exposes registration methods that mutate the current `Extension` object:
  - `on()` stores lifecycle/event handlers by event name (`packages/coding-agent/src/core/extensions/loader-api.ts:39-44`).
  - `registerTool()` stores a tool definition plus extension source info and calls `runtime.refreshTools()` (`packages/coding-agent/src/core/extensions/loader-api.ts:46-53`).
  - `registerCommand()` stores a slash command with source info (`packages/coding-agent/src/core/extensions/loader-api.ts:55-62`).
  - `registerShortcut()` stores shortcut handlers (`packages/coding-agent/src/core/extensions/loader-api.ts:64-77`).
  - `registerFlag()` stores flag metadata and default runtime flag value (`packages/coding-agent/src/core/extensions/loader-api.ts:79-96`).
  - `registerMessageRenderer()` stores renderers by custom message type (`packages/coding-agent/src/core/extensions/loader-api.ts:98-101`).
  - `registerProvider()` queues provider registrations on the runtime until model registry binding is ready (`packages/coding-agent/src/core/extensions/loader-api.ts:195-198`, `packages/coding-agent/src/core/extensions/loader-runtime.ts:35-49`).
- Action methods such as `sendMessage`, `setActiveTools`, `getCommands`, and model methods call into the shared extension runtime and are unavailable until the runner binds core actions (`packages/coding-agent/src/core/extensions/loader-runtime.ts:3-12`, `packages/coding-agent/src/core/extensions/runner.ts:160-232`).

#### 14. ExtensionRunner and runtime binding

- `ExtensionRunner` is constructed with loaded extensions, the shared extension runtime, cwd, session manager, model registry, and optional orchestration context (`packages/coding-agent/src/core/extensions/runner.ts:112-158`).
- `bindCore()` copies session actions into the shared runtime, binds context action callbacks, flushes queued provider registrations into `ModelRegistry`, then replaces provider registration methods with immediate model-registry operations (`packages/coding-agent/src/core/extensions/runner.ts:160-232`).
- Tool, flag, message renderer, command, and shortcut lookups are resolved from loaded extensions:
  - tool collection uses first registration per name (`packages/coding-agent/src/core/extensions/runner-registries.ts:10-20`);
  - tool lookup scans extensions in load order (`packages/coding-agent/src/core/extensions/runner-registries.ts:22-33`);
  - flags use first registration per name (`packages/coding-agent/src/core/extensions/runner-registries.ts:35-45`);
  - duplicate slash command names are assigned invocation names like `name:2` (`packages/coding-agent/src/core/extensions/runner-registries.ts:67-97`).
- `ExtensionRunner` emits specialized event chains for message end, tool result, tool call, user bash, context transformation, provider request, before-agent-start, resources-discover, and input events (`packages/coding-agent/src/core/extensions/runner.ts:395-462`).

#### 15. AgentSession tool registry and custom tools

- `createAgentSession()` creates an `Agent` with an empty initial tool list and later constructs `AgentSession` with the loaded `resourceLoader`, optional `customTools`, and `extensionRunnerRef` (`packages/coding-agent/src/core/sdk.ts:329-438`, `packages/coding-agent/src/core/sdk.ts:469-485`).
- `AgentSession` stores `customTools` from config and calls `_buildRuntime()` during construction with initial active tools and `includeAllExtensionTools: true` (`packages/coding-agent/src/core/agent-session.ts:129-158`).
- `_buildRuntime()` creates built-in tool definitions from settings, constructs `ExtensionRunner` from `resourceLoader.getExtensions()`, binds extension core/actions, then calls `_refreshToolRegistry()` (`packages/coding-agent/src/core/agent-session-tool-registry.ts:130-210`).
- `_refreshToolRegistry()` combines extension-registered tools and SDK `customTools`, filters them through allowlist/denylist, overlays them onto built-in tool definitions by name, wraps extension/custom and built-in definitions into `AgentTool`s, then updates active tools (`packages/coding-agent/src/core/agent-session-tool-registry.ts:11-127`).
- SDK custom tools receive synthetic source info like `<sdk:toolName>` (`packages/coding-agent/src/core/agent-session-tool-registry.ts:26-33`).
- Extension/custom tools override built-in entries with the same name in the final definition registry and tool registry because they are inserted after base definitions (`packages/coding-agent/src/core/agent-session-tool-registry.ts:34-51`, `packages/coding-agent/src/core/agent-session-tool-registry.ts:80-83`).
- `wrapRegisteredTools()` adapts tool definitions so execution receives an extension runner context (`packages/coding-agent/src/core/extensions/wrapper.ts:13-30`).
- Docs describe SDK `customTools` as direct `createAgentSession({ customTools: [...] })` inputs that combine with extension-registered tools (`packages/coding-agent/docs/sdk.md:571-601`).

#### 16. Slash command, prompt template, and skill command integration

- `AgentSession.prompt()` first handles slash commands when prompt/template expansion is enabled: it tries built-in commands, then extension commands, before extension input interception and skill/template expansion (`packages/coding-agent/src/core/agent-session-prompt.ts:16-31`).
- Extension input handlers run before skill and prompt-template expansion; they can mark input handled or transform text/images (`packages/coding-agent/src/core/agent-session-prompt.ts:33-51`).
- Skill commands and prompt templates expand after input interception (`packages/coding-agent/src/core/agent-session-prompt.ts:53-58`).
- Extension slash command lookup uses `extensionRunner.getCommand(commandName)` and invokes `command.handler(args, ctx)` with an extension command context (`packages/coding-agent/src/core/agent-session-prompt.ts:254-278`).
- The command registry exposed to autocomplete/UI is built from extension commands, prompt templates, and skills prefixed as `skill:<name>` (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:128-152`).

#### 17. Extension lifecycle binding in interactive mode

- Interactive mode binds current session extensions by creating a UI context, calling `session.bindExtensions()`, binding command-context actions for new session/fork/tree navigation/switch/reload, and wiring shutdown/error handlers (`packages/coding-agent/src/modes/interactive/interactive-session-runtime.ts:4-83`).
- After binding, interactive mode registers loaded themes, sets autocomplete provider, sets extension shortcuts, and shows loaded resources unless deferred startup is pending (`packages/coding-agent/src/modes/interactive/interactive-session-runtime.ts:85-93`).
- `session.bindExtensions()` applies UI/command/error bindings, emits `session_start`, then runs `extendResourcesFromExtensions()` for `resources_discover` handlers (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:10-30`).
- `extendResourcesFromExtensions()` emits `resources_discover`, converts returned skill/prompt/theme paths to resource extension paths, calls `resourceLoader.extendResources()`, and rebuilds the base system prompt (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:33-56`).

#### 18. Deferred interactive startup

- `computeDeferExtensions()` returns true only for interactive TTY startup with no session-start event, no help/list-models, no unresolved project trust prompt, no explicit extension/resource paths, no system-prompt inputs, no provider/model selection, and no unknown extension flags (`packages/coding-agent/src/main-deferred-startup.ts:55-69`).
- `main()` passes `deferExtensions: true, deferResources: true` to resource loader reload when the deferred fast path applies (`packages/coding-agent/src/main.ts:194-230`).
- In deferred resource mode without trust resolution, resource reload creates an empty extension runtime, clears extensions/skills/prompts/themes/context resources, resolves only explicit system prompt inputs, marks loaded, and returns (`packages/coding-agent/src/core/resource-loader-reload.ts:150-184`).
- Interactive mode stores `deferredStartupPending` from `options.deferredExtensionLoad` (`packages/coding-agent/src/modes/interactive/interactive-mode-base.ts:384-390`).
- Deferred completion binds extensions, calls `session.reload({ reason: "startup" })`, registers themes, reapplies settings/theme, autocomplete, shortcuts, deferred model scope, deferred model restore, and resource disclosure (`packages/coding-agent/src/modes/interactive/interactive-deferred-startup.ts:30-74`).
- `session.reload({ reason: "startup" })` reloads settings, resets API providers, calls full `resourceLoader.reload()`, rebuilds runtime with previous flag values, then emits `session_start` and resources discovery when bindings exist (`packages/coding-agent/src/core/agent-session-extension-bindings.ts:242-265`).

#### 19. Theme integration

- `main()` calls `initTheme(settingsManager.getTheme(), appMode === "interactive")` after preparing the initial message and before mode launch (`packages/coding-agent/src/main.ts:410-417`).
- Interactive constructor registers themes from the resource loader and creates `InteractiveThemeController` (`packages/coding-agent/src/modes/interactive/interactive-mode-base.ts:440-447`).
- After binding current session extensions, interactive mode re-registers themes from the resource loader (`packages/coding-agent/src/modes/interactive/interactive-session-runtime.ts:85`).
- Deferred startup completion also calls `setRegisteredThemes(this.session.resourceLoader.getThemes().themes)` and applies theme settings (`packages/coding-agent/src/modes/interactive/interactive-deferred-startup.ts:44-45`).
- `/reload` refreshes registered themes and reapplies the theme controller (`packages/coding-agent/src/modes/interactive/interactive-slash-commands.ts:57-59`).

---

### Built-in package registration/loading details

#### `packages/workflows`

- The package manifest declares `name: "@bastani/workflows"` (`packages/workflows/package.json:1-3`).
- Its legacy `pi` manifest registers `./src/extension/index.ts` as an extension, `./skills` as skills, and no prompt templates (`packages/workflows/package.json:68-79`).
- `src/extension/index.ts` exports the default factory from `extension-factory.js` (`packages/workflows/src/extension/index.ts:1`).
- The factory builds runtime adapters/state, workflow overlay, workflow command map, persistence/intercom refs, and the `workflow` tool implementation (`packages/workflows/src/extension/extension-factory.ts:77-89`).
- It registers:
  - workflow tool (`packages/workflows/src/extension/extension-factory.ts:90`);
  - `/workflow` slash command (`packages/workflows/src/extension/extension-factory.ts:91-103`);
  - message renderers (`packages/workflows/src/extension/extension-factory.ts:104`);
  - lifecycle handlers (`packages/workflows/src/extension/extension-factory.ts:105`);
  - store widget/tool execution hooks/shortcut/intercom/input interceptor (`packages/workflows/src/extension/extension-factory.ts:107-111`).
- The tool registration registers tool name `workflow` with `WorkflowParametersSchema`, prompt guidance, execute/render handlers (`packages/workflows/src/extension/workflow-tool-registration.ts:11-54`).
- The slash command registration registers command name `workflow` with completions and command handler (`packages/workflows/src/extension/workflow-command-registration.ts:49-65`).
- Workflow resource discovery includes enabled workflows from CLI extension sources and enabled package workflows from configured packages and built-in packages (`packages/coding-agent/src/core/resource-loader-package-resources.ts:104-114`).
- Extensions can receive workflow resources through `pi.getWorkflowResources()` and refresh via `pi.refreshWorkflowResources()` (`packages/coding-agent/src/core/extensions/loader-api.ts:109-118`).

#### `packages/subagents`

- The package manifest declares `name: "@bastani/subagents"` (`packages/subagents/package.json:1-3`).
- Its `pi` manifest registers `./src/extension/index.ts` as an extension, `./skills` as skills, and `./prompts` as prompts (`packages/subagents/package.json:28-38`).
- The extension entry imports Atomic extension types, TUI components, agent discovery, subagent executors, background trackers, slash bridges, config, prompt guidance, and renderers (`packages/subagents/src/extension/index.ts:1-31`).
- `registerSubagentExtension()` exits early for subagent child/fanout child env modes, registering only fanout-child extension when the fanout env flag is set (`packages/subagents/src/extension/index.ts:158-162`).
- On normal load it ensures result/async dirs, cleans old chain/artifact/runtime dirs, loads config, initializes extension state, starts/primes result watcher, creates async tracker and subagent executor (`packages/subagents/src/extension/index.ts:172-229`).
- It registers custom message renderers for slash results, notifications, and control notices (`packages/subagents/src/extension/index.ts:230-269`).
- It registers prompt/slash bridge integrations (`packages/subagents/src/extension/index.ts:277-319`).
- It defines and registers the `subagent` tool with action/list/execute/control behavior, schema, prompt guidance, renderer, and executor callback (`packages/subagents/src/extension/index.ts:327-393`).
- It registers subagent slash commands after the tool (`packages/subagents/src/extension/index.ts:393-394`).
- It registers event bus handlers, tool-result hydration, session-start reset, and session-shutdown cleanup (`packages/subagents/src/extension/index.ts:407-491`).

#### `packages/web-access`

- The package manifest declares `name: "@bastani/web-access"` (`packages/web-access/package.json:1-3`).
- Its `pi` manifest registers `./index.ts` as the only extension (`packages/web-access/package.json:27-31`).
- `index.ts` implements a lightweight registration surface and defers heavy implementation import until needed via `import("./index-heavy.js")` inside `loadHeavy()` (`packages/web-access/index.ts:109-134`).
- It captures heavy tools/commands/handlers/shortcuts through a proxy so the heavy module can register against a captured API, while lightweight wrappers are registered with Atomic immediately (`packages/web-access/index.ts:37-66`, `packages/web-access/index.ts:122-130`).
- Session lifecycle handlers snapshot/replay `session_start`, `session_tree`, and `session_shutdown` events to the heavy module if/when it is loaded (`packages/web-access/index.ts:136-161`).
- It registers shortcuts for curator/activity, whose handlers call `loadHeavy()` and dispatch to captured heavy shortcut handlers (`packages/web-access/index.ts:163-174`).
- It registers lightweight wrapper tools:
  - `web_search` (`packages/web-access/index.ts:176-198`);
  - `code_search` (`packages/web-access/index.ts:200-211`);
  - `fetch_content` (`packages/web-access/index.ts:213-229`);
  - `get_search_content` (`packages/web-access/index.ts:231-245`).
- It registers commands `websearch`, `curator`, `google-account`, and `search`, each dispatching through `runHeavyCommand(loadHeavy, ...)` (`packages/web-access/index.ts:247-257`).

---

### Data Flow

1. User runs `atomic`; package bin resolves to `dist/cli.js` (`packages/coding-agent/package.json:16-18`).
2. CLI shim handles `--version` or dynamically imports `main.ts` (`packages/coding-agent/src/cli.ts:17-31`).
3. `main()` handles package/config commands before standard parsing (`packages/coding-agent/src/main.ts:48-57`).
4. `parseArgs()` collects core flags, resource paths, and unknown extension flags (`packages/coding-agent/src/cli/args.ts:74-232`).
5. `main()` resolves trust, final session cwd, and built-in package paths (`packages/coding-agent/src/main.ts:106-172`).
6. `createAgentSessionServices()` constructs `DefaultResourceLoader` and calls `reload()` (`packages/coding-agent/src/core/agent-session-services.ts:155-163`).
7. Resource loader resolves:
   - configured packages/settings resources;
   - explicit `-e` extension sources;
   - built-in package sources (`packages/coding-agent/src/core/resource-loader-package-resources.ts:14-43`).
8. Package manager reads `atomic`/`pi` manifests or convention directories (`packages/coding-agent/src/core/package-manager-manifest.ts:6-50`, `packages/coding-agent/src/core/package-manager-resource-collector.ts:24-59`).
9. Enabled extension paths are loaded with jiti into extension factories (`packages/coding-agent/src/core/resource-loader-reload.ts:228-251`, `packages/coding-agent/src/core/extensions/loader-core.ts:43-83`).
10. Extension factories call `pi.registerTool()`, `pi.registerCommand()`, `pi.registerFlag()`, etc., mutating `Extension` objects (`packages/coding-agent/src/core/extensions/loader-api.ts:39-101`).
11. Loaded skills/prompts/themes/context/system prompt resources are stored in `DefaultResourceLoader` (`packages/coding-agent/src/core/resource-loader-reload.ts:254-345`).
12. `createAgentSession()` constructs `AgentSession`, which builds `ExtensionRunner`, tool registry, active tools, and system prompt (`packages/coding-agent/src/core/sdk.ts:469-485`, `packages/coding-agent/src/core/agent-session-tool-registry.ts:130-210`).
13. Interactive mode binds extension UI/command lifecycle, emits `session_start`, lets extensions add resources via `resources_discover`, registers themes, autocomplete, and shortcuts (`packages/coding-agent/src/modes/interactive/interactive-session-runtime.ts:4-93`).
14. On prompt submission, slash commands run first, then extension input hooks, skill/template expansion, before-agent-start handlers, and model/tool execution (`packages/coding-agent/src/core/agent-session-prompt.ts:16-180`).

---

### Key Patterns

- **Manifest/convention resource discovery**: Packages declare resources under `atomic` or legacy `pi`, or use conventional resource directories (`packages/coding-agent/src/core/package-manager-manifest.ts:6-50`, `packages/coding-agent/src/core/package-manager-resource-collector.ts:24-59`).
- **Resource loader as integration hub**: `DefaultResourceLoader` centralizes extensions, skills, prompts, themes, context files, system prompt inputs, workflow resources, and inherited snapshots (`packages/coding-agent/src/core/resource-loader-core.ts:30-86`).
- **Extension factory API**: Extension modules export a factory invoked with `ExtensionAPI`; registration methods populate extension-local registries (`packages/coding-agent/src/core/extensions/loader-core.ts:65-76`, `packages/coding-agent/src/core/extensions/loader-api.ts:29-209`).
- **Shared runtime then runner binding**: Extension APIs capture a shared runtime during load; `ExtensionRunner.bindCore()` later wires that runtime to live session actions (`packages/coding-agent/src/core/extensions/loader-runtime.ts:3-56`, `packages/coding-agent/src/core/extensions/runner.ts:160-232`).
- **Tool overlay model**: Built-ins are created first; extension/custom tools are merged after built-ins and can replace names in the final tool registry (`packages/coding-agent/src/core/agent-session-tool-registry.ts:34-51`, `packages/coding-agent/src/core/agent-session-tool-registry.ts:80-83`).
- **Deferred startup gate**: Interactive TTY startup can initially load no resources, then complete full resource/extension loading before first normal model turn if needed (`packages/coding-agent/src/main-deferred-startup.ts:55-69`, `packages/coding-agent/src/modes/interactive/interactive-deferred-startup.ts:30-74`).
- **Lazy heavy built-ins**: Web-access registers lightweight wrappers immediately and imports heavy implementation only when a tool/command/shortcut needs it (`packages/web-access/index.ts:109-134`, `packages/web-access/index.ts:176-257`).

---

### Configuration

- Package metadata declares app config directory `.atomic` and package name `atomic` (`packages/coding-agent/package.json:6-15`).
- CLI help documents resource flags and disable flags (`packages/coding-agent/src/cli/args.ts:260-304`).
- Settings docs define resource arrays: `packages`, `extensions`, `skills`, `prompts`, `themes`, `workflows`, and `enableSkillCommands` (`packages/coding-agent/docs/settings.md:299-313`).
- Docs state settings paths in global settings resolve relative to `~/.atomic/agent`, while project settings resolve relative to `.atomic`; absolute paths and `~` are supported (`packages/coding-agent/docs/settings.md:299-301`).
- Package docs state resources can be declared in `package.json` under the `atomic` key or by conventional directories (`packages/coding-agent/docs/packages.md:3-6`).
- Package docs also document `-e` temporary packages and borrowed project-local `.atomic`, `.pi`, and `.agents/skills` resources for local directories (`packages/coding-agent/docs/packages.md:51-60`).
- Extension docs document auto-discovery locations and the `--extension` quick-test path (`packages/coding-agent/docs/extensions.md:102-136`).

---

### Error Handling and Diagnostics

- CLI parse diagnostics print warnings/errors; parse errors exit with code 1 (`packages/coding-agent/src/main.ts:59-68`).
- Extension load errors are collected in `LoadExtensionsResult.errors` and later surfaced as runtime diagnostics like `Failed to load extension "<path>": <error>` (`packages/coding-agent/src/main.ts:286-293`).
- Resource path existence checks add diagnostics for missing explicit extension/skill/prompt/theme paths (`packages/coding-agent/src/core/resource-loader-reload.ts:243-250`, `packages/coding-agent/src/core/resource-loader-reload.ts:264-310`).
- Unknown extension CLI flags become startup errors after extensions load if no registered flag matches (`packages/coding-agent/src/core/agent-session-services.ts:105-133`).
- Extension command handler errors are emitted through `extensionRunner.emitError()` and treated as handled slash commands (`packages/coding-agent/src/core/agent-session-prompt.ts:263-277`).
- Skill expansion read errors emit extension errors and leave the original text unchanged (`packages/coding-agent/src/core/agent-session-prompt.ts:296-309`).
- Deferred startup completion catches load failures, clears pending state, stops working loader, and shows `Extension loading failed: ...` (`packages/coding-agent/src/modes/interactive/interactive-deferred-startup.ts:65-73`).

---

### Tests Covering Current Behavior

- `packages/coding-agent/test/main-deferred-startup.test.ts:56-90` verifies deferred startup is allowed only on the plain interactive TTY path and disabled for metadata commands, explicit resource paths, unknown extension flags, system prompt inputs, provider/model selection, trust prompt needs, non-interactive modes, non-TTY modes, and resumed startup.
- `packages/coding-agent/test/main-deferred-startup.test.ts:92-135` verifies early input capture is enabled for plain deferred interactive startup and disabled for resume/session startup and explicit provider/model selection.
- `packages/coding-agent/test/resource-loader-defer-resources.test.ts:43-61` verifies `DefaultResourceLoader.reload({ deferExtensions: true, deferResources: true })` skips built-in package resource discovery and a later full reload loads package skills.
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts:139-207` verifies web-access/intercom cold registration does not statically import heavy modules and that MCP cold startup exposes proxy/direct tools according to cache state.
- `packages/coding-agent/test/package-manager-extension-sources.suite.ts:105-187` verifies local extension files, manifest package directories, tilde-like manifest entries, and auto-discovery directory layouts resolve as extension/package resources.
- `packages/coding-agent/test/package-manager-extension-sources.suite.ts:189-293` verifies explicit temporary local directory sources can include package resources plus borrowed `.atomic`, `.pi`, and `.agents/skills` project-local resources with appropriate metadata.
- `packages/coding-agent/test/package-manager-extension-sources.suite.ts:295-348` verifies directory fallback behavior for project-local-only and root-extension local sources.
- `packages/coding-agent/test/package-manager-discovery.suite.ts:105-190` verifies metadata/baseDir for auto-discovered user/project `.pi` and `.agents` skills.
- `packages/coding-agent/test/package-manager-discovery.suite.ts:193-222` verifies `.agents/skills` project scanning from cwd up to git repo root.
- `packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts:16-70` verifies `pi.setActiveTools()` inside an extension tool changes the active tool set before the next provider request in the same run.
- `packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts:72-133` verifies before-agent-start system prompt overrides are preserved when active tools change mid-run.

---

### Docs and Changelog Notes

- Extension docs describe extensions as TypeScript modules that can subscribe to lifecycle events, register custom tools, add commands, and more (`packages/coding-agent/docs/extensions.md:3-16`).
- Extension docs show an example extension registering a tool and command (`packages/coding-agent/docs/extensions.md:55-99`).
- Extension docs list auto-discovery locations and `settings.json` extension/package entries (`packages/coding-agent/docs/extensions.md:108-136`).
- Extension docs state extension factories are loaded via jiti and async factories are awaited before `session_start`, `resources_discover`, and provider-registration flushing (`packages/coding-agent/docs/extensions.md:184-186`).
- Package docs define Atomic packages as bundles of extensions, skills, prompt templates, themes, and workflow definitions (`packages/coding-agent/docs/packages.md:3-6`).
- Package docs document temporary `-e` sources, borrowed local resources, and workflow stage inheritance of the trusted resource set (`packages/coding-agent/docs/packages.md:51-60`).
- SDK docs state `createAgentSession()` uses a `ResourceLoader` for extensions, skills, prompt templates, themes, and context files (`packages/coding-agent/docs/sdk.md:71-72`).
- SDK docs state custom tools passed via `customTools` combine with extension-registered tools, and `tools`/`excludedTools` apply to custom and extension tools (`packages/coding-agent/docs/sdk.md:571-601`).
- Settings docs describe the normal deferred interactive TTY fast path: paint/input first, resource loading in the background, readiness gate before the first prompt/model turn, and synchronous path for provider/model/resource/system-prompt/metadata/trust cases (`packages/coding-agent/docs/settings.md:24`).
- Changelog `[Unreleased]` records the current startup behavior: footer watcher setup is kept out of first paint, extension/resource loading starts after input readiness instead of a blind timer, first prompt waits at a readiness gate, and explicit provider/model selections remain synchronous (`packages/coding-agent/CHANGELOG.md:3-8`).
- Changelog `0.9.5-alpha.8` records early input capture for deferred startup and synchronous handling for trust prompts, explicit resource flags, metadata commands, non-TTY modes, and provider/model selection (`packages/coding-agent/CHANGELOG.md:21-27`).
- Changelog `0.9.5-alpha.7` records deferred resource discovery for bundled packages/resources and explicitly lists package resources, skills, prompts, themes, and extension-discovered resources using async discovery/reads and cooperative yields (`packages/coding-agent/CHANGELOG.md:36-47`).
- Changelog `0.9.5-alpha.6` records fixes for deferred extension loading and reapplying model scope after extensions finish loading (`packages/coding-agent/CHANGELOG.md:50-55`).
