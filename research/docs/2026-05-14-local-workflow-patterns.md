## Pattern Examples: Local Workflow / pi-subagents-adjacent API Shapes

### Pattern 1: Packaged skill directories and `SKILL.md` metadata
**Found in**: `.agents/skills/research-codebase/SKILL.md:1-8`, `docs/copilot-cli/skills.md:27-66`, `docs/claude-code/cli/skills.md:17-37`
**Used for**: Markdown-packaged reusable agent instructions with YAML frontmatter and optional colocated resources.

```markdown
---
name: research-codebase
description: Document codebase as-is with research directory for historical context.
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase...
```

**Key aspects**:
- Skill packages are directories under `.agents/skills/<name>/` with a `SKILL.md` entry point.
- Skill files use YAML frontmatter with `name` and `description`.
- The docs describe the same shape for Copilot/Agent Skills: each skill has its own directory, lowercase hyphenated names, and a required `SKILL.md`.
- Claude docs frame skills as reusable knowledge/workflows that can combine with subagents.

### Pattern 2: Prompt/reference assets inside a skill package
**Found in**: `.agents/skills/prompt-engineer/references/core_prompting.md:1`, `.agents/skills/prompt-engineer/SKILL.md` (package entry), `docs/claude-code/agent-sdk/guides/modifying-system-prompts.md`
**Used for**: A skill package with nested reference material loaded alongside/under the skill.

```text
.agents/skills/prompt-engineer/
├── SKILL.md
└── references/
    └── core_prompting.md
```

**Key aspects**:
- Prompt assets can live as files below the skill directory rather than only inline in `SKILL.md`.
- The package layout supports an entry markdown file plus auxiliary reference documents.

### Pattern 3: Extension tool registration shape
**Found in**: `src/extension/index.ts:187-225`, `src/extension/index.ts:1014-1033`, `src/extension/tools/ask-user-question/tool/types.ts:46-93`
**Used for**: Registering Pi extension tools with name/label/description/parameters/execute/render hooks.

```ts
export interface PiToolOpts<TArgs, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: TArgs,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: PiAgentToolResult<TDetails>) => void) | undefined,
    ctx: PiExecuteContext,
  ) => Promise<PiAgentToolResult<TDetails>>;
  renderCall?: (args: TArgs, theme: PiTheme, context: PiRenderContext) => PiRenderComponent | string;
  renderResult?: (result: PiAgentToolResult<TDetails>, opts: PiRenderResultOpts, theme: PiTheme, context: PiRenderContext) => PiRenderComponent | string;
}
```

```ts
pi.registerTool<WorkflowToolArgs, WorkflowToolResult>({
  name: "workflow",
  label: "workflow",
  description: "Run a defined multi-stage workflow by name.",
  parameters: workflowParameters,
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const details = await executeWorkflowTool(params, ctx);
    return {
      content: [{ type: "text", text: renderResult(details, {}) }],
      details,
    };
  },
  renderCall: (args, _theme, _context) => textRenderComponent(renderCall(args)),
  renderResult: (result, opts, _theme, _context) =>
    textRenderComponent(renderResult(result.details, opts)),
});
```

**Key aspects**:
- Tool execution returns an AgentToolResult-style `{ content, details }` envelope.
- Tool arguments are schema-described through `parameters`.
- Render hooks are registered at the tool boundary.
- The companion `ask_user_question` tool uses TypeBox schemas for nested structured parameters.

### Pattern 4: Management/list/status action schema for workflow tool
**Found in**: `src/extension/index.ts:349-398`, `src/extension/index.ts:407-519`, `src/extension/dispatcher.ts:42-127`
**Used for**: A single tool with action-discriminated behavior for `run`, `list`, `inputs`, `status`, `kill`, and `resume`.

```ts
export interface WorkflowToolArgs {
  name?: string;
  inputs?: Record<string, unknown>;
  action?: "run" | "list" | "status" | "kill" | "resume" | "inputs";
  id?: string;
}

const workflowParameters = {
  type: "object",
  properties: {
    name: { type: "string", description: "Workflow ID (use {action:'list'} to enumerate)" },
    inputs: { type: "object", default: {}, additionalProperties: true },
    action: {
      anyOf: [
        { const: "run" }, { const: "list" }, { const: "status" },
        { const: "kill" }, { const: "resume" }, { const: "inputs" },
      ],
    },
    id: { type: "string", description: "Run identifier for status/kill/resume (UUID or unique short prefix)" },
  },
} as const;
```

```ts
case "list": {
  const items = opts.registry.all().map((def) => ({
    name: def.normalizedName,
    description: def.description,
    inputs: Object.entries(def.inputs).map(([iname, schema]) => ({
      name: iname,
      required: schema.required === true,
    })),
  }));
  return { action: "list", items };
}
```

**Key aspects**:
- The action union is mirrored in both TypeScript and JSON-schema-like tool parameters.
- `list`, `inputs`, and `run` route through `dispatch`; `status`, `kill`, and `resume` are handled at the extension layer.
- `status` supports list mode and detail mode via `id`.
- `kill` supports a `--all` sentinel through `name`.

### Pattern 5: Workflow definition builder and registry/discovery package shapes
**Found in**: `src/workflows/define-workflow.ts:29-123`, `src/workflows/registry.ts:14-91`, `src/extension/discovery.ts:31-109`, `src/extension/discovery.ts:329-415`
**Used for**: Packaged workflow definitions compiled to a sentinel-bearing object and discovered from bundled/local/global/config sources.

```ts
export default defineWorkflow("deep-research-codebase")
  .description("Scout → per-partition specialists → aggregator (parallel fan-out)")
  .input("prompt", { type: "text", required: true })
  .input("max_partitions", { type: "number", default: 4 })
  .run(async (ctx) => {
    const scout = ctx.stage("scout");
    const findings = await scout.prompt(`Scout: ${ctx.inputs.prompt}`);
    return { findings };
  })
  .compile();
```

```ts
const definition: WorkflowDefinition<TInputs> = {
  __piWorkflow: true,
  name: state.name,
  normalizedName,
  description: state.description,
  inputs: frozenInputs,
  run: state.runFn,
};
```

**Key aspects**:
- Definitions carry a `__piWorkflow: true` sentinel, authored name, normalized registry key, description, input schema map, and run function.
- Registry operations include `register`, `upsert`, `merge`, `get`, `has`, `remove`, `names`, and `all`.
- Discovery supports bundled, project-local, user-global, settings-project, and settings-global sources.
- Discovery validates exported workflow definitions before registering them.

### Pattern 6: Chain/parallel/DAG execution primitives
**Found in**: `src/shared/types.ts:151-243`, `src/runs/foreground/executor.ts:134-218`, `src/runs/foreground/executor.ts:758-793`, `workflows/deep-research-codebase.ts:25-73`, `workflows/open-claude-design.ts:41-119`
**Used for**: Workflow run contexts with `stage`, `task`, `chain`, `parallel`, and implicit DAG inference from stage method calls.

```ts
export interface WorkflowRunContext<TInputs extends Record<string, unknown> = Record<string, unknown>> {
  readonly inputs: TInputs;
  stage(name: string, options?: StageOptions): StageContext;
  task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
  chain(steps: readonly WorkflowTaskStep[], options?: WorkflowChainOptions): Promise<WorkflowTaskResult[]>;
  parallel(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): Promise<WorkflowTaskResult[]>;
  readonly ui: WorkflowUIContext;
}
```

```ts
async chain(steps: readonly WorkflowTaskStep[], options: WorkflowChainOptions = {}): Promise<WorkflowTaskResult[]> {
  const results: WorkflowTaskResult[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const explicitPrevious = taskPrevious(step);
    const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
    const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
    results.push(await ctx.task(step.name, taskOptionsFromStep(step, prompt, previous)));
  }
  return results;
}

async parallel(steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> {
  const fallback = parallelFallbackTask(steps, options);
  return Promise.all(
    steps.map((step) => {
      const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback);
      return ctx.task(step.name, taskOptionsFromStep(step, prompt, taskPrevious(step)));
    }),
  );
}
```

```ts
const specialistResults = await Promise.all(
  partitions.map(async (partitionName, i) => {
    const specialist = ctx.stage(`specialist-${i + 1}`);
    return specialist.prompt(`You are a specialist agent... Partition: ${partitionName}`);
  }),
);
```

**Key aspects**:
- Stage creation is synchronous; work starts when `prompt`, `complete`, or `subagent` is awaited.
- `chain` passes prior task output via `{previous}` / context handoff semantics.
- `parallel` uses `Promise.all` over task/stage operations.
- Built-in workflows show sequential pipelines and parallel fan-out/fan-in.

### Pattern 7: Subagent tool-call adapter shape
**Found in**: `src/shared/types.ts:91-106`, `src/extension/wiring.ts:213-239`, `test/unit/executor-subagent-call-shape.test.ts:1-124`
**Used for**: Mapping workflow stage `subagent` calls to pi-subagents-compatible tool parameters.

```ts
export interface SubagentStageOpts {
  agent: string;
  task: string;
  context?: "fresh" | "fork";
}
```

```ts
subagent(opts: SubagentStageOpts, _meta?: StageExecutionMeta): Promise<string> {
  const args: Record<string, unknown> = {
    agent: opts.agent,
    task: opts.task,
  };
  if (opts.context !== undefined) args["context"] = opts.context;
  return pi.callTool!("subagent", args);
}
```

```ts
await ctx.stage("scout").subagent({ agent: "reviewer", task: "audit auth" });
assert.equal(calls[0]!.name, "subagent");
assert.equal(args["agent"], "reviewer");
assert.equal(args["task"], "audit auth");
assert.equal(Object.prototype.hasOwnProperty.call(args, "action"), false);
```

**Key aspects**:
- The stage-level API accepts `agent`, `task`, and optional `context` (`fresh` or `fork`).
- The runtime adapter calls the host `callTool("subagent", args)`.
- Tests assert that execution payloads omit `action` and `env`.
- Parallel subagent stage tests assert separate tool calls for each stage.

### Pattern 8: Docs/tests around workflow API shapes
**Found in**: `test/unit/define-workflow.test.ts:5-48`, `test/unit/dispatcher.test.ts:54-154`, `test/unit/executor-subagent-call-shape.test.ts:29-124`, `test/unit/registry.test.ts`, `test/unit/discovery.test.ts`, `research/docs/2026-02-25-skills-directory-structure.md`, `specs/2026-02-09-skills.md`
**Used for**: Unit-level examples of builder, dispatcher, registry/discovery, and subagent call contracts.

```ts
const def = defineWorkflow("my-workflow")
  .description("test workflow")
  .input("prompt", { type: "text", required: true, description: "task" })
  .run(async (ctx) => {
    const result = await ctx.stage("step1").prompt(ctx.inputs.prompt as string);
    return { result };
  })
  .compile();

assert.equal(def.__piWorkflow, true);
assert.equal(def.name, "my-workflow");
assert.deepEqual(def.inputs["prompt"], { type: "text", required: true, description: "task" });
```

```ts
const result = await dispatch({ action: "list" }, { registry });
assert.equal(result.action, "list");
if (result.action === "list") {
  assert.ok(result.items.some((i) => i.name === "alpha"));
}
```

**Key aspects**:
- Builder tests cover sentinel output, input accumulation, frozen definitions, and compile-time sequencing.
- Dispatcher tests cover `list`, `inputs`, background `run`, and structured not-found/validation results.
- Subagent tests document the pi-subagents-compatible call shape in assertions.
- Research/spec docs in `research/docs/` and `specs/` preserve historical notes on skills and workflow loading.
