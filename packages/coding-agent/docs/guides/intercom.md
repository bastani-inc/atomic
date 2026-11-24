---
title: "Intercom overview"
sidebarTitle: "Intercom overview"
description: "Coordinate multiple Atomic sessions on one machine or across a shared database."
---

Intercom is a message channel between Atomic sessions running on the same machine, or across several machines that share a storage database ([Running Intercom across machines](/intercom/operations#running-intercom-across-machines)). Sessions in the same group send messages, ask questions, and coordinate directly without routing everything through you.

## When to use Intercom

Use Intercom when two or more sessions work on related tasks and need to share context: a planner handing work to a worker, a long-running session reporting a finding, or an orchestrator steering a subagent while it runs. You do not need Intercom for a single session working alone.

## Key capabilities

- **Direct sends, asks, and broadcasts.** Send fire-and-forget updates, ask non-blocking questions whose replies arrive as messages, or broadcast to matching sessions in your group.
- **Named groups.** Isolate unrelated sessions by group so work in one repository or team does not interrupt another.
- **Subagent delivery.** Message subagents while they start, run, wait on tools, or after they finish. Messaging a completed or failed subagent resumes it automatically to handle your request, while messages to paused or quit subagents wait in a queue until the launching session continues them.

## Getting started

Interactive sessions connect to Intercom automatically 3 seconds after startup. Name each session with `/name` so it is easy to target (for example `/name planner` and `/name worker`), then press `Alt+M` or run `/intercom` to pick a session and send a message.

## Next steps

- [Coordinate sessions with Intercom](/intercom) covers the quick start, coordination patterns, and supervisor escalation.
- [Operate Intercom](/intercom/operations) covers connection lifecycles, multi-machine routing, upgrades, and recovery.
- [Intercom reference](/intercom/reference) documents every `intercom` tool action, targeting rule, error class, and setting.
- [Subagents overview](/guides/subagents) explains when delegation fits better than session-to-session coordination.
