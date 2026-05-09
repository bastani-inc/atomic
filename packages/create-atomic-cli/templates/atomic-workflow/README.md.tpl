# {{name}}

Atomic-managed workflow. {{description}}

## Run

```bash
atomic workflow refresh                        # confirm atomic loaded it
atomic workflow -n {{name}} -a {{agent}} --prompt "your prompt here"
```

## Files

- `index.ts` — the workflow definition (`defineWorkflow → for → run → compile`).
- `package.json` — declares this directory as a self-contained Bun package
  with its own `@bastani/atomic-sdk` and provider SDK dependencies.

## Where this is registered

This workflow's registry entry lives in **{{settingsPathLabel}}** under
the `workflows` key. The atomic CLI re-reads that file on
`atomic workflow refresh` and on every `atomic workflow -n` invocation.

If you move or rename this directory, update the entry's `args` path in
`{{settingsPathLabel}}` to match.
