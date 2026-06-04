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