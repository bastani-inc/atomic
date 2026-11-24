---
title: "Standalone libraries"
sidebarTitle: "Overview"
description: "Explore the six standalone @bastani/atomic-* TypeScript libraries you can use in extensions, SDK apps, or independently on Node.js 22.19+."
---

Atomic is built on six TypeScript libraries (requiring Node.js 22.19 or newer). Each package is published on npm at Atomic's version with every release, and each works independently outside Atomic.

| Package | What it does |
| --- | --- |
| [`@bastani/atomic-ai`](/libraries/ai) | One API for every LLM provider: models, auth, streaming, tools, images, classification, and thinking |
| [`@bastani/atomic-agent-core`](/libraries/agent-core) | A stateful agent loop with tool execution, event streaming, steering, and follow-up messages |
| [`@bastani/atomic-tui`](/libraries/tui) | A terminal UI framework with differential rendering, components, overlays, and key handling |
| [`@bastani/atomic-codemode`](/libraries/codemode) | A sandbox that runs model-written JavaScript whose only capability is calling the tools you give it |
| [`@bastani/atomic-schema`](/libraries/schema) | JSON Schema builders and validation without `eval` |
| [`@bastani/atomic-telemetry`](/libraries/telemetry) | Vendor-neutral telemetry contracts and reference contexts that send nothing on their own |

## Install

Install a library on its own with npm:

```bash
npm install @bastani/atomic-ai
```

Inside an Atomic [extension](/extensions), import the libraries without installing them. The running Atomic process provides them, so your extension shares its instances. If you publish an [Atomic package](/packages/authoring) that imports them, list them in `peerDependencies` with a `"*"` range.

To build on Atomic's sessions, tools, and extensions rather than the bare libraries, use the [SDK](/sdk) instead. For custom extension UI, start with [TUI components](/tui).

## Older package names

These libraries began as forks of pi's packages. Extensions written for pi still work inside Atomic: imports of `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` map to `@bastani/atomic`, while `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-codemode`, `@earendil-works/pi-schema`, `@earendil-works/pi-telemetry`, their `@mariozechner/pi-*` equivalents, and `@bastani/pi-ai` (plus subpaths) map to the matching `@bastani/atomic-*` package.

Use the `@bastani/atomic-*` names in new code. The older names resolve only inside Atomic. Outside Atomic, install the `@bastani/atomic-*` packages.
