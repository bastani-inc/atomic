# hostLocalWorkflows

`hostLocalWorkflows` is the single entry point that lets your CLI act as both an atomic-dispatchable workflow host AND a standalone CLI runner. Call it once after `defineWorkflow({...}).compile()` and it:

1. Handles atomic's `_emit-workflow-meta` and `_atomic-run` sub-commands when token-gated.
2. Handles direct CLI invocation — `bun run my-cli.ts --name <X> [--agent <Y>] [--<input> <v>]…` runs the workflow without atomic in the loop.
3. Registers the supplied workflows into a process-local registry so the orchestrator pane that atomic spawns later can resolve them by `(name, agent)` — no `export default` boilerplate required.

## Why explicit?

ESM evaluation is depth-first: a dependency module's body runs **before** its importer's body. If the SDK ran the meta-emit / dispatch handler at module load (top-level `await`), it would execute before the user CLI's `defineWorkflow().compile()` line — draining an empty registry and `process.exit(0)`-ing the user's main(). Explicit `hostLocalWorkflows([wf])` after `compile()` removes that race.

The `_orchestrator-entry` and `_cc-debounce` subs continue to dispatch at module load — they don't depend on user-registered state.

## Usage

```ts
#!/usr/bin/env bun
import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

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

await hostLocalWorkflows([wf]);

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
export interface HostLocalWorkflowsOptions {
  argv?: readonly string[]; // defaults to process.argv
  env?: Record<string, string | undefined>; // defaults to process.env
}

export async function hostLocalWorkflows(
  workflows: readonly WorkflowDefinition[],
  options?: HostLocalWorkflowsOptions,
): Promise<void>;
```

## Behavior

`hostLocalWorkflows`:

1. Registers the supplied `workflows` into a process-local registry keyed by `(agent, name)`. This always happens, even when `argv` carries no recognised sub-command — the orchestrator pane spawned by `_atomic-run` later re-imports the same file and uses this registry to resolve the definition without requiring an `export default`.
2. Inspects `argv` for `_emit-workflow-meta` or `_atomic-run` (atomic dispatch) and validates the dispatch token (`ATOMIC_HOST=1` env + `--dispatch-token=<hex>` argv must match `ATOMIC_DISPATCH_TOKEN` env). When matched:
   - `_emit-workflow-meta`: serializes the supplied `workflows` to JSON, writes one line `ATOMIC_WORKFLOW_META: <json>\n` to stdout, exits 0.
   - `_atomic-run`: parses `--name <X> --agent <Y> [--detach] [--<input> <v>]…`, looks up `(name, agent)` in `workflows`, runs it via `runWorkflow`, exits 0 on success / 1 on missing match or error.
3. **Direct CLI mode** — when no dispatch sub-command matches but `argv` carries `--name <X>` (no token required), runs the workflow via `runWorkflow` so consumers can invoke their CLI as a standalone tool: `bun run my-cli.ts --name <X> [--agent <Y>] [--<input> <v>]… [--detach]`. `--agent` is optional when exactly one workflow matches the name.
4. Otherwise — returns silently so your CLI's main() can continue. **Direct invocations like `bunx my-pkg _emit-workflow-meta` from a user terminal without `ATOMIC_HOST=1` will run your CLI's main() normally — they will not emit the meta line.**

## See also

- Settings schema and full custom-workflow guide: [`docs/settings/custom-workflows.md`](../settings/custom-workflows.md).
