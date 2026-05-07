# hostWorkflows

`hostWorkflows` is the explicit handoff point that lets atomic discover and dispatch your custom workflows from the third-party CLI. Call it once after `defineWorkflow({...}).compile()`, and `export default` the compiled workflow alongside the call — the orchestrator pane that atomic spawns later re-imports the same file and reads `mod.default` to resolve the workflow definition.

## Why explicit?

ESM evaluation is depth-first: a dependency module's body runs **before** its importer's body. If the SDK ran the meta-emit / dispatch handler at module load (top-level `await`), it would execute before the user CLI's `defineWorkflow().compile()` line — draining an empty registry and `process.exit(0)`-ing the user's main(). Explicit `hostWorkflows([wf])` after `compile()` removes that race.

The `_orchestrator-entry` and `_cc-debounce` subs continue to dispatch at module load — they don't depend on user-registered state.

## Usage

```ts
#!/usr/bin/env bun
import { defineWorkflow, hostWorkflows } from "@bastani/atomic-sdk";

const wf = defineWorkflow({
  name: "explain-file",
  description: "Open a Claude pane that walks through a file",
  source: import.meta.path,
  inputs: [
    { name: "path", type: "text", required: true, description: "file to explain" },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage({ name: "explain" }, {}, {}, async (s) => {
      await s.session.query(`Read ${ctx.inputs.path} and walk me through it.`);
      s.save(s.sessionId);
    });
  })
  .compile();

// Required: the orchestrator pane re-imports this file and reads `mod.default`.
export default wf;

await hostWorkflows([wf]);

// Your CLI's main() continues here when not invoked by atomic.
```

Register the binary in your atomic settings:

```json
{
  "workflows": {
    "explain-file": {
      "command": "bunx",
      "args": ["@example/my-workflows"],
      "agents": ["claude"]
    }
  }
}
```

## API

```ts
export interface HostWorkflowsOptions {
  argv?: readonly string[]; // defaults to process.argv
  env?: Record<string, string | undefined>; // defaults to process.env
}

export async function hostWorkflows(
  workflows: readonly WorkflowDefinition[],
  options?: HostWorkflowsOptions,
): Promise<void>;
```

## Behavior

`hostWorkflows`:

1. Inspects `argv` for `_emit-workflow-meta` or `_atomic-run`. Neither present → returns immediately.
2. Validates the dispatch token (`ATOMIC_HOST=1` env + `--dispatch-token=<hex>` argv must match `ATOMIC_DISPATCH_TOKEN` env). Mismatch → returns silently. **Direct invocations like `bunx my-pkg _emit-workflow-meta` from a user terminal will run your CLI's main() normally — they will not emit the meta line.**
3. `_emit-workflow-meta`: serializes the supplied `workflows` to JSON, writes one line `ATOMIC_WORKFLOW_META: <json>\n` to stdout, exits 0.
4. `_atomic-run`: parses `--name <X> --agent <Y> [--detach] [--<input> <v>]…`, looks up `(name, agent)` in `workflows`, runs it via `runWorkflow`, exits 0 on success / 1 on missing match or error.

## See also

- Settings schema and full custom-workflow guide: [`docs/settings/custom-workflows.md`](../settings/custom-workflows.md).
