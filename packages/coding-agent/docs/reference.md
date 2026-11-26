---
title: "Reference index"
sidebarTitle: "Reference index"
description: "Look up Atomic CLI flags, settings, environment variables, keybindings, tools, storage, customization schemas, and APIs."
---

Look up exact commands, settings, configuration schemas, tool behaviors, and API references here. For task walkthroughs, start with [Task guides](/guides) or [Build with Atomic](/build).

## Core reference

- [CLI reference](/reference/cli) covers commands, flags, model-matching rules, arguments, and exit codes.
- [Settings](/settings) lists every `settings.json` field with defaults, scopes, and constraints.
- [Environment variables](/environment-variables) documents Atomic variables, value parsing rules, legacy Pi aliases, color controls, and shell session metadata.
- [Keybindings](/keybindings) lists default shortcuts and custom `keybindings.json` configuration rules.
- [Built-in tools](/tools) covers default coding tools, path selectors, and [exact-text editing](/tools#edit).
- [Codemode](/codemode) documents sandbox globals, tool calls, stored values, classifiers, image generation, and limits.
- [MCP servers](/mcp-servers) covers server configuration, tool exposure, resources, and authentication.
- [Web access](/web-access) documents `web_search`, `fetch_content`, `get_search_content`, `code_search`, slash commands, shortcuts, and `web-search.json`.

## Models, sessions, and storage

- [Provider reference](/providers/reference) covers stop reasons and credential resolution order.
- [Model configuration reference](/models/reference) covers provider and model overrides, variants, and API compatibility.
- [Models configuration](/models-configuration) lists the generated `models.json` field reference (including [remote compaction models](/models#remote-compaction-models)).
- [Session format](/session-format) specifies the JSONL format, entry types, and `SessionManager` API.
- [Compaction reference](/compaction/reference) covers parameters, saved boundaries, custom compactor contracts, hooks, exports, settings, and historical formats.
- [Storage](/storage) covers choosing a store, sharing it across machines, the `atomic storage` commands, exporting and importing sessions, and typed storage errors. Each backend has its own page: [local SQLite](/storage/sqlite) and [PostgreSQL](/storage/postgres) ([`@bastani/atomic-storage-postgres`](/libraries/storage-postgres)), with guides for [PgBouncer](/storage/postgres/pgbouncer) and [server tuning](/storage/postgres/tuning). [Custom adapters](/storage/custom-adapters) covers adapter packages, your own drivers, and the conformance suites. For programmatic backend recipes, see [SDK storage backends](/sdk/storage).
- [Worktree snapshots SDK & errors](/worktree-snapshots#sdk) documents snapshot capture/restore functions, garbage collection, and `WorkspaceError` classes.
- [Environment blueprints](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint) documents `.atomic/blueprint.yaml`, `atomic blueprint cache-key`, and `atomic blueprint prebuild`.

## Customization reference

- [Skill reference](/skills/reference) specifies `SKILL.md` frontmatter and validation rules.
- [Subagent reference](/subagents/reference) covers discovery, automatic model selection, fallback models, and reasoning levels.
- [Intercom reference](/intercom/reference) specifies the `intercom` tool, delivery rules, groups, and settings.
- [Package reference](/packages/reference) covers package filtering, scope, and deduplication.
- [Theme reference](/themes/reference) specifies the theme file format, color tokens, and color values.

## API and protocol reference

- [Extension API reference](/extensions/api-reference) documents `ExtensionContext`, `ExtensionCommandContext`, and `ExtensionAPI` methods.
- [Extension events](/extensions/events) lists every extension event and its payload.
- [Provider API reference](/custom-provider/api-reference) specifies custom provider configuration and model definition options.
- [SDK API reference](/sdk/reference) covers options, loaders, return values, run modes, and exports.
- [SDK storage backends](/sdk/storage) documents `sessionStore`, `storage`, `resolveSessionStore()`, `StorageProvider`, and `createAgentSessionRuntime()` storage wiring.
- [Structured decisions](/sdk/structured-decisions) documents `decide()`, structured output tools, and provider limits.
- [RPC protocol](/rpc/protocol) and [RPC extension UI](/rpc/extension-ui) document RPC commands, events, UI dialogs, types, and errors.
- [JSON event stream](/json) documents `--mode json` event output.
- [TUI API reference](/tui/reference) specifies component, focusable, input, and rendering interfaces.

## Platform setup

- [Windows](/windows)
- [Termux on Android](/termux)
- [Terminal setup](/terminal-setup)
- [tmux](/tmux)
- [Herdr](/herdr)
- [Shell aliases](/shell-aliases)

## Diagnostics and changelog

- [Diagnostics and debugging](/development) covers debug mode, `/debug` snapshots, UI stall profiling, and conversion diagnostics.
- [Changelog](/changelog) lists version history and release notes.
