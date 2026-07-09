## File Locations for Atomic Lazy / Non-Blocking Startup Surfaces

### Scope Notes

Read-only research in:

- `<repo>`

Covered requested surfaces:

- `packages/coding-agent` entrypoints, bootstrap, command discovery, extension/resource loading
- `packages/mcp` MCP discovery and initialization
- `packages/subagents` agents/skills/chains/TUI discovery
- `packages/workflows` workflows/skills/extensions discovery
- `packages/web-access` initialization-related surfaces
- Adjacent package docs/tests/changelogs relevant to startup/discovery behavior

---

## `packages/coding-agent` — Entrypoints, Startup Deferral, Extension/Resource Discovery

### Entrypoints / Bootstrap

- `packages/coding-agent/src/cli.ts:8` — CLI fast path note: full CLI graph is dynamically loaded so metadata paths can skip it.
- `packages/coding-agent/src/main.ts:40` — main async entrypoint.
- `packages/coding-agent/src/main.ts:108` — startup project-trust store setup.
- `packages/coding-agent/src/main.ts:114` — resolves CLI extension/skill/prompt/theme paths.
- `packages/coding-agent/src/main.ts:116` — starts early input capture based on startup/defer computation.
- `packages/coding-agent/src/main.ts:130` — startup `SettingsManager` creation.
- `packages/coding-agent/src/main.ts:143` — session manager creation during startup.
- `packages/coding-agent/src/main-session.ts:138` — `createSessionManager`.
- `packages/coding-agent/src/main-session.ts:226` — missing-session-cwd startup prompt surface.
- `packages/coding-agent/src/bun/split-loader.ts:26` — Atomic startup error for internal broker arg validation.
- `packages/coding-agent/src/bun/split-loader.ts:41` — Atomic startup error for missing app bundle.

### Startup Deferral / Early Input

- `packages/coding-agent/src/main-deferred-startup.ts:8` — `ComputeDeferExtensionsInput`.
- `packages/coding-agent/src/main-deferred-startup.ts:24` — `ComputeStartupInputCaptureInput`.
- `packages/coding-agent/src/main-deferred-startup.ts:35` — `computeStartupInputCaptureEnabled`.
- `packages/coding-agent/src/main-deferred-startup.ts:55` — `computeDeferExtensions`.
- `packages/coding-agent/src/main-early-input.ts` — early input capture implementation file.
- `packages/coding-agent/src/main-app-mode.ts` — app mode selection surface.
- `packages/coding-agent/src/main-session-options.ts` — session option assembly surface.
- `packages/coding-agent/src/main-stdio.ts` — stdio/piped input/diagnostic startup surface.

### Extension Discovery / Loading

- `packages/coding-agent/src/index-extensions.ts:108` — re-exports `discoverAndLoadExtensions`.
- `packages/coding-agent/src/core/extensions/loader.ts:5` — exports extension loading APIs.
- `packages/coding-agent/src/core/extensions/loader.ts:6` — exports `discoverAndLoadExtensions`.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:16` — manifest parsing for package extension metadata.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:38` — extension file predicate.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:51` — resolves extension entries from a directory.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:82` — directory discovery comments/rules.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:91` — `discoverExtensionsInDir`.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:136` — `discoverAndLoadExtensions`.
- `packages/coding-agent/src/core/extensions/loader-discovery.ts:169` — delegates to `loadExtensions`.
- `packages/coding-agent/src/core/extensions/loader-core.ts` — core extension module loading.
- `packages/coding-agent/src/core/extensions/loader-runtime.ts` — extension runtime creation.
- `packages/coding-agent/src/core/extensions/loader-resources.ts` — extension resource provider surface.
- `packages/coding-agent/src/core/extensions/loader-virtual-modules.ts` — virtual module/cache surface.
- `packages/coding-agent/src/core/extensions/runner.ts:112` — `ExtensionRunner` class.
- `packages/coding-agent/src/core/extensions/runner.ts:143` — `ExtensionRunner` constructor.
- `packages/coding-agent/src/core/extensions/runner.ts:101` — session shutdown event helper.
- `packages/coding-agent/src/core/extensions/runner-events.ts` — event dispatch including resource discovery handlers.
- `packages/coding-agent/src/core/extensions/runner-registries.ts` — command/tool/flag registries and lookup.
- `packages/coding-agent/src/core/extensions/runner-handlers.ts` — extension lifecycle handler types.
- `packages/coding-agent/src/core/extensions/runner-project-trust.ts` — project trust handling for extensions.
- `packages/coding-agent/src/core/extensions/runner-ui.ts` — UI context handling for extensions.
- `packages/coding-agent/src/core/extensions/types.ts` — extension type definitions.
- `packages/coding-agent/src/core/extensions/api-types.ts` — extension API types.
- `packages/coding-agent/src/core/extensions/command-types.ts` — command registration types.
- `packages/coding-agent/src/core/extensions/tool-types.ts` — tool registration types.
- `packages/coding-agent/src/core/extensions/event-types.ts` — event type surface.
- `packages/coding-agent/src/core/extensions/session-events.ts` — session lifecycle event types.

### Resource Loader / Skills / Prompts / Themes / Package Resources

- `packages/coding-agent/src/core/resource-loader.ts:2` — exports `DefaultResourceLoader`.
- `packages/coding-agent/src/core/resource-loader-core.ts:30` — `DefaultResourceLoader` class.
- `packages/coding-agent/src/core/resource-loader-core.ts:41` — extension factory and no-extension/no-skill state.
- `packages/coding-agent/src/core/resource-loader-types.ts:16` — `ResourceLoaderReloadOptions`.
- `packages/coding-agent/src/core/resource-loader-types.ts:22` — `deferExtensions` option.
- `packages/coding-agent/src/core/resource-loader-types.ts:28` — `deferResources` option.
- `packages/coding-agent/src/core/resource-loader-types.ts:37` — `ResourceLoader` interface.
- `packages/coding-agent/src/core/resource-loader-types.ts:46` — `reload` interface method.
- `packages/coding-agent/src/core/resource-loader-reload.ts:83` — `loadProjectTrustExtensions`.
- `packages/coding-agent/src/core/resource-loader-reload.ts:100` — extension path merge/load selection.
- `packages/coding-agent/src/core/resource-loader-reload.ts:103` — `loadExtensionsCached`.
- `packages/coding-agent/src/core/resource-loader-extensions.ts:18` — `loadFinalExtensionSet`.
- `packages/coding-agent/src/core/resource-loader-extensions.ts:28` — cached extension loading when no pre-trust extension set exists.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:11` — empty resolved paths shape includes extensions/skills/prompts/themes/workflows.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:24` — `resolvePackageResourcePaths`.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:29` — resolves CLI extension sources.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:40` — resolves builtin package resource paths.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:88` — filtered extensions.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:89` — filtered skills.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:90` — filtered prompts.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:91` — filtered themes.
- `packages/coding-agent/src/core/resource-loader-package-resources.ts:92` — filtered workflows.
- `packages/coding-agent/src/core/resource-loader-assets.ts:40` — async skills loading from paths.
- `packages/coding-agent/src/core/resource-loader-assets.ts:69` — async prompt loading from paths.
- `packages/coding-agent/src/core/resource-loader-source-info.ts:88` — agent root resource source paths include `skills`, `prompts`, `themes`, `extensions`.
- `packages/coding-agent/src/core/resource-loader-source-info.ts:94` — project root resource source paths include `skills`, `prompts`, `themes`, `extensions`.

### Extension-Provided Resource Discovery

- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:10` — `bindExtensions`.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:27` — applies extension bindings.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:28` — emits session start event.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:29` — extends resources from extensions on startup/reload.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:33` — `extendResourcesFromExtensions`.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:34` — checks `resources_discover` handlers.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:38` — emits resource discovery and receives skill/prompt/theme paths.
- `packages/coding-agent/src/core/agent-session-extension-bindings.ts:47` — builds extension resource paths.
- `packages/coding-agent/src/core/agent-session-events.ts:295` — `_emitExtensionEvent`.
- `packages/coding-agent/src/core/agent-session-events.ts:298` — emits `agent_start`.
- `packages/coding-agent/src/core/agent-session-events.ts:300` — emits `agent_end`.

### Commands / CLI Command Surface

- `packages/coding-agent/src/cli/args.ts:172` — parses `--extension` / `-e`.
- `packages/coding-agent/src/cli/args.ts:175` — parses `--no-extensions`.
- `packages/coding-agent/src/cli/args.ts:235` — help accepts extension flags.
- `packages/coding-agent/src/cli/args.ts:251` — command list in help.
- `packages/coding-agent/src/cli/project-trust.ts:5` — startup UI imports.
- `packages/coding-agent/src/cli/project-trust.ts:20` — startup selector for trust prompts.
- `packages/coding-agent/src/cli/project-trust.ts:37` — startup input for trust prompts.
- `packages/coding-agent/src/cli/startup-ui.ts:8` — startup TUI creation.
- `packages/coding-agent/src/cli/startup-ui.ts:22` — `showStartupSelector`.
- `packages/coding-agent/src/cli/startup-ui.ts:54` — `showStartupInput`.
- `packages/coding-agent/src/core/agent-session-message-queue.ts:50` — detects queued extension commands.
- `packages/coding-agent/src/core/agent-session-message-queue.ts:53` — `getCommand` lookup on extension runner.

### Tests to Update / Check

- `packages/coding-agent/test/main-deferred-startup.test.ts` — deferral decision tests.
- `packages/coding-agent/test/interactive-deferred-startup.test.ts` — interactive deferred startup behavior.
- `packages/coding-agent/test/interactive-deferred-startup-first-prompt.test.ts` — first-prompt behavior.
- `packages/coding-agent/test/interactive-deferred-startup-input.test.ts` — input during deferred startup.
- `packages/coding-agent/test/interactive-mode-startup-latency.test.ts` — startup latency coverage.
- `packages/coding-agent/test/interactive-mode-startup-input.test.ts` — interactive startup input.
- `packages/coding-agent/test/interactive-mode-startup-banner.test.ts` — startup banner.
- `packages/coding-agent/test/extensions-discovery.test.ts` — extension discovery.
- `packages/coding-agent/test/extensions-loader-virtual-modules.test.ts` — virtual module loading.
- `packages/coding-agent/test/extensions-runner.test.ts` — extension runner.
- `packages/coding-agent/test/resource-loader-defer-resources.test.ts` — deferred resource loading.
- `packages/coding-agent/test/resource-loader.test.ts` — resource loader.
- `packages/coding-agent/test/resource-loader-01-01.suite.ts` through `resource-loader-05-01.suite.ts` — resource loader suites.
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts` — lazy builtin startup regression.
- `packages/coding-agent/test/suite/regressions/5905-extension-factory-cache.test.ts` — extension factory cache regression.
- `packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts` — extension active tools regression.
- `packages/coding-agent/test/suite/regressions/5433-extension-oauth-prompt-input.test.ts` — extension OAuth prompt input regression.
- `packages/coding-agent/test/suite/regressions/no-builtin-tools-preserves-extension-tools.test.ts` — extension tools under no builtin tools.
- `packages/coding-agent/test/package-manager-extension-sources.suite.ts` — package manager extension source discovery.

### Docs / Changelog to Update

- `packages/coding-agent/CHANGELOG.md:7` — recent startup responsiveness / deferred extension/resource loading entry.
- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/`
- Root docs that mention startup/extensions, if changed:
  - `README.md`
  - `DESIGN.md`
  - `DEV_SETUP.md`

---

## `packages/mcp` — MCP Discovery, Initialization, Lazy Connections

### Extension Entrypoint / Session Startup

- `packages/mcp/index.ts:36` — default extension function `mcpAdapter`.
- `packages/mcp/index.ts:38` — `initPromise` state.
- `packages/mcp/index.ts:43` — direct tool registration from config helper starts.
- `packages/mcp/index.ts:47` — dynamic import of direct tool helpers.
- `packages/mcp/index.ts:64` — direct MCP tools registered.
- `packages/mcp/index.ts:70` — direct tool executor receives lazy state/init promise access.
- `packages/mcp/index.ts:132` — `session_start` handler.
- `packages/mcp/index.ts:136` — clears `initPromise` during session start.
- `packages/mcp/index.ts:140` — early MCP config load.
- `packages/mcp/index.ts:171` — dynamic import of `initializeMcp`.
- `packages/mcp/index.ts:176` — calls `initializeMcp`.
- `packages/mcp/index.ts:202` — stores `initPromise`.
- `packages/mcp/index.ts:217` — clears completed `initPromise`.
- `packages/mcp/index.ts:240` — registers `/mcp` command.

### Initialization / Lazy Connection

- `packages/mcp/init.ts:28` — `initializeMcp`.
- `packages/mcp/init.ts:33` — loads MCP config.
- `packages/mcp/init.ts:35` — creates `McpServerManager`.
- `packages/mcp/init.ts:46` — creates `McpLifecycleManager`.
- `packages/mcp/init.ts:47` — tool metadata map.
- `packages/mcp/init.ts:49` — UI resource handler.
- `packages/mcp/init.ts:50` — consent manager.
- `packages/mcp/init.ts:302` — `lazyConnect`.
- `packages/mcp/lifecycle.ts:7` — `McpLifecycleManager`.
- `packages/mcp/lifecycle.ts:29` — `markKeepAlive`.
- `packages/mcp/lifecycle.ts:33` — `registerServer`.
- `packages/mcp/lifecycle.ts:55` — connection checks.
- `packages/mcp/server-manager.ts:239` — paginated `client.listTools`.

### Config / Discovery

- `packages/mcp/config.ts:11` — generic global MCP config path.
- `packages/mcp/config.ts:12` — project `.mcp.json`.
- `packages/mcp/config.ts:13` — project Pi config path.
- `packages/mcp/config.ts:16` — host import path candidates.
- `packages/mcp/config.ts:40` — `ConfigDiscoveryPath`.
- `packages/mcp/config.ts:46` — `DiscoveredImportConfig`.
- `packages/mcp/config.ts:51` — `ConfigDiscoverySource`.
- `packages/mcp/config.ts:61` — `RepoPromptDiscovery`.
- `packages/mcp/config.ts:69` — `McpDiscoverySummary`.
- `packages/mcp/config.ts:112` — `getMcpDiscoverySummary`.
- `packages/mcp/config.ts:160` — `loadMcpConfig`.
- `packages/mcp/config-write-utils.ts:92` — MCP servers object extraction.
- `packages/mcp/config-write-utils.ts:100` — MCP servers object writing.
- `packages/mcp/cli.js:22` — Pi global MCP config path.
- `packages/mcp/cli.js:26` — generic global config path.
- `packages/mcp/cli.js:27` — project `.mcp.json`.
- `packages/mcp/cli.js:31` — import paths for host configs.
- `packages/mcp/cli.js:44` — helper CLI help.
- `packages/mcp/cli.js:64` — reads `mcpServers` / `mcp-servers`.

### Tool Metadata / Direct Tools / UI

- `packages/mcp/direct-tools.ts:5` — uses `lazyConnect`.
- `packages/mcp/direct-tools.ts:38` — direct auto-auth attempt helper.
- `packages/mcp/tool-metadata.ts` — MCP tool metadata construction.
- `packages/mcp/tool-registrar.ts` — MCP proxy/direct tool result transformation/registration support.
- `packages/mcp/metadata-cache.ts` — metadata cache load/save/validity.
- `packages/mcp/resource-tools.ts` — resource-to-tool naming/surface.
- `packages/mcp/ui-session.ts` — MCP app/UI session runtime.
- `packages/mcp/ui-resource-handler.ts` — UI resource handling.
- `packages/mcp/host-html-template.ts:101` — MCP app iframe host template.
- `packages/mcp/consent-manager.ts:7` — consent manager class.

### Tests to Update / Check

Use path discovery for MCP tests under package/root test directories; directly relevant likely include files matching:

- `packages/mcp/**/*test*`
- `packages/mcp/**/*spec*`
- Root/package tests mentioning MCP:
  - search pattern: `MCP_DIRECT_TOOLS`
  - search pattern: `lazyConnect`
  - search pattern: `initializeMcp`
  - search pattern: `loadMcpConfig`
  - search pattern: `getMcpDiscoverySummary`

### Docs / Changelog to Update

- `packages/mcp/CHANGELOG.md`
- `packages/mcp/README.md:17` — documents on-demand MCP discovery/server startup behavior.
- `packages/mcp/README.md:29` — automatic MCP file reading.
- `packages/mcp/README.md:33` — `.mcp.json` / global config detection.
- `packages/mcp/README.md:37` — helper `init` command.
- `packages/mcp/OAUTH.md:9` — OAuth endpoint auto-discovery.
- `packages/mcp/OAUTH.md:40` — OAuth auto-detection/discovery details.

---

## `packages/subagents` — Agents, Skills, Chains, TUI Discovery

### Extension Entrypoint / Registration

- `packages/subagents/package.json:15` — package main points to `src/extension/index.ts`.
- `packages/subagents/package.json:29` — Pi extension manifest.
- `packages/subagents/package.json:32` — Pi skills manifest.
- `packages/subagents/src/extension/index.ts:1` — subagent orchestration extension entrypoint.
- `packages/subagents/src/extension/index.ts:9` — imports `discoverAgents`.
- `packages/subagents/src/extension/index.ts:13` — TUI render imports.
- `packages/subagents/src/extension/index.ts:18` — slash command registration import.
- `packages/subagents/src/extension/index.ts:20` — slash bridge import.
- `packages/subagents/src/extension/index.ts:28` — config load import.
- `packages/subagents/src/extension/index.ts:32` — exports `loadConfig`.
- `packages/subagents/src/extension/config.ts:5` — `loadConfig`.
- `packages/subagents/src/extension/config.ts:6` — reads `extensions/subagent/config.json`.

### Agent / Chain Discovery

- `packages/subagents/src/agents/agents.ts:1` — public discovery/configuration surface.
- `packages/subagents/src/agents/agents.ts:25` — exports `discoverAgents`, `discoverAgentsAll`.
- `packages/subagents/src/agents/agent-discovery.ts:7` — imports `loadAgentsFromDir`, `loadChainsFromDir`.
- `packages/subagents/src/agents/agent-discovery.ts:9` — builtin agents dir import.
- `packages/subagents/src/agents/agent-discovery.ts:12` — user agent dirs import.
- `packages/subagents/src/agents/agent-discovery.ts:15` — user chain dirs import.
- `packages/subagents/src/agents/agent-discovery.ts:17` — project agent dirs resolver.
- `packages/subagents/src/agents/agent-discovery.ts:18` — project chain dirs resolver.
- `packages/subagents/src/agents/agent-loaders.ts:51` — `loadAgentsFromDir`.
- `packages/subagents/src/agents/agent-loaders.ts:54` — recursive `.md` agent file loading excluding `.chain.md`.
- `packages/subagents/src/agents/agent-loaders.ts:77` — skill/frontmatter parsing.
- `packages/subagents/src/agents/agent-loaders.ts` — also contains chain loading via `loadChainsFromDir`.
- `packages/subagents/src/agents/chain-serializer.ts:108` — `parseChain` for `.chain.md`.
- `packages/subagents/src/agents/chain-serializer.ts:87` — chain step skills parsing.
- `packages/subagents/src/agents/agent-selection.ts:3` — `mergeAgentsForScope`.
- `packages/subagents/src/agents/agent-management-helpers.ts:56` — available agent/chain names.
- `packages/subagents/src/agents/agent-management-helpers.ts:62` — find agents.
- `packages/subagents/src/agents/agent-management-helpers.ts:71` — find chains.
- `packages/subagents/src/extension/doctor.ts:3` — discovers all agents for doctor.
- `packages/subagents/src/extension/doctor.ts:6` — discovers available skills.
- `packages/subagents/src/extension/doctor.ts:129` — discovery diagnostics.
- `packages/subagents/src/extension/doctor.ts:131` — agents/chains discovery check.

### Agent / Chain Paths

- `packages/subagents/src/agents/agent-paths.ts:7` — user chain dir.
- `packages/subagents/src/agents/agent-paths.ts:11` — user chain dirs.
- `packages/subagents/src/agents/agent-paths.ts:15` — user agent dirs.
- `packages/subagents/src/agents/agent-paths.ts:30` — nearest project root detection includes config dirs / `.agents`.
- `packages/subagents/src/agents/agent-paths.ts:48` — project agent settings path.
- `packages/subagents/src/agents/agent-paths.ts:53` — project agent settings paths.
- `packages/subagents/src/agents/agent-paths.ts:58` — project agent dirs resolver.
- `packages/subagents/src/agents/agent-paths.ts:77` — project chain dirs resolver.

### Skills

- `packages/subagents/src/agents/skills.ts` — available skill discovery surface.
- `packages/subagents/skills/` — bundled skill directory from package manifest.
- `packages/subagents/package.json:22` — includes `agents/`.
- `packages/subagents/package.json:23` — includes `skills/**/*`.

### TUI / Status / Rendering

- `packages/subagents/src/tui/` — TUI components/rendering cluster.
- `packages/subagents/src/tui/render.ts` — live/result rendering used by extension entrypoint.
- `packages/subagents/src/extension/index.ts:13` — imports TUI result rendering and animation helpers.
- `packages/subagents/src/extension/index.ts:8` — imports Pi TUI components.
- `packages/subagents/src/runs/background/async-job-tracker.ts` — background job tracker.
- `packages/subagents/src/runs/background/result-watcher.ts` — result watcher.
- `packages/subagents/src/runs/background/run-status.ts` — status inspection.
- `packages/subagents/src/runs/background/notify.ts` — async completion notification.
- `packages/subagents/src/runs/foreground/subagent-executor.ts` — foreground subagent execution.

### Builtin Agents / Prompts

- `packages/subagents/agents/` — builtin agents directory.
- `packages/subagents/agents/codebase-locator.md:35` — file locator search guidance.
- `packages/subagents/agents/codebase-analyzer.md:3` — analyzer agent description.
- `packages/subagents/agents/debugger.md:14` — skill guidance.
- `packages/subagents/agents/worker.md:10` — worker builtin skills.
- `packages/subagents/prompts/` — bundled prompt templates.
- `packages/subagents/prompts/parallel-context-build.md:7` — chain mode prompt references.
- `packages/subagents/prompts/parallel-handoff-plan.md:13` — discovery step prompt references.

### Tests to Update / Check

Use path/content search for subagent tests. Relevant test areas likely include:

- `packages/subagents/**/*test*`
- `packages/subagents/**/*spec*`
- Agent/chain discovery tests:
  - search pattern: `discoverAgents`
  - search pattern: `loadAgentsFromDir`
  - search pattern: `loadChainsFromDir`
  - search pattern: `discoverAvailableSkills`
- Runtime/status tests:
  - search pattern: `asyncJobs`
  - search pattern: `result-watcher`
  - search pattern: `subagentInProgress`
  - search pattern: `foreground`

### Docs / Changelog to Update

- `packages/subagents/CHANGELOG.md:9` — recent foreground/background startup diagnostics entry.
- `packages/subagents/README.md:13` — Atomic bundles extension note.
- `packages/subagents/README.md:49` — subagent startup behavior.
- `packages/subagents/README.md:100` — browsing available subagents.
- `packages/subagents/README.md:105` — builtin agents.

---

## `packages/workflows` — Workflow / Skills / Extension Discovery

### Extension Entrypoint / Runtime

- `packages/workflows/package.json:69` — Pi extension manifest points to workflow extension.
- `packages/workflows/package.json:75` — Pi skills manifest.
- `packages/workflows/src/extension/index.ts` — workflow extension entrypoint.
- `packages/workflows/src/extension/runtime.ts:1` — runtime facade comment.
- `packages/workflows/src/extension/runtime.ts:5` — startup seam comment: registry supplied directly from discovery worker/createBundledWorkflowRegistry.
- `packages/workflows/src/extension/runtime.ts:57` — runtime registry option.
- `packages/workflows/src/extension/runtime.ts:63` — definitions option populated by discovery worker at startup.
- `packages/workflows/src/extension/runtime.ts:106` — live registry reference.
- `packages/workflows/src/extension/runtime.ts:141` — discovery worker registry example.
- `packages/workflows/src/workflows/registry.ts:14` — `WorkflowRegistry`.
- `packages/workflows/src/workflows/registry.ts:55` — registry implementation.
- `packages/workflows/src/workflows/registry.ts:102` — create registry docs.

### Workflow Module Loading / Discovery

- `packages/workflows/src/extension/workflow-module-loader.ts:4` — discovery loads user-authored workflow files through jiti.
- `packages/workflows/src/extension/workflow-module-loader.ts:18` — SDK module specifier.
- `packages/workflows/src/extension/workflow-module-loader.ts:34` — virtual modules mapping.
- `packages/workflows/src/extension/workflow-module-loader.ts:49` — SDK virtual module resolution comment.
- `packages/workflows/src/extension/workflow-module-loader.ts:51` — discovery speed comment.
- `packages/workflows/src/extension/workflow-module-loader.ts` — module materialization and workflow definition loading surface.
- `packages/workflows/src/extension/wiring.ts:298` — workflow stage session creation.
- `packages/workflows/src/extension/wiring.ts:299` — comment: SDK handles extension/skills/prompt-template/slash-command discovery through `SettingsManager` / `ResourceLoader`.
- `packages/workflows/src/extension/wiring.ts:306` — workflow stage session options.
- `packages/workflows/src/extension/wiring.ts:312` — binds stage UI context into extensions.
- `packages/workflows/src/extension/workflow-command-registration.ts:49` — registers `/workflow`.
- `packages/workflows/src/extension/workflow-command-registration.ts:58` — command usage/description.
- `packages/workflows/src/extension/workflow-command-registration.ts:101` — list command reads runtime registry.
- `packages/workflows/src/extension/workflow-command-registration.ts:134` — reload workflow resources command path.
- `packages/workflows/src/extension/workflow-tool-registration.ts` — workflow tool registration.
- `packages/workflows/src/extension/workflow-tool.ts` — workflow tool implementation.
- `packages/workflows/src/extension/workflow-command-completions.ts` — command completion surface.
- `packages/workflows/src/extension/workflow-command-surfaces.ts` — command surfaces.
- `packages/workflows/src/extension/workflow-command-utils.ts` — command utility surface.

### Builtin Workflows

- `packages/workflows/builtin/` — builtin workflow directory.
- `packages/workflows/builtin/deep-research-codebase.ts:19` — builtin workflow definition export.
- `packages/workflows/builtin/deep-research-codebase-runner.ts:52` — initial parallel discovery.
- `packages/workflows/builtin/deep-research-codebase-runner.ts:215` — file/test/docs/config discovery instruction inside workflow.
- `packages/workflows/builtin/goal.ts` — builtin Goal workflow definition.
- `packages/workflows/builtin/goal-runner.ts:100` — Goal workflow runner.
- `packages/workflows/builtin/goal-runner.ts:279` — parallel reviewer batch.
- `packages/workflows/builtin/ralph.ts` — builtin Ralph workflow definition.
- `packages/workflows/builtin/open-claude-design.ts` — builtin workflow definition.
- `packages/workflows/builtin/*.d.ts` — generated/public type definitions for builtins.

### Workflow TUI / Status

- `packages/workflows/src/tui/` — workflow TUI cluster.
- `packages/workflows/src/tui/workflow-list.ts` — workflow list UI.
- `packages/workflows/src/tui/workflow-status.ts` — workflow status UI.
- `packages/workflows/src/tui/graph-view.ts` and related `graph-view-*` files — fullscreen graph overlay.
- `packages/workflows/src/tui/stage-chat-view.ts` and related `stage-chat-view-*` files — attached stage chat UI.
- `packages/workflows/src/tui/store-widget-installer.ts` — store widget install surface.
- `packages/workflows/src/runs/background/` — background workflow run/status cluster.
- `packages/workflows/src/runs/foreground/` — foreground executor/stage runner cluster.

### Skills / Prompts / Themes

- `packages/workflows/skills/` — package skills directory from manifest.
- `packages/workflows/prompts/` — package prompts directory from manifest.
- `packages/workflows/themes/` — package themes included by package manifest.
- `packages/workflows/package.json:51` — includes builtin `.d.ts`.
- `packages/workflows/package.json:52` — includes `skills/**/*`.
- `packages/workflows/package.json:53` — includes `prompts/**/*`.
- `packages/workflows/package.json:54` — includes `themes/*.json`.

### Tests to Update / Check

Use search/path discovery for workflow tests. Relevant likely areas:

- `packages/workflows/**/*test*`
- `packages/workflows/**/*spec*`
- Workflow discovery/module loading:
  - search pattern: `workflow-module-loader`
  - search pattern: `createBundledWorkflowRegistry`
  - search pattern: `reloadWorkflowResources`
  - search pattern: `WorkflowRegistry`
- Workflow command/tool:
  - search pattern: `registerWorkflowSlashCommand`
  - search pattern: `/workflow`
  - search pattern: `workflow reload`
- Stage resource inheritance:
  - search pattern: `bindExtensions`
  - search pattern: `ResourceLoader`
  - search pattern: `stage session`

### Docs / Changelog to Update

- `packages/workflows/CHANGELOG.md:12` — workflow graph statusline mirrors extension statuses.
- `packages/workflows/README.md:20` — custom workflow directories.
- `packages/workflows/README.md:22` — workflow discovery paths/config.
- `packages/workflows/README.md:32` — workflow lifecycle notifications.
- `packages/workflows/README.md:56` — authoring import example.
- `packages/workflows/README.md:85` — workflow definition example.

---

## `packages/web-access` — Initialization / Tool Registration / Config

### Package Entrypoint / Config

- `packages/web-access/package.json` — package manifest and Pi extension registration.
- `packages/web-access/config-paths.ts:4` — web search config paths.
- `packages/web-access/config-paths.ts:9` — readable config path selection.
- `packages/web-access/index.ts` — likely extension entrypoint / tool registration surface.
- `packages/web-access/content-tools.ts:221` — `get_search_content` tool label/description.
- `packages/web-access/content-tools.ts:224` — prompt snippet for stored content retrieval.
- `packages/web-access/code-search.ts:4` — Exa code context tool name.
- `packages/web-access/code-search.ts:5` — Exa web search fallback tool name.
- `packages/web-access/code-search.ts:63` — activity monitor start.
- `packages/web-access/code-search.ts:66` — code-context/web-search fallback mode state.

### Browser / Cookie / External Provider Initialization

- `packages/web-access/chrome-cookies.ts:44` — macOS browser configs.
- `packages/web-access/chrome-cookies.ts:65` — Linux browser configs.
- `packages/web-access/chrome-cookies.ts:74` — platform browser config selection.
- `packages/web-access/chrome-cookies.ts:89` — reads browser password.
- `packages/web-access/activity.ts:33` — activity start logging.

### Curator UI / Server

- `packages/web-access/curator-server.ts:48` — `startCuratorServer`.
- `packages/web-access/curator-server-helpers.ts:6` — JSON response helper.
- `packages/web-access/curator-page.ts:33` — default provider loading state.
- `packages/web-access/curator-page.ts:78` — web search loading hero.
- `packages/web-access/curator-page-assets/script-1.ts:338` — initializes summary model controls.
- `packages/web-access/curator-page-assets/script-2.ts:216` — loading panel creation.
- `packages/web-access/curator-page-assets/script-4.ts:74` — initializes summary model controls on page.
- `packages/web-access/curator-page-assets/script-4.ts:75` — sync loading panel.

### Tests to Update / Check

Use search/path discovery:

- `packages/web-access/**/*test*`
- `packages/web-access/**/*spec*`
- Initialization/config/tool registration:
  - search pattern: `web_search`
  - search pattern: `fetch_content`
  - search pattern: `get_search_content`
  - search pattern: `WEB_SEARCH_CONFIG_PATHS`
  - search pattern: `startCuratorServer`

### Docs / Changelog to Update

- `packages/web-access/CHANGELOG.md`
- `packages/web-access/README.md:17` — zero-config / provider setup statement.
- `packages/web-access/README.md:21` — fallback chain statement.
- `packages/web-access/README.md:31` — config location.
- `packages/web-access/README.md:41` — provider order in auto mode.
- `packages/web-access/README.md:75` — `web_search` docs.

---

## Adjacent / Cross-Package Surfaces

### Root Package / Monorepo Manifests

- `package.json` — root scripts/workspaces.
- `tsconfig.json`
- `tsconfig.base.json`
- `bun.lock`
- `package-lock.json`
- `Cargo.toml`
- `Cargo.lock`

### Atomic Config Helpers Used by Packages

- `packages/coding-agent/src/config.ts:253` — `ENV_STARTUP_BENCHMARK`.
- `packages/coding-agent/src/config.ts:431` — extension transpile cache directory.
- `packages/coding-agent/src/config.ts` — agent/config path helpers consumed by extensions.
- `packages/coding-agent/src/core/settings-manager.ts` — settings/resource package sources.
- `packages/coding-agent/src/core/package-manager.ts` — package source/resource resolution.
- `packages/coding-agent/src/core/model-registry.ts` — model registry loading consulted during startup/listing.
- `packages/coding-agent/src/core/agent-session-services.ts` — session service construction.
- `packages/coding-agent/src/core/agent-session-runtime.ts` — agent session runtime construction.

### Shared Docs / Guidance

- `README.md`
- `DESIGN.md`
- `DEV_SETUP.md`
- `CONTRIBUTING.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/`
- `specs/`
- `research/`

---

## Related Directories / Clusters

### Coding Agent

- `packages/coding-agent/src/core/extensions/` — extension discovery/loading/runtime/runner/types cluster.
- `packages/coding-agent/src/core/resource-loader-*` — resource discovery/reload/package resources/source info cluster.
- `packages/coding-agent/src/main*.ts` — startup/bootstrap/deferred startup/session/stdio cluster.
- `packages/coding-agent/src/cli/` — CLI parsing, startup UI, project trust, command help/listing cluster.
- `packages/coding-agent/test/` — startup, extension discovery, resource loader test cluster.
- `packages/coding-agent/test/suite/regressions/` — startup/extension regression cluster.

### MCP

- `packages/mcp/index.ts`, `packages/mcp/init.ts`, `packages/mcp/config.ts` — core extension startup/config/init cluster.
- `packages/mcp/server-manager.ts`, `packages/mcp/lifecycle.ts` — server connection lifecycle cluster.
- `packages/mcp/direct-tools.ts`, `packages/mcp/tool-registrar.ts`, `packages/mcp/tool-metadata.ts`, `packages/mcp/metadata-cache.ts` — tool discovery/metadata/direct tool cluster.
- `packages/mcp/ui-*`, `packages/mcp/host-html-template.ts`, `packages/mcp/app-bridge.bundle.js` — MCP UI/app bridge cluster.

### Subagents

- `packages/subagents/src/agents/` — agent/chain/skill discovery, loading, serialization, management cluster.
- `packages/subagents/src/extension/` — extension entrypoint, config, doctor, schemas, prompt guidance cluster.
- `packages/subagents/src/runs/` — foreground/background execution and status cluster.
- `packages/subagents/src/tui/` — TUI rendering/status cluster.
- `packages/subagents/agents/` — builtin agent definitions.
- `packages/subagents/skills/` — bundled skills.
- `packages/subagents/prompts/` — bundled prompt templates.

### Workflows

- `packages/workflows/src/extension/` — workflow runtime, command/tool registration, module loader, wiring cluster.
- `packages/workflows/src/workflows/` — registry cluster.
- `packages/workflows/builtin/` — builtin workflow definitions/runners/types.
- `packages/workflows/src/runs/foreground/` — workflow executor/stage runner cluster.
- `packages/workflows/src/runs/background/` — background runner/status/cancellation cluster.
- `packages/workflows/src/tui/` — workflow UI/graph/stage chat cluster.
- `packages/workflows/skills/`, `packages/workflows/prompts/`, `packages/workflows/themes/` — packaged resources.

### Web Access

- `packages/web-access/index.ts` and tool files — extension/tool registration cluster.
- `packages/web-access/config-paths.ts` — config path cluster.
- `packages/web-access/curator-*` — curator UI/server cluster.
- `packages/web-access/*search*`, `packages/web-access/*content*` — search/content extraction cluster.
- `packages/web-access/chrome-cookies.ts` — browser cookie initialization cluster.

---

## Changelogs to Update if Behavior Changes

- `packages/coding-agent/CHANGELOG.md`
- `packages/mcp/CHANGELOG.md`
- `packages/subagents/CHANGELOG.md`
- `packages/workflows/CHANGELOG.md`
- `packages/web-access/CHANGELOG.md`

---

## Documentation to Update if Behavior Changes

- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/`
- `packages/mcp/README.md`
- `packages/mcp/OAUTH.md`
- `packages/subagents/README.md`
- `packages/workflows/README.md`
- `packages/web-access/README.md`
- Root:
  - `README.md`
  - `DESIGN.md`
  - `DEV_SETUP.md`
  - `docs/`
  - `specs/`

---

## Most Relevant Existing Tests by Topic

### Startup / Lazy Startup

- `packages/coding-agent/test/main-deferred-startup.test.ts`
- `packages/coding-agent/test/interactive-deferred-startup.test.ts`
- `packages/coding-agent/test/interactive-deferred-startup-first-prompt.test.ts`
- `packages/coding-agent/test/interactive-deferred-startup-input.test.ts`
- `packages/coding-agent/test/interactive-mode-startup-latency.test.ts`
- `packages/coding-agent/test/suite/regressions/1223-startup-lazy-builtins.test.ts`

### Extension Discovery / Loading

- `packages/coding-agent/test/extensions-discovery.test.ts`
- `packages/coding-agent/test/extensions-loader-virtual-modules.test.ts`
- `packages/coding-agent/test/extensions-runner.test.ts`
- `packages/coding-agent/test/suite/regressions/5905-extension-factory-cache.test.ts`
- `packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts`

### Resource Loading / Deferral

- `packages/coding-agent/test/resource-loader-defer-resources.test.ts`
- `packages/coding-agent/test/resource-loader.test.ts`
- `packages/coding-agent/test/resource-loader-01-01.suite.ts`
- `packages/coding-agent/test/resource-loader-01-02.suite.ts`
- `packages/coding-agent/test/resource-loader-02-01.suite.ts`
- `packages/coding-agent/test/resource-loader-03-01.suite.ts`
- `packages/coding-agent/test/resource-loader-04-01.suite.ts`
- `packages/coding-agent/test/resource-loader-05-01.suite.ts`

### MCP / Subagents / Workflows / Web Access

Search package test trees for:

- MCP:
  - `initializeMcp`
  - `lazyConnect`
  - `loadMcpConfig`
  - `getMcpDiscoverySummary`
  - `MCP_DIRECT_TOOLS`
- Subagents:
  - `discoverAgents`
  - `discoverAgentsAll`
  - `discoverAvailableSkills`
  - `loadChainsFromDir`
  - `result-watcher`
- Workflows:
  - `workflow-module-loader`
  - `WorkflowRegistry`
  - `reloadWorkflowResources`
  - `/workflow`
  - `bindExtensions`
- Web Access:
  - `web_search`
  - `fetch_content`
  - `get_search_content`
  - `startCuratorServer`
  - `WEB_SEARCH_CONFIG_PATHS`
