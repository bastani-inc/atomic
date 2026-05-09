# Disk-resident workflow capsules

> **This is the niche path.** Most third-party CLIs should use the default
> `standalone-cli` shape from `bun create @bastani/atomic-cli`, which
> bundles workflows directly into the compiled binary — no externalize
> array, no separate capsule files, no runtime resolution to think about.
>
> Read this doc only if you need workflows that ship **separately** from
> your host binary. The two real reasons:
>
> 1. **Hot-reload during development** — you want to change a workflow's
>    behaviour without re-running `bun build --compile`.
> 2. **Third-party-distributed workflows** — your binary loads workflow
>    plugins authored by other people, distributed as standalone files.

## The problem

When you ship a workflow as a separately-built `.mjs` capsule (via
`Bun.build({ format: "esm", target: "bun" })` and write to disk
somewhere outside any `node_modules` tree), OpenTUI's platform-native
loader fails to resolve at the capsule's runtime location:

```
[atomic-sdk:_orchestrator-entry] ResolveMessage: Cannot find module
  '@opentui/core-linux-x64/index.ts'
  from '/path/to/<wf>.mjs'
```

The capsule's bundled copy of `@opentui/core` includes a template-literal
dynamic import (`@opentui/core-${process.platform}-${process.arch}`).
Bun walks up from the capsule's directory looking for the platform
package, finds nothing, and the orchestrator subprocess exits 1.

## The fix

Externalize `@opentui/core` and its platform variants in your capsule
build. The SDK's `_orchestrator-entry` subprocess registers the host's
already-loaded `@opentui/core` via OpenTUI's runtime plugin, so the
bare specifier in your capsule resolves to the host's instance.

```ts
import { mkdirSync } from "node:fs";

await Bun.build({
  entrypoints: ["./workflows/my-wf.ts"],
  format: "esm",
  target: "bun",
  outdir: "./dist/workflows",
  external: [
    "@opentui/core",
    // Platform-native variants — every entry from
    // @opentui/core/package.json#optionalDependencies
    "@opentui/core-darwin-x64",
    "@opentui/core-darwin-arm64",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-win32-x64",
    "@opentui/core-win32-arm64",
  ],
});
```

`@opentui/core` covers the bare specifier and all subpaths
(`@opentui/core/testing`, etc.) via Bun's subpath inheritance. The
platform-native packages must be enumerated because Bun's `external`
treats only `*` as a wildcard.

If OpenTUI ships a new platform variant, that list goes stale and your
build will silently include the toxic dynamic import again. The
mitigation is to keep the externals list synchronised with
`@opentui/core/package.json#optionalDependencies` whenever you bump
the SDK's `@opentui/core` peer.

## Wiring the capsule into your host

The host references the capsule via the `source` field of the
`WorkflowDefinition` it hands to `runWorkflow`:

```ts
import { runWorkflow } from "@bastani/atomic-sdk";
import path from "node:path";

const capsulePath = path.join(
  path.dirname(process.execPath),
  "workflows",
  "my-wf.mjs",
);

const workflow = {
  __brand: "WorkflowDefinition" as const,
  name: "my-wf",
  agent: "claude" as const,
  description: "…",
  inputs: [/* … */],
  source: capsulePath,
  // (run, compose, etc. — re-imported from disk by the orchestrator subprocess)
} satisfies Pick<WorkflowDefinition, /* required keys */>;

await runWorkflow({ workflow, inputs: {} });
```

The orchestrator subprocess reads `source`, dynamic-imports the capsule
from disk, and executes it. The runtime plugin handles `@opentui/core`
resolution at import time.

## Why we don't recommend this

- **You're shipping more files.** A binary plus a `workflows/` directory
  is two things to keep in sync; one binary is one thing.
- **The externalize array rots.** OpenTUI's platform set is small today
  (six packages) but not frozen.
- **Hot-reload is rarely worth it.** Most workflow iteration happens at
  dev time via `bun run mycli.ts hello --prompt "..."`, where the file
  is already loaded fresh from disk every time.

If those costs are still worth it for your case, this is the supported
shape.
