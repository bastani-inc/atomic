---
title: "Programmatic integration"
sidebarTitle: "Overview"
description: "Choose between JSON event stream mode, RPC mode, the TypeScript SDK, and TUI component APIs, then follow a minimal integration."
---

Atomic provides three programmatic integration modes plus a component API for interactive extension interfaces. Choose the smallest mode that fits your integration, run its minimal example, and continue to its reference.

## Choose an integration mode

| Goal | Mode | Entry point |
| --- | --- | --- |
| Run one or more prompts and parse structured output as JSON lines | [JSON event stream](/json) | `atomic --mode json` |
| Drive a long-lived process with commands, interrupts, and extension UI prompts | [RPC mode](/rpc) | `atomic --mode rpc` |
| Embed Atomic directly inside a Node.js application (Node.js 22.19+) | [TypeScript SDK](/sdk) | `@bastani/atomic` |

- **JSON event stream** executes one or more positional prompts in sequence, writes newline-delimited session events to stdout, and exits.
- **RPC mode** keeps an Atomic subprocess running over stdin/stdout JSON Lines so you can send follow-up prompts, steer or abort turns, switch models, and answer extension dialogs and OAuth prompts.
- **TypeScript SDK** runs the same agent runtime as a library inside your Node.js application, with direct control over extensions, skills, tools, models, workspaces, and session storage.

## Protocol and API references

- [RPC protocol reference](/rpc/protocol): every RPC command, streamed event, error shape, and JSON type.
- [RPC extension UI protocol](/rpc/extension-ui): handle extension dialogs, widgets, questionnaires, and OAuth flows over RPC.
- [RPC client examples](/rpc/examples): connect with the typed `RpcClient` or a standalone Node.js script.
- [SDK API reference](/sdk/reference): complete session options, loaders, tool status, task supervision, run modes, and exports.
- [Structured decisions API](/sdk/structured-decisions): run typed classifier or chat decisions with `decide()` and `generateStructuredOutput()`.
- [Embed Atomic in a web server](/sdk/web-server): build a streaming HTTP API with Next.js App Router and `createAgentSession()`.

## Terminal UI and standalone libraries

- [Build TUI components](/tui) walks through custom interactive components and common patterns, and [TUI API reference](/tui/reference) documents the component, focus, input, and rendering contracts.
- [Standalone libraries](/libraries) covers the six `@bastani/atomic-*` packages (`ai`, `agent-core`, `tui`, `codemode`, `schema`, and `telemetry`) that you can install independently of the CLI.
