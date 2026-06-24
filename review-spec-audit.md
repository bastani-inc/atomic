Unable to write `review-spec-audit.md` because no file write/edit tool is available and the task also says “Do not modify files.” Findings:

## Spec Audit Findings

### 1. Critical: edit tool is still wired to legacy regex hashline implementation, not `@bastani/hashline`
- Spec requires replacing legacy `packages/coding-agent/src/core/tools/hashline.ts` and using `@bastani/hashline` `Patcher`/`parsePatch`/snapshot store (`/tmp/omp-ref/REPLICATION-SPEC.md:41-49`).
- Current edit implementation imports legacy helpers from `./hashline.ts`, including `applyHashlineOperations`, `parseHashlineEditInput`, `getHashlineSnapshot`, and `recordHashlineSnapshot` (`packages/coding-agent/src/core/tools/edit.ts:18-28`).
- It applies edits through `applyHashlineOperations(...)` (`packages/coding-agent/src/core/tools/edit.ts:217`) instead of the replicated `Patcher`.
- The legacy implementation still exists and exports `applyHashlineOperations` (`packages/coding-agent/src/core/tools/hashline.ts:414`).

### 2. Critical: read/write/search still use legacy snapshot/tag store instead of replicated hashline snapshot engine
- Spec requires the new hashline engine to be the single source of truth (`/tmp/omp-ref/REPLICATION-SPEC.md:41-42`).
- `read.ts` imports `createHashlineSnapshotStore`, `formatHashlineContent`, and `recordHashlineSnapshot` from legacy `./hashline.ts` (`packages/coding-agent/src/core/tools/read.ts:18`) and records snapshots through it (`packages/coding-agent/src/core/tools/read.ts:460`).
- `write.ts` imports the same legacy store/format functions (`packages/coding-agent/src/core/tools/write.ts:11`) and records snapshots through it (`packages/coding-agent/src/core/tools/write.ts:307`).
- `search.ts` imports legacy snapshot helpers (`packages/coding-agent/src/core/tools/search.ts:14`) and records snapshots through them (`packages/coding-agent/src/core/tools/search.ts:229`).

### 3. Critical: model-facing edit prompt is not verbatim reference guidance
- Spec requires tool prompts/guidance to match `/tmp/omp-ref/tools-docs/*.md` verbatim where model-facing (`/tmp/omp-ref/REPLICATION-SPEC.md:62-65`).
- Reference edit docs include detailed hashline grammar, tolerated input shapes, output details, and examples (`/tmp/omp-ref/tools-docs/edit.md:23-87`).
- Current edit tool only exposes a short custom `promptGuidelines` array (`packages/coding-agent/src/core/tools/edit.ts:250-255`) and does not include the reference guidance verbatim.

## Completion Assessment

The full objective does **not** appear complete. Although `packages/hashline` exists, the active `edit`/`read`/`write`/`search` code paths still use the legacy `core/tools/hashline.ts` implementation, so the replicated hashline engine is not the single source of truth required by the spec.