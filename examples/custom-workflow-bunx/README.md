# custom-workflow-bunx

Canonical example of a custom atomic workflow distributed via `bunx`.

## Setup

Add the binary to your atomic settings:

```json
{
  "workflows": {
    "deploy": {
      "command": "bunx",
      "args": ["@example/custom-workflow-bunx"],
      "agents": ["claude"]
    }
  }
}
```

On startup atomic spawns `bunx @example/custom-workflow-bunx _emit-workflow-meta --dispatch-token=…` to discover the workflow. Running `atomic workflow -n deploy -a claude` spawns `bunx @example/custom-workflow-bunx _atomic-run --dispatch-token=… --name deploy --agent claude`.

See `index.ts` for the one-line `hostWorkflows([wf])` boilerplate that makes this work. Read `docs/atomic-sdk/host-workflows.md` for the full reference.

## Run standalone

```sh
bun run ./index.ts
```

The `hostWorkflows([wf])` returns silently when not invoked under atomic, so your CLI's main() runs normally.
