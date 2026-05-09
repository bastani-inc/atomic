# headless-test

Visible seed → 3 parallel headless stages → visible merge → headless
verdict. Demonstrates mixing visible (tmux pane) and headless (no pane)
stages in one workflow.

## Run

```bash
bun install
bun run claude-worker.ts   --prompt="TypeScript"
bun run copilot-worker.ts  --prompt="TypeScript"
bun run opencode-worker.ts --prompt="TypeScript"
```

## What's here

- `claude/`, `copilot/`, `opencode/` — workflow definitions per agent.
- `<agent>-worker.ts` — Commander entrypoint.

Headless stages still appear as graph nodes in the orchestrator panel —
they just don't grab a tmux window. Useful for parallelism without UI
clutter.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of mixing visible and
headless stages, not a starter template.
