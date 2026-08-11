---
title: "i-have-adhd"
description: "ADHD-friendly response style bundled with Atomic"
---

# i-have-adhd

Atomic bundles `@bastani/i-have-adhd` as a first-party extension. It keeps responses easy to act on: lead with the next action, number multi-step work, show progress, and cut filler. The rules are loaded from the bundled `i-have-adhd` skill.

ADHD-friendly output is enabled by default for new sessions. Atomic injects the rules once as a hidden message, so the transcript stays clean while the style remains active across turns, restarts, branches, and compaction.

## Control the mode

Use the session command:

```text
/i-have-adhd on
/i-have-adhd off
```

With no argument, `/i-have-adhd` toggles the current session. The saved session setting wins when that session is resumed or branched.

To opt out before a new session starts, use `--no-adhd`:

```bash
atomic --no-adhd
```

For a persistent default opt-out, create `.i-have-adhd-off` in the active agent directory (`~/.atomic/agent/` by default). A saved session state still wins over that default.

You can also say either exact stop phrase:

- `stop adhd mode`
- `normal mode`

Atomic turns the mode off, saves that choice for the session, and confirms it. Use `/i-have-adhd on` to enable it again.
