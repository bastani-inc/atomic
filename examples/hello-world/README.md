# hello-world

Minimal single-session workflow with structured inputs (`greeting`,
`style`, optional `notes`). The simplest possible shape for a workflow
worker — one stage, one agent turn, runs across all three agents.

## Run

```bash
bun install
bun run claude-worker.ts   --greeting="Hello" --style=casual
bun run copilot-worker.ts  --greeting="Hello" --style=casual
bun run opencode-worker.ts --greeting="Hello" --style=casual
```

## What's here

- `claude/`, `copilot/`, `opencode/` — one workflow definition per agent.
- `<agent>-worker.ts` — Commander entrypoint that mounts the workflow's
  declared inputs as `--<flag>` options and calls `runWorkflow`.
- `package.json` — workspace deps for `@bastani/atomic-sdk` plus each
  agent's provider SDK.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of the minimum workflow
shape, not a starter template.
