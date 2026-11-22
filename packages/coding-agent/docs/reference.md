---
title: Reference
sidebarTitle: "Reference index"
description: "Exact contracts for Atomic CLI commands, settings, environment variables, keybindings, tools, storage, models, extensions, SDK, RPC, and TUI."
---

# Reference

Look up exact commands, settings, types, and tool contracts here. For a walkthrough, start with [Guides](/guides) or [Build with Atomic](/build).

## Everyday contracts

- [CLI reference](/reference/cli) covers commands, flags, arguments, and exit codes.
- [Settings](/settings) lists every `settings.json` field with defaults and constraints.
- [Environment variables](/environment-variables) documents Atomic and legacy Pi variables, provider credentials, and shell session metadata.
- [Keybindings](/keybindings) lists default shortcuts and custom `keybindings.json` actions.
- [Built-in tools](/tools) covers default coding tools, path selectors, and [exact-text editing](/tools#edit).
- [Codemode](/codemode) documents sandbox globals, tool calls, stored values, classifiers, image generation, and limits.
- [MCP Servers](/mcp-servers) covers server configuration, tool exposure, resources, and authentication.
- [Web access](/web-access) documents `web_search`, `fetch_content`, `get_search_content`, `code_search`, slash commands, shortcuts, and `web-search.json`.
- [Session format](/session-format) specifies the JSONL format, entry types, and `SessionManager` API.

## Domain contracts

- [Provider reference](/providers/reference) covers stop reasons and credential resolution order.
- [Model configuration reference](/models/reference) covers provider and model overrides, variants, and API compatibility.
- [Models configuration](/models-configuration) lists the generated `models.json` field reference.
- [Compaction reference](/compaction/reference) covers parameters, saved boundaries, hooks, exports, settings, and historical formats.
- [Skill reference](/skills/reference) specifies `SKILL.md` frontmatter and validation rules.
- [Subagent reference](/subagents/reference) covers discovery, automatic model selection, fallback models, and reasoning levels.
- [Intercom reference](/intercom/reference) specifies the `intercom` tool contract, delivery rules, and settings.
- [Package reference](/packages/reference) covers package filtering, scope, and deduplication.
- [Theme reference](/themes/reference) specifies the theme file format, color tokens, and color values.
- [Extension API reference](/extensions/api-reference) documents `ExtensionContext`, `ExtensionCommandContext`, and `ExtensionAPI` methods.
- [Extension events](/extensions/events) lists every extension event and its payload.
- [Provider API reference](/custom-provider/api-reference) specifies custom provider configuration and model definition contracts.
- [SDK API reference](/sdk/reference) covers options, loaders, return values, run modes, and exports.
- [Storage](/storage) covers local SQLite, shared libSQL and PostgreSQL databases, adapters, and CLI commands.
- [Structured decisions](/sdk/structured-decisions) documents `decide()`, structured output tools, and provider limits.
- [RPC protocol](/rpc/protocol) documents RPC commands, events, types, and errors.
- [TUI API reference](/tui/reference) specifies component, focusable, input, and rendering contracts.
- [Orchestration](/orchestration) explains how to launch subagents from codemode and combine their results.

## Platform setup

- [Windows](/windows)
- [Termux on Android](/termux)
- [Terminal setup](/terminal-setup)
- [tmux](/tmux)
- [Herdr](/herdr)
- [Shell aliases](/shell-aliases)

## Project

- [Development](/development) covers debug mode, UI stall profiling, and conversion diagnostics.
- [Changelog](/changelog) lists version history and release notes.
