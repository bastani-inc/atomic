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