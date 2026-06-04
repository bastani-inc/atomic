## 1. Established patterns

- **Three-tier test split is already explicit**
  - **Root unit tests:** `test/unit/*.test.ts`
  - **Root integration tests:** `test/integration/*.test.ts`
  - **Package-local tests:** `packages/coding-agent/test/**/*.test.ts`
- **CI only exercises the root tiers + package build**
  - Root `package.json` runs `bun run test:unit` and `bun run test:integration`.
  - `.github/workflows/test.yml` runs `typecheck`, `packages/coding-agent` docs check/build, then root unit/integration tests.
- **Root tests are the main cross-package contract layer**
  - They cover workflow/runtime/subagents/MCP/intercom behavior, e.g. `test/unit/workflow-*.test.ts`, `subagents-*.test.ts`, `mcp-*.test.ts`, `integrations-*.test.ts`.
- **Package tests are dense, feature-scoped, and regression-heavy**
  - `packages/coding-agent/test/` is the largest inventory and covers CLI, sessions, tools, TUI, RPC, config, models, skills, and many regressions.
  - Naming is descriptive and behavior-oriented: `agent-session-*.test.ts`, `interactive-mode-*.test.ts`, `rpc-*.test.ts`, `session-manager/*.test.ts`.
- **There is a dedicated “parity/regression” style inside package tests**
  - `packages/coding-agent/test/suite/` is explicitly for harness-based `AgentSession`/`AgentSessionRuntime` characterization and regressions.
  - The suite README says to use `regressions/<issue>-<slug>.test.ts`, which is a strong convention for preserving behavior during migration.
- **Rust parity tests do not exist yet**
  - Repo search found no `Cargo.toml` and no `*.rs` files, so there is no Rust-side parity harness to mirror these contracts.

## 2. Variations / exceptions

- **Package tests are not all run by root CI**
  - `packages/coding-agent/package.json` has its own `vitest --run`, but root CI does not call it directly; it relies on `build` plus root tests.
- **Some package tests are “legacy harness” tests**
  - `packages/coding-agent/test/test-harness.ts` and `test-harness.test.ts` still exist alongside the newer `test/suite/harness.ts` path.
- **Integration tests are narrower than unit tests**
  - `test/integration/` focuses on wiring/entrypoint/runtime behavior: `mcp-entrypoint`, `runtime-wiring`, `overlay-entrypoints`, `workflow-package-typing`, etc.
- **A few tests are not `.test.ts` in the obvious places**
  - Example support files like `packages/coding-agent/test/rpc-example.ts` and `streaming-render-debug.ts` sit beside tests.
- **The “parity” concept is currently TS-vs-TS, not TS-vs-Rust**
  - In practice, parity means matching behavior across runtime layers (`AgentSession`, workflows, MCP, UI), not comparing against a Rust implementation.

## 3. Anti-patterns or risks

- **No Rust contract baseline**
  - Since there’s no Rust code, the migration risk is losing behavior without an executable Rust reference suite.
- **Test ownership is fragmented**
  - Some behavior lives in root tests, some in package tests, and some in `packages/coding-agent/test/suite/`; this makes it easy to miss coverage when moving subsystems.
- **CI coverage gap risk**
  - If `packages/coding-agent/package.json` tests are not run in root CI, a Rust port could diverge in package-local behavior while still passing CI.
- **Legacy harness duplication**
  - Coexisting `test-harness.ts` and `test/suite/harness.ts` can encode overlapping expectations in two styles.
- **Regression naming is strong but not unified across all tiers**
  - Root integration/unit tests don’t appear to follow the same issue-number convention as `test/suite/regressions/`, so migration mapping may be uneven.

## 4. Evidence index

- **Root test commands:** `package.json`
  - `test:unit`, `test:integration`, `test:all`
- **CI coverage:** `.github/workflows/test.yml`
  - Runs root unit/integration tests and `packages/coding-agent` build/docs checks
- **Package-local test runner:** `packages/coding-agent/package.json`
  - `vitest --run`
- **Package regression suite rulebook:** `packages/coding-agent/test/suite/README.md`
  - `test/suite/`, `test/suite/regressions/`, `<issue>-<slug>.test.ts`
- **Root unit inventory:** `test/unit/*.test.ts`
  - Examples: `builtin-workflows.test.ts`, `mcp-security.test.ts`, `subagents-*.test.ts`, `workflow-*.test.ts`
- **Root integration inventory:** `test/integration/*.test.ts`
  - Examples: `runtime-wiring.test.ts`, `mcp-entrypoint.test.ts`, `workflow-package-typing.test.ts`
- **Package test inventory:** `packages/coding-agent/test/**/*.test.ts`
  - Examples: `agent-session-*.test.ts`, `interactive-mode-*.test.ts`, `rpc-*.test.ts`, `session-manager/*.test.ts`
- **Rust absence check:** repo-wide search
  - No `Cargo.toml`, no `*.rs` files