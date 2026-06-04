## 1. Must-read paths

- `packages/coding-agent/src/core/sdk.ts`  
  **Why:** This is the public SDK factory boundary. `createAgentSession()` is defined here, and it owns model selection, tool allowlisting/blocklisting, auth/stream wiring, and session construction. If Rust replaces TS, this is the main compatibility seam to preserve or redesign.

- `packages/coding-agent/src/core/agent-session-services.ts`  
  **Why:** Splits “cwd-bound service setup” from session creation. `createAgentSessionServices()` and `createAgentSessionFromServices()` show how session creation is already being decomposed, which is useful if Rust replaces only the session factory first.

- `packages/coding-agent/src/core/agent-session-runtime.ts`  
  **Why:** Defines the higher-level runtime wrapper that can replace sessions (`newSession`, `switchSession`, `fork`, `importFromJsonl`). Useful to understand what `createAgentSession()` feeds into and what must survive a Rust port.

- `packages/coding-agent/docs/sdk.md`  
  **Why:** Canonical user-facing contract for SDK usage. It explains the intended role of `createAgentSession()` vs `AgentSessionRuntime`.

- `packages/coding-agent/test/suite/regressions/sdk-tool-exclusions.test.ts`  
  **Why:** High-signal behavior test for session creation options (`tools`, `excludedTools`, `noTools`, custom tools, dynamic extension tools). Good proxy for what the replacement API must preserve.

## 2. Supporting paths

- `packages/coding-agent/src/core/agent-session.ts`  
  **Why:** The concrete session object created by `createAgentSession()`. It shows what session construction must provide to runtime consumers.

- `packages/coding-agent/src/main.ts`  
  **Why:** CLI wiring calls `createAgentSessionServices()` and `createAgentSessionFromServices()`. This is where the SDK boundary is consumed in practice.

- `packages/coding-agent/src/index.ts` and `packages/coding-agent/src/core/index.ts`  
  **Why:** Public exports. These show which session-creation symbols are part of the package API.

- `packages/coding-agent/test/suite/regressions/2835-tools-allowlist-filters-extension-tools.test.ts`  
  **Why:** Another tool-policy regression test; useful for replacement compatibility.

- `packages/coding-agent/test/suite/regressions/no-builtin-tools-preserves-extension-tools.test.ts`  
  **Why:** Verifies `noTools` semantics and service-based forwarding.

- `packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts`  
  **Why:** Exercises runtime replacement paths after session creation.

- `packages/coding-agent/test/suite/agent-session-runtime.test.ts` and `packages/coding-agent/test/agent-session-runtime-events.test.ts`  
  **Why:** Broader runtime lifecycle coverage around the session factory boundary.

## 3. Entry points / symbols

- `createAgentSession(options)` — `packages/coding-agent/src/core/sdk.ts`  
  Main public SDK factory.

- `CreateAgentSessionOptions` / `CreateAgentSessionResult` — `packages/coding-agent/src/core/sdk.ts`  
  Public API shape and return contract.

- `createAgentSessionServices(options)` — `packages/coding-agent/src/core/agent-session-services.ts`  
  Builds cwd-bound services before session creation.

- `createAgentSessionFromServices(options)` — `packages/coding-agent/src/core/agent-session-services.ts`  
  Bridges services into `createAgentSession()`.

- `createAgentSessionRuntime(createRuntime, options)` — `packages/coding-agent/src/core/agent-session-runtime.ts`  
  Higher-level runtime wrapper entry.

- `CreateAgentSessionRuntimeFactory` — `packages/coding-agent/src/core/agent-session-runtime.ts`  
  The factory contract that the CLI/runtime layer uses.

- `AgentSessionRuntime` methods: `newSession()`, `switchSession()`, `fork()`, `importFromJsonl()` — `packages/coding-agent/src/core/agent-session-runtime.ts`  
  Session replacement API surface.

- `AgentSession` constructor + tool/session fields — `packages/coding-agent/src/core/agent-session.ts`  
  The object ultimately created by the SDK.

## 4. Gaps or uncertainty

- I did **not** verify whether there is already a Rust-side replacement plan or crate layout; the repo scout says there is no `Cargo.toml` / `*.rs` baseline.
- The exact “replacement of `createAgentSession`” could mean:
  1. keep the TS API and reimplement internals in Rust, or  
  2. replace it with a different boundary (for example, a Rust session service + thin TS adapter).  
  The repo currently shows only the TS decomposition, not a Rust target.
- I did not inspect every test file that touches session creation, so there may be additional edge-case coverage around auth/model fallback that matters for migration.