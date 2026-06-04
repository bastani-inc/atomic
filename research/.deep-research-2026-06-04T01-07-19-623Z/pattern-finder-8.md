## 1. Established patterns

- **JSONL is the canonical persistence format.**  
  `packages/coding-agent/src/core/session-manager.ts` defines `FileEntry`/`SessionEntry` unions and writes line-by-line session records. `docs/session-format.md` explicitly says sessions are JSONL with a `type` field and tree links via `id`/`parentId`.

- **Sessions are tree-structured, not just linear logs.**  
  The docs and `SessionManager` support branching in-place: `parentId`, `branch()`, `getTree()`, `getBranch()`, `createBranchedSession()`, and `forkFrom()` all point to a persistent DAG/tree model rather than append-only history.

- **Labeling is a first-class entry type, not metadata on messages.**  
  `LabelEntry` in `session-manager.ts` stores `targetId` + `label`; docs describe it as a bookmark/marker. This makes labels durable and replayable across reloads.

- **Backward compatibility is handled by explicit migrations.**  
  `CURRENT_SESSION_VERSION = 3` plus migration helpers (`migrateV1ToV2`, session-version docs) show a pattern of preserving old session files and upgrading on load.

- **Compatibility is centered on “context building” from the current leaf.**  
  `buildSessionContext()` walks from leaf to root and reconstructs model state/messages. That’s the core contract a Rust implementation would need to preserve.

- **Session persistence is tied to agent event boundaries.**  
  `AgentSession` saves on `message_end`, starts session after first exchange, and flushes buffered bash messages on `agent_end`. Persistence isn’t a separate writer; it’s integrated with runtime events.

## 2. Variations / exceptions

- **Session entries include both LLM-visible and extension-only records.**  
  `custom` entries persist extension state but do not enter context; `custom_message` entries do enter context. That split is important for migration because not every JSONL line means prompt content.

- **Branch summaries and compaction are special “context repair” records.**  
  `branch_summary` and `compaction` alter how earlier context is reconstructed; they are not normal conversational messages.

- **Version 3 is a narrow schema rename, not a format overhaul.**  
  `docs/session-format.md` frames v3 as renaming `hookMessage` to `custom`, which suggests compatibility pressure is already accepted and expected.

- **Some behavior is implementation-specific but persisted.**  
  `fromHook` on `compaction`/`branch_summary` is described as legacy/implementation-specific and optional. Good example of “preserve if present, don’t rely on it.”

- **Branching can happen from UI commands, not just APIs.**  
  The TUI `/branch` flow in the session UI shows branching is user-facing, not just internal session manipulation.

## 3. Anti-patterns or risks

- **Hard-coupling persistence to TypeScript runtime objects.**  
  `session-manager.ts` directly serializes rich TS unions (`AgentMessage`, custom messages, extension payloads). A Rust port must either exactly mirror these discriminated unions or introduce a translation layer.

- **Leaf-path reconstruction is fragile if ordering changes.**  
  Because context is derived by walking `id`/`parentId`, any mismatch in append/branch behavior can break replay, resume, and branch display.

- **Compatibility surface is larger than it looks.**  
  Sessions aren’t just messages: they include labels, branch summaries, compaction markers, model/thinking changes, session info, and extension payloads.

- **Docs and code can drift.**  
  The scout notes some design docs are historical/speculative; for migration planning, `session-manager.ts` and `docs/session-format.md` are the authoritative pairing to trust.

- **Extension payloads are open-ended.**  
  `custom` / `custom_message` / `details` fields permit arbitrary extension data, which is a migration risk if Rust tries to strongly type everything too early.

## 4. Evidence index

- `packages/coding-agent/src/core/session-manager.ts`
  - `CURRENT_SESSION_VERSION = 3`
  - `SessionHeader`, `SessionEntry`, `LabelEntry`, `BranchSummaryEntry`, `CustomEntry`, `CustomMessageEntry`
  - `migrateV1ToV2()`
  - `getTree()`, `getBranch()`, `branch()`, `createBranchedSession()`, `forkFrom()`
- `packages/coding-agent/docs/session-format.md`
  - JSONL format
  - tree structure via `id`/`parentId`
  - version history v1/v2/v3
  - `branch_summary`, `label`, `session_info`
  - `buildSessionContext()` behavior
- `packages/coding-agent/src/core/agent-session.ts`
  - session persistence on `message_end`
  - branch/session switching behavior
  - `agent_end` flushing behavior
- `packages/coding-agent/test/fixtures/before-compaction.jsonl`
  - real-world session JSONL examples with mixed message/branch/compaction history
- Scout note: `research/.deep-research-2026-06-04T01-07-19-623Z/00-codebase-scout.md`
  - flags this partition as “Session JSONL persistence, branching, labels, and session-format compatibility”