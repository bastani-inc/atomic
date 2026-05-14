# Local `@bastani/atomic-workflows` Locator

Read-only locator for files/directories involved in local SDK, workflow tool, extension entrypoint, prompt/skill assets, and workflow execution APIs, especially surfaces relevant to pi-subagents-style API/tool/skill behavior.

## Package and Extension Entrypoints

- `package.json:2` — package name is `@bastani/atomic-workflows`.
- `package.json:15-20` — package entry/export map: SDK main is `./src/index.ts`; bundled workflow exports are `./workflows/index.ts` and `./workflows/*.ts`.
- `package.json:37-42` — published file set includes `src/**/*.ts`, `workflows/**/*.ts`, and top-level docs/license.
- `package.json:56-63` — pi extension registration points: extension entrypoint `./src/extension/index.ts`; workflow directory `./workflows`.
- `src/extension/index.ts:228-233` — local `PiExtensionApi` shape includes `registerTool` and `registerCommand` surfaces.
- `src/extension/index.ts:1007-1023` — registers the `workflow` tool and forwards tool calls through `executeWorkflowTool`.
- `src/extension/index.ts:1035-1037` — registers the companion `ask_user_question` tool.
- `src/extension/index.ts:1391-1851` — registers and implements the `/workflow` slash command family.
- `src/extension/index.ts:1854-1929` — registers `/workflows-doctor` diagnostics command.
- `src/extension/index.ts:1939-1952` — registers workflow message renderers / inline input form renderers.
- `src/extension/index.ts:1962-2035` — hooks CLI workflow startup dispatch and lifecycle events (`session_start`, `session_shutdown`).
- `src/extension/index.ts:2107` — installs input interceptor for registered workflow commands.

## Public SDK / Authoring API Files

- `src/index.ts:6-23` — root SDK exports: `defineWorkflow`, `createRegistry`, workflow identity helpers, shared types, foreground `run`, store APIs, cancellation registry.
- `src/workflows/define-workflow.ts:37-56` — public workflow builder interfaces.
- `src/workflows/define-workflow.ts:137-138` — `defineWorkflow(name)` function.
- `src/workflows/registry.ts:14` — `WorkflowRegistry` interface.
- `src/workflows/registry.ts:117` — `createRegistry(initial)` function.
- `src/workflows/identity.ts` — workflow name normalization/equality helpers exported by `src/index.ts`.
- `src/shared/types.ts:22-52` — workflow input schema types.
- `src/shared/types.ts:67-83` — workflow UI/HIL context types.
- `src/shared/types.ts:94-145` — stage and subagent stage option types.
- `src/shared/types.ts:159-170` — MCP and persistence port interfaces.
- `src/shared/types.ts:186-246` — task/context/chain/parallel option types.
- `src/shared/types.ts:246-297` — stage context and top-level workflow run context types.
- `src/shared/types.ts:336-367` — runtime config, run function, and workflow definition types.

## Workflow Tool and Dispatch Files

- `src/extension/render-call.ts:6-16` — display renderer shape for workflow tool calls.
- `src/extension/render-result.ts:93-120` — workflow tool result union and result renderer entrypoint.
- `src/extension/dispatcher.ts:52-57` — dispatcher entrypoint for `list`, `inputs`, and `run` actions.
- `src/extension/dispatcher.ts:67-80` — `list` action result construction.
- `src/extension/dispatcher.ts:83-105` — `inputs` action result construction.
- `src/extension/dispatcher.ts:109-159` — `run` action path, including input resolution and detached background run acceptance.
- `src/extension/runtime.ts:63-72` — extension runtime exposes registry and dispatch API.
- `src/extension/runtime.ts:93-107` — creates runtime from registry/definitions and forwards dispatch to `dispatcher.ts`.
- `src/extension/wiring.ts` — adapter wiring for extension runtime, including stage/completion/subagent support.
- `src/extension/background-ui-adapter.ts` — UI adapter used by background workflow runs.
- `src/extension/doctor.ts:35-63` — diagnostics result fields for companion/subagent adapter availability.

## Workflow Execution APIs

- `src/runs/foreground/executor.ts:40-91` — foreground run option and result interfaces.
- `src/runs/foreground/executor.ts:103` — `resolveInputs(...)` API.
- `src/runs/foreground/executor.ts:283` — foreground `run(...)` API.
- `src/runs/foreground/executor.ts:711-712` — stage context forwards `complete` and `subagent` calls.
- `src/runs/foreground/executor.ts:762-798` — top-level workflow task helpers: `task`, `chain`, and `parallel`.
- `src/runs/foreground/executor.ts:804-806` — calls the workflow definition's `run(ctx)` function.
- `src/runs/foreground/stage-runner.ts:52-63` — stage adapter interfaces for `complete` and `subagent`.
- `src/runs/foreground/stage-runner.ts:270-287` — stage context implementations for `complete(...)` and `subagent(...)`.
- `src/runs/background/runner.ts:37-87` — detached/background run option and entrypoint definitions.
- `src/runs/background/cancellation-registry.ts` — active run/stage cancellation registry.
- `src/runs/background/job-tracker.ts` — background job tracking.
- `src/runs/shared/graph-inference.ts` — DAG/frontier tracking exported from the SDK.
- `src/runs/shared/cli-flags.ts` — CLI flag parsing for startup workflow runs.
- `src/runs/shared/validate-inputs.ts` — workflow input validation helpers.

## Pi-subagents-Adjacent Integration Files

- `src/extension/subagents.ts:5-28` — comments/types for workflow run/stage env injection and optional host tool bridge.
- `src/extension/subagents.ts:42` — env-var record construction for delegated child sessions.
- `src/extension/subagents.ts:114-127` — structural detection/requirement for pi task delegation support.
- `src/extension/companions.ts:58-98` — companion package descriptors and registered tool hints, including `subagent`, `mcp`, web, and intercom tools.
- `src/extension/companions.ts:139-163` — companion detection against registered commands/tools.
- `src/extension/index.ts:1865-1885` — doctor/runtime notes for pi-subagents adapter reporting.
- `src/extension/mcp.ts` — workflow MCP scope/event bridge.
- `src/intercom/intercom-bridge.ts`, `src/intercom/intercom-routing.ts`, `src/intercom/result-intercom.ts` — intercom integration surfaces used alongside workflow execution.

## Companion Tool: `ask_user_question`

- `src/extension/tools/ask-user-question/index.ts:1-19` — companion tool entrypoint and registration notes.
- `src/extension/tools/ask-user-question/ask-user-question.ts:69` — `ask_user_question` execute handler registration.
- `src/extension/tools/ask-user-question/tool/types.ts` — questionnaire tool schema/types.
- `src/extension/tools/ask-user-question/tool/validate-questionnaire.ts` — questionnaire validation.
- `src/extension/tools/ask-user-question/tool/response-envelope.ts:9` — maps questionnaire result to LLM-facing tool envelope.
- `src/extension/tools/ask-user-question/state/` — questionnaire state/session/key routing files.
- `src/extension/tools/ask-user-question/view/` — questionnaire TUI/dialog rendering files.
- Directory count: `src/extension/tools/ask-user-question/` contains 36 files.

## Workflow Discovery and Config Files

- `src/extension/discovery.ts:2-15` — discovery purpose and source precedence comments.
- `src/extension/discovery.ts:258-276` — dynamic import of workflow files.
- `src/extension/discovery.ts:300-353` — directory and explicit-path loading helpers.
- `src/extension/discovery.ts:366-439` — all-source workflow discovery flow.
- `src/extension/discovery.ts:480-484` — bundled workflow discovery APIs.
- `src/extension/config-loader.ts:2-12` — config loader purpose and config file locations.
- `src/extension/config-loader.ts:27-37` — workflow config entry/config shape.
- `src/extension/config-loader.ts:287-325` — workflow config defaults and effective config.
- `src/extension/config-loader.ts:377-390` — scoped discovery config construction.
- `src/extension/config-loader.ts:425-453` — project/global config path loading flow.
- `docs/settings/custom-workflows.md:3-7` — custom workflow settings overview and shape.
- `docs/settings/custom-workflows.md:37-39` — notes `hostLocalWorkflows` as required for external CLI workflows.
- `docs/atomic-sdk/host-local-workflows.md` — SDK helper documentation for hosted local workflows.

## Bundled Workflow Files

- `workflows/index.ts` — bundled workflow manifest imported by discovery (`src/extension/discovery.ts:31`).
- `workflows/deep-research-codebase.ts` — bundled workflow definition.
- `workflows/open-claude-design.ts` — bundled workflow definition.
- `workflows/ralph.ts` — bundled workflow definition.
- Directory count: `workflows/` contains 4 files.

## Prompt / Skill Assets

- `.agents/skills/` — repository-local skill assets; contains 93 files.
- `.agents/skills/*/SKILL.md` — skill entry documents for bun, create-spec, gh-commit, gh-create-pr, impeccable, playwright-cli, prek, prompt-engineer, research-codebase, tdd, typescript-advanced-types, and typescript-expert.
- `.agents/skills/prompt-engineer/SKILL.md` — prompt-engineering skill entrypoint.
- `.agents/skills/prompt-engineer/references/core_prompting.md`, `advanced_patterns.md`, `quality_improvement.md` — prompt-engineering references.
- `.pi/agents/` — local pi agent prompt/persona markdown files; contains codebase locator/research/debugger style agents.
- `.pi/extensions/` — local pi extension examples (`btw.ts`, `goal.ts`, `review.ts`, `todos.ts`, `whimsical.ts`).
- `docs/claude-code/agent-sdk/guides/skills.md`, `docs/claude-code/cli/skills.md`, `docs/copilot-cli/skills.md` — skill documentation references.
- `src/tui/prompt-card.ts` — prompt card TUI component.
- `test/unit/prompt-card.test.ts`, `test/unit/store-pending-prompt.test.ts` — prompt-related tests.

## Tests and Research Docs

- `test/unit/define-workflow.test.ts`, `test/unit/define-workflow-extended.test.ts` — workflow builder tests.
- `test/unit/builtin-workflows.test.ts` — bundled workflow tests.
- `test/unit/workflow-attach-pane.test.ts`, `test/unit/workflow-list-render.test.ts` — workflow TUI tests.
- `test/unit/` — contains 73 unit test files total.
- `research/docs/2026-05-12-extension-runs-workflows-test-surfaces.md` — existing locator/research doc for extension workflow test surfaces.
- `research/docs/2026-05-12-workflow-authoring-registry-core.md` — existing research doc for authoring/registry core.
- `specs/2026-05-06-sdk-self-contained-runworkflow.md`, `specs/2026-05-11-pi-workflows-extension.md` — relevant workflow SDK/extension specs.

## Related Directory Clusters

- `src/extension/` — extension integration layer; 51 files including entrypoint, dispatcher/runtime, discovery/config, companions, doctor, renderers, and tools.
- `src/runs/` — workflow execution layer; 11 files across foreground, background, and shared execution helpers.
- `src/workflows/` — SDK workflow authoring/registry layer; 3 files.
- `src/shared/` — shared runtime/store/types/persistence helpers for workflow execution.
- `src/tui/` — workflow UI/rendering surfaces, including graph, run detail, prompt cards, inputs overlays, status lists, and stage chat view.
- `workflows/` — bundled workflow definitions and manifest; 4 files.
- `.agents/skills/` — prompt/skill assets; 93 files.
