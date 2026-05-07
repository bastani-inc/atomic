# hostLocalWorkflows

`hostLocalWorkflows` is the explicit handoff that makes your CLI atomic-dispatchable. It registers the supplied workflows so atomic can resolve them and responds to atomic's two internal sub-commands when atomic spawns this CLI as a subprocess. **Anything else returns silently** — your own CLI surface is yours to shape however you want.

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

1. Registers the supplied `workflows` into a process-local registry keyed by `(agent, name)`. The orchestrator pane atomic spawns later re-imports the file and uses this registry to resolve the definition — no `export default` required.
2. Inspects `argv` for `_emit-workflow-meta` / `_atomic-run` and validates the dispatch token (`ATOMIC_HOST=1` env + `--dispatch-token=<hex>` argv must match `ATOMIC_DISPATCH_TOKEN` env). When matched:
   - `_emit-workflow-meta`: writes `ATOMIC_WORKFLOW_META: <json>\n` to stdout, exits 0.
   - `_atomic-run`: parses `--name <X> --agent <Y> [--detach] [--<input> <v>]…`, runs via `runWorkflow`, exits 0 on success / 1 on error.
3. Otherwise — including bare invocation, the consumer's own commander flags, attempts to hijack the meta channel from a user terminal without `ATOMIC_HOST=1`, and the orchestrator pane's re-import — returns silently. Your own argv parser stays in control.

## Composing with your own CLI

`hostLocalWorkflows` deliberately stays out of your CLI surface. To expose your workflow as a directly-invokable CLI, set up commander (or any argv parser) AFTER `hostLocalWorkflows` and call `runWorkflow` yourself:

```ts
import { Command } from "@commander-js/extra-typings";
import { defineWorkflow, hostLocalWorkflows, runWorkflow } from "@bastani/atomic-sdk";

const wf = defineWorkflow({ … }).for("claude").run(…).compile();

// Atomic dispatch — exits here when atomic spawns us with `_atomic-run`.
await hostLocalWorkflows([wf]);

// Your own CLI. Whatever shape you want.
const program = new Command();
program
  .option("--path <path>", "file to explain")
  .action(async (opts) => {
    await runWorkflow({ workflow: wf, inputs: opts });
  });
await program.parseAsync();
```

The two paths don't interfere: atomic's sub-commands are token-gated and `process.exit` before your parser runs.

## See also

- Settings schema and full custom-workflow guide: [`docs/settings/custom-workflows.md`](../settings/custom-workflows.md).
