---
title: "Plan a task with subagents"
description: "Ask Atomic to split work, check the results, and pick up after an interruption."
---

# Plan a task with subagents

Give Atomic a goal, a way to tell whether it's done, and any limits on edits, cost, or time. You don't need to write JavaScript. For example:

> Review the installation guide for Linux and Windows. Give each platform to a separate read-only agent. Check disputed commands against the CLI, then report discrepancies by platform. Don't edit files.

The parent chat launches the reviews, then continues when each child reports back. Open `/tasks` to see which reviews are queued, running, or finished. You can message a child from its chat without interrupting the others. If you close Atomic, reopen the same parent session to recover its children and their results.

To repeat the procedure later, ask Atomic to write it as a [skill](/skills#skills-as-workflows). If you already have a workflow file from an earlier Atomic, [give the parent its path](/orchestration/migrating-workflows). See [Orchestration](/orchestration) for the actual script and [Patterns](/orchestration/patterns) for other ways to split a task.
