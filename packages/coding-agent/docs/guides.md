---
title: "Task guides"
sidebarTitle: "All guides"
description: "Task guides for interactive and non-interactive work, sessions, compaction, subagents, providers, and security."
---

New to Atomic? Follow the [Quickstart](/quickstart) to install, authenticate, run your first session, and add project instructions. To extend or embed Atomic, go to [Build with Atomic](/build). For exact flags, settings, events, or types, go to the [Reference index](/reference).

## Use Atomic daily

- **[Interactive mode](/usage).** Use the terminal editor, slash commands, startup typing, message queue, and context files.
- **[Non-interactive mode](/guides/non-interactive).** Run one-shot prompts with `-p`, stream JSON events, or drive Atomic over RPC.
- **[Configure Atomic](/guides/configuration).** Create a global settings file and override settings per project.
- **[Sessions](/sessions).** Save, resume, name, search, and branch sessions.
- **[Worktree snapshots](/worktree-snapshots).** Capture and restore repository state alongside your session history.
- **[Resume on any machine](/guides/resume-on-any-machine).** Continue a session on another machine that shares your storage.
- **[Context and compaction](/compaction).** Keep long sessions inside the model's context window.

## Delegate and automate

- **[Plan a task with subagents](/guides/orchestration).** Distribute multi-step work across subagents and verify the results.
- **[Subagents](/guides/subagents).** Delegate independent tasks to fresh or forked subagents in the background.
- **[Background tasks](/background-tasks).** Launch, inspect, steer, and stop background subagents and shells.
- **[Intercom](/guides/intercom).** Coordinate live sessions and subagents on one machine or across a shared database.
- **[Team and CI setup](/guides/team-setup).** Share Intercom with a team through one database while sessions stay private, and configure CI runners from environment variables.
- **[Computer use](/computer-use).** Automate desktop apps, browsers, and terminals across macOS, Linux, and Windows.
- **[Verification](/verification).** Reproduce bugs and collect verifiable evidence across terminal, browser, and desktop environments.

## Models and providers

- **[Providers](/providers).** Configure subscription logins, API keys, and cloud providers.
- **[Local models](/llama-cpp).** Run local models with llama.cpp.

## Security and isolation

- **[Security](/security).** Review project trust, sandbox boundaries, and credential export guarantees.
- **[Containerization](/containerization).** Run Atomic or its tools inside Gondolin, Docker, or OpenShell.

## Quick references

- **[Herdr](/herdr).** Configure status indicators and session restore inside Herdr panes.
- **[Settings](/settings).** Browse the full `settings.json` reference.
- **[Environment variables](/environment-variables).** Look up Atomic variables, legacy aliases, color controls, and provider credentials.
- **[Keybindings](/keybindings).** Look up default shortcuts and custom bindings.
