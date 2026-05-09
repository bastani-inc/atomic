# commander-embed

Mount an atomic workflow under a parent Commander CLI by calling
`runWorkflow({ workflow, inputs })` inside a Commander action — alongside
a plain Commander sibling command. No re-entry boilerplate: the SDK
ships its own orchestrator entry script.

## Run

```bash
bun install
bun run cli.ts greet --who=Alex
bun run cli.ts status                # plain Commander sibling
bun run cli.ts --help                # all commands
```

## What's here

- `claude/` — the embedded workflow.
- `cli.ts` — parent Commander tree with `greet` (workflow) and `status`
  (plain Commander command, no atomic involvement).

## Compiled-binary distribution

`bun build --compile` works without any boilerplate. The SDK
auto-defaults `pathToAtomicExecutable` to `process.execPath` in
compiled-binary hosts, and the `@bastani/atomic-sdk/workflows` barrel
installs an argv handler at module-load time so the spawned
`_orchestrator-entry` self-dispatches before Commander parses argv.

For the canonical compile-and-ship shape (mycli + workflows + build
script in one project), see [`../compiled-cli/`](../compiled-cli) — a
snapshot of the `bun create @bastani/atomic-cli --template=standalone-cli`
output.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of embedding a single
workflow under a parent Commander tree, not a starter template.
