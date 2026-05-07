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

`hostLocalWorkflows([wf])` doubles as a CLI runner. Pass `--name <workflow>` (and optional `--agent <agent>` when the same name is registered for multiple agents) along with any inputs:

```sh
# Foreground (attaches to the orchestrator pane in tmux)
bun run ./index.ts --name explain-file --path src/cli.ts

# Background (`--detach` returns immediately)
bun run ./index.ts --name explain-file --agent claude --path src/cli.ts --detach
```

Bare `bun run ./index.ts` (no flags) returns silently so your own `main()` can take over if you've added one.
