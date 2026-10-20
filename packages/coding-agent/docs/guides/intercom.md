---
title: "Intercom"
description: "What Intercom is, when sessions should talk to each other, and where the full Intercom guide lives."
---

# Intercom

Intercom is a message channel between agent sessions running on the same machine, or on several machines that share a storage database ([Running Intercom across machines](/intercom/operations#running-intercom-across-machines)). Sessions in the same group can send each other messages, ask questions and wait for an answer, and coordinate without going through you.

## When to use one

Use it when two sessions are working on related things and one knows something the other needs: a planner handing work to a worker, a long-running session reporting a finding, or steering a workflow stage while it runs. You do not need it for a single session working alone.

## What you get

- Send, ask-and-wait, and reply between live sessions in your group.
- Groups that keep unrelated sessions isolated from each other.
- Delivery to workflow stages, including stages that have not started yet.

## Next steps

- [Intercom](/intercom) — the full guide, including groups and addressing.
- [Operations](/intercom/operations) — observable states and recovery actions.
- [Subagents](/guides/subagents) — when delegation is a better fit than coordination.
