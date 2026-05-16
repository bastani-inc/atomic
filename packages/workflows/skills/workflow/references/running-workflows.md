# Running and Inspecting Pi Workflows

Use this when the user asks to run, start, kick off, monitor, connect to, attach to, pause, interrupt, resume, or inspect a workflow.

## Discover first

For named workflows, do not guess names or schemas:

```ts
workflow({ action: "list" })
workflow({ action: "get", workflow: "<name>" })
workflow({ action: "inputs", workflow: "<name>" })
```

If required inputs are missing and cannot be inferred, ask the user with `ask_user_question` or a concise free-form question.

## Run named workflows

```ts
workflow({
  action: "run",
  workflow: "deep-research-codebase",
  inputs: { prompt: "map workflow dispatch" },
})
```

Slash equivalent:

```text
/workflow deep-research-codebase prompt="map workflow dispatch"
```

Input overrides are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=3`, `flag=true`, and `prompt="multi word value"` preserve useful types. A whole input object can also be passed as one JSON token.

Named workflow dispatch is always background-oriented: expect a run id and then monitor status. Press F2 or use `/workflow connect <run-id>` to attach to the graph viewer. If the TUI is available and required inputs are missing, `/workflow <name>` opens an input picker unless the user passes `--no-picker`.

## Slash command surface

```text
/workflow list
/workflow inputs <name>
/workflow <name> --help
/workflow <name> [key=value ...]
/workflow connect [run-id]
/workflow attach [run-id] [stage-id-or-name]
/workflow pause [run-id] [stage-id-or-name]
/workflow status [run-id]
/workflow status --all
/workflow interrupt <run-id|--all>
/workflow resume <run-id> [stage-id-or-name] [message]
```

Use `connect` for the orchestrator graph. Use `attach` when the user wants to open a chat pane for a specific stage. Use `pause`/`resume` for live paused work; `resume` on a non-paused run reopens the saved snapshot/overlay.

Human-in-the-loop prompts from `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor` surface in the workflow UI/graph viewer, not as ordinary chat modals.

## Direct runs

Use direct workflow-native orchestration for one-off tracked work that does not need a reusable workflow file.

Single tracked task:

```ts
workflow({
  task: { name: "review", task: "Review this patch for API risks." },
  async: true,
  intercom: { delivery: "result" },
})
```

Parallel fan-out:

```ts
workflow({
  tasks: [
    { name: "docs", task: "Review documentation gaps" },
    { name: "risks", task: "Review operational risks" },
  ],
  concurrency: 2,
  outputMode: "file-only",
  async: true,
})
```

Dependent chain:

```ts
workflow({
  task: "Design the workflow SDK migration",
  chain: [
    { name: "research", task: "Research {task}" },
    { name: "plan", task: "Plan from {previous}" },
  ],
  async: true,
})
```

Direct mode supports top-level/default options and per-task options such as `context`, `model`, `fallbackModels`, `thinkingLevel`, `mcp`, `output`, `reads`, `progress`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, and `cwd`. For large fan-outs, prefer `outputMode: "file-only"`.

## Monitor/control with the workflow tool

```ts
workflow({ action: "status" })
workflow({ action: "status", runId: "<id>" })
workflow({ action: "interrupt", runId: "<id>" })
workflow({ action: "interrupt", runId: "--all" })
workflow({ action: "resume", runId: "<id>" })
```

The LLM-callable tool exposes status/interrupt/resume controls. Use slash commands for graph connect, stage attach, and pause because those are interactive TUI surfaces.

When a run needs user input or attention, surface that to the user instead of polling silently.

## Intercom

For async direct runs, request result delivery when available:

```ts
workflow({
  tasks: [{ name: "reviewer", task: "Review the patch" }],
  async: true,
  intercom: { delivery: "result" },
})
```

Treat intercom payloads as user-visible workflow output.

## Common mistakes

- Do not fabricate workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy tool fields like `agent`, `stage`, or run-control `name`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Prefer `outputMode: "file-only"` for large fan-outs.
- Use status/resume controls for run lifecycle; inspect workflow output and artifacts for behavior.
