---
title: "Plan a task with subagents"
description: "Ask Atomic to split work, check the results, and pick up after an interruption."
---

# Plan a task with subagents

This page introduces multi-step task delegation in plain language. Give Atomic a goal, a way to verify completion, and any limits on edits, cost, or time. You do not need to write JavaScript.

> Review the installation guide for Linux and Windows. Give each platform to a separate read-only agent. Check disputed commands against the CLI, then report discrepancies by platform. Do not edit files.

The parent session launches the reviews and continues as each child reports back. Open `/tasks` or focus the agent panel below the prompt to check which reviews are queued, running, or finished. Select any child to read its transcript or send it a message on the same screen without interrupting the others. If you close Atomic, reopen the same parent session to restore its unfinished children and inspect their results.

## Next steps

- [Orchestration](/orchestration) explains how the parent coordinates multi-step work with codemode and subagents.
- [Orchestration patterns](/orchestration/patterns) shows seven reusable ways to split and verify work.
- [Subagents](/subagents) covers bundled specialists, execution modes, and run control.
- [Background and parallel work](/background-tasks) explains the agent panel, `/tasks`, and background shells.
- [Skills as workflows](/skills#skills-as-workflows) explains how to save a repeatable procedure as a skill. If you have a workflow file from an earlier release, follow [Convert an earlier workflow into a skill](/orchestration/migrating-workflows).
