---
title: "Subagents overview"
sidebarTitle: "Subagents overview"
description: "Learn what subagents do, when to delegate tasks, and how background subagents work."
---

A subagent is a separate agent session that your main session launches for a focused task. It runs in its own context window, so a long code search or debugging trace does not crowd out your main conversation.

This page introduces subagents at a high level. For day-to-day usage, worktrees, and run control, see [Run subagents](/subagents). For custom agent files, see [Create custom subagents](/subagents/authoring). For exact parameters, fallback rules, and `config.json`, see [Subagent reference](/subagents/reference). For programmatic child configuration, see [Subagent children in the SDK](/sdk#subagent-children).

Ask Atomic to delegate in plain language:

```text
Have codebase-analyzer trace the authentication flow and report the entry points.
Keep working with me here while it runs.
```

## When to use a subagent

Delegate bounded, independent work. Good fits include searching an unfamiliar area of the codebase, reproducing a failure, reviewing a diff with fresh context, or running several independent tasks at once. Keep work in your main session when it is small or relies on nuance the subagent would need to rediscover.

## Key capabilities

- **Background execution.** Every subagent runs in the background, so you can keep chatting in your main session while subagents work and collect results as completion notices arrive.
- **Bundled specialists.** Atomic includes ready-to-use agents such as `codebase-analyzer`, `debugger`, and `worker`. Run `/agents` to browse available specialists and inspect their prompts and tools.
- **Single or parallel runs.** Launch one subagent or a parallel batch, with optional Git worktree isolation so writers do not conflict on the same files.
- **Fresh or forked context.** Most agents start with a fresh context window so they inspect code without bias. The `worker` agent starts with a forked copy of your main conversation by default so it can pick up an approved plan immediately.
- **One-level delegation.** Only your main session launches subagents; subagents cannot launch other subagents.

## Next steps

- [Run subagents](/subagents) covers bundled agents, worktrees, run control, and coordination.
- [Create custom subagents](/subagents/authoring) explains how to write Markdown agent definitions and override built-in agents.
- [Subagent reference](/subagents/reference) covers discovery precedence, fallback models, `config.json`, tool parameters, and SDK error codes.
- [Subagent children in the SDK](/sdk#subagent-children) covers child inheritance and programmatic configuration from `@bastani/atomic`.
- [Manage background tasks](/background-tasks) covers the agent panel, `/tasks`, steering, and stopping running work.
- [Orchestrate with codemode and subagents](/orchestration) shows how to combine codemode scripts with subagents for multi-step work.
