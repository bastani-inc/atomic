---
title: Guides
description: "Task guides for everyday work with Atomic: interactive use, non-interactive runs, sessions, compaction, subagents, providers, local models, security, and containers."
---

# Guides

Find a guide for the task you want to do with Atomic.

New to Atomic? Follow the [Quickstart](/quickstart) to install, authenticate, run a first session, and add project instructions.

Looking to extend or embed Atomic? Go to [Build with Atomic](/build). Looking up an exact flag, setting, event, or type? Go to the [Reference index](/reference).

## Everyday use

1. **[Interactive use](/usage).** Learn the interactive loop, slash commands, startup typing, and context files.
2. **[Non-interactive use](/guides/non-interactive).** Run one-shot prompts with `-p`, stream JSON events, or drive Atomic over RPC.
3. **[Configure Atomic](/guides/configuration).** Write a global settings file and override settings per project.
4. **[Sessions](/sessions).** Save, resume, name, search, and branch sessions.
5. **[Worktree snapshots](/worktree-snapshots).** Capture and restore repository state alongside your session history.
6. **[Resume on any machine](/guides/resume-on-any-machine).** Continue a session on another machine that shares your storage.
7. **[Context and compaction](/compaction).** Keep long sessions inside the model's context window.

## Running work for you

- **[Plan a task with subagents](/guides/orchestration).** Distribute multi-step work across subagents and verify the results.
- **[Subagents](/guides/subagents).** Delegate independent tasks to fresh or forked subagents in the background.
- **[Background tasks](/background-tasks).** Launch, inspect, steer, and stop background subagents and shells.
- **[Intercom](/guides/intercom).** Coordinate live sessions and subagents on one machine or across a shared database.
- **[Team and CI setup](/guides/team-setup).** Share Intercom with a team through one database while sessions stay private, and configure CI runners from environment variables.
- **[Computer use](/computer-use).** Automate desktop apps, browsers, and terminals across macOS, Linux, and Windows.
- **[Verification](/verification).** Reproduce bugs and collect verifiable evidence across terminal, browser, and desktop environments.

## Models, safety, and references

- **[Providers](/providers).** Configure subscription logins, API keys, and cloud providers.
- **[Local models](/llama-cpp).** Run local models with llama.cpp.
- **[Security](/security).** Review project trust, sandbox boundaries, and credential export guarantees.
- **[Containerization](/containerization).** Run Atomic or its tools inside Gondolin, Docker, or OpenShell.
- **[Herdr](/herdr).** Configure status indicators and session restore inside Herdr panes.
- **[Environment variables](/environment-variables).** Look up Atomic variables, legacy aliases, and provider credentials.
- **[Settings](/settings).** Browse the full settings reference.
- **[Keybindings](/keybindings).** Look up default shortcuts and custom bindings.
