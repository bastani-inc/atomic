---
title: "Standalone libraries"
sidebarTitle: "All libraries"
description: "Explore Atomic's six core @bastani/atomic-* TypeScript libraries and two optional storage adapter packages for extensions, SDK apps, and standalone Node.js 24.20+ projects."
---

Atomic publishes six core TypeScript libraries and two optional storage adapter packages (all requiring Node.js 24.20 or newer). Each package publishes on npm at Atomic's version with every release and works independently outside Atomic.

## Core libraries

The six core libraries are bundled inside `@bastani/atomic` and provided to extensions automatically:

| Package | What it does |
| --- | --- |
| [`@bastani/atomic-ai`](/libraries/ai) | One API for every LLM provider: models, auth, streaming, tools, images, classification, and thinking |
| [`@bastani/atomic-agent-core`](/libraries/agent-core) | A stateful agent loop with tool execution, event streaming, steering, and follow-up messages |
| [`@bastani/atomic-tui`](/libraries/tui) | A terminal UI framework with differential rendering, components, overlays, and key handling |
| [`@bastani/atomic-codemode`](/libraries/codemode) | A sandbox that runs model-written JavaScript whose only capability is calling the tools you give it |
| [`@bastani/atomic-schema`](/libraries/schema) | JSON Schema builders and validation without `eval` |
| [`@bastani/atomic-telemetry`](/libraries/telemetry) | Vendor-neutral telemetry contracts and reference contexts that send nothing on their own |

## Storage adapter packages

Remote SQL storage adapters are **not** bundled into `@bastani/atomic` and must be installed separately when you use PostgreSQL:

| Package | What it does |
| --- | --- |
| [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) | PostgreSQL 16+ storage adapter (`openPostgresDatabase()`, cloud IAM, proxies, poolers) for shared sessions and Intercom |

For CLI usage, install storage adapters in user scope with `atomic install npm:@bastani/atomic-storage-postgres`. For TypeScript SDK applications, install them with `npm install` alongside `@bastani/atomic` (see [SDK storage backends](/sdk/storage)).

> **Native bindings:** `@bastani/atomic-natives` is an internal N-API native module installed automatically as a runtime dependency of `@bastani/atomic` (with per-platform binary packages in its `optionalDependencies`) and is not intended as a standalone user library.

## Install

Install a core library on its own with npm:

```bash
npm install @bastani/atomic-ai
```

Inside an Atomic [extension](/extensions), import the six core libraries without installing them. The running Atomic process provides them, so your extension shares its instances. If you publish an [Atomic package](/packages/authoring) that imports them, list them in `peerDependencies` with a `"*"` range.

To build on Atomic's sessions, tools, and extensions rather than the bare libraries, use the [SDK](/sdk) and [SDK storage backends](/sdk/storage). For custom extension UI, start with [TUI components](/tui).

## Older package names

These libraries began as forks of pi's packages. Extensions written for pi still work inside Atomic: imports of `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` map to `@bastani/atomic`, while `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-codemode`, `@earendil-works/pi-schema`, `@earendil-works/pi-telemetry`, their `@mariozechner/pi-*` equivalents, and `@bastani/pi-ai` (plus subpaths) map to the matching `@bastani/atomic-*` package.

Use the `@bastani/atomic-*` names in new code. The older names resolve only inside Atomic. Outside Atomic, install the `@bastani/atomic-*` packages.
