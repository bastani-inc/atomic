---
title: "Choose an integration mode"
sidebarTitle: "Choose a mode"
description: "Compare Print mode, JSON event streams, RPC mode, and the TypeScript SDK, run a minimal example for each, and continue to its reference."
---

Atomic provides four programmatic integration modes plus a component API for interactive extension interfaces. Choose the smallest mode that fits your integration, run its minimal example below, and continue to its guide or reference.

## Compare integration modes

| What you want | Use this | Entry point |
| --- | --- | --- |
| Run one or more prompts and capture plain text in a shell pipeline | [Print mode](/guides/non-interactive) | `atomic -p` |
| Run one or more prompts and parse structured session events in scripts or CI | [JSON event stream](/json) | `atomic --mode json` |
| Drive a long-lived Atomic process from another language, editor, or service | [RPC mode](/rpc) | `atomic --mode rpc` |
| Embed Atomic directly inside a Node.js 24.20+ application | [TypeScript SDK](/sdk) | `@bastani/atomic` |

- **Print mode** runs one or more prompts (including piped stdin or `@file` inputs), writes the final response as plain text to stdout, and exits.
- **JSON event stream** executes prompts in sequence, writes every session event as newline-delimited JSON to stdout, and exits.
- **RPC mode** keeps an Atomic subprocess running over stdin/stdout JSON Lines so you can send follow-up prompts, steer or abort turns, switch models, and answer extension dialogs and OAuth prompts.
- **TypeScript SDK** runs the same agent runtime in-process inside Node.js, with direct control over extensions, skills, tools, models, workspaces, and [session storage backends](/sdk/storage).

## Minimal examples

### Print mode

```bash
git diff | atomic -p "Write a concise commit message for this diff"
```

### JSON event stream

```bash
atomic --mode json "List the TypeScript files in src/" 2>/dev/null \
  | jq -c 'select(.type == "message_end")'
```

### RPC mode

Send newline-delimited JSON commands on stdin and read JSON responses and events from stdout:

```bash
printf '%s\n' '{"id":"1","type":"prompt","message":"Say hello in one sentence."}' \
  | atomic --mode rpc --no-session
```

For multi-turn control, framing rules, and a streaming Python or TypeScript client, see [Drive Atomic over RPC](/rpc) and [Connect with RPC clients](/rpc/examples).

### TypeScript SDK

Install `@bastani/atomic` on Node.js 24.20+, create an in-memory session, stream text deltas, and dispose cleanly in `finally`:

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@bastani/atomic";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("List the files in the current directory.");
} finally {
  await session.dispose();
}
```

## TypeScript SDK guides

<Columns cols={2}>
  <Card title="Use the TypeScript SDK" href="/sdk">
    Create sessions, bind Git workspaces, configure Intercom policies, handle human input, and manage lifecycle events.
  </Card>
  <Card title="Configure session storage" href="/sdk/storage">
    Wire SQLite, JSONL, in-memory, and PostgreSQL storage for `createAgentSession()`, `createAgentSessionRuntime()`, and `SessionManager`.
  </Card>
  <Card title="Make structured decisions" href="/sdk/structured-decisions">
    Run typed classifier or chat decisions with `decide()`, `generateStructuredOutput()`, and `structured_output`.
  </Card>
  <Card title="Stream from a web server" href="/sdk/web-server">
    Run Atomic behind a Next.js App Router endpoint and stream NDJSON transcript updates to a browser.
  </Card>
  <Card title="SDK API reference" href="/sdk/reference">
    Complete reference for session options, runtime methods, resource loaders, run modes, error classes, and exports.
  </Card>
  <Card title="Compactors and blueprints" href="/compaction/custom-compactors">
    Plug in custom remote compactors or configure repeatable [environment blueprints](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint) for cross-machine resume.
  </Card>
</Columns>

## RPC and JSON guides

<Columns cols={2}>
  <Card title="Drive Atomic over RPC" href="/rpc">
    Startup flags, command concurrency lanes, strict JSONL framing, shutdown signals, and a Python client.
  </Card>
  <Card title="RPC protocol reference" href="/rpc/protocol">
    Every RPC command, streamed event, structured error code, and JSON wire type.
  </Card>
  <Card title="Handle extension UI over RPC" href="/rpc/extension-ui">
    Implement dialogs, notifications, widgets, questionnaires, and interactive OAuth prompts over RPC.
  </Card>
  <Card title="Connect with RPC clients" href="/rpc/examples">
    Use the typed `RpcClient` in TypeScript or a standalone Node.js script.
  </Card>
  <Card title="Parse JSON event streams" href="/json">
    Event shapes, `message_update` wire stripping, piped input, exit codes, and `jq` filtering for `--mode json`.
  </Card>
</Columns>

## Terminal UI and standalone libraries

<Columns cols={2}>
  <Card title="Build TUI components" href="/tui">
    Walk through custom interactive components, overlays, status bars, and common extension UI patterns.
  </Card>
  <Card title="TUI API reference" href="/tui/reference">
    Component, focus, keyboard input, and rendering contracts for interactive extensions.
  </Card>
  <Card title="Standalone libraries" href="/libraries">
    Use the six core `@bastani/atomic-*` packages (`ai`, `agent-core`, `tui`, `codemode`, `schema`, and `telemetry`) directly.
  </Card>
  <Card title="PostgreSQL storage adapter" href="/libraries/storage-postgres">
    Install the optional PostgreSQL storage adapter package (`@bastani/atomic-storage-postgres`) for shared multi-machine sessions.
  </Card>
</Columns>
