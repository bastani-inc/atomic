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
- **[Resume on any machine and blueprints](/guides/resume-on-any-machine).** Continue a session on another machine that shares your storage, and automate dependency rebuilds with [`.atomic/blueprint.yaml` blueprints](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint).
- **[Storage](/storage).** Choose where sessions are kept: a [local SQLite](/storage/sqlite) file, [JSONL files](/storage/jsonl), or a [PostgreSQL](/storage/postgres) database that several machines share. Move sessions between stores with export and import. To run many agents on PostgreSQL, see [PgBouncer](/storage/postgres/pgbouncer) and [server tuning](/storage/postgres/tuning). For apps built on the SDK, see [SDK session storage](/sdk/storage).
- **[Context and compaction](/compaction).** Keep long sessions inside the model's context window, or plug in a [custom remote compactor](/compaction#customize-morph-or-add-a-remote-compactor).
- **[MCP servers](/mcp-servers).** Connect external tools and data sources over Model Context Protocol.

## Delegate and automate

- **[Plan a task with subagents](/guides/orchestration).** Distribute multi-step work across subagents and verify the results.
- **[Subagents](/guides/subagents).** Delegate independent tasks to fresh or forked subagents in the background (see the full [Subagents guide](/subagents)).
- **[Background tasks](/background-tasks).** Launch, inspect, steer, and stop background subagents and shells.
- **[Intercom](/guides/intercom).** Coordinate live sessions and subagents on one machine or across a shared database (see the full [Intercom guide](/intercom)).
- **[Team and CI setup](/guides/team-setup).** Share Intercom with a team through one PostgreSQL database while sessions stay private, and configure CI runners.
- **[Structured decisions](/sdk/structured-decisions).** Make typed classifier or chat decisions with `decide()` and `generateStructuredOutput()`.
- **[Computer use](/computer-use).** Automate desktop apps, browsers, and terminals across macOS, Linux, and Windows.
- **[Verification](/verification).** Reproduce bugs and collect verifiable evidence across terminal, browser, and desktop environments.

## Models and providers

- **[Providers](/providers).** Configure subscription logins, API keys, and cloud providers.
- **[Local models](/llama-cpp).** Run local models with llama.cpp.

## Security and isolation

- **[Security](/security).** Review project trust, sandbox boundaries, and credential export guarantees.
- **[Containerization](/containerization).** Run Atomic or its tools inside Gondolin, Docker, or OpenShell.

## Quick references

- **[CLI reference](/reference/cli).** Look up commands, flags, subcommands, and exit codes.
- **[Built-in tools](/tools)**, **[Codemode](/codemode)**, and **[Web access](/web-access).** Review default tools, sandbox scripting, and search/fetch controls.
- **[Herdr](/herdr).** Configure status indicators and session restore inside Herdr panes.
- **[Settings](/settings).** Browse the full `settings.json` reference.
- **[Environment variables](/environment-variables).** Look up Atomic variables, legacy aliases, color controls, and provider credentials.
- **[Keybindings](/keybindings).** Look up default shortcuts and custom bindings.
- **[Diagnostics and debugging](/development).** Capture debug snapshots, trace UI stalls, and report bugs.
