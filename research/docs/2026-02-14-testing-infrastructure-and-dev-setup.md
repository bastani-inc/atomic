---
date: 2026-02-14 23:27:39 UTC
researcher: Copilot CLI
git_commit: 66590e164ec3aaae8603a8b3c5d362f53da835db
branch: lavaman131/feature/testing
repository: atomic
topic: "Robust testing infrastructure, pre-commit hooks, and developer setup for Atomic CLI"
tags: [research, testing, coverage, pre-commit, bun, dev-setup, contributing]
status: complete
last_updated: 2026-02-14
last_updated_by: Copilot CLI
---

# Research: Testing Infrastructure & Developer Setup for Atomic CLI

## Research Question

Research the codebase to design a robust testing environment that tests core TUI components (not trivial behavior), configure pre-commit hooks with >85% coverage threshold using Bun best practices, and plan a DEV_SETUP.md linked from README.md in a "Contributing Guide" section.

## Summary

The Atomic CLI has **5 test files covering ~5% of 101+ source files** with 20 passing tests and 51 assertions. An additional ~104 tests existed previously but became stale and were removed/disabled. The existing tests are well-written — they test real behavior like filesystem operations, data transformations, error handling, and SDK snapshot building. However, vast portions of the codebase (graph engine, config system, SDK adapters, command registry, formatters) have zero test coverage. Tests are disabled in CI (`ci.yml:38-40`). No coverage tooling, pre-commit hooks, or `bunfig.toml` configuration exists. This document provides a complete blueprint for building a production-grade testing environment.

---

## Detailed Findings

### 1. Current Test Suite Audit

#### Existing Test Files (5 files, 20 tests, 51 assertions)

| File                                                                                                                                                                                   | Tests | Assertions | What It Tests                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`src/commands/init.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/commands/init.test.ts)                                           | 3     | 11         | `reconcileScmVariants` — real filesystem I/O with tmpdir, file creation/deletion, SCM variant filtering                                                |
| [`src/ui/utils/mcp-output.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/mcp-output.test.ts)                               | 8     | 17         | `applyMcpServerToggles`, `getActiveMcpServers`, `buildMcpSnapshotView` — toggle overrides, filtering, sorting, secret masking, tool name normalization |
| [`src/ui/utils/hitl-response.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/hitl-response.test.ts)                         | 5     | 8          | `normalizeHitlAnswer`, `getHitlResponseRecord` — HITL response normalization, legacy/structured field extraction                                       |
| [`src/ui/utils/transcript-formatter.hitl.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/transcript-formatter.hitl.test.ts) | 1     | 2          | `formatTranscript` — renders HITL response text instead of raw JSON                                                                                    |
| [`src/sdk/opencode-client.mcp-snapshot.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/sdk/opencode-client.mcp-snapshot.test.ts)     | 3     | 13         | `buildOpenCodeMcpSnapshot` — snapshot building from mocked SDK client, partial success, complete failure                                               |

**Quality Assessment**: The existing tests are structurally sound — they test real behavior (filesystem mutations, data transformations, error cascades), use proper fixtures (tmpdir with try/finally cleanup, typed mock objects), and cover edge cases (empty inputs, partial failures, null returns). They do NOT test trivial behavior.

#### Previously Existing Tests (Now Stale/Removed)

Per [`research/docs/2026-02-12-bun-test-failures-root-cause-analysis.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/research/docs/2026-02-12-bun-test-failures-root-cause-analysis.md), 104 additional tests failed across 6 categories because **source code evolved but tests were not updated**. These tests were in `tests/` directories (now removed). Categories included:

- Agent `model` field mismatches (30 tests)
- `sentMessages` tracking after `spawnSubagent` refactor (20 tests)
- Theme color palette migration from Tailwind to Catppuccin (12 tests)
- Tool renderer icon changes from emoji to Unicode (8 tests)
- Claude SDK `createSession`/`query` refactor (6 tests)
- Misc UI test drift (8 tests)

---

### 2. Testing Anti-Patterns Identified

Based on the testing-anti-patterns analysis of the codebase:

#### Anti-Pattern 1: Substring Matching on Rendered Output

**File**: [`src/ui/utils/transcript-formatter.hitl.test.ts:34-35`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/transcript-formatter.hitl.test.ts#L34-L35)

```typescript
expect(rendered).toContain('User answered: ""');
expect(rendered).not.toContain('{"answer"');
```

**Issue**: Substring matching on concatenated rendered output is fragile — it tests presentation details rather than the data transformation. If the renderer changes whitespace, ordering, or wrapping, the test breaks even if the logic is correct.
**Better approach**: Test the structured data returned by `formatTranscript` (the `lines` array) rather than joining and grepping the string output.

#### Anti-Pattern 2: Testing Private Internals via Type Casting

**File**: [`src/sdk/opencode-client.mcp-snapshot.test.ts:12-14`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/sdk/opencode-client.mcp-snapshot.test.ts#L12-L14)

```typescript
const client = new OpenCodeClient({ directory: "/tmp/project" });
const harness = client as unknown as OpenCodeSnapshotHarness;
harness.sdkClient = {
    /* mock */
};
```

**Issue**: Reaching into private internals via `as unknown as` creates coupling to implementation details. If the class restructures its internals, tests break even if public behavior is unchanged.
**Mitigation**: This is partially justified here because `buildOpenCodeMcpSnapshot` is a core data transformation worth testing in isolation. Consider extracting the snapshot-building logic into a standalone pure function.

#### Anti-Pattern 3: Tests That Went Stale (Historical)

The 104 failed tests documented in the root cause analysis represent the classic anti-pattern of **tests coupled to implementation details** (color hex values, emoji characters, internal method call counts) rather than behavioral contracts. When the implementation evolved, the tests became noise rather than safety nets.

#### Anti-Pattern 4: No Test Isolation Infrastructure

There is no test setup/teardown infrastructure (`beforeAll`, `afterAll`, `beforeEach`, `afterEach`), no preload scripts, and no shared test utilities. Each test file creates its own fixtures from scratch. This is acceptable at the current scale (5 files) but will not scale.

---

### 3. Untested Core Components (Prioritized by Testability)

#### Tier 1: Pure Functions & Data Transformers (Highest Value, Easiest to Test)

| Module                                                                                                                                                 | Key Testable Functions                                             | Why It Matters                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| [`src/graph/types.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/types.ts)                         | Type guards (`isGraphNode`, `isConditionalEdge`, etc.)             | Core workflow engine — wrong type guards = wrong routing       |
| [`src/graph/annotation.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/annotation.ts)               | Annotation reducers (merge, replace, append strategies)            | State management for the graph engine                          |
| [`src/ui/utils/format.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/format.ts)                 | `truncateText`, `formatDuration`, `formatRelativeTime`, `wrapText` | User-facing display logic — wrong output = broken UI           |
| [`src/sdk/tools/schema-utils.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/sdk/tools/schema-utils.ts)   | JSON Schema ↔ Zod conversions, schema merging                      | Tool integration foundation — wrong conversions = broken tools |
| [`src/models/model-operations.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/models/model-operations.ts) | Model list filtering, cost calculations, capability checks         | Model selection logic                                          |
| [`src/utils/platform.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/utils/platform.ts)                   | `isWindows`, `isMac`, `isLinux`, platform path resolution          | Cross-platform correctness                                     |
| [`src/config/index.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/config/index.ts)                       | Config loading, merging, validation, default generation            | Project setup correctness                                      |

#### Tier 2: State Machines & Builders (Medium Complexity)

| Module                                                                                                                                                           | Key Testable Logic                                      | Why It Matters                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| [`src/graph/builder.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/builder.ts)                               | Graph construction, edge wiring, node registration      | Workflow definition correctness |
| [`src/graph/compiled.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/compiled.ts)                             | Graph execution, state transitions, conditional routing | Core runtime engine             |
| [`src/ui/commands/registry.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/commands/registry.ts)                 | Command registration, lookup, alias resolution          | Command system foundation       |
| [`src/ui/commands/builtin-commands.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/commands/builtin-commands.ts) | Command execution, argument parsing                     | All user slash commands         |
| [`src/ui/tools/registry.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/tools/registry.ts)                       | Tool renderer lookup, icon/label resolution             | Tool display in TUI             |

#### Tier 3: Integration Points (Require Mocking)

| Module                                                                                                                                       | Key Testable Logic                               | Why It Matters        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| [`src/sdk/unified-client.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/sdk/unified-client.ts) | Unified SDK interface routing to correct backend | Multi-agent support   |
| [`src/commands/init.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/commands/init.ts)           | Config file generation, agent detection          | Project setup flow    |
| [`src/telemetry/events.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/telemetry/events.ts)     | Event construction, payload validation           | Telemetry correctness |

---

### 4. Pre-Commit Hook Configuration

#### Bun Coverage Capabilities

Bun has production-ready built-in coverage support:

- **CLI**: `bun test --coverage`
- **Reporters**: `text` (console table) and `lcov` (standard format for CI/Codecov)
- **Thresholds**: Configurable via `bunfig.toml` — fails with non-zero exit if below threshold
- **Configuration**: All options in `[test]` section of `bunfig.toml`

**References**:

- [Bun Test Coverage Docs](https://bun.sh/docs/test/coverage)
- [Bun Test Configuration](https://bun.sh/docs/runtime/bunfig#test-runner)

#### Recommended: `bunfig.toml` Configuration

```toml
[test]
# Coverage
coverage = true
coverageThreshold = { lines = 0.85, functions = 0.85 }
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
coverageSkipTestFiles = true
coveragePathIgnorePatterns = [
  "src/cli.ts",
  "src/version.ts"
]

# Execution
timeout = 10000
```

#### Pre-Commit Hook Options

| Tool             | Language | Parallel | File Filtering    | Bun Compatible | Recommended      |
| ---------------- | -------- | -------- | ----------------- | -------------- | ---------------- |
| **Lefthook**     | Go       | ✅ Yes   | ✅ Built-in globs | ✅ Yes         | ✅ Best fit      |
| **Husky**        | Node.js  | ❌ No    | Manual            | ✅ Yes         | ✅ Alternative   |
| **Shell script** | POSIX    | ❌ No    | Manual            | ✅ Yes         | ❌ Not shareable |

**Recommended approach: Lefthook** — fast (Go binary), parallel execution, glob-based file filtering, version-controlled config.

```bash
bun add --dev lefthook
bunx lefthook install
```

**`lefthook.yml`**:

```yaml
pre-commit:
    parallel: true
    commands:
        typecheck:
            run: bun run typecheck
        lint:
            glob: "*.{ts,tsx}"
            run: bun run lint
        test:
            run: bun test --bail

pre-push:
    commands:
        test-coverage:
            run: bun test --coverage
```

#### CI Integration Update

The current `ci.yml` has tests commented out (`# TODO: Re-enable after fixing failing tests`). The updated CI should:

```yaml
- name: Run tests with coverage
  run: bun test --coverage --coverage-reporter=lcov

- name: Upload coverage
  uses: codecov/codecov-action@v3
  with:
      file: ./coverage/lcov.info
```

---

### 5. DEV_SETUP.md Plan

#### Proposed Structure

```markdown
# Developer Setup

## Prerequisites

- Bun (latest)
- Git
- At least one coding agent CLI installed

## Getting Started

1. Clone and install
2. Install git hooks (lefthook)
3. Run tests

## Development Commands

- bun test / bun test --coverage
- bun run typecheck
- bun run lint / bun run lint:fix
- bun run dev

## Testing

### Running Tests

### Writing Tests

### Coverage Requirements (>85%)

### Testing Anti-Patterns to Avoid

## Pre-Commit Hooks

### What Runs

### Skipping Hooks (emergency)

## Project Structure

- Brief src/ module map

## CI/CD

- What CI checks run on PRs
```

#### README.md Integration

Add after the "FAQ" section and before "License":

```markdown
## Contributing Guide

See [DEV_SETUP.md](DEV_SETUP.md) for development setup, testing guidelines, and contribution workflow.
```

The Table of Contents at line 97-113 should be updated to include:

```markdown
- [Contributing Guide](#contributing-guide)
```

---

### 6. Current Build & Tooling Configuration

| Tool                   | Status                  | Configuration                                                         |
| ---------------------- | ----------------------- | --------------------------------------------------------------------- |
| **Bun test runner**    | ✅ Available, no config | `bun test` (no `bunfig.toml`)                                         |
| **TypeScript**         | ✅ Strict mode          | `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess: true`    |
| **Oxlint**             | ✅ Active               | `oxlint.json` — correctness errors, `*.test.ts` excluded from linting |
| **Prettier/formatter** | ❌ Not configured       | No formatting tool                                                    |
| **Coverage**           | ❌ Not configured       | No `bunfig.toml`, no coverage in scripts                              |
| **Pre-commit hooks**   | ❌ Not configured       | No husky/lefthook/git hooks                                           |
| **CI tests**           | ⚠️ Disabled             | `ci.yml:38-40` commented out; runs in `publish.yml` only              |
| **`bunfig.toml`**      | ❌ Does not exist       | All Bun defaults                                                      |

---

## Code References

### Existing Test Files

- [`src/commands/init.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/commands/init.test.ts) — SCM variant reconciliation (3 tests)
- [`src/ui/utils/mcp-output.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/mcp-output.test.ts) — MCP display utilities (8 tests)
- [`src/ui/utils/hitl-response.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/hitl-response.test.ts) — HITL response normalization (5 tests)
- [`src/ui/utils/transcript-formatter.hitl.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/transcript-formatter.hitl.test.ts) — Transcript HITL rendering (1 test)
- [`src/sdk/opencode-client.mcp-snapshot.test.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/sdk/opencode-client.mcp-snapshot.test.ts) — OpenCode MCP snapshot (3 tests)

### Key Source Files for New Tests

- [`src/graph/types.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/types.ts) — Type guards for workflow engine
- [`src/graph/annotation.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/annotation.ts) — Annotation reducers
- [`src/graph/builder.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/builder.ts) — Graph construction
- [`src/graph/compiled.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/graph/compiled.ts) — Graph execution engine
- [`src/ui/utils/format.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/utils/format.ts) — Formatters (truncate, duration, relative time)
- [`src/ui/commands/registry.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/ui/commands/registry.ts) — Command registration/lookup
- [`src/sdk/tools/schema-utils.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/sdk/tools/schema-utils.ts) — Schema conversions
- [`src/config/index.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/config/index.ts) — Config loading/merging
- [`src/models/model-operations.ts`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/src/models/model-operations.ts) — Model operations

### Configuration Files

- [`package.json`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/package.json) — Scripts: test, lint, typecheck, build
- [`tsconfig.json`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/tsconfig.json) — TypeScript strict config
- [`oxlint.json`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/oxlint.json) — Linter config (ignores `*.test.ts`)
- [`.github/workflows/ci.yml`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/.github/workflows/ci.yml) — CI with tests disabled (line 38-40)
- [`.github/workflows/publish.yml`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/.github/workflows/publish.yml) — Publish workflow (tests enabled, line 52-53)

---

## Architecture Documentation

### Testing Patterns Currently in Use

1. **bun:test** as the test runner — `import { test, expect, describe } from "bun:test"`
2. **Colocated test files** — `*.test.ts` next to source files
3. **Real filesystem I/O** — `mkdtemp`/`mkdir`/`writeFile` with `try/finally` cleanup
4. **Type-cast mocking** — `as unknown as Harness` to access private internals
5. **Inline mock objects** — Typed mock data matching real interfaces
6. **No external test dependencies** — No jest, vitest, sinon, or mock libraries

### Module Architecture (for test planning)

```
src/
├── cli.ts                    # Entry point (not testable in isolation)
├── config.ts                 # Config types/loading
├── version.ts                # Version constant
├── commands/                 # CLI subcommands (chat, config, init, uninstall, update)
│   └── init.test.ts          # ✅ Has tests
├── config/                   # Project config loading/discovery
├── graph/                    # Workflow engine (12 files — ZERO tests)
│   ├── types.ts              # Type guards, interfaces
│   ├── annotation.ts         # State reducers
│   ├── builder.ts            # Graph construction
│   ├── compiled.ts           # Graph execution
│   ├── checkpointer.ts       # State persistence
│   ├── errors.ts             # Error types
│   └── nodes.ts              # Node definitions
├── models/                   # Model operations (3 files — ZERO tests)
├── sdk/                      # SDK adapters (19 files — 1 test file)
│   ├── opencode-client.mcp-snapshot.test.ts  # ✅ Has tests
│   └── tools/                # Tool schema utilities
├── telemetry/                # Usage tracking (12 files — ZERO tests)
├── ui/                       # TUI components (38 files — 3 test files)
│   ├── commands/             # Slash command system
│   ├── components/           # React-like TUI components
│   ├── hooks/                # UI state hooks
│   ├── tools/                # Tool renderers
│   └── utils/                # UI utilities
│       ├── hitl-response.test.ts             # ✅ Has tests
│       ├── transcript-formatter.hitl.test.ts # ✅ Has tests
│       └── mcp-output.test.ts               # ✅ Has tests
├── utils/                    # Shared utilities (16 files — ZERO tests)
└── workflows/                # Session management (2 files — ZERO tests)
```

---

## Historical Context (from research/)

- [`research/docs/2026-02-12-bun-test-failures-root-cause-analysis.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/research/docs/2026-02-12-bun-test-failures-root-cause-analysis.md) — Root cause analysis of 104 failing tests across 6 categories; all failures due to source evolution without test updates
- [`research/docs/2026-02-14-failing-tests-mcp-config-discovery.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/research/docs/2026-02-14-failing-tests-mcp-config-discovery.md) — MCP config discovery test failures
- [`specs/2026-02-12-bun-test-failures-remediation.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/specs/2026-02-12-bun-test-failures-remediation.md) — Spec for remediating test failures
- [`docs/style-guide.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/docs/style-guide.md) — UI/UX style guide for contributions

---

## Related Research

- [`research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/research/docs/2026-02-12-sdk-ui-standardization-comprehensive.md) — SDK/UI standardization patterns
- [`research/docs/2026-01-25-commander-cli-audit.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/research/docs/2026-01-25-commander-cli-audit.md) — CLI code quality audit
- [`research/docs/2026-02-12-opentui-distribution-ci-fix.md`](https://github.com/bastani-inc/atomic/blob/66590e164ec3aaae8603a8b3c5d362f53da835db/research/docs/2026-02-12-opentui-distribution-ci-fix.md) — CI/CD fix for OpenTUI distribution

---

## External References

### Bun Documentation

- [Bun Test Runner](https://bun.sh/docs/cli/test) — CLI reference
- [Bun Test Coverage](https://bun.sh/docs/test/coverage) — Coverage features, reporters, thresholds
- [Bun Test Configuration](https://bun.sh/docs/runtime/bunfig#test-runner) — `bunfig.toml` reference
- [Bun Test Writing](https://bun.sh/docs/test/writing) — Test API and best practices

### Pre-Commit Hook Tools

- [Lefthook](https://github.com/evilmartians/lefthook) — Fast Git hooks manager (Go)
- [Lefthook Usage Guide](https://lefthook.dev/usage/commands.html) — Configuration reference
- [Husky](https://typicode.github.io/husky/) — Git hooks (Node.js, officially supports Bun)

### DeepWiki Research

- [Bun Coverage Implementation](https://deepwiki.com/search/how-does-bun-test-coverage-wor_037e3571-6d12-4b3e-a519-8257c636e212) — Source code analysis
- [Bun Test Configuration](https://deepwiki.com/search/how-is-bun-test-configured-wha_b7b2fe72-b866-4b8e-ad02-90f9175717f1) — bunfig.toml options
- [Bun Git Hooks](https://deepwiki.com/search/does-bun-have-builtin-git-hook_58293d47-1cc9-4006-baf5-b306633432f5) — Built-in hook support analysis

---

## Open Questions

1. **Coverage baseline**: What is the current line/function coverage percentage? Running `bun test --coverage` would establish the baseline before setting the 85% threshold target.
2. **Graph engine testability**: Several `src/graph/` files import from `@opentui/core` — does the graph engine have dependencies that make unit testing difficult, or are the type guards and reducers genuinely pure?
3. **Formatter choice**: Should a code formatter (Prettier, dprint, Biome) be added alongside the testing infrastructure, or is oxlint-only the intentional approach?
4. **Test file location**: Should new tests remain colocated (`*.test.ts` next to source) or move to a `tests/` directory? The historical `tests/` directory existed but was removed.
5. **Lefthook vs Husky**: Lefthook offers parallel execution and glob filtering but adds a Go dependency; Husky is pure Node.js and lighter. Which aligns better with the project's minimal-dependency philosophy?
