---
title: "Standalone libraries"
sidebarTitle: "All libraries"
description: "Explore Atomic's six core @bastani/atomic-* TypeScript libraries and the optional PostgreSQL storage adapter package for extensions, SDK apps, and standalone Node.js 24.20+ projects."
---

Atomic publishes six core TypeScript libraries and one optional storage adapter package (`@bastani/atomic-storage-postgres`), all requiring Node.js 24.20 or newer. Each package publishes on npm at Atomic's version with every release and works independently outside Atomic.

## Core libraries

The six core libraries are bundled inside `@bastani/atomic` and provided to extensions automatically:

<Columns cols={2}>
  <Card title="@bastani/atomic-ai" href="/libraries/ai">
    One API for every LLM provider: models, auth, streaming, tools, images, classification, and thinking.
  </Card>
  <Card title="@bastani/atomic-agent-core" href="/libraries/agent-core">
    A stateful agent loop with tool execution, event streaming, steering, and follow-up messages.
  </Card>
  <Card title="@bastani/atomic-tui" href="/libraries/tui">
    A terminal UI framework with differential rendering, alternate-screen viewports, overlays, and key handling.
  </Card>
  <Card title="@bastani/atomic-codemode" href="/libraries/codemode">
    A QuickJS WebAssembly sandbox that runs model-written JavaScript whose only capability is calling injected tools.
  </Card>
  <Card title="@bastani/atomic-schema" href="/libraries/schema">
    JSON Schema drafts 2020-12 and 7 builders and validation without `eval`, with zero runtime dependencies.
  </Card>
  <Card title="@bastani/atomic-telemetry" href="/libraries/telemetry">
    Vendor-neutral telemetry contracts, metrics, trace rendering, and typed schemas that send nothing on their own.
  </Card>
</Columns>

## Storage adapter package

Remote SQL storage is **not** bundled into `@bastani/atomic`. Install the optional PostgreSQL adapter only when you store sessions or Intercom multi-node routing in PostgreSQL:

<Columns cols={2}>
  <Card title="@bastani/atomic-storage-postgres" href="/libraries/storage-postgres">
    PostgreSQL 16+ storage adapter (`openPostgresDatabase()`, cloud IAM, HTTP proxies, and pooler auto-detection) for shared sessions and Intercom.
  </Card>
</Columns>

For CLI usage, install the adapter in user scope with `atomic install npm:@bastani/atomic-storage-postgres`. For TypeScript SDK applications, install it with `npm install` alongside `@bastani/atomic` (see [SDK storage backends](/sdk/storage)).

<Note>
**Native bindings:** `@bastani/atomic-natives` is an internal N-API native module installed automatically as a runtime dependency of `@bastani/atomic` (with per-platform binaries in its `optionalDependencies`) and is not intended as a standalone user library.
</Note>

## Install

Install any core library on its own with npm:

```bash
npm install @bastani/atomic-ai
```

Inside an Atomic [extension](/extensions), import the six core libraries without installing them—the running Atomic process provides them so your extension shares its instances. If you publish an [Atomic package](/packages/authoring) that imports them, list them in `peerDependencies` with a `"*"` range.

To build on Atomic's sessions, tools, and extensions rather than bare libraries, use the [TypeScript SDK](/sdk) and [SDK storage backends](/sdk/storage). For custom extension UI, start with [Build TUI components](/tui).

## Older package names

These libraries began as forks of pi's packages. Extensions written for pi still work inside Atomic: imports of `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` map to `@bastani/atomic`, while `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-codemode`, `@earendil-works/pi-schema`, `@earendil-works/pi-telemetry`, their `@mariozechner/pi-*` equivalents, and `@bastani/pi-ai` (plus subpaths) map to the matching `@bastani/atomic-*` package.

Use the `@bastani/atomic-*` names in new code. The older names resolve only inside Atomic; outside Atomic, install the `@bastani/atomic-*` packages directly.
