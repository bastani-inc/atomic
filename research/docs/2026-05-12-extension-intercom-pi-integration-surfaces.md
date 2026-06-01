---
date: 2026-05-12 00:51:04 UTC
researcher: pi specialist agent
git_commit: 6423aeed02f8036c985f7ddb68c0b0d6edcb0422
branch: refactor/pi-rewrite
repository: atomic-pi-rewrite
topic: "src/extension and src/intercom pi integration surfaces"
tags: [research, codebase, pi, extension, intercom, mcp, subagents]
status: complete
last_updated: 2026-05-12
last_updated_by: pi specialist agent
---

# Research: src/extension and src/intercom pi integration surfaces

## Research Question

Investigate the codebase partition `src/extension` and `src/intercom` as the pi integration surfaces for the broader research question: "test research question".

Scout context partitions:

- `test/` unit, integration, and support infrastructure
- `src/runs` and `src/workflows` execution/runtime core
- `src/extension` and `src/intercom` pi integration surfaces
- `research/`, `specs/`, and `docs/` historical design context

## Summary

`src/extension/index.ts` is the composition root consumed by pi. It declares the structural `ExtensionAPI` subset, builds workflow runtime adapters from pi SDK/UI surfaces, seeds a bundled workflow registry synchronously, upgrades that registry after async config+discovery, and registers all pi-facing affordances: the `workflow` tool, `/workflow`, `/workflow:<name>` aliases, `/workflows-doctor`, run lifecycle renderers, CLI flags, session lifecycle hooks, status/widget/overlay hooks, and sibling extension wiring.

`src/intercom` is a small structural integration layer for pi-intercom/pi-subagents cooperation. It derives a stable parent session name, subscribes to `subagent:control-intercom`, converts child `need_decision` and `notify` messages into workflow store notices and optional `pi.ui.confirm` prompts, and emits `subagent:control-intercom:response` events.

The surrounding `src/extension` helpers are deliberately port-shaped: config loading, workflow discovery, runtime facade, dispatcher, pi SDK adapter wiring, MCP scope events, subagent env/event helpers, doctor rendering, and status-file writing each live in separate modules with pure or structurally typed boundaries.

## Detailed Findings

### 1. Composition root and pi API surface

`src/extension/index.ts` defines a minimal structural pi `ExtensionAPI` rather than importing pi's runtime type. The interface includes tool/command/flag/shortcut registration, message renderers, lifecycle `on`, `events.emit/on`, `subagents`, `exec`, persistence APIs, session manager, and `ui.custom`/`ui.setWidget`/dialog methods (`src/extension/index.ts:254-360`).

The factory starts by building runtime and UI adapters (`buildRuntimeAdapters`, `buildUIAdapter`), plus a graph overlay adapter over the shared workflow store (`src/extension/index.ts:791-803`). It then creates mutable refs for persistence, MCP port, runtime config, status writer, runtime registry, discovery result, and config load result (`src/extension/index.ts:813-856`).

A stable `runtimeProxy` delegates to `runtimeRef.current`, so tool/command closures keep using the latest discovered registry after async discovery swaps it (`src/extension/index.ts:858-866`). Context-specific invocations rebuild an `ExtensionRuntime` with `ctx.ui` when command/tool execution supplies live UI (`src/extension/index.ts:868-881`).

### 2. Workflow tool dispatch boundary

`makeExecuteWorkflowTool()` is the internal tool executor adapter. It routes registry-backed `list`, `inputs`, and `run` actions to `ExtensionRuntime.dispatch`, while handling `status`, `kill`, and `resume` directly against the background run store/status modules (`src/extension/index.ts:413-490`).

The actual pi tool registration adapts pi's positional tool execution signature `(toolCallId, params, signal, onUpdate, ctx)` to the internal `(args, ctx)` executor shape. It returns `content` text rendered via `renderResult()` and stores the typed details in `details` (`src/extension/index.ts:953-970`). The tool's call/result render slots return compact text render components (`src/extension/index.ts:961-982`; helper renderers in `src/extension/render-call.ts` and `src/extension/render-result.ts`).

`src/extension/dispatcher.ts` is the registry-facing action router. It returns workflow names for `list`, maps workflow input schema entries for `inputs`, returns a structured failed `run` result for unknown workflow names, dispatches detached runs through `runDetached()`, and foreground runs through `run()` (`src/extension/dispatcher.ts:59-145`). The facade in `src/extension/runtime.ts` creates or accepts a registry and forwards dispatch options, adapters, UI, store, cancellation, persistence, MCP, and runtime config (`src/extension/runtime.ts:93-112`).

### 3. Slash command and alias surfaces

Slash command registration is wrapped by `tryRegisterSlashCommand()`, which uses canonical `pi.registerCommand(name, { description, handler, getArgumentCompletions })` when present and falls back to legacy `registerSlashCommand(opts)` (`src/extension/index.ts:519-538`).

`/workflow:<name>` aliases are registered per workflow and dispatch directly to the same runtime path as the tool and main slash command. Alias args support `--detach`/`--bg` stripping plus key/value and JSON object input parsing (`src/extension/index.ts:540-587`).

The main `/workflow` command supports:

- empty or `list` → registry names (`src/extension/index.ts:999-1009`)
- `status` → in-flight run summaries (`src/extension/index.ts:1012-1027`)
- `kill <runId|prefix|--all>` → cancellation through the shared cancellation registry and persistence port (`src/extension/index.ts:1029-1083`)
- `resume <runId>` → opens overlay for a snapshot and prints snapshot metadata (`src/extension/index.ts:1085-1104`)
- `inputs <workflow>` and `<workflow> --help` → input schema rendering (`src/extension/index.ts:1106-1163`)
- `<workflow> [inputs...]` → foreground/detached workflow dispatch (`src/extension/index.ts:1165-1199`)

Autocomplete is first-token only and returns `null` after a space to dismiss pi's picker for second arguments such as run IDs (`src/extension/index.ts:1201-1246`). Input parsing is implemented by `stripDetachFlags()` and `parseWorkflowArgs()`, which merge JSON object tokens and parse `key=value` values through `JSON.parse` when possible (`src/extension/index.ts:640-680`).

### 4. Startup config, discovery, and runtime swap

The factory seeds `runtimeRef` synchronously with bundled workflows from `discoverBundledWorkflowsSync()` so commands and aliases are available immediately (`src/extension/index.ts:844-853`). It then starts `discoveryPromise`, which loads config, converts scoped workflow config into discovery config, discovers all workflow sources, resolves effective runtime tunables, replaces the status writer, rebuilds persistence/runtime refs, and registers aliases for newly discovered non-bundled workflows (`src/extension/index.ts:894-951`).

`src/extension/discovery.ts` supports five workflow source kinds with precedence: settings-project, project-local `.pi/workflows`, settings-global, user-global `~/.pi/agent/workflows`, then bundled (`src/extension/discovery.ts:1-15`). It validates workflow definitions by `__piWorkflow`, `name`, `normalizedName`, and `run` function (`src/extension/discovery.ts:145-167`), validates discovery config shape (`src/extension/discovery.ts:170-197`), reports duplicate normalized names as warnings while first-seen wins (`src/extension/discovery.ts:199-241`), and records diagnostic codes for invalid definitions, duplicates, import failures, missing paths, and invalid config (`src/extension/discovery.ts:72-98`).

`discoverWorkflows()` executes the precedence order and merges bundled definitions last (`src/extension/discovery.ts:375-461`). `discoverBundledWorkflowsSync()` imports the bundled manifest from `../../workflows/index.js` and applies the same candidate validation path (`src/extension/discovery.ts:484-498`).

`src/extension/config-loader.ts` loads global config from `<homeDir>/.pi/agent/extensions/workflow/config.json` and the first existing project-local candidate from `.pi/extensions/workflow/config.json` or `.pi/agent/extensions/workflow/config.json` (`src/extension/config-loader.ts:1-18`, `src/extension/config-loader.ts:438-453`). The config shape covers `workflows`, `maxDepth`, `defaultConcurrency`, `persistRuns`, `statusFile`, and `resumeInFlight` (`src/extension/config-loader.ts:38-50`). Defaults are `maxDepth:4`, `defaultConcurrency:4`, `persistRuns:true`, `statusFile:false`, and `resumeInFlight:"ask"` (`src/extension/config-loader.ts:288-327`). `toScopedDiscoveryConfig()` resolves project workflow paths under project root and global workflow paths under `<homeDir>/.pi/agent`, excluding global entries shadowed by project workflow keys (`src/extension/config-loader.ts:377-420`).

### 5. Runtime adapters and UI adapter

`src/extension/wiring.ts` maps pi runtime surfaces to workflow runtime ports. Current `buildRuntimeAdapters()` always provides an `agentSession` adapter backed by `createAgentSession()` from `@bastani/atomic`; stage options are copied after deleting workflow-only `mcp` (`src/extension/wiring.ts:85-119`).

The same function conditionally adds a `subagent` adapter when either `pi.subagents.run` or `pi.callTool` is present. The primary path calls `pi.subagents.run({ agent, task, context, env, signal })`; the fallback calls `pi.callTool("subagent", { action:"run", agent, task, env, context? })` (`src/extension/wiring.ts:123-149`). Env injection combines current process workflow env with stage execution metadata (`src/extension/wiring.ts:99-107`).

`buildUIAdapter()` maps pi dialog methods into the workflow HIL adapter: `input`, `confirm`, `select`, and `editor`, returning `undefined` when no dialog methods are available (`src/extension/wiring.ts:309-348`). `PiCustomOverlay*` types document the structural `ui.custom` overlay/focused-pane shapes and overlay handle operations (`src/extension/wiring.ts:180-240`).

### 6. Persistence, status file, lifecycle, widgets, and overlay

`makePersistencePort()` adapts `pi.appendEntry`, `pi.setLabel`, and `pi.appendCustomMessageEntry` when `persistRuns` is enabled; it returns `undefined` if persistence is disabled or `appendEntry` is absent (`src/extension/index.ts:730-753`).

`src/extension/status-writer.ts` resolves status output to an explicit `statusFilePath` or `<projectRoot>/.pi/workflows/status.json` (`src/extension/status-writer.ts:52-66`). When enabled, it subscribes to store snapshots and writes JSON atomically via temp file + rename, recording deduplicated warning notices on write failures (`src/extension/status-writer.ts:72-135`).

On `session_start`, the factory kills any leftover in-process runs, clears the store, registers the pi-intercom parent session name, awaits config/discovery, installs the store widget using the live session UI, dispatches CLI workflow flags, and restores persisted runs from the session manager (`src/extension/index.ts:1333-1377`). It also installs the compaction hook and kills all in-flight workflows plus uninstalls widgets on `session_shutdown` (`src/extension/index.ts:1379-1391`). Without lifecycle support, CLI workflow flags are dispatched after discovery as a fallback (`src/extension/index.ts:1392-1399`).

The factory installs a store widget and tool execution hooks unconditionally after lifecycle wiring (`src/extension/index.ts:1401-1402`). It registers `F2` to open the workflow orchestrator pane and `ctrl+h` to toggle it, using the active run or most recent run as fallback (`src/extension/index.ts:1404-1436`). Run-level message renderers are registered for `workflow.run.start` and `workflow.run.end`; per-stage chat-scroll renderers are deliberately omitted in this factory path (`src/extension/index.ts:1305-1319`).

### 7. Doctor diagnostics

`/workflows-doctor` builds a discovery result, structural sibling capability booleans, HIL/UI/shortcut/persistence status, and runtime adapter capability labels, then renders through `buildDoctorReport()` (`src/extension/index.ts:1258-1303`).

`src/extension/doctor.ts` formats registry count, sources, discovery diagnostics, config diagnostics, tunables, configured workflows, sibling capabilities (`pi-subagents`, `pi-mcp-adapter`, MCP scope events, `pi-intercom`, `pi-web-access`), HIL/UI/shortcut/exec/persistence availability, and runtime adapter labels (`src/extension/doctor.ts:86-175`).

### 8. MCP and subagents sibling integration helpers

`src/extension/mcp.ts` is a structural event helper for pi-mcp-adapter. `setMcpScope()` emits `mcp.scope.set` with `{ stageId, allow: string[] | null, deny: string[] | null }`; `clearMcpScope()` emits the same event with null allow/deny to restore unrestricted access (`src/extension/mcp.ts:68-105`). `makeMcpPort()` wraps these helpers when `pi.events.emit` exists and otherwise leaves MCP scoping as a no-op (`src/extension/index.ts:759-785`).

`src/extension/subagents.ts` contains pi-subagents cooperation helpers: `injectWorkflowEnv()` and `readWorkflowEnv()` for `PI_WORKFLOW_RUN_ID` / `PI_WORKFLOW_STAGE_ID`, `emitStageStart()` / `emitStageEnd()` event emitters, structural presence detection, and `assertSubagentsPresent()` (`src/extension/subagents.ts:1-125`). The current runtime wiring consumes `readWorkflowEnv()` and metadata to pass workflow context into the subagent adapter.

### 9. Intercom bridge and routing

`src/intercom/intercom-bridge.ts` derives a stable parent session name from `sha256(cwd).slice(0, 8)`, producing `pi-workflows-parent-<hash>` (`src/intercom/intercom-bridge.ts:37-53`). Presence detection is structural on `setSessionName`, and `registerIntercomParentSession()` no-ops when absent or calls `pi.setSessionName(name)` and returns the name (`src/intercom/intercom-bridge.ts:59-93`). The factory deliberately calls it inside `session_start` to avoid pi loader action-method restrictions during extension loading (`src/extension/index.ts:1347-1350`).

`src/intercom/result-intercom.ts` subscribes to `pi.events.on("subagent:control-intercom", handler)` when available, validates that payloads are objects with string `type`, and routes `need_decision`, `notify`, or unknown future types to callback slots. Callback errors are caught and re-thrown asynchronously so one failing callback does not prevent the handler registration path (`src/intercom/result-intercom.ts:89-143`).

`src/intercom/intercom-routing.ts` builds those callbacks over the workflow store, optional raw `emit`, and optional `confirm` dialog (`src/intercom/intercom-routing.ts:22-35`). `need_decision` records a warning notice with `requiresAck:true`, asks `confirm("Subagent needs decision", message)` when present, emits `subagent:control-intercom:response` with `{ requestId, runId, stageId, accepted }`, then acks the notice (`src/intercom/intercom-routing.ts:55-101`). `notify` records a notice with level coerced to `info|warning|error`, and unknown types record warning notices without response emission (`src/intercom/intercom-routing.ts:103-124`).

The factory wires the subscription at the end of initialization, passing the singleton store, `pi.events.emit` if present, and `pi.ui.confirm` if present (`src/extension/index.ts:1446-1460`).

### 10. Rendering helpers

`src/extension/render-call.ts` renders compact strings for workflow tool invocations by action. `src/extension/render-result.ts` defines the public `WorkflowToolResult` discriminated union for `list`, `status`, `inputs`, `run`, `kill`, and `resume`, and renders them into compact text, including background-run and error summaries. `src/extension/renderers.ts` renders persistent run-level entry strings such as `▶ workflow "name" started [runId]` and run end icons.

### 11. Test coverage touching this partition

The test suite has direct unit and integration coverage for this partition:

- `test/unit/extension.test.ts` checks the factory is callable and no-ops against `{}`.
- `test/unit/slash-dispatch.test.ts` covers arg parsing, slash command dispatch semantics, aliases, completions, and `makeExecuteWorkflowTool` paths.
- `test/unit/config-loader.test.ts`, `test/unit/config-loader-helpers.test.ts`, and `test/unit/config-provenance.test.ts` cover config loading/merge/scoping behavior.
- `test/unit/discovery.test.ts` and `test/unit/discovery-module-imports.test.ts` cover workflow discovery and module import behavior.
- `test/unit/wiring.test.ts` and `test/unit/wiring-adapters.test.ts` cover UI/runtime adapter behavior.
- `test/unit/integrations-mcp.test.ts`, `test/unit/integrations-subagents.test.ts`, `test/unit/integrations-intercom.test.ts`, and `test/unit/intercom-routing.test.ts` cover sibling integration helpers and intercom routing.
- `test/unit/doctor.test.ts` and `test/integration/doctor.test.ts` cover doctor report content and the registered command path.
- `test/integration/entrypoint-hil.test.ts`, `test/integration/mcp-entrypoint.test.ts`, `test/integration/overlay-entrypoints.test.ts`, `test/integration/runtime-tunables.test.ts`, and `test/integration/runtime-wiring.test.ts` exercise the factory-registered entrypoints through mocked pi surfaces.

## Code References

- `src/extension/index.ts:254-360` — structural `ExtensionAPI` shape for pi integration.
- `src/extension/index.ts:413-490` — workflow tool action dispatch for list/inputs/run/status/kill/resume.
- `src/extension/index.ts:519-587` — canonical/legacy slash command registration and `/workflow:<name>` aliases.
- `src/extension/index.ts:640-680` — detach flag and workflow input argument parsing.
- `src/extension/index.ts:730-785` — persistence and MCP port adapters.
- `src/extension/index.ts:791-951` — factory startup, runtime refs, config/discovery runtime swap.
- `src/extension/index.ts:961-982` — pi `workflow` tool registration.
- `src/extension/index.ts:986-1247` — `/workflow` command implementation and completions.
- `src/extension/index.ts:1261-1303` — `/workflows-doctor` registration.
- `src/extension/index.ts:1333-1399` — session lifecycle hooks and CLI flag fallback.
- `src/extension/index.ts:1401-1436` — store widget/tool hooks and F2/ctrl+h overlay shortcuts.
- `src/extension/index.ts:1449-1460` — intercom subscription wiring.
- `src/extension/discovery.ts:375-461` — all-source workflow discovery with precedence.
- `src/extension/config-loader.ts:438-498` — global/project config loading and merge.
- `src/extension/wiring.ts:109-149` — pi SDK agent-session adapter and subagent adapter.
- `src/intercom/intercom-bridge.ts:83-93` — parent session name registration.
- `src/intercom/result-intercom.ts:100-143` — `subagent:control-intercom` subscription and routing.
- `src/intercom/intercom-routing.ts:71-125` — store/UI/event callbacks for intercom control payloads.

## Architecture Documentation

The partition uses structural typing and optional capability detection throughout. Every sibling integration is guarded: absent tool registration, command registration, event bus, persistence, lifecycle, UI dialogs, overlay support, shortcuts, subagents, MCP adapter, and intercom all degrade to no-op or reduced behavior. The factory is therefore safe to invoke against `{}` and older pi builds.

The runtime is assembled by composition rather than global imports: workflow execution core receives adapters/ports for agent sessions, HIL UI, cancellation, persistence, MCP scope, config, and store. `src/extension` is the boundary that translates pi's extension API into those ports.

The registry lifecycle is two-phase: sync bundled workflows for immediate registration, async config+discovery to incorporate user/project workflows and tunables. The stable runtime proxy keeps registered slash/tool closures valid across the swap.

Cross-extension communication uses pi's event bus. MCP scoping emits `mcp.scope.set`; subagent lifecycle helpers emit workflow stage events; pi-intercom control messages use `subagent:control-intercom` and `subagent:control-intercom:response`.

UI integration is split between persistent above-editor widget (`installStoreWidget`), on-demand graph overlay (`buildGraphOverlayAdapter` plus F2/ctrl+h and `/workflow resume`), and HIL dialogs (`buildUIAdapter`).

## Historical Context

- `research/docs/2026-05-11-pi-coding-agent-reference.md` documents the pi extension API methods used here: `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `appendEntry`, `setSessionName`, `pi.events`, `pi.exec`, lifecycle hooks, and `ctx.ui.custom`/dialogs.
- `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md` documents the sibling extension contracts this partition mirrors: pi-mcp-adapter's event-bus orientation, pi-subagents' `subagent` tool and optional pi-intercom companion, and pi-intercom's `subagent:control-intercom`/`subagent:result-intercom` channels.
- `research/docs/2026-05-11-atomic-codebase-inventory.md` and `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md` provide the migration context: Atomic's former tmux/provider-specific workflow orchestration is being inverted into pi extension surfaces, widgets, overlays, and SDK-backed sessions.

## Related Research

- `research/docs/2026-05-11-pi-coding-agent-reference.md`
- `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md`
- `research/docs/2026-05-11-atomic-codebase-inventory.md`
- `research/docs/2026-05-11-map-the-entire-atomic-cli-codebase.md`

## Open Questions

- The broader research question text was `test research question`, so this document focuses on the explicitly assigned partition rather than a domain-specific product question.
- Some test comments in the runtime wiring area mention legacy `pi --mode json`/`pi.exec` flows, while the current `src/extension/wiring.ts` code documents and implements `createAgentSession()` as the primary stage-session adapter. A dedicated test-partition report can clarify the current test expectations separately.
