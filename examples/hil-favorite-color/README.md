# hil-favorite-color

Human-in-the-loop prompt mid-workflow — the agent pauses to ask the user
a question, then continues with the answer.

## Run

```bash
bun install
bun run claude-worker.ts
bun run copilot-worker.ts
bun run opencode-worker.ts
```

The workflow asks for your favorite color in an interactive tmux pane,
then prints a message that uses your answer. Attach to the session if
it doesn't already have focus.

## What's here

- `claude/`, `copilot/`, `opencode/` — workflow definitions per agent.
- `<agent>-worker.ts` — Commander entrypoint.

Compare with [`../hil-favorite-color-headless/`](../hil-favorite-color-headless)
for the same flow but where the question is asked from an
otherwise-headless stage.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of mid-workflow HIL prompts,
not a starter template.
