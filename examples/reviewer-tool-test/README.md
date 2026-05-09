# reviewer-tool-test

Custom reviewer tool wiring on the Copilot SDK — defines a Zod-validated
`defineTool` and exposes it inside a stage as the only allowed tool.

> Copilot only — Claude and OpenCode have their own tool-definition
> shapes covered elsewhere.

## Run

```bash
bun install
bun run copilot-worker.ts
```

## What's here

- `copilot/` — workflow that registers the reviewer tool.
- `copilot-worker.ts` — Commander entrypoint.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of Copilot tool registration,
not a starter template.
