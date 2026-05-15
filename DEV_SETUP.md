# @bastani/atomic-workflows — Development Setup

This document covers setup, the local dev loop, testing patterns, and project layout for working on `@bastani/atomic-workflows`. End users should start with the [README](./README.md).

---

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3.14** — the runtime, package manager, and test runner for this repo
- **[pi](https://github.com/earendil-works/pi)** — the host that loads the extension

This repo uses **Bun** for all development, scripts, and testing.

The package ships raw `.ts` files with no build step. Do not introduce `dist/`, `tsconfig.build.json`, `outDir`, or bundling. pi imports the extension modules directly with Bun; tests run via Bun's built-in `bun:test` runner.

---

## Setup

```bash
git clone git@github.com:flora131/atomic.git
cd atomic
bun install
```

`bun install` reads `bunfig.toml` for repo-wide settings (textual lockfile, hoisted linker, exact versions).

---

## Local dev loop with pi

Three options, from heaviest to lightest:

### A. `pi plugin install` against the local path (persisted)

```bash
pi plugin install -l "$PWD"   # project-local
# or
pi plugin install    "$PWD"   # global
```

pi adds the absolute path to its settings file and resolves the package's `pi` manifest. From inside pi, `/reload` re-imports the extension after you edit source — no restart needed.

### B. One-off load with `-e` (no settings write)

```bash
pi -e "$PWD/src/extension/index.ts"
```

The fastest iteration loop. Combine with `--no-extensions` to isolate the extension under test:

```bash
pi --no-extensions \
   -e "$PWD/src/extension/index.ts" \
   "/workflow list"
```

Pass an initial prompt at the end to drive a single command and exit (works with `-p` for print mode).

### C. Symlink into the extensions directory

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/workflows
```

Useful when you want the extension persisted globally but don't want pi to track it in settings.

> pi's docs call out `pi -e <path>` as the recommended path for "quick tests" and `pi plugin install` / auto-discovered locations as the path for resources that need `/reload` hot-reload. See [pi extension-loading docs](https://github.com/earendil-works/pi/blob/main/docs/extension-loading.md).

---

## Commands

| Command                    | Description                 |
| -------------------------- | --------------------------- |
| `bun run typecheck`        | Type-check the package      |
| `bun test`                 | Run unit tests              |
| `bun run test:unit`        | Run unit tests              |
| `bun run test:integration` | Run integration tests       |
| `bun run test:all`         | Run both unit + integration |
| `bun run lint`             | Alias for typecheck         |

Both `typecheck` and `lint` run `tsc --noEmit`. There is no separate ESLint pipeline.

---

## Testing patterns

All tests use **Bun's built-in `bun:test` runner** with `node:assert/strict` assertions. Two tiers:

### Unit tests (`test/unit/*.test.ts`)

Pure-TS tests against modules in `src/`. They mock pi's `ExtensionAPI` surface with hand-built fakes — fast, deterministic, no pi runtime in the loop.

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";

test("dispatcher rejects unknown workflow", async () => {
  const result = await dispatcher.dispatch({ name: "missing", action: "run" });
  assert.equal(result.status, "failed");
});
```

Run: `bun run test:unit`.

### Integration tests (`test/integration/*.test.ts`)

Higher-fidelity tests that compose multiple modules (runtime, wiring, overlay) and exercise the extension factory against a structural mock of `ExtensionAPI`. Still no real pi process — but they cover end-to-end registration, lifecycle, and overlay paths.

Run: `bun run test:integration`.

### Improved coverage with pi's SDK (recommended for new end-to-end tests)

pi exposes `DefaultResourceLoader.extensionFactories` for in-process extension injection. This is the highest-fidelity test path short of spawning a real `pi` process:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import factory from "../src/extension/index.ts";

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [factory],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
});
```

This pattern lets you assert against pi's real `ExtensionAPI`, real command dispatch, real tool registration, and real event bus — no manual mocks. It's the canonical pi pattern documented under `docs/` in [`can1357/pi`](https://github.com/earendil-works/pi).

Add an integration test that exercises this for the `workflow` tool + `/workflow list` slash command and you'll catch ExtensionAPI shape drift before it ships.

### Quiet output for AI agents

Bun's reporter is already terse. To shrink output further, target a single file or filter by test name:

```bash
bun test test/unit/registry.test.ts
bun test --test-name-pattern "dispatch"
```

---

## Running examples

```bash
bun examples/hello-world.ts
bun examples/parallel-fan-out.ts
```

Bun resolves `.js` import specifiers to the underlying `.ts` source files directly — no loader hook required.

---

## Project layout

```
.
├── src/
│   ├── extension/           # pi extension entry point: tool, slash commands, hooks
│   ├── intercom/            # pi-intercom adapter (HIL for detached runs)
│   ├── runs/
│   │   ├── foreground/      # Synchronous executor and stage runner
│   │   ├── background/      # Detached runner, cancellation registry, status helpers
│   │   └── shared/          # Concurrency, graph-inference, validation, workflow runner
│   ├── shared/              # store, store-types, types, persistence-{compaction,restore,session-entries}
│   ├── tui/                 # Above-editor widget and DAG overlay
│   ├── workflows/           # defineWorkflow, createRegistry, identity helpers
│   └── index.ts             # Public entry point
├── workflows/               # Bundled workflow definitions
│   ├── deep-research-codebase.ts
│   ├── ralph.ts
│   ├── open-claude-design.ts
│   └── index.ts
├── test/
│   ├── unit/                # Unit tests
│   ├── integration/         # Integration tests
│   └── support/             # helpers.ts
├── examples/                # Runnable standalone examples
├── bunfig.toml
├── package.json
└── tsconfig.json
```

---

## Best practices

- **Source files use `.js` import extensions** (TypeScript ESM convention). The repo ships as `.ts` files; Bun resolves `.js` specifiers to `.ts` sources directly — both pi's loader and `bun test` follow the same convention. Do not break this.
- **Avoid `any` and `unknown`.** Use specific types. The codebase compiles with `strict`, `noUnusedLocals`, `noUnusedParameters`.
- **Mirror pi extension conventions.** When in doubt about a structural choice (extension shape, manifest layout, file naming), check [`can1357/pi`](https://github.com/earendil-works/pi) (especially `packages/swarm-extension`) first — both extensions follow the same ship-as-source pattern.
- **Track in-progress fixes in `issues.md`.** Delete the file once issues are resolved to keep the repo clean.

---

## Releasing

### Branch naming

- Release: `release/v<major>.<minor>.<patch>` (e.g. `release/v0.1.1`)
- Prerelease: `prerelease/v<major>.<minor>.<patch>-<prerelease>` (e.g. `prerelease/v0.1.1-0`)

### Workflow

1. Create a branch following the naming convention above.
2. Edit `package.json` to set the target version.
3. Commit with the message `chore(release): bump to v<version>`.
4. Open a PR to `main`.
5. Once merged, publish with `npm publish --provenance`.

Bun is the development/test/runtime path. **npm is still the registry publication tool** because npm's provenance flow signs the published tarball via OIDC. Provenance is enabled in CI; no `NPM_TOKEN` is needed for OIDC-authenticated publishes. If you see steps configuring `NPM_TOKEN` / `NODE_AUTH_TOKEN` for publishing, they are mistakes — remove them.

---

## CI

CI runs typecheck and `test:all` on PRs via Bun. See `.github/workflows/test.yml`.

---

## Known issues

- Track in-progress fixes in `issues.md` if you encounter test ordering or shared-state issues that Bun exposes; fix them at the source rather than papering over with retries.
