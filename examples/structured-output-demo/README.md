# structured-output-demo

Per-SDK structured output — each agent's native schema-enforced response
path (JSON schema for Claude / OpenCode, custom Zod-validated tool for
Copilot) producing the same typed object.

## Run

```bash
bun install
bun run claude-worker.ts   --prompt=Python
bun run copilot-worker.ts  --prompt=Python
bun run opencode-worker.ts --prompt=Python
```

## What's here

- `claude/`, `copilot/`, `opencode/` — per-agent structured-output workflow.
- `helpers/schema.ts` — shared Zod schema, prompt builder, and logger.
- `<agent>-worker.ts` — Commander entrypoint.

Read each `<agent>/index.ts` to see how the same Zod schema lands in
three different SDK shapes — JSON Schema for Claude/OpenCode,
`defineTool` with Zod for Copilot.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of cross-agent structured
output, not a starter template.
