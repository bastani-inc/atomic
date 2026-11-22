---
title: "Intercom"
description: "What Intercom is, when sessions should talk to each other, and where the full Intercom guide lives."
---

# Intercom

Intercom is a message channel between agent sessions running on the same machine, or on several machines that share a storage database ([Running Intercom across machines](/intercom/operations#running-intercom-across-machines)). Sessions in the same group send messages, ask questions, and coordinate directly without routing everything through you.

## When to use Intercom

Use Intercom when two or more sessions work on related tasks and share context: a planner handing work to a worker, a long-running session reporting a finding, or an orchestrator steering a subagent while it runs. You do not need Intercom for a single session working alone.

## What you get

- Direct sends, non-blocking asks with replies, and group broadcasts between live sessions.
- Named groups that isolate unrelated sessions from each other.
- Delivery to subagents, including ones that are starting, released, paused, finished, or being restored.

## Next steps

- Read [Intercom](/intercom) for the quick start, coordination patterns, and supervisor escalation.
- Read [Intercom operations](/intercom/operations) for connection states, multi-machine routing, and recovery actions.
- Read [Subagents](/guides/subagents) when delegation fits better than session-to-session coordination.
