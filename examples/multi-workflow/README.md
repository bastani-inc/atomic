# multi-workflow

Two Claude workflows (`hello`, `goodbye`) under a single `cli.ts`. Uses
`listWorkflows(registry)` to register one Commander subcommand per
workflow, with each workflow's declared inputs mounted as `--<flag>`
options.

## Run

```bash
bun install
bun run cli.ts hello   --who=Alex
bun run cli.ts goodbye --tone=melodramatic
bun run cli.ts --help
```

## What's here

- `hello/`, `goodbye/` — two independent Claude workflows.
- `cli.ts` — single Commander entrypoint that dispatches by workflow name.

This is the shape to use when one CLI needs to expose multiple
workflows. For the variant where the same dispatcher spans agents
(claude/copilot/opencode), reach for the `-a/--agent` flag — see the
atomic CLI's builtin registry for an example.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of registry-driven
multi-workflow CLIs, not a starter template.
