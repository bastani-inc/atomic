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