## Partition 46: Test coverage inventory across root tests, package tests, integration tests, and Rust parity tests

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the repo’s **verification map** for the TypeScript codebase you’d be replacing.

- **Root tests** validate cross-package runtime behavior: workflow execution, subagents, MCP, intercom, and shared runtime wiring.
- **Package tests** (mostly `packages/coding-agent/test`) validate the CLI/runtime contract of `@bastani/atomic`: sessions, tools, extensions, RPC, TUI, model/auth boundaries, and regressions.
- **Integration tests** validate package boundaries, wiring, and plugin/runtime compatibility.
- **Rust parity tests:** none exist yet. There is no Rust workspace or `*.rs` test surface in the current repo.

So for migration planning, this partition is effectively the **behavioral contract inventory** you’d need to preserve in Rust.

## 2. Key flows and invariants

### Root-level contract
- `bun run test:unit` and `bun run test:integration` are the repo-level gates.
- CI runs these plus typecheck and binary smoke tests.
- Root tests focus on **composition** rather than internals:
  - runtime wiring
  - workflow executor/stage runner behavior
  - MCP and intercom integration
  - subagent/builtin workflow semantics

### Package-level contract (`packages/coding-agent`)
- `vitest --run` is the package’s main verification path.
- Test corpus is broad and behavior-heavy:
  - CLI / main entry behavior
  - session manager JSONL persistence
  - tools (`read`, `write`, `edit`, `bash`, etc.)
  - extensions ABI and runner
  - RPC / print mode / interactive mode
  - model registry / auth storage
  - regressions and scenario-style suite

### Important invariant
The package tests appear to exercise **workspace source via aliases**, not just published artifacts. That means they encode current source-level behavior tightly; a Rust rewrite would need either:
1. a replacement test harness against the Rust binary/library, or
2. a compatibility layer that preserves the existing JS-facing contracts.

## 3. Tests / validation

### Root tests
Likely to matter most for Rust migration:
- `test/unit/runtime.test.ts`
- `test/unit/executor.test.ts`
- `test/unit/stage-runner.test.ts`
- `test/unit/integrations-mcp.test.ts`
- `test/unit/integrations-intercom.test.ts`
- `test/unit/subagents-*.test.ts`
- `test/unit/builtin-workflows.test.ts`

### Integration tests
High signal for boundary parity:
- `test/integration/runtime-wiring.test.ts`
- `test/integration/mock-extension-api.test.ts`
- `test/integration/mcp-entrypoint.test.ts`
- `test/integration/workflow-package-typing.test.ts`
- `test/integration/custom-registry.test.ts`

### Package tests
Highest-value for CLI/runtime parity:
- `rpc.test.ts`, `rpc-jsonl.test.ts`
- `print-mode.test.ts`
- `interactive-mode-*.test.ts`
- `agent-session-*.test.ts`
- `session-manager/*.test.ts`
- `tools.test.ts`
- `extensions-*.test.ts`
- `model-registry.test.ts`, `auth-storage.test.ts`

### Rust parity status
- **None yet**
- No `Cargo.toml`
- No Rust test harness
- No parity matrix

## 4. Risks, unknowns, and verification steps

### Risks
- CI may **not** run `packages/coding-agent/test` explicitly, so some critical behavior is locally important but not CI-enforced.
- The repo has **no Rust baseline**, so “parity” is currently undefined.
- The largest likely migration gaps are:
  - RPC / interactive TUI behavior
  - session JSONL compatibility
  - tool semantics
  - extension loading/ABI
  - workflow/subagent integration

### Unknowns
- Whether every regression test under `packages/coding-agent/test/suite/regressions` is executed in practice.
- Which root tests are true release gates vs. developer-only checks.
- Which behaviors are intentionally coupled to Bun/Node APIs.

### Verification steps
1. Build a **test-to-subsystem matrix** from these inventories.
2. Mark each test as:
   - keep as-is
   - rewrite in Rust
   - replace with contract test
   - retire
3. Add a Rust parity suite only after defining:
   - binary/library boundaries
   - IPC/RPC contract
   - session format compatibility
   - extension/workflow strategy

If you want, I can turn this into a **TS test → Rust equivalent mapping table** next.

### Online Researcher
# 1. Relevant external facts

- `bun test` is the repo’s primary test runner for root tests, via:
  - `bun run test:unit`
  - `bun run test:integration`
  - `bun run test:all`
- `packages/coding-agent` uses `vitest --run` for its package-level test suite.
- I found **no Rust test infrastructure** in this repo snapshot:
  - no `Cargo.toml`
  - no `*.rs`
  - no Rust parity-test inventory

# 2. Local implications

- For a TS→Rust migration, the current **highest-value compatibility surface** is the existing test corpus, not the absence of Rust tests.
- The repo’s test coverage breaks down into four useful buckets:

  1. **Root unit tests** (`test/unit/`)
     - exercise shared runtime, workflows, subagents, MCP, intercom
     - likely become the first Rust parity target

  2. **Root integration tests** (`test/integration/`)
     - verify runtime wiring, package/plugin boundaries, entrypoints
     - these are the best tests for ensuring the Rust replacement still fits the host

  3. **Package tests** (`packages/coding-agent/test/`)
     - largest behavioral corpus
     - especially important for CLI/session/TUI/tooling parity

  4. **Parity/Rust tests**
     - currently absent
     - need to be created to lock behavior during porting

- CI currently runs root tests and binary smoke checks, but **does not explicitly run** `packages/coding-agent/test` as a separate job, so that suite is important locally even if CI coverage is incomplete.

# 3. Version/API assumptions

- Assumes current test commands remain:
  - `bun run test:unit`
  - `bun run test:integration`
  - `bun run test:all`
- Assumes package tests continue using:
  - `vitest --run`
- Assumes no Rust harness exists yet; Rust parity work will need a new test runner and mapping from existing TS test behavior.

# 4. Unverified or unnecessary research

- I did **not** need external docs to answer this partition; the local artifact already identifies the relevant test inventory.
- I did **not** verify whether every `packages/coding-agent/test/suite/regressions/*` file is executed automatically.
- I did **not** inspect individual test contents yet, so this is an **inventory**, not a behavior-by-behavior migration matrix.

If you want, I can turn this into a **TS test → Rust parity test plan** next.