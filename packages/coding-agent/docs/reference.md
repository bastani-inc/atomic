---
title: "Reference index"
sidebarTitle: "Reference index"
description: "Look up Atomic CLI flags, slash commands, settings, environment variables, keybindings, tools, storage, customization schemas, and APIs."
---

Look up exact commands, settings, configuration schemas, tool behaviors, and API references here. For task walkthroughs, start with [Task guides](/guides) or [Build with Atomic](/build).

## Core reference

- [CLI reference](/reference/cli) covers commands, flags, model-matching rules, arguments, and exit codes.
- [Slash commands](/slash-commands) lists every built-in and bundled extension slash command, argument rules, and subagent-view routing.
- [Settings](/settings) lists every `settings.json` field with defaults, scopes, and constraints.
- [Environment variables](/environment-variables) documents Atomic variables, value parsing rules, proxy variables, legacy Pi aliases, color controls, and shell session metadata.
- [Keybindings](/keybindings) lists default shortcuts, selector controls, reserved keys, and custom `keybindings.json` rules.
- [Built-in tools](/tools) covers default coding tools, path selectors, and [exact-text editing](/tools#edit).
- [Codemode](/codemode) documents sandbox globals, tool calls, stored values, classifiers, image generation, and limits.
- [MCP servers](/mcp-servers) covers server configuration, tool exposure, resources, and authentication.
- [Web access](/web-access) documents `web_search`, `fetch_content`, `get_search_content`, `code_search`, slash commands, shortcuts, and `web-search.json`.
- [Background tasks reference](/background-tasks/reference) documents observation wait modes, heartbeat batching, Linux cgroup cleanup, and task error classes.

## Models, sessions, and storage

- [Provider reference](/providers/reference) covers credential resolution order, normalized stop reasons, and cross-provider error handling.
- [GitHub Copilot errors](/providers/github-copilot-errors) documents the 11 typed Copilot error classes, retry/fallback matrix, diagnostics, and SDK helpers.
- [Model configuration reference](/models/reference) covers supported APIs, value resolution, capabilities, overrides, fast variants, and API compatibility.
- [`models.json` field reference](/models-configuration) lists every provider, model, override, and compatibility field (including [remote compaction models](/models#remote-compaction-models)).
- [Session format](/session-format) specifies the JSONL format, entry types, and `SessionManager` API.
- [Compaction reference](/compaction/reference) covers parameters, compactor HTTP contract, saved boundaries, hooks, exports, branch summary format, settings, and historical formats.
- [Worktree snapshots reference](/worktree-snapshots/reference) documents the snapshot SDK API, `WorkspaceError` classes, retention/garbage collection, and environment-hash inputs.
- [Storage](/storage) covers choosing a session store, sharing one database between machines, the `atomic storage` commands, exporting and importing sessions, and storage errors. Each store has its own page: [SQLite](/storage/sqlite), [JSONL](/storage/jsonl), and [PostgreSQL](/storage/postgres), with [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres), [PgBouncer](/storage/postgres/pgbouncer), [server tuning](/storage/postgres/tuning), and [custom adapters](/storage/custom-adapters). For SDK apps, see [SDK session storage](/sdk/storage).
- [Environment blueprints](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint) documents `.atomic/blueprint.yaml`, `atomic blueprint cache-key`, and `atomic blueprint prebuild`.

## Customization reference

- [Skill format](/skills/reference) specifies `SKILL.md` frontmatter and validation rules.
- [Subagent reference](/subagents/reference) covers discovery, automatic model selection, fallback models, reasoning levels, and `config.json`.
- [Intercom reference](/intercom/reference) specifies the `intercom` tool, delivery rules, groups, and settings.
- [Package reference](/packages/reference) covers package filtering, scope, and resource precedence.
- [Theme format](/themes/reference) specifies the theme file format, color tokens, and color values.

## API and protocol reference

- [Extension API reference](/extensions/api-reference) documents `ExtensionContext`, `ExtensionCommandContext`, and `ExtensionAPI` methods.
- [Extension events](/extensions/events) lists every extension event and its payload.
- [Custom provider API](/custom-provider/api-reference) specifies custom provider configuration and model definition options.
- [SDK API reference](/sdk/reference) covers options, loaders, return values, run modes, and exports.
- [SDK session storage](/sdk/storage) documents `sessionStore`, `storage`, `resolveSessionStore()`, `StorageProvider`, and `createAgentSessionRuntime()` storage wiring.
- [Structured decisions](/sdk/structured-decisions) documents `decide()`, structured output tools, and provider limits.
- [RPC protocol](/rpc/protocol) and [RPC extension UI](/rpc/extension-ui) document RPC commands, events, UI dialogs, types, and errors.
- [JSON event stream](/json) documents `--mode json` event output.
- [TUI API reference](/tui/reference) specifies component, focusable, input, and rendering interfaces.

## Platform setup

- [Run on Windows](/windows)
- [Run on Android (Termux)](/termux)
- [Configure your terminal](/terminal-setup)
- [Run in tmux](/tmux)
- [Herdr](/herdr)
- [Shell aliases](/shell-aliases)

## Diagnostics and changelog

- [Diagnostics and debugging](/development) covers debug mode, `/debug` snapshots, UI stall profiling, and conversion diagnostics.
- [Changelog](/changelog) lists version history and release notes.
