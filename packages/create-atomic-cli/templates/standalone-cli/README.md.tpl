# {{name}}

Third-party CLI built on `@bastani/atomic-sdk`, distributed as a single
self-contained binary.

## Run from source

```bash
bun install
bun run mycli.ts hello --prompt "say hi"
bun run mycli.ts --help
```

## Build the binary

```bash
bun run build
./dist/{{name}} hello --prompt "say hi"
```

The output `./dist/{{name}}` is ~100 MB and includes the bun runtime —
your users don't need to install bun, node, or atomic.

## What's here

- `mycli.ts` — the CLI entry. Commander tree wired up to `runWorkflow`.
- `workflows/hello.ts` — sample workflow definition. Statically imported
  in `mycli.ts`, so it's bundled into the binary.
- `build.ts` — `bun build --compile` for the current platform.

## Adding workflows

1. Create a new file under `workflows/`.
2. `export default defineWorkflow({ … }).for(<agent>).run(…).compile();`
3. Import it in `mycli.ts`, register a Commander subcommand, call
   `runWorkflow({ workflow, inputs })` in the action.

If your workflow imports third-party packages your binary doesn't
otherwise carry, see [`disk-resident-workflows.md`](https://github.com/flora131/atomic/blob/main/packages/atomic-sdk/docs/disk-resident-workflows.md)
for the alternative shape (workflows shipped as `.mjs` capsules
alongside the binary).
