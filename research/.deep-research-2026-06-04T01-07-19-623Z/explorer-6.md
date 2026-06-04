## Partition 6: SDK session creation boundary and replacement of `createAgentSession`

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Two-step creation boundary is now explicit.**  
  The repo separates cwd-bound infrastructure from session construction:
  - `createAgentSessionServices()` builds `authStorage`, `settingsManager`, `modelRegistry`, `resourceLoader`, and diagnostics (`packages/coding-agent/src/core/agent-session-services.ts`).
  - `createAgentSessionFromServices()` then forwards those services into `createAgentSession()` (`packages/coding-agent/src/core/agent-session-services.ts`).
  This is the main seam for a Rust port.

- **`createAgentSession()` remains the SDK compatibility surface.**  
  `packages/coding-agent/src/core/sdk.ts` still accepts legacy-style options like `cwd`, `agentDir`, `model`, `tools`, `excludedTools`, `customTools`, `sessionManager`, and `sessionStartEvent`.  
  So the current architecture preserves an old public entrypoint while internally moving toward services/runtime layering.

- **Runtime ownership is wrapped in `AgentSessionRuntime`.**  
  `packages/coding-agent/src/core/agent-session-runtime.ts` owns:
  - the active `session`
  - cwd-bound `services`
  - `diagnostics`
  - `modelFallbackMessage`  
  It also centralizes session replacement flows: `switchSession()`, `newSession()`, `fork()`.

- **Lifecycle events are a hard contract around replacement.**  
  The runtime emits/cancels on:
  - `session_before_switch`
  - `session_before_fork`
  - `session_shutdown`  
  and supports `setRebindSession()` / `setBeforeSessionInvalidate()` hooks.  
  This shows session replacement is not just state swap; it is an eventful protocol.

- **Tests characterize the boundary behavior, not just the API shape.**  
  Repeated tests in `packages/coding-agent/test/suite/agent-session-runtime.test.ts` and `.../agent-session-runtime-events.test.ts` assert:
  - `session_before_switch` then `session_shutdown` then new `session_start`
  - cancellation behavior
  - `beforeSessionInvalidate` order
  - `session_before_fork` behavior  
  This is a stable contract, not incidental implementation detail.

## 2. Variations / exceptions

- **`createAgentSession()` still does a lot.**  
  Despite the new services layer, `sdk.ts` still handles model auth, tool filtering, extension loading, and session assembly.  
  So the boundary is conceptually separated, but not fully extracted yet.

- **`AgentSessionRuntime` is a host-side orchestration wrapper, not the session itself.**  
  It manages replacement and rebinding, but the underlying `AgentSession` still owns most stateful behavior.

- **Replacement flows differ by intent:**
  - `switchSession()` loads an existing JSONL session file
  - `newSession()` creates a fresh session in the same cwd
  - `fork()` branches from a selected entry and may capture selected text  
  These are related but not identical code paths.

- **Some replacement hooks are synchronous on purpose.**  
  `beforeSessionInvalidate` is explicitly synchronous to avoid yielding while tearing down UI state. That’s an exception to the otherwise async lifecycle.

## 3. Anti-patterns or risks

- **The SDK boundary is still too centralized for a clean Rust swap.**  
  `createAgentSession()` mixes:
  - config resolution
  - model/auth setup
  - resource loading
  - tool registry setup
  - extension/runtime wiring  
  This makes it harder to replace only one layer.

- **Session replacement depends on callback choreography.**  
  `rebindSession` and `beforeSessionInvalidate` are external hooks into internal lifecycle timing. That coupling is easy to break in a port.

- **Type-level contracts are large and transitive.**  
  `extensions/types.ts` pulls in session manager, model, UI, tool, and prompt-related types. Any Rust boundary here will need either:
  - a new plugin ABI, or
  - an embedded JS compatibility layer.

- **The current split is only partially enforced by structure.**  
  `createAgentSessionFromServices()` just forwards into `createAgentSession()`, so the “services first” abstraction is still thin and mostly organizational.

## 4. Evidence index

- `packages/coding-agent/src/core/sdk.ts`
  - `createAgentSession()`
  - `CreateAgentSessionOptions`
  - `CreateAgentSessionResult`

- `packages/coding-agent/src/core/agent-session-services.ts`
  - `AgentSessionServices`
  - `createAgentSessionServices()`
  - `createAgentSessionFromServices()`

- `packages/coding-agent/src/core/agent-session-runtime.ts`
  - `AgentSessionRuntime`
  - `switchSession()`
  - `newSession()`
  - `fork()`
  - `setRebindSession()`
  - `setBeforeSessionInvalidate()`

- `packages/coding-agent/src/core/extensions/types.ts`
  - `session_before_switch`
  - `session_before_fork`
  - `session_shutdown`

- Tests:
  - `packages/coding-agent/test/suite/agent-session-runtime.test.ts`
  - `packages/coding-agent/test/agent-session-runtime-events.test.ts`
  - `packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts`

If you want, I can do the next partition in the same style: **session JSONL and branching persistence**.

### Analyzer
## 1. Behavioral model

This partition is the **session-construction seam** for the TS runtime.

- `createAgentSession()` is the low-level factory.
  - It resolves `cwd`/`agentDir`.
  - Builds or reuses `AuthStorage`, `ModelRegistry`, `SettingsManager`, `SessionManager`, `ResourceLoader`.
  - Selects/repairs the model and thinking level.
  - Computes tool policy (`tools`, `excludedTools`, `noTools`, `customTools`).
  - Constructs the `AgentSession`.

- `createAgentSessionServices()` is the **cwd-bound infrastructure layer**.
  - Loads extensions/resources.
  - Registers provider extensions into the model registry.
  - Applies extension flag values.
  - Returns diagnostics instead of throwing for many setup issues.

- `createAgentSessionFromServices()` is a thin adapter that forwards services into `createAgentSession()`.

- `createAgentSessionRuntime()` + `AgentSessionRuntime` are the **replacement boundary**.
  - Own the live session plus its services.
  - Rebuild the whole runtime for `/new`, `/resume`, `/fork`, and `/import`.
  - Tear down the old session first, then install the replacement session.

For a Rust migration, this is the seam to preserve or replace first: session creation is not just “construct an object,” it is a composition root for auth, models, tools, extensions, and persistence.

## 2. Key flows and invariants

### Session creation flow
1. Normalize paths.
2. Create/load auth + model registry + settings + session manager.
3. Load resources if not injected.
4. Restore prior session model/thinking state if present.
5. Otherwise choose an initial model via settings/provider defaults.
6. Clamp thinking level to model capability.
7. Build tool policy:
   - allowlist first
   - then excluded-tools filtering
   - `noTools: "builtin"` disables only built-ins, not extensions/custom tools
   - `noTools: "all"` disables everything
8. Create `AgentSession`.
9. Return session + extensions result + optional fallback message.

### Runtime replacement flow
- Before replacement, emit `session_before_switch` / `session_before_fork`.
- If cancelled, no state changes.
- Otherwise:
  1. emit shutdown for current session
  2. invalidate old session
  3. create a fresh runtime with the new cwd/session target
  4. rebind host UI/session callbacks
  5. run any `withSession` callback against the replacement session

### Important invariants
- **Replacement is destructive**: old `AgentSession` becomes stale after switch/fork/new/import.
- **UI/event listeners are session-scoped**: they must be reattached after replacement.
- **Diagnostics are non-fatal**: errors from extension/provider registration are collected.
- **Tool filtering is ordered**:
  - allowlist narrows first
  - excluded names are removed afterward
  - unknown exclusions are ignored
- **Dynamic extension tools must respect exclusions even when registered later**.
- **Session restore is stateful**:
  - model can be restored if present and authenticated
  - thinking level can be restored from history
  - otherwise defaults are used
- **Session imports require filesystem existence checks** and may copy JSONL into the session dir.

## 3. Tests / validation

Good coverage exists for the tool-policy part of the boundary:

- `sdk-tool-exclusions.test.ts`
  - excludes built-in tools
  - preserves guidance when allowlisting
  - allowlist + exclude precedence
  - `noTools: "builtin"` behavior
  - SDK custom tools excluded
  - extension tools excluded before and after binding
  - CLI app-mode exclusions
  - service-based forwarding

- `no-builtin-tools-preserves-extension-tools.test.ts`
  - `noTools: "builtin"` keeps extension tools active
  - `noTools: "all"` disables all tools
  - service-based session creation preserves `noTools`

- `2860-replaced-session-context.test.ts`
  - validates replacement semantics
  - stale `pi`/context objects become invalid
  - `withSession` targets the replacement session
  - fork/new replacement callbacks work

These tests are useful migration guards because they encode the behavioral contract, not just implementation details.

## 4. Risks, unknowns, and verification steps

### Risks
- This boundary depends heavily on TS-native extension loading and `jiti`; a Rust rewrite breaks that unless you keep a JS plugin layer.
- `@earendil-works/pi-agent-core`, `pi-ai`, and related runtime libraries are external and not in-repo, so Rust replacement needs equivalent behavior or a bridge.
- The session factory is coupled to persistence, auth, model discovery, extension flags, and tool policy all at once.

### Unknowns
- Whether Rust should replace only the runtime core or also the extension/plugin ABI.
- Whether session replacement should remain in-process or become a subprocess boundary.
- How much of `AgentSession` itself must survive for compatibility.

### Verify next
- Trace any additional tests around model restore/auth fallback and session import.
- Inspect `agent-session.ts` where `CreateAgentSessionResult` is consumed to confirm what the replacement object must expose.
- Decide whether Rust will:
  1. reimplement `createAgentSession()` directly,
  2. provide a Rust backend with a thin TS adapter, or
  3. move only session replacement to Rust first while keeping JS session construction.

### Online Researcher
## 1. Relevant external facts

No external library/docs research was necessary for this partition beyond the repo’s own SDK docs and source.

From the local SDK contract:

- `createAgentSession()` is the **public factory boundary** for constructing an `AgentSession`.
- `createAgentSessionRuntime()` / `AgentSessionRuntime` are the **session-replacement layer** (`newSession`, `switchSession`, `fork`, `importFromJsonl`), so they are the more likely long-term boundary if Rust replaces only the session core.
- `createAgentSessionServices()` already splits out **cwd-bound infrastructure** from session creation.
- The SDK docs explicitly say session replacement lives on `AgentSessionRuntime`, not `AgentSession`.

## 2. Local implications

For a TS → Rust migration, the safest seam is:

1. **Keep the TS-facing API stable first**
   - Preserve `createAgentSession()` return shape:
     - `session`
     - `extensionsResult`
     - `modelFallbackMessage?`
   - This avoids breaking callers while internals move.

2. **Move the “engine” behind the seam**
   - Rust can own:
     - model/session initialization
     - tool allowlist/blocklist resolution
     - auth + stream wiring
     - session persistence / restoration
   - TS can remain a thin adapter if needed.

3. **Prefer replacing the runtime boundary, not only the raw session factory**
   - `createAgentSessionServices()` is already a useful extraction point.
   - If Rust controls session lifecycle, the real compatibility target is likely `AgentSessionRuntime`, because it owns replacement flows.

4. **Preserve tool-policy behavior exactly**
   - Tests indicate migration must keep:
     - `tools`
     - `excludedTools`
     - `noTools`
     - custom tools
     - extension-provided tools
   - These are part of the observable SDK contract.

5. **Preserve session restoration semantics**
   - Existing behavior restores:
     - prior model
     - prior thinking level
     - fallback messaging when restore fails
   - Rust must match these edge cases or callers will see behavior drift.

## 3. Version/API assumptions

- Assumption: the current contract is the one in `packages/coding-agent/docs/sdk.md` and `src/core/sdk.ts`.
- Assumption: `createAgentSession()` remains the compatibility surface until a deliberate API migration is introduced.
- Assumption: Rust will either:
  - back the existing TS API, or
  - introduce a new lower-level runtime with a TS adapter.

## 4. Unverified or unnecessary research

- I did **not** verify any external Rust SDK, crate, or cross-language bridge details yet.
- I did **not** research upstream pi/atomic Rust plans because this partition is mainly about the local boundary and migration seam.
- If you want, the next useful step is to inspect:
  - `packages/coding-agent/src/core/agent-session-runtime.ts`
  - the session/tool regression tests
  to define the exact Rust replacement contract.