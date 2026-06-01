# Atomic Monorepo — Development Setup

This document covers setup, the local dev loop, testing patterns, and project layout for working on the Atomic Bun workspace. The workflow extension lives at [`packages/workflows`](./packages/workflows/README.md), and the Atomic-branded coding-agent fork lives at [`packages/coding-agent`](./packages/coding-agent/README.md).

---

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.3.14** — runtime, package manager, and test runner

This repo uses **Bun** for all development, scripts, and testing. The `@bastani/workflows` workspace package ships raw `.ts` files with no build step; Atomic bundles it into `@bastani/atomic` during the coding-agent build.

---

## Setup

```bash
git clone git@github.com:bastani-inc/atomic.git
cd atomic
bun install
```

`bun install` runs the root `prepare` script, which installs Git hooks with [`prek`](https://prek.j178.dev/) from [`prek.toml`](./prek.toml). The hook shims installed by default come from `default_install_hook_types`; currently that is `pre-commit`. To reinstall hooks manually, run `bun run hooks:install`. Set `PREK_DISABLE_INSTALL=1` to skip hook installation for a local install; CI skips it automatically.

The root `package.json` is a private workspace package named `atomic-monorepo`. The only publishable package is `packages/coding-agent` (`@bastani/atomic`); other `packages/*` workspaces are bundled or internal.

---

## Running the Atomic coding-agent from source

The `packages/coding-agent` package is the Atomic-branded fork of pi's coding-agent CLI. In this repo its CLI name is `atomic`, its config directory is `~/.atomic/agent`, and its environment variable prefix is `ATOMIC_`.

For most local development, run the TypeScript entrypoint directly with Bun from the workspace root:

```bash
bun packages/coding-agent/src/cli.ts --help
bun packages/coding-agent/src/cli.ts
```

For a one-shot non-interactive prompt:

```bash
bun packages/coding-agent/src/cli.ts -p "List files in this repo"
```

The direct source command is the recommended dev loop because it avoids generating `dist/` and resolves package assets from `src/`.

If you need to exercise the compiled package layout, use the coding-agent watch script in one terminal:

```bash
bun --cwd packages/coding-agent run dev
```

After the first emit, run the compiled CLI from another terminal:

```bash
bun packages/coding-agent/dist/cli.js --help
bun packages/coding-agent/dist/cli.js
```

To run the development CLI against a different working directory while keeping source in this checkout:

```bash
cd /path/to/target/project
bun /path/to/atomic/packages/coding-agent/src/cli.ts
```

For a production-style build, run:

```bash
bun --cwd packages/coding-agent run build
```

---

## Local dev loop with atomic

The extension entrypoint is now:

```text
packages/workflows/src/extension/index.ts
```

Three options, from heaviest to lightest:

### A. `atomic plugin install` against the local package path (persisted)

```bash
atomic plugin install -l "$PWD/packages/workflows"   # project-local
# or
atomic plugin install    "$PWD/packages/workflows"   # global
```

atomic adds the absolute package path to its settings file and resolves the package's `atomic` manifest. From inside atomic, `/reload` re-imports the extension after you edit source — no restart needed.

### B. One-off load with `-e` (no settings write)

```bash
atomic -e "$PWD/packages/workflows/src/extension/index.ts"
```

The fastest iteration loop. Combine with `--no-extensions` to isolate the extension under test:

```bash
atomic --no-extensions \
   -e "$PWD/packages/workflows/src/extension/index.ts" \
   "/workflow list"
```

### C. Symlink into the extensions directory

```bash
mkdir -p ~/.atomic/agent/extensions
ln -s "$PWD/packages/workflows" ~/.atomic/agent/extensions/workflows
```

Useful when you want the extension persisted globally but don't want atomic to track it in settings.

---

## Commands

Run these from the workspace root:

| Command                    | Description                                                      |
| -------------------------- | ---------------------------------------------------------------- |
| `bun run typecheck`        | Type-check the workspace                                         |
| `bun test`                 | Run unit tests                                                   |
| `bun run test:unit`        | Run unit tests                                                   |
| `bun run test:integration` | Run integration tests                                            |
| `bun run test:all`         | Run both unit + integration                                      |
| `bun run lint`             | Alias for typecheck                                              |
| `bun run hooks:install`    | Install `prek.toml` Git hooks using `default_install_hook_types` |
| `bun run hooks:run`        | Run all `prek.toml` hooks across the repository                  |

Both `typecheck` and `lint` run `tsc --noEmit`. There is no separate ESLint pipeline. Git hook configuration lives in [`prek.toml`](./prek.toml), not `.pre-commit-config.yaml`.

---

## Testing patterns

All tests use **Bun's built-in `bun:test` runner** with `node:assert/strict` assertions.

### Unit tests (`test/unit/*.test.ts`)

Pure-TS tests against modules in `packages/workflows/src/`. They mock pi's `ExtensionAPI` surface with hand-built fakes — fast, deterministic, no pi runtime in the loop.

Run: `bun run test:unit`.

### Integration tests (`test/integration/*.test.ts`)

Higher-fidelity tests that compose multiple modules (runtime, wiring, overlay) and exercise the extension factory against a structural mock of `ExtensionAPI`. Still no real pi process — but they cover end-to-end registration, lifecycle, and overlay paths.

Run: `bun run test:integration`.

### Improved coverage with pi's SDK

pi exposes `DefaultResourceLoader.extensionFactories` for in-process extension injection:

```ts
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    getAgentDir,
} from "@bastani/atomic";
import factory from "./packages/workflows/src/extension/index.ts";

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

---

## Running examples

```bash
bun examples/hello-world.ts
bun examples/parallel-fan-out.ts
```

Examples import the workspace package `@bastani/workflows`.

---

## Project layout

```text
.
├── package.json                         # private workspace root: atomic-monorepo
├── packages/
│   ├── coding-agent/                    # @bastani/atomic CLI fork
│   └── workflows/
│       ├── package.json                 # private bundled @bastani/workflows metadata
│       ├── src/
│       │   ├── extension/               # atomic extension entry point, commands, tools, hooks
│       │   ├── intercom/                # intercom adapter
│       │   ├── runs/                    # foreground/background workflow execution
│       │   ├── shared/                  # store, store-types, types, persistence helpers
│       │   ├── tui/                     # widget and DAG overlay renderers
│       │   ├── workflows/               # defineWorkflow, registry, identity helpers
│       │   └── index.ts                 # public entry point
│       ├── workflows/                   # bundled workflow definitions
│       ├── skills/                      # bundled atomic skills
│       ├── agents/                      # bundled agent definitions
│       ├── themes/                      # bundled themes
│       └── README.md
├── test/
│   ├── unit/
│   ├── integration/
│   └── support/
├── examples/
├── docs/
├── scripts/
├── bunfig.toml
└── tsconfig.json
```

---

## Best practices

- **Source files use `.js` import extensions** (TypeScript ESM convention). The repo ships as `.ts` files; Bun resolves `.js` specifiers to `.ts` sources directly.
- **Avoid `any` and `unknown`.** Use specific types. The codebase compiles with `strict`, `noUnusedLocals`, and `noUnusedParameters`.
- **Keep the root package private.** The only publishable workspace package is `packages/coding-agent` (`@bastani/atomic`).
- **Keep `packages/workflows` private.** It is bundled into `@bastani/atomic`; do not publish it independently.
- **Do not add a build step** for `@bastani/workflows`; it ships raw TypeScript/resources into the Atomic bundle.
- **Track in-progress fixes in `issues.md`.** Delete the file once issues are resolved.

---

## Releasing

Atomic uses a tag-driven release flow: push a `v<version>` git tag and CI cross-compiles binaries, publishes to npm with OIDC provenance, and creates the GitHub Release with binaries attached.

### Workflow

1. Run `bun run scripts/bump-version.ts <version>` (e.g. `0.8.0` or `0.8.0-0`), then `bun install`.
2. Move the `[Unreleased]` section in `packages/coding-agent/CHANGELOG.md` to a new `## [<version>] - <YYYY-MM-DD>` section. CI extracts release notes from this section.
3. Run `bun run typecheck`, `cd packages/coding-agent && bun run build`, and `bun run test:all`.
4. Commit `packages/*/package.json`, `packages/*/README.md`, `packages/coding-agent/CHANGELOG.md`, and `bun.lock` with `chore(release): bump to v<version>`.
5. Tag and push:
    ```sh
    git tag v<version>
    git push origin main
    git push origin v<version>
    ```
6. The tag push triggers `.github/workflows/publish.yml`, which publishes `@bastani/atomic` to npm with OIDC provenance and creates the GitHub Release with six binary archives attached (darwin/linux/windows × arm64/x64).

Bun is the development/test/runtime path. **npm is still the registry publication tool** because npm's provenance flow signs the published tarball via OIDC. Provenance is enabled in CI; no `NPM_TOKEN` is needed.

---

## CI

CI runs typecheck and `test:all` on PRs via Bun. See [docs/ci.md](./docs/ci.md) and `.github/workflows/test.yml`.
