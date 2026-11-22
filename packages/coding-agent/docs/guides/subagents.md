---
title: "Subagents"
description: "What subagents are, when delegation helps, and where the full subagent guide lives."
---

# Subagents

This short overview introduces subagents and when to delegate work. A subagent is a separate agent session that your main session launches for a focused task. It runs in its own context window, so a long search or debugging trace does not crowd out your main conversation.

## When to use one

Delegate bounded, independent work. Good fits include searching an unfamiliar area of the codebase, reproducing a failure, reviewing a diff with fresh context, or running several independent tasks at once. Keep work in your main session when it is small or relies on context the subagent would need to rediscover.

## What you get

- Single or parallel runs that return results to your session.
- Fresh or forked context, so a child can start clean or reuse the parent's conversation.
- Background execution, so you can keep chatting while children run and collect results as they finish.

## Next steps

- [Subagents](/subagents) is the full guide to bundled agents, run control, worktrees, and execution modes.
- [Custom subagents](/subagents/authoring) explains how to define and scope your own agents.
- [Background and parallel work](/background-tasks) covers inspecting, waiting on, messaging, and stopping delegated tasks.
- [Orchestration](/orchestration) shows how to combine codemode scripts with subagents for multi-step work.
