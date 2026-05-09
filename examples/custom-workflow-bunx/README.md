# custom-workflow-bunx

Canonical example of a custom atomic workflow distributed via `bunx`.
Registers a single Claude workflow, `explain-file`, that takes a path
input and opens a Claude pane that walks through the file.

## Run

This example is invoked **by atomic**, not directly. Add an entry to
your `settings.json`:

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

Then refresh and invoke:

```bash
atomic workflow refresh
atomic workflow -n explain-file -a claude --path src/cli.ts
```

On startup atomic spawns `bunx @example/custom-workflow-bunx
_emit-workflow-meta --dispatch-token=…` to discover the workflow. The
invocation above spawns `bunx @example/custom-workflow-bunx _atomic-run
--dispatch-token=… --name explain-file --agent claude --path src/cli.ts`.

## What's here

- `index.ts` — the workflow definition. The trailing
  `await hostLocalWorkflows([wf])` is what makes the file responsive to
  atomic's two token-gated sub-commands (`_emit-workflow-meta` and
  `_atomic-run`).
- `package.json` — declares this directory as a self-contained Bun
  package with its own `@bastani/atomic-sdk` and provider SDK deps.

## Run standalone

`hostLocalWorkflows([wf])` only handles atomic's two internal
sub-commands; it intentionally stays out of your CLI surface.
`bun run ./index.ts` with no flags returns silently — that's expected.

If you want this file to also work as a directly-invokable CLI, add a
Commander tree (or any argv parser) AFTER `hostLocalWorkflows` and call
`runWorkflow` yourself:

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

The two paths don't interfere: atomic's sub-commands are token-gated
and `process.exit` before your parser runs.

---

**Starting fresh?** For a workflow registered with atomic, run
`bun create @bastani/atomic-cli my-workflow --template=atomic-workflow`
— it scaffolds this exact shape (a self-contained Bun package + a
merged `settings.json` entry) for you. This directory is a checked-in
reference; the scaffold is the recommended starting point.
