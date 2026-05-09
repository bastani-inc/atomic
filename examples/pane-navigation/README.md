# pane-navigation

Driver CLI for the SDK's pane-navigation primitives (`nextWindow`,
`previousWindow`, `gotoOrchestrator`, `attachSession`, `detachSession`).
Spawns a 3-stage workflow detached and exposes `start / list / status /
next / prev / home / attach / stop` subcommands. Catches
`SessionNotFoundError` for friendly errors.

## Run

```bash
bun install

# 1. Spawn the workflow detached and capture its session id
bun run cli.ts start --agent claude

# 2. In a second terminal, attach so you can watch window changes live
tmux -L atomic attach -t <session-id>

# 3. Back in the first terminal, drive the navigation primitives
bun run cli.ts list
bun run cli.ts status <session-id>
bun run cli.ts next   <session-id>
bun run cli.ts prev   <session-id>
bun run cli.ts home   <session-id>
bun run cli.ts attach <session-id>
bun run cli.ts stop   <session-id>
```

`--agent` accepts `claude`, `copilot`, or `opencode`.

## What's here

- `claude/`, `copilot/`, `opencode/` — same 3-stage workflow per agent.
- `cli.ts` — Commander driver that wraps the SDK's session primitives.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of pane-navigation
primitives, not a starter template.
