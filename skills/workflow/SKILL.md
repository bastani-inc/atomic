---
name: workflow
description: Use pi workflows for named multi-stage workflows or workflow-native direct task, parallel, and chain orchestration.
---

# Workflow Skill

Use `workflow` when the work benefits from tracked stages, resumable run state, workflow widgets, or reusable workflow definitions. Use `subagent` for ad hoc agent delegation when you do not need workflow run state or workflow-specific UI.

## Named Workflows

Inspect available definitions before running an unfamiliar workflow:

```ts
workflow({ action: "list" })
workflow({ action: "inputs", workflow: "deep-research-codebase" })
workflow({ workflow: "deep-research-codebase", inputs: { prompt: "..." } })
```

Use status and resume controls for background runs:

```ts
workflow({ action: "status" })
workflow({ action: "status", runId: "abc123" })
workflow({ action: "interrupt", runId: "abc123" })
workflow({ action: "resume", runId: "abc123" })
```

## Direct Task

Use a single task for focused work that should still produce a workflow run:

```ts
workflow({
  task: {
    name: "reviewer",
    prompt: "Review the auth module and summarize risks.",
    context: "fresh",
    output: "reviews/auth.md"
  }
})
```

Task options follow pi `createAgentSession()` options where supported, plus workflow-owned fields such as `output`, `reads`, `progress`, and `worktree`.

## Parallel Tasks

Use `tasks` for independent work that can fan out:

```ts
workflow({
  tasks: [
    { name: "api-reviewer", task: "Review API surfaces" },
    { name: "runtime-reviewer", task: "Review runtime behavior" }
  ],
  concurrency: 2,
  async: true
})
```

Use `count` to repeat a task item. Prefer `outputMode: "file-only"` for large fan-out results.

## Chains

Use `chain` when later steps depend on earlier outputs:

```ts
workflow({
  chain: [
    { name: "researcher", task: "Research {task}" },
    {
      parallel: [
        { name: "reviewer-a", task: "Review {previous}" },
        { name: "reviewer-b", task: "Find gaps in {previous}" }
      ]
    },
    { name: "planner", task: "Create a plan from {previous}" }
  ],
  task: "workflow SDK parity with pi-subagents"
})
```

Defaults follow pi-subagents-style handoff semantics: the first missing chain task uses `{task}`, later missing chain tasks use `{previous}`, and missing tasks inside chain-parallel groups use `{previous}`.

## Intercom

For async direct parallel or chain runs, prefer result delivery over polling when pi-intercom is available:

```ts
workflow({
  tasks: [{ name: "reviewer", task: "Review the patch" }],
  async: true,
  intercom: { delivery: "result" }
})
```

Control notifications may ask the parent session for attention or a decision. Treat workflow intercom payloads as user-visible run output.

## Safety Rules

- Do not use legacy aliases such as `agent`, `stage`, or run-control `name`.
- Do not expect `create`, `update`, or `delete`; workflow definitions are code-authored.
- Use `/workflow` slash commands for named workflows and diagnostics only.
- Prefer workflow code with `ctx.task`, `ctx.parallel`, and `ctx.chain` for reusable orchestration.
