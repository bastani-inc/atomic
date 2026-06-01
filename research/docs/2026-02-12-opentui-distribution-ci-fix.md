---
date: 2026-02-12 01:57:03 UTC
researcher: Copilot
git_commit: 0b82b59b160cee1290c5b3a4b7e3ea98d4248445
branch: lavaman131/hotfix/opentui-distribution
repository: atomic
topic: "OpenTUI Distribution & CI Publish Workflow Fix"
tags: [research, opentui, distribution, ci-cd, publishing, native-bindings]
status: complete
last_updated: 2026-02-12
last_updated_by: Copilot
---

# Research: OpenTUI Distribution & CI Publish Workflow Fix

## Research Question

Research the current way that OpenTUI is being distributed in the atomic TUI and understand how to fix it so CI deployment works. Reference the publishing failures in GitHub Actions run: https://github.com/bastani-inc/atomic/actions/runs/21928096164. Thoroughly reference how `sst/opencode` and `sst/opentui` handle this distribution.

## Summary

The CI publish workflow fails at the "Create config archives" step because it tries to copy `.github/agents`, `.github/hooks`, and `.github/scripts` directories that no longer exist. Only `.github/skills` and `.github/workflows` remain. The `package.json` `files` field also references these nonexistent directories. Both the workflow and the `files` field need updating to reflect the current `.github` directory structure (only `skills`). Additionally, `sst/opencode` and `sst/opentui` provide reference patterns for native binary distribution that atomic already partially follows.

## Detailed Findings

### 1. CI Publish Workflow Failure

**Failed Run**: https://github.com/bastani-inc/atomic/actions/runs/21928096164

**Job**: `Build Binaries` — Step: `Create config archives`

**Error**:

```
cp: cannot stat '.github/agents': No such file or directory
##[error]Process completed with exit code 1.
```

**Root Cause**: The workflow (`.github/workflows/publish.yml:77-102`) copies several `.github` subdirectories into a config-staging folder. These directories no longer exist:

| Directory           | Exists? | Referenced in workflow | Referenced in package.json `files` |
| ------------------- | ------- | ---------------------- | ---------------------------------- |
| `.github/agents`    | ❌ No   | Line 86                | Yes                                |
| `.github/hooks`     | ❌ No   | Line 87                | Yes                                |
| `.github/prompts`   | ❌ No   | Line 88 (suppressed)   | Yes                                |
| `.github/scripts`   | ❌ No   | Line 89                | Yes                                |
| `.github/skills`    | ✅ Yes  | Line 90                | Yes                                |
| `.github/workflows` | ✅ Yes  | Not copied             | Not in files                       |

**Current `.github` directory contents**:

```
.github/
├── dependabot.yml
├── skills/
│   ├── gh-commit/
│   └── gh-create-pr/
└── workflows/
    ├── ci.yml
    ├── claude.yml
    ├── code-review.yml
    ├── pr-description.yml
    └── publish.yml
```

### 2. Affected Configuration in `package.json`

**File**: `package.json` lines 22-33

```json
"files": [
  "src",
  ".claude",
  ".opencode",
  ".github/agents",     // ❌ Does not exist
  ".github/hooks",      // ❌ Does not exist
  ".github/prompts",    // ❌ Does not exist
  ".github/scripts",    // ❌ Does not exist
  ".github/skills",     // ✅ Exists
  "CLAUDE.md",
  "AGENTS.md"
]
```

### 3. OpenTUI Native Binding Distribution (Current Implementation)

**Dependencies** (`package.json` lines 58-59):

```json
"@opentui/core": "^0.1.79",
"@opentui/react": "^0.1.79"
```

**CI Cross-Platform Install** (`.github/workflows/publish.yml` lines 37-50):
The CI workflow uses `npm pack` to download platform-specific tarballs and bypasses OS/CPU platform checks:

```bash
OPENTUI_VERSION="0.1.79"
for platform in darwin-x64 darwin-arm64 linux-arm64 win32-x64 win32-arm64; do
  pkg="@opentui/core-${platform}"
  dest="node_modules/@opentui/core-${platform}"
  npm pack "${pkg}@${OPENTUI_VERSION}" --pack-destination /tmp
  tar -xzf "/tmp/opentui-core-${platform}-${OPENTUI_VERSION}.tgz" -C "$dest" --strip-components=1
done
```

**@opentui/core package.json** (`node_modules/@opentui/core/package.json` lines 55-66):
Platform packages are declared as `optionalDependencies`:

```json
{
    "@opentui/core-darwin-x64": "0.1.79",
    "@opentui/core-darwin-arm64": "0.1.79",
    "@opentui/core-linux-x64": "0.1.79",
    "@opentui/core-linux-arm64": "0.1.79",
    "@opentui/core-win32-x64": "0.1.79",
    "@opentui/core-win32-arm64": "0.1.79"
}
```

Each platform package has `os` and `cpu` fields that cause npm/bun to skip installation on non-matching platforms. The CI workaround manually installs all 6 to enable cross-platform `bun build --compile`.

**Compiled Binary Targets** (`.github/workflows/publish.yml` lines 58-75):

- `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`

### 4. Source Code OpenTUI Usage

Key imports across the codebase:

| File                                          | Imports                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/ui/index.ts`                             | `createCliRenderer` from `@opentui/core`, `createRoot` from `@opentui/react`                                  |
| `src/ui/chat.tsx`                             | `useKeyboard`, `useRenderer`, `flushSync`, `useTerminalDimensions`, `MacOSScrollAccel`, `SyntaxStyle`, `RGBA` |
| `src/ui/theme.tsx`                            | `SyntaxStyle`, `RGBA` from `@opentui/core`                                                                    |
| `src/ui/code-block.tsx`                       | `SyntaxStyle` from `@opentui/core`                                                                            |
| `src/ui/components/autocomplete.tsx`          | `KeyEvent`, `ScrollBoxRenderable`, `useTerminalDimensions`                                                    |
| `src/ui/components/user-question-dialog.tsx`  | `KeyEvent`, `TextareaRenderable`, `ScrollBoxRenderable`, `useKeyboard`, `useTerminalDimensions`               |
| `src/ui/components/model-selector-dialog.tsx` | `KeyEvent`, `ScrollBoxRenderable`, `useKeyboard`, `useTerminalDimensions`                                     |

### 5. How sst/opentui Handles Distribution

**Source**: DeepWiki (https://deepwiki.com/sst/opentui)

**Architecture**: TypeScript + Zig native layer with FFI via `Bun.dlopen()`

**Build Pipeline** (`packages/core/scripts/build.ts`):

1. Defines 6 platform variants (darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64, win32-arm64)
2. Runs `zig build` with cross-compilation for each target
3. Copies compiled `.dylib`/`.so`/`.dll` to `node_modules/@opentui/core-{platform}-{arch}/`
4. Generates `index.ts` exporting the library path
5. Generates `package.json` with `"os"` and `"cpu"` fields

**Runtime Resolution** (`packages/core/src/zig.ts`):

```typescript
const module = await import(
    `@opentui/core-${process.platform}-${process.arch}/index.ts`
);
let targetLibPath = module.default;
// Loads via Bun.dlopen() as singleton
```

**Release Workflow** (`release.yml`):

1. `prepare` — extracts version from git tag
2. `validate-version` — ensures tag matches `package.json` versions
3. `build-native` — cross-compiles Zig for all 6 platforms
4. `npm-publish` — publishes all packages to npm
5. `github-release` — creates GitHub release with binary assets

**Publishing** (`packages/core/scripts/publish.ts`):
Publishes `@opentui/core` then iterates `optionalDependencies` to publish all platform packages via `npm publish --access=public`.

### 6. How sst/opencode Handles Distribution

**Source**: DeepWiki (https://deepwiki.com/sst/opencode)

**Distribution Channels**:

- Quick install script: `curl -fsSL https://opencode.ai/install | bash`
- NPM: `opencode-ai` package with platform-specific `optionalDependencies`
- Package managers: Homebrew, AUR, Scoop, Chocolatey, Mise
- Docker: Multi-architecture images on GitHub Container Registry
- Desktop: Tauri-based platform-specific installers

**NPM Package Structure**:

- Main package `opencode-ai` includes a `postinstall.mjs` script
- `postinstall.mjs` selects the correct platform-specific binary from `optionalDependencies`
- `bin` field points to the `opencode` executable
- Platform-specific binary packages are published as separate npm packages

**Publishing Pipeline** (`publish.yml`):

1. `version` — determines version from `./script/version.ts`
2. `build-cli` — compiles CLI for all targets via `packages/opencode/script/build.ts`
3. `build-tauri` — builds desktop apps via matrix strategy
4. `publish` — runs `packages/opencode/script/publish.ts` (handles npm, Docker, AUR, Homebrew)

**Install Script Logic**:

1. Detects OS and architecture
2. Constructs download URL (e.g., `opencode-linux-x64.tar.gz`)
3. Downloads and extracts archive
4. Moves binary to install directory (respects `$OPENCODE_INSTALL_DIR`, `$XDG_BIN_DIR`, `$HOME/bin`, or `$HOME/.opencode/bin`)
5. Updates PATH in shell config files

**Handling Native Dependencies** (like opentui):

- OpenCode uses the same `optionalDependencies` pattern from `@opentui/core`
- Only the matching platform package is installed at `npm install` time
- The `packages/opencode/bin/opencode` script resolves the correct binary based on platform and architecture within `node_modules`

## Code References

- `.github/workflows/publish.yml:86` — `cp -r .github/agents config-staging/.github/` (fails, directory missing)
- `.github/workflows/publish.yml:87` — `cp -r .github/hooks config-staging/.github/` (would fail)
- `.github/workflows/publish.yml:89` — `cp -r .github/scripts config-staging/.github/` (would fail)
- `.github/workflows/publish.yml:37-50` — OpenTUI cross-platform native binding installation
- `package.json:22-33` — `files` field with stale directory references
- `package.json:58-59` — OpenTUI core and react dependencies
- `install.sh` — Binary distribution install script
- `install.ps1` — Windows binary distribution install script

## Architecture Documentation

### Distribution Flow

1. **npm publish**: Publishes `@bastani/atomic` with `files` listed in `package.json` (source + config)
2. **Binary build**: CI compiles platform-specific binaries via `bun build --compile --target=bun-{platform}`
3. **Config archives**: CI creates `atomic-config.tar.gz` and `atomic-config.zip` with agent config files
4. **GitHub Release**: Uploads binaries + config archives + checksums
5. **Install scripts**: `install.sh`/`install.ps1` download platform binaries and config from GitHub releases

### Native Binding Pattern (from sst/opentui and sst/opencode)

Both upstream projects follow this pattern for native binary distribution:

- Main package declares platform packages as `optionalDependencies`
- Each platform package has `os` and `cpu` fields in `package.json`
- npm/bun skips non-matching platform packages at install time
- CI explicitly installs all platform packages to enable cross-compilation
- Runtime resolution: `import(@opentui/core-${process.platform}-${process.arch})`

## Historical Context (from research/)

- `research/docs/2026-01-21-binary-distribution-installers.md` — Complete binary distribution strategy with install script templates, SHA256 verification, PATH management
- `research/docs/2026-01-20-cross-platform-support.md` — Cross-platform implementation patterns, Windows compatibility issues identified
- `research/docs/2026-01-31-opentui-library-research.md` — Comprehensive OpenTUI library research (architecture, components, known limitations)

## Related Research

- `research/docs/2026-01-21-binary-distribution-installers.md`
- `research/docs/2026-01-20-cross-platform-support.md`
- `research/docs/2026-01-31-opentui-library-research.md`

## Open Questions

1. Should a `commands/` folder be added to `.github/` alongside `skills/` (user mentioned "skills and commands folders")?
2. Should the OpenTUI version in the CI workflow (`OPENTUI_VERSION="0.1.79"`) be dynamically read from `package.json` or `bun.lock` instead of hardcoded?
3. Should the `atomic-config.tar.gz`/`.zip` archive contents be updated to match only the currently existing config directories?
