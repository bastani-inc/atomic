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