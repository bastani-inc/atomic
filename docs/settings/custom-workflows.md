# Custom Workflows

Custom workflows extend atomic with workflows defined in external CLIs. Declare them in `.atomic/settings.json` (project-local) or `~/.atomic/settings.json` (user-global) using a `workflows` map where each key is an alias and each value has `{ command, args?, agents }` — the same shape as an MCP server entry. Custom workflows appear alongside builtins in `atomic workflow list`, `WorkflowPickerPanel`, and `atomic workflow inputs`.

## Settings shape

The `workflows` map in `settings.json` takes arbitrary string aliases as keys. Each value must have `command` and `agents`; `args` is optional.

```jsonc
// .atomic/settings.json  (or ~/.atomic/settings.json)
{
  "workflows": {
    "deploy": {
      "command": "bunx",
      "args": ["@me/deploy-workflows"],
      "agents": ["claude"]
    },
    "review": {
      "command": "bunx",
      "args": ["@me/review-workflows", "--profile", "strict"],
      "agents": ["claude", "opencode"]
    },
    "scaffold": {
      "command": "/usr/local/bin/my-scaffold-cli",
      "agents": ["copilot"]
    }
  }
}
```

- `command` — executable to spawn (e.g. `bunx`, `node`, absolute path).
- `args` — static arguments prepended before atomic's hidden subcommands. Defaults to `[]`.
- `agents` — required; one or more of `"claude" | "opencode" | "copilot"`. Atomic registers one entry per agent listed.

## The hostWorkflows contract

> **Required:** The CLI you point `command` at MUST call `await hostWorkflows([wf])` once after `defineWorkflow(...).compile()`. Atomic dispatches custom workflows by re-spawning that CLI with hidden `_emit-workflow-meta` and `_atomic-run` subcommands; `hostWorkflows()` is the helper that responds to them. The same call also registers the workflows into a process-local registry so the orchestrator pane that atomic spawns later can resolve them without you needing to also `export default` the compiled workflow.

Canonical pattern (from [`examples/custom-workflow-bunx/index.ts`](../../examples/custom-workflow-bunx/index.ts)):

```ts
#!/usr/bin/env bun
import { defineWorkflow, hostWorkflows } from "@bastani/atomic-sdk";

const explainFile = defineWorkflow({
  name: "explain-file",
  description: "Open a Claude pane that walks through a file",
  source: import.meta.path,
  inputs: [
    {
      name: "path",
      type: "text",
      required: true,
      description: "absolute or relative path to the file to explain",
    },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage(
      { name: "explain", description: "Read the file and walk through it" },
      {},
      {},
      async (s) => {
        await s.session.query(
          `Read ${ctx.inputs.path} and walk me through what it does. ` +
            `Highlight any non-obvious behaviour or invariants. Keep it under 10 short sentences.`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();

await hostWorkflows([explainFile]);

// Your CLI's main() continues here if not invoked by atomic.
```

**Why explicit?** ESM evaluation is depth-first: a dependency module's body runs before its importer's body. If the SDK handled dispatch at module load, it would drain an empty registry before the consumer's `.compile()` line ran. The explicit `await hostWorkflows([wf])` call after `.compile()` sidesteps that ordering constraint entirely.

## Precedence

Project-local `.atomic/settings.json` > user-global `~/.atomic/settings.json` > builtin registry. When a custom workflow overrides a prior entry, atomic writes an audit line to stderr:

```
[atomic/workflows] override: <name>/<agent> (<origin>) > <prior.kind>
```

where `<origin>` is `local` or `global` and `<prior.kind>` is `external` or `builtin`.

## Broken entries

When an entry fails to load — schema error, missing binary, timeout, missing meta line, malformed JSON, etc. — it is tracked as a non-dispatchable broken entry. Three surfaces:

- **`WorkflowPickerPanel`** — renders the entry as a `picker-row-broken` row; pressing Enter flashes the reason on the statusline instead of launching the workflow.
- **`atomic workflow list`** — lists the entry under a trailing "skipped" section with the reason.
- **`atomic workflow -n <broken> -a <agent>`** — exits with code 2 and prints a `reason / source / fix` block to stderr.

## Troubleshooting

| Diagnostic | Fix |
|---|---|
| `"<alias>": metadata emission timed out after <N>ms — ensure the third-party CLI invokes hostWorkflows([…]) after compile()` | Add `await hostWorkflows([wf])` after `.compile()` in the CLI pointed to by `command`. |
| `"<alias>": expected ATOMIC_WORKFLOW_META line — the third-party CLI may be missing the 'await hostWorkflows([wf])' call after compile() (or it is not importing @bastani/atomic-sdk)` | Add `await hostWorkflows([wf])` after `.compile()` and confirm the package imports `@bastani/atomic-sdk`. |
| `"<alias>": command "<cmd>" not found on PATH` | Install the package or use an absolute path in `command`. |
| `"<alias>/<agent>": command did not register a workflow for agent "<agent>"` | Add a `.for("<agent>")` branch in the CLI's `defineWorkflow` call. |

## Reference

- Working example: [`examples/custom-workflow-bunx/`](../../examples/custom-workflow-bunx/) — minimal `bunx`-friendly package that registers a single workflow.
- SDK helper: [`hostWorkflows`](../atomic-sdk/host-workflows.md).
- Schema: [`assets/settings.schema.json`](../../assets/settings.schema.json).
