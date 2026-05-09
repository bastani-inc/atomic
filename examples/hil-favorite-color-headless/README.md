# hil-favorite-color-headless

HIL pause inside a **headless** stage — the agent escalates from no-pane
mode into an interactive prompt only when it needs human input.

## Run

```bash
bun install
bun run claude-worker.ts
bun run copilot-worker.ts
bun run opencode-worker.ts
```

## What's here

- `claude/`, `copilot/`, `opencode/` — workflow definitions per agent.
- `<agent>-worker.ts` — Commander entrypoint.

Compare with [`../hil-favorite-color/`](../hil-favorite-color) — same
flow, but the question is asked from a stage that ran headless until
the prompt arrived.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of HIL escalation from a
headless stage, not a starter template.
