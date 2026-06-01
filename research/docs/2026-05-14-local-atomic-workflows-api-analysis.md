## Analysis: Local `@bastani/atomic-workflows` SDK and Workflow Tool

### Overview

`@bastani/atomic-workflows` is published as raw TypeScript: `package.json` points `main`, `types`, and the root export at `./src/index.ts`, and declares the pi extension entry under `pi.extensions` plus bundled workflow discovery under `pi.workflows` (`package.json:15-20`, `package.json:58-62`). The SDK authoring surface builds immutable compiled `WorkflowDefinition` objects, stores them in normalized-name registries, and exposes both foreground executor helpers and background/run-state utilities from the package root (`src/index.ts:6-24`). In pi, the extension registers one LLM tool named `workflow`, one primary slash command `/workflow`, a diagnostics slash command `/workflows-doctor`, the companion `ask_user_question` tool, renderers/widgets/shortcuts, and discovery-backed runtime dispatch (`src/extension/index.ts:1014-1043`, `src/extension/index.ts:1390-1852`, `src/extension/index.ts:1854-2040`).

### Entry Points

- `package.json:15-20` - package root exports `./src/index.ts`; `./workflows` and `./workflows/*` expose bundled workflow modules.
- `package.json:58-62` - pi package metadata registers `./src/extension/index.ts` and bundled workflow directory `./workflows`.
- `src/index.ts:6-24` - public SDK entrypoint re-exports authoring, registry, identity, executor, graph, store, store types, and cancellation APIs.
- `src/extension/index.ts:835-2148` - default pi extension factory; wires runtime adapters, workflow discovery, tool/slash registrations, UI surfaces, lifecycle hooks, shortcut, and intercom/MCP integrations.
- `src/extension/dispatcher.ts:57-156` - registry-backed dispatcher for `list`, `inputs`, and `run` workflow tool/slash actions.
- `src/runs/foreground/executor.ts:281-856` - synchronous/foreground executor used directly by SDK consumers/tests and by background runner internals.
- `src/runs/background/runner.ts:76-145` - detached background execution mode used by dispatcher/user-facing workflow runs.

### Exported SDK Surface

#### Root package exports (`src/index.ts:6-24`)

- Authoring API: `defineWorkflow` (`src/index.ts:6`) and its `WorkflowBuilder` / `CompletedWorkflowBuilder` types (`src/index.ts:10`).
- Registry API: `createRegistry` (`src/index.ts:7`) and `WorkflowRegistry` type (`src/index.ts:11`).
- Identity helpers: `normalizeWorkflowName`, `workflowNamesEqual` (`src/index.ts:8`).
- Shared public types: `export type * from "./shared/types.js"` (`src/index.ts:9`). This includes input schemas, `WorkflowRunContext`, `StageContext`, task helpers, runtime ports, and `WorkflowDefinition` (`src/shared/types.ts:15-330`).
- Foreground execution helpers: `run`, `resolveInputs` and `RunOpts`, `RunResult`, `ResolvedInputs` (`src/index.ts:13-14`).
- DAG inference helper: `GraphFrontierTracker` and `StageNode` (`src/index.ts:16-17`).
- Store helpers: `createStore`, `store`, and store snapshot/status/overlay/prompt types (`src/index.ts:18-19`).
- Cancellation helpers: `createCancellationRegistry`, singleton `cancellationRegistry`, and related types (`src/index.ts:22-24`).

#### `defineWorkflow` builder (`src/workflows/define-workflow.ts:31-121`)

- `defineWorkflow(name)` validates `name` as a non-empty string and seeds builder state with blank description, empty inputs, and no run function (`src/workflows/define-workflow.ts:110-120`).
- Builder methods are immutable/chained: `.description(text)` returns a new builder with replaced description (`src/workflows/define-workflow.ts:66-68`), `.input(key, schema)` returns a new builder with a copied inputs object plus the new schema (`src/workflows/define-workflow.ts:70-75`), and `.run(fn)` returns a new builder with `runFn` set (`src/workflows/define-workflow.ts:77-79`).
- `.compile()` is available on `CompletedWorkflowBuilder`; at runtime it throws if `.run()` has not been called (`src/workflows/define-workflow.ts:81-87`).
- Compilation normalizes the name, freezes a copied inputs map, creates `{ __piWorkflow: true, name, normalizedName, description, inputs, run }`, and freezes the top-level definition (`src/workflows/define-workflow.ts:89-103`).
- Tests assert compile output fields, missing `.run()` error, empty-name error, frozen definition behavior, and input accumulation (`test/unit/define-workflow.test.ts:6-55`).

#### Name identity (`src/workflows/identity.ts:18-31`)

- `normalizeWorkflowName` trims, lowercases, converts whitespace/underscores to hyphens, strips non-alphanumeric/non-hyphen characters, collapses repeated hyphens, and trims leading/trailing hyphens (`src/workflows/identity.ts:18-29`).
- `workflowNamesEqual(a,b)` compares the normalized forms (`src/workflows/identity.ts:35-37`).
- The public entrypoint test documents normalization of `" Example_Task! "` to `"example-task"` and equality between `"Example Task"` and `"example_task"` (`test/unit/public-entrypoint.test.ts:20-21`).

#### Registry (`src/workflows/registry.ts:13-99`)

- `createRegistry(initial)` builds a `Map` keyed by each definition's `normalizedName` and returns a registry facade (`src/workflows/registry.ts:93-98`).
- `register`/`upsert` copy the map, set `definition.normalizedName`, and return a new registry (`src/workflows/registry.ts:47-56`).
- `merge` copies the current map and overlays `other.all()` entries, with later entries replacing collisions by normalized key (`src/workflows/registry.ts:58-64`).
- `get`, `has`, and `remove` normalize raw input names before lookup/deletion (`src/workflows/registry.ts:66-77`).
- `names()` returns map keys in insertion order; `all()` returns definitions in insertion order (`src/workflows/registry.ts:79-85`).
- Tests cover empty registry, immutable-style registration, unknown lookup, overwrite by same normalized name, merge, initial array population, and `all()` behavior (`test/unit/registry.test.ts:12-61`).

### Shared Type and Schema Surface

#### Workflow input schemas (`src/shared/types.ts:15-45`)

- Supported input `type` values are `"text" | "string" | "number" | "boolean" | "select"` (`src/shared/types.ts:15-16`).
- All inputs may carry `description` and `required` through `BaseInputSchema` (`src/shared/types.ts:18-21`).
- Text/string schemas allow `default?: string` (`src/shared/types.ts:23-26`); number schemas allow `default?: number` (`src/shared/types.ts:28-31`); boolean schemas allow `default?: boolean` (`src/shared/types.ts:33-36`).
- Select schemas require `choices: readonly string[]` and may carry `default?: string` (`src/shared/types.ts:38-42`).
- `resolveInputs` copies provided values, fills declared defaults where the provided key is `undefined`, then throws `TypeError('pi-workflows: required input "<key>" not provided')` for missing required values (`src/runs/foreground/executor.ts:100-119`).

#### Workflow run context and stage context (`src/shared/types.ts:224-330`)

- `StageContext` exposes stage execution methods `prompt`, `complete`, and `subagent`, streaming controls `steer`/`followUp`, event subscription, session metadata, model/thinking controls, message/state accessors, tree navigation, compaction, and abort (`src/shared/types.ts:231-286`).
- `WorkflowRunContext` exposes resolved `inputs`, `stage(name, options?)`, high-level `task`, `chain`, `parallel`, and `ui` HIL primitives (`src/shared/types.ts:293-316`).
- `WorkflowRunFn` is `(ctx) => Promise<Record<string, unknown>>` (`src/shared/types.ts:321-323`), and `WorkflowDefinition` carries the `__piWorkflow` sentinel, display and normalized names, description, frozen input schema map, and run function (`src/shared/types.ts:327-338`).

#### TypeBox schemas (`src/extension/tools/ask-user-question/tool/types.ts:45-104`)

- The local workflow tool parameter schema is a JSON-schema-shaped constant rather than TypeBox: `workflowParameters` is an object with `name`, `inputs`, `action`, and `id` properties (`src/extension/index.ts:352-388`).
- TypeBox is used by the companion `ask_user_question` tool. `OptionSchema` requires `label` with `maxLength: 60`, required `description`, and optional `preview` (`src/extension/tools/ask-user-question/tool/types.ts:45-60`).
- `QuestionSchema` requires `question`, `header` with `maxLength: 16`, `options` as 2-4 `OptionSchema` entries, and optional `multiSelect` defaulting to false (`src/extension/tools/ask-user-question/tool/types.ts:62-84`).
- `QuestionsSchema` is an array with 1-4 questions, and `QuestionParamsSchema` wraps it as `{ questions }` (`src/extension/tools/ask-user-question/tool/types.ts:86-94`).
- Static TypeScript types are derived from the TypeBox schemas via `Static<typeof ...>` for options, questions, and params (`src/extension/tools/ask-user-question/tool/types.ts:96-98`).

### Pi Extension Registration

#### Runtime setup and discovery (`src/extension/index.ts:835-1008`)

- The factory builds `StageAdapters` from pi host surfaces via `buildRuntimeAdapters(pi)` (`src/extension/index.ts:843-847`).
- It creates a graph overlay adapter with `buildGraphOverlayAdapter(pi, store)` (`src/extension/index.ts:856-858`).
- It seeds `runtimeRef.current` with synchronously discovered bundled workflows, adapters, cancellation registry, persistence port, MCP port, and default runtime config (`src/extension/index.ts:910-918`).
- Async startup loads config, builds scoped discovery config, discovers workflows, updates runtime config, replaces the status writer, rebuilds the persistence port, and swaps the runtime to the newly discovered registry (`src/extension/index.ts:950-1008`).
- Discovery supports bundled, project-local, user-global, settings-project, and settings-global sources with precedence documented in `src/extension/discovery.ts:1-18`; the structural validator requires `__piWorkflow: true`, non-empty `name`, non-empty `normalizedName`, and callable `run` (`src/extension/discovery.ts:132-153`).

#### `workflow` LLM tool (`src/extension/index.ts:1014-1043`)

- Registered only when `pi.registerTool` exists (`src/extension/index.ts:1014`).
- Tool metadata: `name: "workflow"`, `label: "workflow"`, description `"Run a defined multi-stage workflow by name."`, and `parameters: workflowParameters` (`src/extension/index.ts:1015-1019`).
- Pi's positional execute signature is adapted to the internal `(args, ctx)` executor; the tool returns `content` containing rendered text plus `details` carrying the structured workflow result (`src/extension/index.ts:1020-1026`).
- `renderCall` renders via `renderCall(args)`, and `renderResult` renders `result.details` via `renderResult` (`src/extension/index.ts:1028-1032`).
- `makeExecuteWorkflowTool` routes `list`, `inputs`, and `run` to the active extension runtime, handles `status` by reading active store snapshots or a detailed run lookup, handles `kill` via `killRun`/`killAllRuns`, and handles `resume` via `resumeRun` (`src/extension/index.ts:397-518`).

#### Companion `ask_user_question` tool (`src/extension/index.ts:1034-1043`)

- After `workflow` registration, the factory casts the local structural `ExtensionAPI` to the upstream pi API shape and calls `registerAskUserQuestionTool(piFull)` (`src/extension/index.ts:1034-1043`).
- Inline comments describe the tool as a structured multi-question dialog with single/multi-select, free-text fallback, chat escape hatch, markdown previews, notes, and clean headless `no_ui` behavior (`src/extension/index.ts:1034-1040`).

#### Slash commands and input interception (`src/extension/index.ts:541-625`, `src/extension/index.ts:1390-1852`)

- `registerWorkflowCommand` forwards to `pi.registerCommand?.(name, options)` and stores the same handler in an internal map for input interception (`src/extension/index.ts:541-561`).
- `installInputInterceptor` subscribes to `pi.on("input")`, identifies slash commands by their first token, dispatches stored workflow command handlers directly, catches handler errors into `ctx.ui.notify`, and returns `{ action: "handled" }` to stop the host submission pipeline (`src/extension/index.ts:570-624`).
- `/workflow` is registered with a description covering run/inspect usage and admin subcommands (`src/extension/index.ts:1390-1394`).
- `/workflow list` or empty args emits a chat-surface catalogue from `runtimeProxy.registry.all()` (`src/extension/index.ts:1423-1437`).
- `/workflow status [id|--all]` either inspects a resolved run prefix and emits detail or emits status rows selected from the store (`src/extension/index.ts:1443-1477`).
- `/workflow kill`, `/workflow resume`, `/workflow connect`, `/workflow attach`, and `/workflow pause` delegate into `handleRunControlCommand` (`src/extension/index.ts:1405-1420`, `src/extension/index.ts:1481-1500`).
- `/workflow inputs <name>` dispatches `action: "inputs"` and renders the workflow schema or a not-found message plus available workflow names (`src/extension/index.ts:1504-1528`).
- `/workflow <name> [key=value...]` parses inputs, optionally opens an inline/overlay input picker for declared/missing required fields, then dispatches `action: "run"`; successful dispatch emits a background dispatch chat surface and may open the overlay if the picker was shown (`src/extension/index.ts:1533-1689`).
- `/workflows-doctor` discovers/uses the registry, detects companion packages and host capabilities, builds a doctor payload/report, and renders diagnostics (`src/extension/index.ts:1854-2038`).

#### Completions, shortcut, renderers, and integrations

- `/workflow` completions include admin subcommands, workflow names, run IDs for run-control subcommands, `--all`/`--yes`/`-y` for status/kill, workflow input names, `--no-picker`, `--help`, select choices, and boolean true/false completions (`src/extension/index.ts:1692-1850`).
- F2 is registered when `pi.registerShortcut` exists and opens the graph overlay for the active run or the most recent run (`src/extension/index.ts:2040-2066`).
- Intercom control subscription wires store notices, optional `pi.events.emit`, and optional `pi.ui.confirm` through `subscribeIntercomControl` (`src/extension/index.ts:2075-2095`).
- Store widget and tool execution hooks are installed before shortcut/integrations (`src/extension/index.ts:2038-2039`).

### Workflow Execution Modes

#### User-facing mode: always detached/background (`src/extension/dispatcher.ts:111-151`)

- Dispatcher handles `action: "run"` by resolving the workflow from the registry; not-found returns `{ action: "run", runId: "", status: "failed", error, stages: [] }` (`src/extension/dispatcher.ts:112-123`).
- It pre-validates inputs with `resolveInputs` so missing required inputs are returned in the dispatch result instead of surfacing only inside the background promise (`src/extension/dispatcher.ts:128-141`).
- It calls `runDetached(def, inputs, ...)` and immediately returns a running result containing `name`, `runId`, status/message, and empty stages (`src/extension/dispatcher.ts:143-151`).
- `test/unit/dispatcher.test.ts` documents that `dispatch("run")` always returns synchronously with `status: "running"`, empty stages, and a run ID; returns before a slow workflow body settles; and returns structured failure for unknown workflows (`test/unit/dispatcher.test.ts:84-144`).

#### Detached runner (`src/runs/background/runner.ts:76-145`)

- `runDetached` preallocates a UUID run ID, creates an `AbortController`, registers it in the cancellation registry before executor startup, and then starts the foreground executor in a fire-and-forget promise (`src/runs/background/runner.ts:90-130`).
- It strips background-only options, injects the preallocated `runId`, `signal`, cancellation registry, store, and a store-backed background HIL adapter built by `buildBackgroundUIAdapter(store, runId, controller.signal)` (`src/runs/background/runner.ts:104-123`).
- On settle, it unregisters the job tracker entry and lets the executor unregister cancellation in its own `finally` path (`src/runs/background/runner.ts:132-141`; executor cleanup at `src/runs/foreground/executor.ts:855-856`).
- It returns `buildDetachedAccepted(def.name, runId)`, whose message is `Workflow "<name>" started in background (runId: <runId>).` (`src/runs/background/runner.ts:55-71`, `src/runs/background/runner.ts:144-145`).

#### Foreground executor (`src/runs/foreground/executor.ts:281-856`)

- `run` enforces configured `maxDepth` before store/persistence side effects (`src/runs/foreground/executor.ts:290-301`).
- It resolves inputs, creates or accepts a run ID, forwards caller abort signals into an owned `AbortController`, creates a running `RunSnapshot`, records it in the store, optionally registers cancellation, calls `onRunStart`, and appends `workflow.run.start` when persistence is supplied (`src/runs/foreground/executor.ts:304-346`).
- It creates `GraphFrontierTracker` and a per-run concurrency limiter from `opts.config?.defaultConcurrency` (`src/runs/foreground/executor.ts:349-350`).
- `ctx.stage(name, options?)` generates a stage ID, obtains parent IDs from graph inference, records a pending stage snapshot, creates an internal agent-session-backed stage context, registers a live stage-control handle, and records stage start in the store (`src/runs/foreground/executor.ts:464-555`).
- A tracked stage call waits for pause/barrier release, acquires concurrency, marks the stage running, appends `workflow.stage.start`, applies MCP scope if provided, races the adapter call against abort, captures session metadata/result text, marks completion/failure, clears MCP scope, records/appends stage end, updates graph frontier, marks the stage non-attachable, disposes the inner context, and releases concurrency (`src/runs/foreground/executor.ts:557-668`).
- `ctx.task` creates a stage and prompts it with `prompt`/`task` plus previous/context handoff processing; it returns `{ name, stageName, text, sessionId?, sessionFile? }` (`src/runs/foreground/executor.ts:746-763`).
- `ctx.chain` runs steps sequentially and defaults missing first-step prompt to `{task}` and later missing prompts to `{previous}`; `ctx.parallel` runs task steps via `Promise.all` with a shared fallback task (`src/runs/foreground/executor.ts:765-785`).
- On workflow body success, the executor records completed run state and appends `workflow.run.end`; on thrown errors it records failed state; on abort it finalizes as killed (`src/runs/foreground/executor.ts:790-854`, `src/runs/foreground/executor.ts:260-277`).

### Slash / Prompt / Skill Conventions

#### Slash command grammar (`src/extension/index.ts:697-772`)

- `tokenizeWorkflowArgs` is shell-aware for quotes: it preserves quoted spans as single tokens, keeps quote characters for downstream JSON parsing, collapses whitespace, and treats unterminated quotes as an end-of-line token rather than throwing (`src/extension/index.ts:697-728`).
- `parseWorkflowArgs` merges standalone JSON object tokens into the result and parses `key=value` tokens by splitting on the first `=`; JSON values become typed numbers/booleans/objects where valid, otherwise strings are kept (`src/extension/index.ts:731-772`).
- Tests document empty/whitespace tokenization, quoted values, nested opposite quotes, unterminated quotes, JSON object merging, ignored positional tokens, empty values, and end-to-end quoted prompt parsing (`test/unit/slash-dispatch.test.ts:43-147`).

#### Prompt/task conventions (`src/shared/types.ts:145-221`, `src/runs/foreground/executor.ts:139-192`)

- `WorkflowTaskOptions` accepts `prompt` and alias `task`; it accepts `previous` and backward-compatible alias `context`; comments describe `{previous}` and `{context}` handoff placeholders (`src/shared/types.ts:145-167`).
- `applyTaskContext` replaces `{previous}` with the last context text and `{context}` with rendered labeled context blocks; if no placeholder is present it appends a `---\nContext:` block (`src/runs/foreground/executor.ts:139-154`).
- `taskPrompt` throws when neither `prompt` nor `task` is supplied (`src/runs/foreground/executor.ts:156-161`).
- Chain default prompts are `"{task}"` for the first missing step and `"{previous}"` for subsequent missing steps (`src/runs/foreground/executor.ts:179-181`).

#### Skill/slash interaction with pi input pipeline (`src/extension/index.ts:570-624`)

- The extension's input interceptor only handles registered workflow slash commands; comments identify pi built-in slash, skill, bash, and python commands as host-side categories that normally avoid the optimistic submission path (`src/extension/index.ts:570-579`).
- For workflow commands, the interceptor calls the same command handler itself and returns `{ action: "handled" }`, so `/workflow ...` and `/workflows-doctor` are synchronous command UIs rather than agent-streaming turns (`src/extension/index.ts:600-624`).
- `test/unit/slash-dispatch.test.ts` explicitly documents that per-workflow slash aliases are not registered and `/workflow <name>` is the single workflow-run slash surface (`test/unit/slash-dispatch.test.ts:6-12`).

### Tests Documenting Public API Behavior

- `test/unit/public-entrypoint.test.ts:1-35` verifies root exports compose: workflow authoring, registry lookup, normalization/equality, direct workflow run invocation, `resolveInputs` error, and graph frontier sequencing.
- `test/unit/define-workflow.test.ts:6-55` documents builder compile shape, `.run()` requirement, name validation, frozen definitions, and multiple input accumulation.
- `test/unit/registry.test.ts:12-61` documents registry immutability, normalized lookup, overwrite semantics, merging, and initial population.
- `test/unit/dispatcher.test.ts:1-21` states the public dispatcher contract after foreground mode removal; concrete tests at `test/unit/dispatcher.test.ts:84-144` verify background-only dispatch behavior.
- `test/unit/slash-dispatch.test.ts:1-15` states slash API expectations; parser/tokenizer tests at `test/unit/slash-dispatch.test.ts:43-147` cover argument grammar.
- `test/unit/public-entrypoint.test.ts:27-34` documents observable helper edge cases: missing required input error and `GraphFrontierTracker` parent inference after a settled stage.
