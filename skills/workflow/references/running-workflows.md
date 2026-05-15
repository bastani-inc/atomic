# Running and Inspecting Pi Workflows

Use this when the user asks to run, start, kick off, monitor, interrupt, resume, attach to, or inspect a workflow.

## Discover first

For named workflows, do not guess the schema:

```ts
workflow({ action: "list" })
workflow({ action: "inputs", workflow: "<name>" })
```

If required inputs are missing and cannot be inferred, ask the user with `ask_user_question` or a concise free-form question.

## Run

```ts
workflow({ workflow: "deep-research-codebase", inputs: { prompt: "map workflow dispatch" } })
```

Slash equivalent:

```text
/workflow deep-research-codebase prompt="map workflow dispatch"
```

Named workflow dispatch is background-oriented: expect a run id and then monitor status.

## Direct runs

Use direct workflow-native orchestration for one-off tracked work:

```ts
workflow({
  task: { name: "review", task: "Review this patch for API risks." },
  async: true,
  intercom: { delivery: "result" }
})
```

Parallel:

```ts
workflow({
  tasks: [
    { name: "docs", task: "Review documentation gaps" },
    { name: "risks", task: "Review operational risks" }
  ],
  concurrency: 2,
  outputMode: "file-only"
})
```

Chain:

```ts
workflow({
  task: "Design the workflow SDK migration",
  chain: [
    { name: "research", task: "Research {task}" },
    { name: "plan", task: "Plan from {previous}" }
  ]
})
```

## Monitor/control

```ts
workflow({ action: "status" })
workflow({ action: "status", runId: "<id>" })
workflow({ action: "interrupt", runId: "<id>" })
workflow({ action: "resume", runId: "<id>" })
workflow({ action: "doctor" })
```

Slash equivalents:

```text
/workflow status --all
/workflow status <id>
/workflow interrupt <id>
/workflow resume <id>
/workflows-doctor
```

When a run needs user input or attention, surface that to the user instead of polling silently.

## Intercom

For async direct runs, request result delivery when available:

```ts
workflow({
  tasks: [{ name: "reviewer", task: "Review the patch" }],
  async: true,
  intercom: { delivery: "result" }
})
```

Treat intercom payloads as user-visible workflow output.

## Common mistakes

- Do not fabricate workflow names; list first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy tool fields like `agent`, `stage`, or run-control `name`.
- Prefer `outputMode: "file-only"` for large fan-outs.
- Use status/resume controls for run lifecycle; inspect workflow output and artifacts for behavior.
