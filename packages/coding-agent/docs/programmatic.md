---
title: Programmatic use
description: Choose between JSON event stream mode, RPC mode, the SDK, and the TUI component APIs, then follow one minimal integration.
---

# Programmatic use

Atomic exposes three integration modes plus a component API for interactive extension interfaces. Pick one mode, complete its minimal example, then continue to its reference.

## Choose a mode

| You want | Use | Start at |
| --- | --- | --- |
| A one-shot run whose output you parse as structured events | [JSON event stream mode](/json) | `atomic --mode json` |
| A long-lived process you drive with commands and read events from | [RPC mode](/rpc) | `atomic --mode rpc` |
| Atomic embedded inside a Node.js application, with its resources and lifecycle in-process | [SDK](/sdk) | `@bastani/atomic` |

- JSON mode runs one process with one prompt, streams newline-delimited events, then exits.
- RPC mode keeps the process alive so you can send more input, interrupt, switch models, and answer extension UI dialogs and OAuth prompts (see [RPC extension UI protocol](/rpc/extension-ui)).
- The SDK provides the same engine as a library, with programmatic control over extensions, skills, tools, and session storage.

## Then continue to the contracts

- [RPC protocol](/rpc/protocol): every command, event, and type.
- [RPC extension UI protocol](/rpc/extension-ui): drive extension-rendered UI and OAuth prompts over RPC.
- [RPC client examples](/rpc/examples): additional client implementations.
- [SDK API reference](/sdk/reference): options, loaders, return values, run modes, and exports.

## Build interactive interfaces and use standalone libraries

- [TUI components](/tui) covers writing a first component and common interaction patterns. [TUI API reference](/tui/reference) holds the component, focusable, input, and rendering contracts.
- [Libraries](/libraries) documents the standalone `@bastani/atomic-*` packages (`ai`, `agent-core`, `tui`, `codemode`, `schema`, and `telemetry`).
