# sequential-describe-summarize

Two stages passing data via `s.save()` → `s.transcript(handle)` — the
canonical handoff pattern between sessions. Stage 1 describes the topic
and saves its session id; stage 2 reads stage 1's transcript path and
summarizes it.

## Run

```bash
bun install
bun run claude-worker.ts --topic="Bun"
```

## What's here

- `claude/` — the two-stage workflow definition.
- `claude-worker.ts` — Commander entrypoint.

The handle returned by `ctx.stage(...)` is how downstream stages address
upstream output. Stage 2 reads stage 1's transcript via
`s.transcript(stage1Handle)` rather than re-prompting an agent for the
same content.

---

**Starting fresh?** Run `bun create @bastani/atomic-cli` for a working
scaffold. This directory is a focused demo of the
`s.save() → s.transcript(handle)` handoff pattern, not a starter
template.
