---
date: 2026-05-14 07:08:04 UTC
researcher: Pi AI coding agent
git_commit: f06be183847709686491a5d58b559e0e63f75156
branch: refactor/pi-rewrite
repository: atomic-pi-rewrite
topic: "nicobailon/pi-subagents API parity for atomic-workflows SDK and workflow tool"
tags: [research, codebase, github-mcp, pi-subagents, atomic-workflows, workflow-tool, sdk, skills]
status: complete
last_updated: 2026-05-14
last_updated_by: Pi AI coding agent
---

# Research

## Research Question

Use GitHub MCP to thoroughly research `nicobailon/pi-subagents`. The target is to replicate the same API for the `@bastani/atomic-workflows` SDK and `workflow` tool, including a workflow skill.

## Optimized Research Question

Using GitHub MCP and fresh local codebase research, document the current `pi-subagents` public API, tool schema, execution modes, extension registration, slash/prompt/skill packaging, discovery/management behavior, and runtime/control semantics, then map those observed API surfaces to the current `@bastani/atomic-workflows` SDK and `workflow` tool surfaces that would be involved in API parity.

## Summary

`pi-subagents` is a pi package that registers a single high-surface-area tool named `subagent`, packaged slash commands, prompt templates, builtin agents, and a parent-orchestrator skill. Its package metadata publishes raw TypeScript plus `agents/`, `skills/`, and `prompts/`, and pi loads its extension, skills, and prompts through the `pi` manifest (`package.json` lines [28-51](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/package.json#L28-L51)).

The core `subagent` API is an action-discriminated TypeBox schema with three execution modes and management/control actions: single `{ agent, task? }`, top-level parallel `{ tasks: [...] }`, chain `{ chain: [...] }`, and actions `list/get/create/update/delete/status/interrupt/resume/doctor` (`src/extension/schemas.ts` lines [101-156](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L101-L156), `src/shared/types.ts` line [597](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/types.ts#L597)). The extension registers that schema as tool `subagent`, adds renderers, registers slash commands, notification handlers, and session lifecycle hooks (`src/extension/index.ts` lines [398-476](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L398-L476), [491-547](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L491-L547)).

The current local `@bastani/atomic-workflows` package already has a raw-TypeScript SDK, `workflow` tool, named workflow registry/discovery, background workflow run dispatch, `ctx.task`/`ctx.chain`/`ctx.parallel`, and a limited `ctx.stage(...).subagent({ agent, task, context? })` bridge to pi-subagents. The local tool API is currently named-workflow oriented (`list`, `inputs`, `run`, `status`, `kill`, `resume`) rather than the direct execution/management shape used by `subagent` (`research/docs/2026-05-14-local-atomic-workflows-api-analysis.md`).

## Detailed Findings

### 1. Remote package shape and asset registration

- `pi-subagents` package metadata publishes source and assets: `src/**/*.ts`, `agents/`, `skills/**/*`, `prompts/**/*`, `README.md`, and `CHANGELOG.md` (`package.json` lines [28-35](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/package.json#L28-L35)).
- Pi package registration includes one extension entry, one skills directory, and one prompts directory (`package.json` lines [43-52](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/package.json#L43-L52)).
- The latest GitHub release observed through GitHub MCP is `v0.24.2`, targeting commit `635112deea068528d89694e58ca068ddc1fe4b2d`.
- Local `@bastani/atomic-workflows` currently publishes `src/**/*.ts`, `workflows/**/*.ts`, and pi metadata for `extensions` and `workflows`, not a packaged workflow skill/prompt directory (`package.json:37-42`, `package.json:56-63`; see `research/docs/2026-05-14-local-atomic-workflows-locator.md`).

### 2. `subagent` tool schema and result types

- The remote schema uses TypeBox and separates reusable nested shapes:
  - top-level parallel task item (`TaskItem`) begins at `src/extension/schemas.ts` line [38](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L38);
  - chain parallel task item begins at line [52](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L52);
  - chain item begins at line [66](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L66);
  - control overrides begin at line [86](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L86).
- `SubagentParams` includes execution fields, management/control action fields, async/background controls, output/file-only controls, skills/model overrides, clarify TUI toggle, worktree flag, and session/artifact settings (`src/extension/schemas.ts` lines [101-171](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L101-L171)).
- `Details` is the structured result envelope with mode, run id, context, results, control events, async id/dir, progress, artifacts, and chain metadata (`src/shared/types.ts` lines [208-229](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/types.ts#L208-L229)).
- `AsyncStatus`, `SubagentState`, and `ExtensionConfig` describe background state, extension runtime state, and config (`src/shared/types.ts` lines [277-326](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/types.ts#L277-L326), [380-425](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/types.ts#L380-L425), [497-509](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/types.ts#L497-L509)).
- Local `workflow` tool parameters are currently a JSON-schema-shaped object with `name`, `inputs`, `action`, and `id`, not TypeBox; local `ask_user_question` already uses TypeBox (`research/docs/2026-05-14-local-atomic-workflows-api-analysis.md`).

### 3. Tool registration and runtime routing

- The remote extension starts at `registerSubagentExtension(pi)` (`src/extension/index.ts` line [222](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L222)).
- The registered tool is `name: "subagent"`, `label: "Subagent"`, with a long embedded description documenting execution, chain variables, management, control, and diagnostics (`src/extension/index.ts` lines [398-472](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L398-L472)).
- The tool executes through `executor.execute(...)`, renders compact calls by action/mode, and renders structured results through `renderSubagentResult` (`src/extension/index.ts` lines [459-472](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L459-L472)).
- After tool registration, the extension registers slash commands and notification/event handlers (`src/extension/index.ts` lines [475-492](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L475-L492)).
- Local `workflow` tool registration is at `src/extension/index.ts:1014-1033` and routes through `executeWorkflowTool`; local slash registration is a `/workflow` command family at `src/extension/index.ts:1390-1852`.

### 4. Execution modes and dispatch path

- `SubagentParamsLike` mirrors the schema on the executor side (`src/runs/foreground/subagent-executor.ts` lines [101-132](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L101-L132)).
- Execution validation enforces exactly one mode among chain, parallel tasks, or single agent, and validates unknown agents/empty chains/first-step task requirements (`src/runs/foreground/subagent-executor.ts` lines [592-681](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L592-L681)).
- Default context is derived from requested agent configs: if any requested agent has `defaultContext: "fork"`, the run becomes forked unless the caller already supplied `context` (`src/runs/foreground/subagent-executor.ts` lines [691-702](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L691-L702)).
- Action mode is handled before normal execution. `doctor`, `status`, `resume`, and `interrupt` are special control paths; other valid management actions route to `handleManagementAction` (`src/runs/foreground/subagent-executor.ts` lines [1981-2054](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L1981-L2054)).
- Normal execution guards recursion depth, expands repeated parallel counts, resolves fork context/session files, computes effective async behavior, initializes session/artifact paths, records foreground controls, then routes to async, chain, parallel, or single paths (`src/runs/foreground/subagent-executor.ts` lines [2056-2211](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L2056-L2211)).
- Dedicated code paths exist for async (`runAsyncPath`, line [839](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L839)), foreground chain (`runChainPath`, line [1017](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L1017)), foreground parallel (`runParallelPath`, line [1361](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L1361)), and foreground single (`runSinglePath`, line [1679](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L1679)).
- Local `@bastani/atomic-workflows` has `ctx.task`, `ctx.chain`, and `ctx.parallel` execution helpers (`src/runs/foreground/executor.ts:762-798`) and user-facing workflow runs are dispatched as detached/background named workflow runs (`src/extension/dispatcher.ts:109-159`).

### 5. Chain, parallel, templates, outputs, and work directories

- Remote chain step types are in `src/shared/settings.ts`: sequential step (`lines [44-54](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L44-L54)`), parallel task item (`lines [57-68](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L57-L68)`), and parallel step (`lines [71-76](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L71-L76)`).
- `resolveChainTemplates` defaults missing sequential first-step task to `{task}`, later sequential steps to `{previous}`, and parallel task defaults to `{previous}` (`src/shared/settings.ts` lines [151-169](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L151-L169)).
- Chain execution creates a run-specific `chainDir`, optionally clarifies sequential chains in TUI, then walks sequential and parallel steps (`src/runs/foreground/chain-execution.ts` lines [352-405](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/chain-execution.ts#L352-L405)).
- `buildChainInstructions` injects `[Read from: ...]`, `[Write to: ...]`, progress-file instructions, and previous-step summaries into child task prompts (`src/shared/settings.ts` lines [261-304](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L261-L304)).
- Parallel chain behavior namespaces relative output paths under `parallel-<step>/<task>-<agent>` to avoid collisions (`src/shared/settings.ts` lines [316-371](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L316-L371)).
- Local workflow helper chain semantics are similar for `{task}`/`{previous}` defaults, but current local workflow tool only runs pre-defined workflows rather than accepting arbitrary tool-level `chain` arrays (`research/docs/2026-05-14-local-workflow-patterns.md`).

### 6. Agent and chain discovery/management

- Remote agent config includes runtime name, local/package names, description, tools/MCP direct tools, model/fallback/thinking, system prompt mode, context inheritance, default context, source, file path, skills/extensions/output/default reads/progress, and disabled/override metadata (`src/agents/agents.ts` lines [70-105](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L70-L105)).
- Remote chain config is a named list of step configs and source/file metadata (`src/agents/agents.ts` lines [117-125](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L117-L125)).
- Agent discovery recursively loads markdown agent files and excludes `.chain.md` files (`src/agents/agents.ts` lines [544-665](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L544-L665)). Chain discovery parses `.chain.md` files (`src/agents/agents.ts` lines [668-686](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L668-L686)).
- Project agent dirs include legacy `.agents` and canonical `.pi/agents`; project chains use `.pi/chains` (`src/agents/agents.ts` lines [697-723](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L697-L723)).
- `discoverAgents` and `discoverAgentsAll` merge builtin, user, and project definitions with settings overrides (`src/agents/agents.ts` lines [725-791](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L725-L791)).
- Management actions are `list/get/create/update/delete` (`src/agents/agent-management.ts` line [24](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agent-management.ts#L24)), with handlers for listing (`line [397](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agent-management.ts#L397)`), creating (`line [445](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agent-management.ts#L445)`), updating (`line [505](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agent-management.ts#L505)`), deleting (`line [613](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agent-management.ts#L613)`), and dispatching (`line [634](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agent-management.ts#L634)`).
- Local atomic workflows has workflow discovery/registry rather than agent/chain management: `defineWorkflow`, `createRegistry`, bundled/local/global discovery, and config loading (`research/docs/2026-05-14-local-atomic-workflows-api-analysis.md`).

### 7. Slash commands and prompt shortcuts

- Remote slash commands register in one function (`src/slash/slash-commands.ts` line [408](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L408)).
- Registered slash surfaces are `/run` (`line [412](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L412)`), `/chain` (`line [442](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L442)`), `/run-chain` (`line [466](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L466)`), `/parallel` (`line [496](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L496)`), and `/subagents-doctor` (`line [521](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L521)`).
- Inline slash config parses bracketed key/value overrides such as output, outputMode, reads, model, skills, and progress (`src/slash/slash-commands.ts` lines [36-64](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L36-L64)).
- Execution flags support `--bg` and `--fork` (`src/slash/slash-commands.ts` lines [67-88](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L67-L88)).
- Packaged prompt shortcuts exist under `prompts/`: `gather-context-and-clarify.md`, `parallel-cleanup.md`, `parallel-context-build.md`, `parallel-handoff-plan.md`, `parallel-research.md`, and `parallel-review.md` (GitHub MCP directory listing).
- Local atomic workflows currently has `/workflow` and `/workflows-doctor`; tests explicitly document that per-workflow slash aliases are not registered and `/workflow <name>` is the single workflow-run slash surface (`research/docs/2026-05-14-local-atomic-workflows-api-analysis.md`).

### 8. Skill behavior and examples

- The remote `pi-subagents` skill is a parent-orchestrator skill and explicitly says child subagents should not run their own orchestration loops (`skills/pi-subagents/SKILL.md` lines [1-15](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/skills/pi-subagents/SKILL.md#L1-L15)).
- The skill distinguishes direct tool use from slash commands and lists prompt shortcuts (`skills/pi-subagents/SKILL.md` lines [27-48](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/skills/pi-subagents/SKILL.md#L27-L48)).
- It documents direct single, parallel, chain, async/background, control, clarify TUI, worktree, intercom, management, file-based agent creation, prompt template integration, constraints, and common orchestration patterns (`skills/pi-subagents/SKILL.md` lines [194-553](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/skills/pi-subagents/SKILL.md#L194-L553)).
- The self-orchestrated workflow guidance maps natural-language feature work to `clarify → planner → worker → parallel fresh-context reviewers → worker` (`skills/pi-subagents/SKILL.md` lines [618-692](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/skills/pi-subagents/SKILL.md#L618-L692)).
- Local repository skill conventions already exist under `.agents/skills/<name>/SKILL.md`, and package-level workflow skill parity would use that existing skill shape (`research/docs/2026-05-14-local-workflow-patterns.md`).

### 9. Current local atomic-workflows parity map

Observed current local surfaces involved in mirroring the remote API:

- Package and extension entrypoints: `package.json:15-20`, `package.json:56-63`, `src/extension/index.ts:1007-1043`.
- Public SDK exports: `src/index.ts:6-24` exports `defineWorkflow`, `createRegistry`, identity helpers, shared types, foreground `run`, graph/store/cancellation helpers.
- Workflow authoring: `src/workflows/define-workflow.ts:31-121`, `src/workflows/registry.ts:13-99`.
- Tool dispatch: `src/extension/dispatcher.ts:52-159` supports `list`, `inputs`, and `run`; extension-layer tool code supports `status`, `kill`, and `resume`.
- Execution helpers: `src/runs/foreground/executor.ts:762-798` implements `ctx.task`, `ctx.chain`, and `ctx.parallel`.
- Stage-level subagent adapter: `src/shared/types.ts:91-106`, `src/extension/wiring.ts:213-239`, and `test/unit/executor-subagent-call-shape.test.ts:1-124` document the current `stage.subagent({ agent, task, context? })` bridge.
- Existing differences recorded by local research: local workflow tool is named-workflow/registry oriented, while remote `subagent` tool accepts direct execution arrays and management configs; local workflow slash surface is `/workflow`, while remote `pi-subagents` exposes `/run`, `/chain`, `/parallel`, `/run-chain`, and `/subagents-doctor`; local package metadata registers workflows, while remote package metadata registers skills and prompts as well.

## Code References

### Remote `nicobailon/pi-subagents` GitHub references

- [`package.json#L28-L52`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/package.json#L28-L52) - package published files and pi extension/skill/prompt registration.
- [`src/extension/schemas.ts#L101-L171`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/schemas.ts#L101-L171) - `SubagentParams` TypeBox schema.
- [`src/extension/index.ts#L398-L476`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/extension/index.ts#L398-L476) - `subagent` tool definition and registration.
- [`src/runs/foreground/subagent-executor.ts#L1981-L2054`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L1981-L2054) - action-mode routing for doctor/status/resume/interrupt/management.
- [`src/runs/foreground/subagent-executor.ts#L2056-L2211`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/runs/foreground/subagent-executor.ts#L2056-L2211) - normal execution setup and routing.
- [`src/shared/settings.ts#L44-L85`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L44-L85) - chain/parallel step types.
- [`src/shared/settings.ts#L151-L169`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/shared/settings.ts#L151-L169) - chain template defaults.
- [`src/agents/agents.ts#L725-L791`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/agents/agents.ts#L725-L791) - agent/chain discovery aggregation.
- [`src/slash/slash-commands.ts#L408-L526`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/src/slash/slash-commands.ts#L408-L526) - slash command registrations.
- [`skills/pi-subagents/SKILL.md#L194-L553`](https://github.com/nicobailon/pi-subagents/blob/635112deea068528d89694e58ca068ddc1fe4b2d/skills/pi-subagents/SKILL.md#L194-L553) - user/agent-facing skill API examples.

### Local `@bastani/atomic-workflows` references

- `package.json:15-20` - root SDK/workflow exports.
- `package.json:56-63` - pi extension and bundled workflow metadata.
- `src/index.ts:6-24` - public SDK entrypoint.
- `src/extension/index.ts:1014-1043` - `workflow` and `ask_user_question` tool registration.
- `src/extension/dispatcher.ts:52-159` - workflow `list`/`inputs`/`run` dispatcher.
- `src/runs/foreground/executor.ts:762-798` - local `task`/`chain`/`parallel` helpers.
- `src/extension/wiring.ts:213-239` - current bridge from workflow stages to host `subagent` tool.
- `test/unit/executor-subagent-call-shape.test.ts:1-124` - tests for current `stage.subagent` call shape.

## Architecture Documentation

The observed remote architecture is layered:

1. **Package asset layer**: raw TypeScript extension, builtin agents, prompt templates, and skill docs are published together and declared in the pi manifest.
2. **Tool schema layer**: a single `SubagentParams` schema encodes execution, management, async, control, output, skills, model, worktree, clarify, and session knobs.
3. **Extension layer**: `registerSubagentExtension` loads config/state, creates executor, registers renderers, bridges prompt/slash requests, registers the tool and slash commands, and subscribes to lifecycle/events.
4. **Execution layer**: `createSubagentExecutor` validates mutually exclusive modes, handles management/control actions, resolves discovery/default context/fork/session/artifacts/depth/intercom settings, and routes to async/chain/parallel/single implementations.
5. **Agent/chain asset layer**: Markdown agents and `.chain.md` chains are recursively discovered, merged by source precedence, and managed through the same tool action path.
6. **Skill/prompt guidance layer**: package-level skill and prompt shortcuts document how parent orchestrators use the tool and repeatable fanout/fanin workflows.

The local atomic-workflows architecture has equivalent layers for package entrypoints, extension registration, named workflow discovery/registry, workflow execution, and SDK helpers. It already contains a stage-level `subagent` bridge and top-level `ctx.chain`/`ctx.parallel`, but its user-facing tool currently centers on named workflow definitions rather than direct ad hoc execution payloads.

## Historical Context (from research/)

- `research/docs/2026-05-14-local-atomic-workflows-locator.md` - Locates local SDK, workflow tool, execution, prompt/skill, and subagent-adjacent files.
- `research/docs/2026-05-14-local-atomic-workflows-api-analysis.md` - Documents current local SDK/tool behavior and tests.
- `research/docs/2026-05-14-local-workflow-patterns.md` - Documents local patterns for skills, tools, schemas, chain/parallel execution, and subagent bridge tests.
- `research/docs/2026-05-14-existing-workflows-research-locator.md` - Lists relevant prior research/specs.
- `research/web/2026-05-14-nicobailon-pi-subagents-github.md` - GitHub MCP source capture for remote repository files and release metadata.
- `research/docs/2026-05-12-workflow-authoring-registry-core.md` - Prior workflow authoring/registry research.
- `research/docs/2026-05-12-extension-runs-workflows-test-surfaces.md` - Prior runtime/test surface research.
- `research/docs/2026-05-11-pi-mcp-adapter-and-subagents.md` - Prior pi MCP/subagents/intercom context.
- `specs/2026-05-11-pi-workflows-extension.md` - Current workflows extension design context.
- `specs/2026-05-06-sdk-self-contained-runworkflow.md` - Current SDK run workflow design context.

## Related Research

- `research/docs/2026-05-14-local-atomic-workflows-locator.md`
- `research/docs/2026-05-14-local-atomic-workflows-api-analysis.md`
- `research/docs/2026-05-14-local-workflow-patterns.md`
- `research/docs/2026-05-14-existing-workflows-research-locator.md`
- `research/web/2026-05-14-nicobailon-pi-subagents-github.md`

## Open Questions

- Whether `workflow` parity should use the existing `workflow` tool name with a `pi-subagents`-style direct execution schema, or add a second API surface while preserving current named-workflow `run/list/inputs/status/kill/resume` semantics.
- Whether workflow management parity means managing named workflow definitions, saved workflow chains, packaged workflow prompt shortcuts, or all three.
- Whether workflow skill packaging should be package-level via `pi.skills`/`pi.prompts` like `pi-subagents`, local project-level under `.agents/skills`, or both.
- How much of remote subagent behavior is in-scope for workflow parity: clarify TUI, output/file-only mode, session resume/revive, control events, worktree isolation, intercom result delivery, and nested depth guards.
