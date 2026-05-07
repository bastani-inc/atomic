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

See `index.ts` for the `defineWorkflow → compile → hostWorkflows([wf])` pattern. Read `docs/atomic-sdk/host-workflows.md` for the full reference.

## Run standalone

```sh
bun run ./index.ts
```

`hostWorkflows([wf])` returns silently when not invoked under atomic, so your CLI's main() runs normally.
