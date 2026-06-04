## 1. Relevant external facts

- None verified here. This partition is mostly about **local repo behavior**, not an external Rust/TS library boundary.
- The only material external-style assumption is that the intercom layer is a **local IPC/broker + UI extension** pattern, which will need a Rust-side equivalent if migrated.

## 2. Local implications

- The migration target is **not “rewrite one file”**; it’s a small subsystem:
  - `packages/intercom/*` = extension entrypoint, broker/client, reply tracking, UI overlays.
  - `packages/workflows/src/intercom/*` = supervisor decision + notify routing.
  - `packages/subagents/src/intercom/*` = child→supervisor target resolution and payload shaping.
- The key compatibility surface is the **wire protocol** in `packages/intercom/types.ts` and framing/transport in `broker/framing.ts`.
- `reply-tracker.ts` is central for preserving:
  - pending ask/reply state,
  - “reply to current turn” behavior,
  - reply attribution.
- UI behavior to preserve:
  - session picker overlay,
  - compose/send overlay,
  - inline incoming-message rendering.
- Cross-session orchestration depends on:
  - broker registration/presence,
  - session naming conventions,
  - parent/supervisor resolution from workflows/subagents.

## 3. Version/API assumptions

- No Rust API/version assumptions can be made from this artifact alone.
- If migrating, the safest assumption is:
  - keep the **message schema stable** first,
  - reimplement transport and state machine in Rust,
  - then swap host integration points one by one.
- The repo currently appears to rely on **TypeScript source packages** and host-side extension APIs; a Rust port would need a compatible extension/plugin boundary.

## 4. Unverified or unnecessary research

- Unverified:
  - exact host extension API limits for Rust,
  - whether intercom UI can be replaced natively or must remain host-rendered,
  - CI/test coverage for all intercom paths.
- Unnecessary for this partition:
  - generic Rust ecosystem comparisons,
  - broad TS→Rust migration advice not tied to `intercom`, `workflows`, or `subagents`.

If you want, I can turn this into a **migration sequence** for the intercom subsystem specifically.