# custom-workflow-bunx

Canonical example of a custom atomic workflow distributed via `bunx`. Registers a single Claude workflow, `explain-file`, that takes a path input and opens a Claude pane that walks through the file.

## Setup

Add the binary to your atomic settings:

```json
{
  "workflows": {
    "explain-file": {
      "command": "bunx",
      "args": ["@example/custom-workflow-bunx"],
      "agents": ["claude"]
    }
  }
}
```

On startup atomic spawns `bunx @example/custom-workflow-bunx _emit-workflow-meta --dispatch-token=…` to discover the workflow. Running `atomic workflow -n explain-file -a claude --path src/cli.ts` spawns `bunx @example/custom-workflow-bunx _atomic-run --dispatch-token=… --name explain-file --agent claude --path src/cli.ts`.

See `index.ts` for the `defineWorkflow → compile → hostLocalWorkflows([wf])` pattern. Read `docs/atomic-sdk/host-local-workflows.md` for the full reference.

## Run standalone

`hostLocalWorkflows([wf])` only handles atomic's two internal sub-commands (`_emit-workflow-meta` and `_atomic-run`); it intentionally stays out of your CLI surface. `bun run ./index.ts` with no flags returns silently — that's expected.

If you want this file to also work as a directly-invokable CLI, add your own commander setup (or any argv parser) AFTER `hostLocalWorkflows` and call `runWorkflow` yourself:

```ts
import { Command } from "@commander-js/extra-typings";
import { defineWorkflow, hostLocalWorkflows, runWorkflow } from "@bastani/atomic-sdk";

const explainFile = defineWorkflow({ … }).for("claude").run(…).compile();

// Atomic dispatch — exits here when atomic spawns us with `_atomic-run`.
await hostLocalWorkflows([explainFile]);

// Your own CLI. Whatever shape you want.
const program = new Command();
program
  .option("--path <path>", "file to explain")
  .action(async (opts) => {
    await runWorkflow({ workflow: explainFile, inputs: opts });
  });
await program.parseAsync();
```

The two paths don't interfere: atomic's sub-commands are token-gated and `process.exit` before your parser runs.
