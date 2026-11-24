---
title: "Plan multi-step work"
sidebarTitle: "Plan multi-step work"
description: "Delegate multi-step work in plain language, monitor background subagents, and resume after interruptions."
---

Give Atomic a goal, a way to verify completion, and any limits on edits, cost, or time. You do not need to write JavaScript to split work across agents.

This page covers plain-language delegation. For codemode JavaScript orchestration and interruption recovery APIs, see [Orchestrate with codemode and subagents](/orchestration).

> Review the installation guide for Linux and Windows. Give each platform to a separate read-only agent. Check disputed commands against the CLI, then report discrepancies by platform. Do not edit files.

Your main session launches the subagents in the background and continues as each subagent reports back. To check which subagents are queued, running, or finished, run `/tasks` or focus the agent panel below the prompt (press `↓` on an empty prompt, or click a row in fullscreen mode; see [Manage background tasks](/background-tasks)). Select any subagent to read its live transcript or send it a message on the same screen without interrupting the others.

If you close Atomic while subagents are running, reopen the same main session to restore them and collect their results:

- Running subagents relaunch automatically when you reopen the session.
- Paused and quit subagents stay awaiting manual resume unless you set `resumeInFlight` to `"ask"` or `"auto"` in `~/.atomic/agent/extensions/subagent/config.json` ([Subagent config.json reference](/subagents/reference#subagent-config-json-reference)).
- Forking a session (`/fork` or `--fork`) never restores the original session's subagents.
- Sessions started with `--no-session` are not saved, so their subagents cannot be restored after Atomic closes.

## Next steps

- [Orchestrate with codemode and subagents](/orchestration) explains how your main session coordinates multi-step work using small JavaScript scripts in codemode alongside subagents.
- [Orchestration patterns](/orchestration/patterns) shows seven reusable ways to split and verify work.
- [Run subagents](/subagents) covers bundled specialists, context modes, worktrees, and run control.
- [Manage background tasks](/background-tasks) explains the agent panel, `/tasks`, heartbeats, and background shells.
- [Skills as workflows](/skills#skills-as-workflows) explains how to save a repeatable procedure as a skill. If you have a workflow file from an earlier release, follow [Migrate an earlier workflow to a skill](/orchestration/migrating-workflows).
