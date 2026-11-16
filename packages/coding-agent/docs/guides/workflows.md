---
title: "Workflows"
description: "What workflows are, when to reach for one, and where the full authoring and operations guides live."
---

# Workflows

A workflow runs a multi-stage job for you: each stage is a tracked unit of work with its own prompt, tools, and outputs, and the stages form a graph rather than one long chat.

## When to use one

Reach for a workflow when the task has structure and a finish line you can check — an implementation with review, a migration with verification, a "keep fixing until the checks pass" loop. Stay in normal chat for a single edit or a quick question, where the tracking costs more than it gives you.

## What you get

- Stages that run in order or in parallel, with their own models and tool access.
- Durable runs you can pause, resume, inspect, and steer while they work.
- Explicit stop conditions and evidence, instead of a transcript you have to re-read.

Run one with the `workflow` tool, or from chat with `/workflow`. Connect to a live run with `/workflows <run>` to watch stages and talk to them.

## Next steps

- [Workflows](/workflows) — the full guide, including builtins and the run lifecycle.
- [Builtins](/workflows/builtins) — the workflows that ship with Atomic.
- [Authoring](/workflows/authoring) — write your own workflow in TypeScript.
- [Operations](/workflows/operations) — run control, prompts, and troubleshooting.
