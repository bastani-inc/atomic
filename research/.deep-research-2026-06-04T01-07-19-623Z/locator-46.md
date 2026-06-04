## 1. Must-read paths

- `package.json`  
  Root test commands:
  - `bun run test:unit` → `bun test test/unit`
  - `bun run test:integration` → `bun test test/integration`
  - `bun run test:all` → both  
  This defines the repo’s main verification surface for a Rust migration.

- `.github/workflows/test.yml`  
  CI only runs:
  - root `bun run typecheck`
  - `packages/coding-agent` docs/build
  - root unit + integration tests
  - binary smoke tests  
  Notably, it does **not** explicitly run `packages/coding-agent/test` as a separate package test suite.

- `packages/coding-agent/package.json`  
  Package-level test command:
  - `"test": "vitest --run"`  
  This is the main package test inventory for CLI/runtime parity work.

- `packages/coding-agent/vitest.config.ts`  
  Shows how package tests are wired to workspace source aliases (`@earendil-works/pi-*`, `@mariozechner/pi-*`). Important for understanding whether tests are exercising source, not published artifacts.

- `packages/coding-agent/test/`  
  Largest test corpus in the repo; covers CLI, session manager, tools, RPC, TUI, extensions, model registry, auth, themes, clipboard, etc.

- `packages/coding-agent/test/suite/`  
  Higher-level scenario/regression suite:
  - `agent-session-*`
  - `regressions/*`  
  This is the closest thing to end-to-end behavioral coverage inside the package.

- `test/unit/`  
  Root unit tests for workflow/runtime/subagents/MCP/intercom/shared runtime. Key for migration because these are the repo-level compatibility checks.

- `test/integration/`  
  Integration tests for runtime wiring and package/plugin boundaries:
  - `custom-registry.test.ts`
  - `mcp-entrypoint.test.ts`
  - `mock-extension-api.test.ts`
  - `runtime-wiring.test.ts`
  - `workflow-package-typing.test.ts`

## 2. Supporting paths

- `test/support/`  
  Shared helpers used by root integration tests.

- `packages/coding-agent/test/suite/harness.ts`  
  Test harness for scenario-style package tests.

- `packages/coding-agent/test/suite/regressions/*`  
  Regression inventory worth preserving during any Rust rewrite.

- `packages/coding-agent/test/fixtures/`  
  Fixtures for session JSONL, skills, and empty workspace cases.

- `packages/coding-agent/test/rpc-example.ts`  
  Example client flow referenced by docs; relevant if Rust changes the RPC surface.

- `packages/coding-agent/docs/rpc.md`  
  Docs link directly to the test example; useful for external contract parity.

- `packages/coding-agent/test/interactive-mode-*.test.ts`  
  Coverage for TUI startup, status, compaction, import/clone commands, warnings, suspend, and footer ordering.

- `packages/coding-agent/test/session-manager/*.test.ts`  
  Persistence/label/tree traversal/migration coverage for JSONL session storage.

- `packages/coding-agent/test/extensions-*.test.ts` and `packages/coding-agent/test/tools.test.ts`  
  High-value for Rust migration because they encode tool/extension ABI behavior.

- `packages/coding-agent/test/model-registry.test.ts`, `model-resolver.test.ts`, `auth-storage.test.ts`  
  Provider/auth boundaries likely to move in a Rust port.

- `test/manual/`  
  Not automated, but useful to know what the repo still relies on humans to validate.

## 3. Entry points / symbols

- Root test scripts:
  - `test:unit`
  - `test:integration`
  - `test:all`

- Package test script:
  - `packages/coding-agent/package.json#scripts.test`

- CI test job:
  - `.github/workflows/test.yml:jobs.test.steps`

- Package test harness:
  - `packages/coding-agent/test/suite/harness.ts`

- Root integration targets:
  - `test/integration/runtime-wiring.test.ts`
  - `test/integration/mock-extension-api.test.ts`
  - `test/integration/mcp-entrypoint.test.ts`
  - `test/integration/workflow-package-typing.test.ts`

- Root unit targets:
  - `test/unit/runtime.test.ts`
  - `test/unit/executor.test.ts`
  - `test/unit/stage-runner.test.ts`
  - `test/unit/integrations-mcp.test.ts`
  - `test/unit/integrations-intercom.test.ts`
  - `test/unit/subagents-*.test.ts`
  - `test/unit/builtin-workflows.test.ts`

- Package high-signal tests:
  - `packages/coding-agent/test/rpc.test.ts`
  - `packages/coding-agent/test/rpc-jsonl.test.ts`
  - `packages/coding-agent/test/print-mode.test.ts`
  - `packages/coding-agent/test/interactive-mode-status.test.ts`
  - `packages/coding-agent/test/agent-session-*.test.ts`
  - `packages/coding-agent/test/session-manager/*.test.ts`
  - `packages/coding-agent/test/tools.test.ts`
  - `packages/coding-agent/test/extensions-runner.test.ts`

## 4. Gaps or uncertainty

- I found **no Rust tests/parity tests** in this repo: no `Cargo.toml`, no `*.rs`, and no Rust test inventory.
- CI appears to **not run** `packages/coding-agent/test` explicitly; that suite may be locally important but CI-uncertain.
- The package-level Vitest suite is large, but I couldn’t verify whether every `test/suite/regressions/*` file is invoked in practice or if some are only ad hoc.
- If you want, I can turn this into a **migration test matrix**: “TS test → likely Rust equivalent → keep/replace/drop.”