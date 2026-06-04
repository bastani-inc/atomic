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